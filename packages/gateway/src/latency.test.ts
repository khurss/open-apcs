import {expect,it} from 'vitest';
import {LatencyHistogram} from './latency.js';
it('reports bounded-memory nearest-rank upper bounds without hiding outliers',()=>{
  const h=new LatencyHistogram();
  expect(h.summary()).toBeNull();
  for(let i=0;i<95;i++) h.record(20.1);
  for(let i=0;i<4;i++) h.record(150.2);
  h.record(2000.5);
  expect(h.summary()).toEqual({count:100,p50:21,p95:21,p99:151,max:2000.5});
  const snapshot=h.summary()!;snapshot.count=1;
  expect(h.summary()!.count).toBe(100);
  const slow=new LatencyHistogram();slow.record(3000);expect(slow.summary()!.p99).toBe(3000);
  for(const value of [-1,NaN,Infinity]) expect(()=>h.record(value)).toThrow();
});
