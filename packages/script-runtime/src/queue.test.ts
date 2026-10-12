import { afterEach, expect, it, vi } from 'vitest';
import { ScriptQueue } from './queue.js';
import type { ScriptRequest } from './contract.js';
const request: ScriptRequest = { mode: 'evaluate', language: 'javascript', source: 'return true;', inputs: { a: false, b: false }, nowMs: 0 };
afterEach(() => vi.useRealTimers());
it('bounds outstanding work and executes only one job at a time', async () => {
  const finish: Array<(value: { value: boolean }) => void> = []; let active = 0; let maximum = 0;
  const queue = new ScriptQueue(async () => { active++; maximum = Math.max(maximum, active); const result = await new Promise<{ value: boolean }>((resolve) => finish.push(resolve)); active--; return result; }, 2);
  const first = queue.run(request); const second = queue.run(request); await expect(queue.run(request)).rejects.toThrow(/full/);
  expect(finish).toHaveLength(1); finish.shift()!({ value: true }); await expect(first).resolves.toEqual({ value: true });
  await vi.waitFor(() => expect(finish).toHaveLength(1)); finish.shift()!({ value: false }); await expect(second).resolves.toEqual({ value: false }); expect(maximum).toBe(1); queue.close();
});
it('removes cancelled queued work before it can execute', async () => {
  let finish!: (value: { value: boolean }) => void; const execute = vi.fn(async () => new Promise<{ value: boolean }>((resolve) => { finish = resolve; }));
  const queue = new ScriptQueue(execute); const first = queue.run(request); const abort = new AbortController(); const second = queue.run(request, abort.signal);
  const cancelled = expect(second).rejects.toThrow(/cancelled/); abort.abort(); await cancelled;
  finish({ value: true }); await first; expect(execute).toHaveBeenCalledTimes(1); queue.close();
});
it('aborts an expired job without allowing overlapping execution', async () => {
  vi.useFakeTimers(); let finish!: (value: { value: boolean }) => void; let signal: AbortSignal | undefined; let calls = 0;
  const queue = new ScriptQueue(async (_request, abort) => { signal = abort; calls++; return new Promise<{ value: boolean }>((resolve) => { finish = resolve; }); }, 4, 100);
  const first = queue.run(request); const rejected = expect(first).rejects.toThrow(/deadline/); await vi.advanceTimersByTimeAsync(101); await rejected; expect(signal?.aborted).toBe(true);
  const second = queue.run(request); expect(calls).toBe(1); const cancelled = expect(second).rejects.toThrow(/closed/); queue.close(); await cancelled; finish({ value: true });
});
