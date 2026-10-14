/** Supervised renewal diagnostic through the real API; never submits output commands. */
import {readFileSync,writeFileSync,appendFileSync,mkdirSync,openSync,closeSync} from 'node:fs';
import {request} from '@playwright/test';
import {setTimeout as sleep} from 'node:timers/promises';
import type {TraceSnapshot} from '../../packages/gateway/src/transport-trace.js';
const seconds=Number(process.env.APCS_TRACE_SECONDS??600);
const cfg=JSON.parse(readFileSync('/run/bench/config.json','utf8'));
if(!process.send||!Number.isInteger(seconds)||seconds<10||seconds>3600||cfg.gpio!==18||!/^https:\/\//.test(cfg.origin)||!/^[0-9a-f-]{36}$/.test(cfg.deviceId))throw new Error('Supervised HTTPS GPIO18 diagnostic required');
const notify=(message:string)=>new Promise<void>((resolve,reject)=>process.send!(message,undefined,undefined,e=>e?reject(e):resolve()));
const access=readFileSync(cfg.credentialsFile,'utf8');
const api=await request.newContext({baseURL:cfg.origin,extraHTTPHeaders:{origin:cfg.origin},timeout:5000});
const directory=`/artifacts/session-${new Date().toISOString().replaceAll(':','-')}`;
let csrf='',armed=false,locked=false,last=0,error:unknown,boot:string|null=null,samples=0;
async function get(path:string){const r=await api.get(path);try{if(!r.ok())throw new Error(`Diagnostic GET failed: ${r.status()}`);return await r.json();}finally{await r.dispose();}}
async function post(path:string,data:unknown){const r=await api.post(path,{data,headers:{'x-csrf-token':csrf}});try{if(!r.ok())throw new Error(`Diagnostic POST failed: ${r.status()}`);return await r.json();}finally{await r.dispose();}}
function capture(trace:TraceSnapshot|null|undefined){
  if(!trace)throw new Error('Transport trace unavailable');
  const fresh=trace.events.filter(e=>e.sequence>last);
  if(fresh.length&&fresh[0]!.sequence!==last+1)throw new Error('Transport trace sampling gap');
  for(const event of fresh){appendFileSync(`${directory}/gateway.jsonl`,JSON.stringify(event)+'\n');last=event.sequence;}
}
try {
  ({csrfToken:csrf}=await post('/api/v1/auth/login',{username:access.match(/^Username: (.+)$/m)?.[1],password:access.match(/^Password: (.+)$/m)?.[1]}));
  closeSync(openSync('/artifacts/rigol.lock','wx',0o600));locked=true;await notify('locked');mkdirSync(directory);
  if((await get(`/api/v1/devices/${cfg.deviceId}/runtime`)).state!=='stopped')throw new Error('Bench must be stopped before renewal diagnostic');
  const signals=(await get('/api/v1/signals?limit=100')).items.filter((s:any)=>s.deviceId===cfg.deviceId&&s.direction==='output'&&s.dataType==='boolean');
  if(signals.length!==1)throw new Error('Expected exactly one LED output in the catalog page');
  await notify('arming');armed=true;
  await post(`/api/v1/devices/${cfg.deviceId}/commission`,{action:'start',gpio:18,acknowledgeLedOnly:true,reason:'Transport renewal diagnostic; no output commands'});
  console.log(`Session evidence: ${directory}`);
  const end=performance.now()+seconds*1000;let progress=performance.now()+30000;
  while(performance.now()<end) {
    const status=await get(`/api/v1/devices/${cfg.deviceId}/runtime?trace=true`);
    writeFileSync(`${directory}/runtime.json`,JSON.stringify(status,null,2));capture(status.transport);
    if(status.state!=='running'||status.error)throw new Error(status.error??'Physical renewal runtime stopped');
    const sample=await get(`/api/v1/signals/${signals[0].id}/value`);
    if(sample.quality!=='Good'||sample.value!==false||!sample.bootId||(boot!==null&&boot!==sample.bootId))throw new Error('Expected stable Good OFF output');
    boot=sample.bootId;samples++;
    if(performance.now()>progress){console.log(JSON.stringify({samples,transportEvents:last}));progress=performance.now()+30000;}
    await sleep(1000);
  }
}catch(reason){error=reason;}
finally {
  if(armed){try{const status=await post(`/api/v1/devices/${cfg.deviceId}/commission`,{action:'stop',reason:'End transport renewal diagnostic'});if(status.state!=='stopped')throw new Error('Stop was not confirmed');const final=await get(`/api/v1/devices/${cfg.deviceId}/runtime?trace=true`);capture(final.transport);writeFileSync(`${directory}/final-runtime.json`,JSON.stringify(final,null,2));}catch{error??=new Error('Cleanup failed; inspect bench');}}
  if(locked)writeFileSync(`${directory}/result.json`,JSON.stringify({seconds,samples,transportEvents:last,bootId:boot,error:error instanceof Error?error.message:error?'Diagnostic failed':null,scope:'OFF session renewals only; no output commands, reconciliation or endurance qualification'},null,2));
  await api.dispose();
}
if(error)throw error;
console.log(JSON.stringify({samples,transportEvents:last,stopped:true}));
