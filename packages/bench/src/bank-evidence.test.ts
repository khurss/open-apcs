import {expect,it} from 'vitest';
import {verifyBankEvidence} from './bank-evidence.js';
const rows=Array.from({length:61},(_,i)=>({value:100+(80+i)%100,bootId:'boot',sequence:80+i,quality:'Good',receivedTime:new Date(100000+i*1000).toISOString()}));
const ui=rows.map(r=>({value:r.value.toFixed(2),quality:'Good',at:Date.parse(r.receivedTime)+200}));
const check=(samples=rows,events=ui)=>verifyBankEvidence(samples,events,{bootId:'boot',channel:1,first:80,last:140,seconds:60});
it('proves a bounded full numeric sequence including wraparound and every rendered value',()=>{
  expect(check()).toMatchObject({samples:61,ui:{count:61,p95:200,p99:200}});
});
it('rejects missing, repeated, foreign, malformed or late archive and UI evidence',()=>{
  for(const bad of [rows.slice(1),rows.filter((_,i)=>i!==10),[...rows.slice(0,10),rows[9]!,...rows.slice(10)],rows.map((r,i)=>i===4?{...r,value:999}:r),rows.map((r,i)=>i===4?{...r,bootId:'other'}:r),rows.map((r,i)=>i===4?{...r,quality:'Stale'}:r),rows.map((r,i)=>i===4?{...r,receivedTime:'bad'}:r)]) expect(()=>check(bad)).toThrow();
  for(const bad of [ui.slice(1),ui.filter((_,i)=>i!==10),ui.map(e=>({...e,at:e.at+1000})),ui.map((e,i)=>i===4?{...e,value:'wrong'}:e),ui.map((e,i)=>i===4?{...e,quality:'Stale'}:e)]) expect(()=>check(rows,bad)).toThrow();
});
it('requires near-one-Hz coverage for the requested duration',()=>{
  expect(()=>verifyBankEvidence(rows,ui,{bootId:'boot',channel:1,first:80,last:140,seconds:3600})).toThrow();
});

it('accepts boundary-read skew only with matching receive-time coverage',()=>{
  const samples=Array.from({length:63},(_,i)=>({...rows[0]!,sequence:80+i,value:100+(80+i)%100,receivedTime:new Date(100000+i*1000).toISOString()}));
  const events=samples.map(r=>({value:r.value.toFixed(2),quality:'Good',at:Date.parse(r.receivedTime)+200}));
  expect(verifyBankEvidence(samples,events,{bootId:'boot',channel:1,first:80,last:142,seconds:60}).samples).toBe(63);
  expect(()=>verifyBankEvidence(samples.map((r,i)=>({...r,receivedTime:new Date(100000+i*500).toISOString()})),events,{bootId:'boot',channel:1,first:80,last:142,seconds:60})).toThrow();
});
