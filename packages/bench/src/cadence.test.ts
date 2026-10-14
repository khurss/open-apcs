import { afterEach, expect, it, vi } from 'vitest';
import { cadence } from './cadence.js';
afterEach(() => vi.useRealTimers());
it('waits again when a timer wakes before a fractional deadline', async () => {
  let now = 0;
  const starts: number[] = [];
  await cadence({start:0,ticks:2,phaseMs:62.5,now:()=>now,wait:async ms=>{now+=Math.max(0,ms-0.4);},step:async (_tick,late)=>{expect(late).toBeGreaterThanOrEqual(0);starts.push(now);}});
  expect(starts[0]).toBeGreaterThanOrEqual(62.5);
  expect(starts[1]).toBeGreaterThanOrEqual(1062.5);
});
it('keeps independent device phases when another device waits for acknowledgement', async () => {
  vi.useFakeTimers();
  const starts: number[][] = [[], []];
  const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
  const start = Date.now();
  const jobs = [0, 500].map((phase, device) => cadence({start, ticks:3, phaseMs:phase, now:Date.now, wait, step:async () => { starts[device]!.push(Date.now()-start); await wait(device ? 800 : 100); }}));
  await vi.advanceTimersByTimeAsync(4000); await Promise.all(jobs);
  expect(starts).toEqual([[0,1000,2000],[500,1500,2500]]);
});
it('rejects a missed period instead of sending a catch-up burst', async () => {
  vi.useFakeTimers(); const step = vi.fn(async () => { await new Promise(resolve => setTimeout(resolve, 2100)); });
  const done = cadence({start:Date.now(),ticks:3,phaseMs:0,now:Date.now,wait:ms=>new Promise(resolve=>setTimeout(resolve,ms)),step});
  const failed = expect(done).rejects.toThrow(/missed/i);
  await vi.advanceTimersByTimeAsync(3000); await failed;
  expect(step).toHaveBeenCalledTimes(1);
});

it('reports an actual missed deadline once, without counting propagated cancellation', async () => {
  let now = 0;
  const onMiss = vi.fn();
  let original: unknown;
  try {
    await cadence({start:0,ticks:3,phaseMs:0,now:()=>now,wait:async ms=>{now+=ms;},step:async()=>{now+=2100;},onMiss});
  } catch (error) { original = error; }
  expect(original).toBeInstanceOf(Error);
  expect(onMiss).toHaveBeenCalledExactlyOnceWith({tick:1,latenessMs:1100});
  await expect(cadence({start:now,ticks:3,phaseMs:0,now:()=>now,wait:async ms=>{now+=ms;},step:async()=>{throw original;},onMiss})).rejects.toBe(original);
  expect(onMiss).toHaveBeenCalledTimes(1);
});
