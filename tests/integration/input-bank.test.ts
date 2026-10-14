import {randomUUID} from 'node:crypto';
import {createServer,connect,type Socket} from 'node:net';
import {connectAsync} from 'mqtt';
import {afterEach,expect,it,vi} from 'vitest';
import {SignalStore} from '../../packages/domain/src/signals.js';
import {MqttInputBank,inputBankTopic} from '../../packages/gateway/src/input-bank.js';
const closers:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of closers.splice(0).reverse()) await close();});
function fixture(){
  const url=process.env.APCS_TEST_MQTT_URL;if(!url)throw new Error('Docker broker required');
  const deviceId=randomUUID(),boot=randomUUID(),ids=[randomUUID(),randomUUID()];
  const options={url,siteId:randomUUID(),deviceId,signalId:randomUUID(),inputSignalIds:ids};
  const signals=new SignalStore({monotonicNow:()=>performance.now(),wallNow:()=>new Date()});
  for(const id of ids)signals.register({id,deviceId,dataType:'float64',freshnessMs:3000});
  signals.beginSession(deviceId,boot);
  const fault=vi.fn();const bank=new MqttInputBank(options,boot,signals,fault);closers.push(()=>bank.stop());
  return {options,boot,ids,signals,fault,bank};
}
it('rejects malformed, retained, foreign-session and replayed MQTT bank frames without partial updates',async()=>{
  const f=fixture();await f.bank.start();
  const client=await connectAsync(f.options.url,{protocolVersion:5,reconnectPeriod:0});closers.push(()=>client.endAsync(true));
  const frame={v:1,bootId:f.boot,sequence:999,values:[99,199]};const topic=inputBankTopic(f.options);
  await client.publishAsync(topic,JSON.stringify(frame),{qos:1,retain:true});
  for(const value of [{...frame,bootId:'old'},{...frame,values:[99,null]},{...frame,values:[99]},{...frame,extra:true},{...frame,sequence:0}]) await client.publishAsync(topic,JSON.stringify(value),{qos:1});
  await expect.poll(()=>f.bank.rejectedFrames).toBeGreaterThanOrEqual(6);
  expect(f.signals.get(f.ids[0]!).sequence).toBeLessThan(10);
  expect(f.signals.get(f.ids[0]!).value).toBeLessThan(99);
  expect(f.signals.get(f.ids[1]!).value).toBeLessThan(199);
  expect(f.fault).not.toHaveBeenCalled();
  await client.publishAsync(topic,'',{qos:1,retain:true});
  await f.bank.stop();for(const id of f.ids)expect(f.signals.get(id).quality).toBe('Disconnected');
  await expect(f.bank.start()).rejects.toThrow(/stopped|started/);
});
it('disconnects all bank inputs and reports a single fault when MQTT is lost',async()=>{
  const f=fixture();const broker=new URL(f.options.url);const sockets=new Set<Socket>();
  const proxy=createServer(client=>{
    const upstream=connect(Number(broker.port||1883),broker.hostname);sockets.add(client);sockets.add(upstream);
    client.on('error',()=>upstream.destroy());upstream.on('error',()=>client.destroy());
    client.on('close',()=>{sockets.delete(client);upstream.destroy();});upstream.on('close',()=>{sockets.delete(upstream);client.destroy();});
    client.pipe(upstream);upstream.pipe(client);
  });
  await new Promise<void>(resolve=>proxy.listen(0,'127.0.0.1',resolve));
  closers.unshift(async()=>{for(const socket of sockets)socket.destroy();await new Promise<void>(resolve=>proxy.close(()=>resolve()));});
  const address=proxy.address();if(!address||typeof address==='string')throw new Error('Proxy unavailable');
  f.options.url=`mqtt://127.0.0.1:${address.port}`;await f.bank.start();
  for(const socket of sockets)socket.destroy();
  await expect.poll(()=>f.fault.mock.calls.length).toBe(1);
  for(const id of f.ids)expect(f.signals.get(id).quality).toBe('Disconnected');
});
