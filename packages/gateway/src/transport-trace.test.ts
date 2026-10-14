import {expect,it} from 'vitest';
import {TransportTrace, frameFingerprint} from './transport-trace.js';
it('matches byte fingerprints shared with firmware without retaining payloads',()=>{
  expect(frameFingerprint(Buffer.from('hello'))).toEqual({hash:1335831723,bytes:5});
  const trace=new TransportTrace(()=>12.5,()=>new Date('2026-10-14T00:00:00Z'));
  trace.record('send',Buffer.from('private payload'));
  expect(JSON.stringify(trace.snapshot())).not.toContain('private payload');
  expect(trace.snapshot().events[0]).toMatchObject({sequence:1,event:'send',monotonicMs:12.5,at:'2026-10-14T00:00:00.000Z',bytes:15});
});
it('bounds retained evidence, counts overwritten events and isolates snapshots',()=>{
  const trace=new TransportTrace(()=>0,()=>new Date(0));
  for(let i=0;i<140;i++) trace.record('receive',Buffer.from(String(i)));
  const snapshot=trace.snapshot();
  expect(snapshot.events).toHaveLength(128); expect(snapshot.overwritten).toBe(12);
  expect(snapshot.events[0]!.sequence).toBe(13);
  snapshot.events[0]!.bytes=0; snapshot.events.length=0;
  expect(trace.snapshot().events[0]!.bytes).toBe(2);
});
