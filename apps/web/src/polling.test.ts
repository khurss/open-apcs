import { afterEach, expect, it, vi } from 'vitest';
import { startPolling } from './polling.js';
afterEach(() => vi.useRealTimers());
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
it('includes HTTP response time in the refresh period', async () => {
  vi.useFakeTimers();
  const starts: number[] = [];
  const stop = startPolling(async () => { starts.push(performance.now()); await wait(150); }, 250);
  await vi.advanceTimersByTimeAsync(700);
  stop();
  expect(starts).toEqual([0,250,500]);
});
it('skips elapsed slots without overlapping or sending catch-up requests', async () => {
  vi.useFakeTimers();
  const starts: number[] = []; let pending = 0, peak = 0;
  const stop = startPolling(async () => { starts.push(performance.now()); peak = Math.max(peak, ++pending); await wait(600); pending--; }, 250);
  await vi.advanceTimersByTimeAsync(1400);
  stop();
  expect(starts).toEqual([0,750]);
  expect(peak).toBe(1);
});
it('does not schedule another refresh after disposal during an in-flight request', async () => {
  vi.useFakeTimers();
  const refresh = vi.fn(async () => { await wait(150); });
  const stop = startPolling(refresh, 250);
  await vi.advanceTimersByTimeAsync(50); stop();
  await vi.advanceTimersByTimeAsync(1000);
  expect(refresh).toHaveBeenCalledTimes(1);
});
