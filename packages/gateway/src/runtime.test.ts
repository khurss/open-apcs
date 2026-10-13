import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LedRuntime, type RuntimeGateway } from './runtime.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
function bench() {
  const gateway: RuntimeGateway = { start: vi.fn(async () => {}), synchronize: vi.fn(async () => {}),
    dispatchNext: vi.fn(async () => false), stop: vi.fn(async () => {}) };
  return { gateway, runtime: new LedRuntime(gateway, () => Date.now()) };
}
describe('headless LED runtime scheduling', () => {
  it('can explicitly restart after a failed startup', async () => {
    const { gateway, runtime } = bench();
    vi.mocked(gateway.start).mockRejectedValueOnce(new Error('Broker unavailable'));
    await expect(runtime.start()).rejects.toThrow('Broker unavailable');
    await runtime.start();
    expect(runtime.status.state).toBe('running');
    await runtime.stop();
  });

  it('does not continue startup after an immediate stop', async () => {
    const { gateway, runtime } = bench();
    const starting = runtime.start();
    const stopping = runtime.stop();
    await Promise.all([starting, stopping]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(runtime.status.state).toBe('stopped');
    expect(gateway.dispatchNext).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('polls commands and renews sessions without a browser', async () => {
    const { gateway, runtime } = bench();
    await runtime.start();
    expect(runtime.status.state).toBe('running');
    await vi.advanceTimersByTimeAsync(1050);
    expect(gateway.dispatchNext).toHaveBeenCalledTimes(21);
    expect(gateway.synchronize).toHaveBeenCalledTimes(2);
    await runtime.stop();
  });
  it('never overlaps or catches up a stalled cycle', async () => {
    const { gateway, runtime } = bench();
    let release!: (value: boolean) => void;
    vi.mocked(gateway.dispatchNext).mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    await runtime.start(); await vi.advanceTimersByTimeAsync(2000);
    expect(gateway.dispatchNext).toHaveBeenCalledTimes(1);
    release(false); await vi.advanceTimersByTimeAsync(0);
    expect(gateway.dispatchNext).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(50);
    expect(gateway.dispatchNext).toHaveBeenCalledTimes(2);
    await runtime.stop();
  });
  it('stops renewals and requires explicit restart after a failed cycle', async () => {
    const { gateway, runtime } = bench();
    vi.mocked(gateway.dispatchNext).mockRejectedValueOnce(new Error('Journal unavailable'));
    await runtime.start(); await vi.advanceTimersByTimeAsync(100);
    expect(runtime.status).toEqual({ state: 'faulted', error: 'Runtime cycle failed; explicit restart required' });
    expect(gateway.stop).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(gateway.synchronize).toHaveBeenCalledTimes(1);
    expect(gateway.dispatchNext).toHaveBeenCalledTimes(1);
    await runtime.start();
    expect(runtime.status.state).toBe('running');
    await runtime.stop();
  });
  it('cleans up a failed startup', async () => {
    const { gateway, runtime } = bench();
    vi.mocked(gateway.synchronize).mockRejectedValueOnce(new Error('Offline'));
    await expect(runtime.start()).rejects.toThrow('Offline');
    expect(gateway.stop).toHaveBeenCalledOnce();
    expect(runtime.status.state).toBe('faulted');
    expect(vi.getTimerCount()).toBe(0);
  });
  it('stops cleanly and prevents duplicate start', async () => {
    const { gateway, runtime } = bench();
    await runtime.start(); await expect(runtime.start()).rejects.toThrow(/started|running/i);
    await runtime.stop(); await vi.advanceTimersByTimeAsync(5000);
    expect(runtime.status.state).toBe('stopped');
    expect(gateway.dispatchNext).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

it('reports known timing failure categories without exposing arbitrary transport error text',async()=>{
  const {gateway,runtime}=bench();
  vi.mocked(gateway.synchronize).mockRejectedValueOnce(new Error('Snapshot is not fresh'));
  await expect(runtime.start()).rejects.toThrow();
  expect(runtime.status.error).toContain('snapshot freshness');
  await runtime.start();
  vi.mocked(gateway.dispatchNext).mockRejectedValueOnce(new Error('Secret transport URL fixture'));
  await vi.advanceTimersByTimeAsync(100);
  expect(runtime.status.error).toBe('Runtime cycle failed; explicit restart required');
  await runtime.stop();
});
