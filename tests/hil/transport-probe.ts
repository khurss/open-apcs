/** Explicit disarmed GPIO18 diagnostic: sends probes only, never leases or writes. */
import {readFileSync,writeFileSync,appendFileSync,openSync,closeSync,unlinkSync,mkdirSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';
import {connectAsync} from 'mqtt';
import {request} from '@playwright/test';
import {parsePhysicalConfig} from '../../packages/gateway/src/physical-config.js';
import {decodeFrame,deviceTopic} from '../../packages/led-protocol/src/index.js';
import {frameFingerprint} from '../../packages/gateway/src/transport-trace.js';
import {percentiles} from '../../packages/bench/src/load-evidence.js';
const seconds=Number(process.env.APCS_TRACE_SECONDS??300);
if(!Number.isInteger(seconds)||seconds<10||seconds>3600) throw new Error('Explicit 10–3600 second diagnostic required');
const cfg=JSON.parse(readFileSync('/run/bench/config.json','utf8'));
const physical=parsePhysicalConfig(JSON.parse(readFileSync('/run/physical/config.json','utf8')));
if(cfg.gpio!==18 || physical.devices.length!==1 || physical.devices[0]!.gpio!==18) throw new Error('Reviewed single GPIO18 bench required');
const target=physical.devices[0]!;
const input=deviceTopic(target.siteId,target.deviceId,'in'),output=deviceTopic(target.siteId,target.deviceId,'out');
const directory=`/artifacts/transport-${new Date().toISOString().replaceAll(':','-')}`;
closeSync(openSync('/artifacts/rigol.lock','wx',0o600)); mkdirSync(directory);
const record=(event:string,data:unknown={})=>appendFileSync(`${directory}/network.jsonl`,JSON.stringify({at:new Date().toISOString(),monotonicMs:performance.now(),event,data})+'\n');
const access=readFileSync(cfg.credentialsFile,'utf8');
const api=await request.newContext({baseURL:cfg.origin,extraHTTPHeaders:{origin:cfg.origin},timeout:5000});
let client:Awaited<ReturnType<typeof connectAsync>>|undefined;
let pending:{nonce:string;sent:number;done:()=>void}|null=null;
let finishing=false;
let boot:string|null=null,requests=0,missing=0,late=0,failure:unknown;
const delays:number[]=[];
for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>{failure=new Error('Diagnostic interrupted');pending?.done();});
try {
  const login=await api.post('/api/v1/auth/login',{data:{username:access.match(/^Username: (.+)$/m)?.[1],password:access.match(/^Password: (.+)$/m)?.[1]}});
  if(!login.ok()) throw new Error('Diagnostic login failed'); await login.dispose();
  const stopped=async()=>{const r=await api.get(`/api/v1/devices/${cfg.deviceId}/runtime?trace=true`);try{if(!r.ok() || (await r.json()).state!=='stopped') throw new Error('Physical runtime must remain explicitly stopped');}finally{await r.dispose();}};
  await stopped();
  client=await connectAsync(physical.url,{username:physical.username,password:physical.password,ca:physical.ca,protocolVersion:5,reconnectPeriod:0,clean:true,queueQoSZero:false,connectTimeout:3000,clientId:`apcs-trace-${randomUUID()}`});
  client.on('error',()=>{failure=new Error('Diagnostic MQTT connection failed');});
  client.on('close',()=>{if(!finishing)failure??=new Error('Diagnostic MQTT connection closed');});
  client.on('packetsend',p=>{if(p.cmd==='publish')record('packet-send',{messageId:p.messageId,...frameFingerprint(Buffer.from(p.payload))});});
  client.on('packetreceive',p=>{if(p.cmd==='puback'||p.cmd==='publish')record('packet-receive',{command:p.cmd,messageId:p.messageId});});
  client.on('message',(topic,payload,packet)=>{
    if(topic!==output)return;
    record('receive',frameFingerprint(payload));
    try {
      const frame=decodeFrame(payload,packet.retain);
      if(frame.kind!=='snapshot'||frame.nonce!==pending?.nonce)return;
      if(frame.value!==false || (boot!==null&&boot!==frame.bootId)) throw new Error('Diagnostic requires one stable OFF boot');
      boot=frame.bootId;
      const elapsed=performance.now()-pending.sent; delays.push(elapsed); if(elapsed>250)late++;
      record('snapshot',{elapsedMs:elapsed,deviceTimeMs:frame.deviceTimeMs,...frameFingerprint(payload)});
      pending.done(); pending=null;
    }catch { failure=new Error('Invalid diagnostic reply or unexpected physical state'); pending?.done();pending=null; }
  });
  await client.subscribeAsync(output,{qos:1,rap:true});
  record('start',{seconds,clientId:client.options.clientId}); console.log(`Transport evidence: ${directory}`);
  const end=performance.now()+seconds*1000;
  let progress=performance.now()+30000;
  while(performance.now()<end && !failure) {
    await stopped();
    const nonce=randomUUID(),bytes=Buffer.from(JSON.stringify({v:1,kind:'probe',nonce}));
    let done!:()=>void; const reply=new Promise<void>(resolve=>{done=resolve;});
    const sent=performance.now();pending={nonce,sent,done};requests++;
    record('send',frameFingerprint(bytes));
    let timer:ReturnType<typeof setTimeout>|undefined;
    try {
      await Promise.race([client.publishAsync(input,bytes,{qos:1,retain:false,properties:{messageExpiryInterval:1}}).then(()=>record('puback',frameFingerprint(bytes))),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Probe publication timeout')),1500);})]);
    }finally {clearTimeout(timer);}
    let observation:ReturnType<typeof setTimeout>|undefined;
    try {await Promise.race([reply,new Promise<void>(resolve=>{observation=setTimeout(resolve,1500);})]);}finally{clearTimeout(observation);}
    if(pending){missing++;record('missing',frameFingerprint(bytes));pending=null;}
    if(performance.now()>progress){console.log(JSON.stringify({requests,replies:delays.length,late,missing}));progress=performance.now()+30000;}
    await sleep(Math.max(0,500-(performance.now()-sent)));
  }
  await stopped();
}catch(error){failure=error;}
finally {
  const error=failure instanceof Error?failure.message:failure?'Diagnostic failed':null;
  writeFileSync(`${directory}/result.json`,JSON.stringify({requests,replies:delays.length,late,missing,timing:delays.length?percentiles(delays):null,error,scope:'Probes only; no control authority, output commands or endurance acceptance'},null,2));
  finishing=true; await client?.endAsync(true);await api.dispose();unlinkSync('/artifacts/rigol.lock');
}
if(failure)throw failure;
console.log(JSON.stringify({requests,replies:delays.length,late,missing,timing:delays.length?percentiles(delays):null}));
