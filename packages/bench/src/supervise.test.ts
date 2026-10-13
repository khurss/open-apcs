import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import { confirmedStopped } from './cleanup-state.js';
import { supervise } from './supervise.js';
function child() { const c = new EventEmitter() as EventEmitter & { kill(signal: string): boolean }; c.kill = vi.fn(() => { queueMicrotask(() => c.emit('close', null)); return true; }); return c; }
it('independently disarms after worker death once arming may have begun', async () => {
  const c = child(), cleanup = vi.fn(async () => {});
  const done = supervise(c, cleanup, 1000);
  c.emit('message', 'arming'); c.emit('close', 1);
  await expect(done).rejects.toThrow(); expect(cleanup).toHaveBeenCalledWith(true, false);
});
it('kills a blocked worker at the deadline and performs cleanup', async () => {
  const c = child(), cleanup = vi.fn(async () => {});
  const done = supervise(c, cleanup, 10);
  c.emit('message', 'locked'); c.emit('message', 'arming');
  await expect(done).rejects.toThrow();
  expect(c.kill).toHaveBeenCalledWith('SIGKILL'); expect(cleanup).toHaveBeenCalledWith(true, true);
});
it('does not claim ownership of an already active bench and propagates cleanup failure', async () => {
  const c = child(), cleanup = vi.fn(async () => {}), done = supervise(c, cleanup, 1000);
  c.emit('close', 1); await expect(done).rejects.toThrow(); expect(cleanup).toHaveBeenCalledWith(false, false);
  const d = child(), failed = supervise(d, async () => { throw new Error('Disarm unavailable'); }, 1000);
  d.emit('message', 'arming'); d.emit('close', 0); await expect(failed).rejects.toThrow('Disarm unavailable');
});

it('accepts a stopped faulted graph but never mistakes faulted device control for confirmed cleanup',()=>{
  expect(confirmedStopped('/api/v1/graphs/id/runtime','faulted')).toBe(true);
  expect(confirmedStopped('/api/v1/graphs/id/runtime','running')).toBe(false);
  expect(confirmedStopped('/api/v1/devices/id/runtime','faulted')).toBe(false);
  expect(confirmedStopped('/api/v1/devices/id/commission','stopped')).toBe(true);
});
