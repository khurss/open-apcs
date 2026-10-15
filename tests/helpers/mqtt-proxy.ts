import {createServer,connect,type Socket} from 'node:net';
/** Test-only transport cut. No production fault-injection API is installed. */
export async function mqttProxy(url:string){
 const broker=new URL(url);const sockets=new Set<Socket>();
 const proxy=createServer(client=>{
  const upstream=connect(Number(broker.port||1883),broker.hostname);sockets.add(client);sockets.add(upstream);
  client.on('error',()=>upstream.destroy());upstream.on('error',()=>client.destroy());
  client.on('close',()=>{sockets.delete(client);upstream.destroy();});upstream.on('close',()=>{sockets.delete(upstream);client.destroy();});
  client.pipe(upstream);upstream.pipe(client);
 });
 await new Promise<void>(resolve=>proxy.listen(0,'127.0.0.1',resolve));
 const address=proxy.address();if(!address||typeof address==='string')throw new Error('MQTT fixture unavailable');
 const disconnect=()=>{for(const socket of sockets)socket.destroy();};
 return {url:`mqtt://127.0.0.1:${address.port}`,disconnect,close:async()=>{disconnect();await new Promise<void>(resolve=>proxy.close(()=>resolve()));}};
}
