import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphTask, type GraphIo } from './graph-task.js';
import type { LogicGraph } from '../../domain/src/logic.js';
import type { SignalSnapshot } from '../../domain/src/signals.js';
import type { CommandSnapshot } from '../../domain/src/commands.js';
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
afterEach(() => vi.useRealTimers());
const sample = (value: boolean): SignalSnapshot => ({ value, quality: 'Good', bootId: 'boot', sequence: 1, receivedTime: new Date(0).toISOString(), sourceTime: null });
const graph: LogicGraph = { schemaVersion: 1, nodes: [{ id: 'input', kind: 'input', label: 'Input', x: 0, y: 0, signalId: 'switch' }, { id: 'output', kind: 'output', label: 'LED', x: 100, y: 0, signalId: 'led' }], edges: [{ id: 'wire', source: 'input', target: 'output', port: 'in' }] };
function bench() {
  const samples: Record<string, SignalSnapshot> = { switch: sample(true), led: sample(false) };
  let serial = 0; const commands = new Map<string, CommandSnapshot>();
  const io: GraphIo = {
    read: vi.fn(async () => structuredClone(samples)),
    request: vi.fn(async (targetSignalId, value) => { const command: CommandSnapshot = { id: `c${++serial}`, targetSignalId, value, bootId: 'boot', state: 'Accepted', reason: null, evidence: null, history: [] }; commands.set(command.id, command); return structuredClone(command); }),
    command: vi.fn(async (id) => structuredClone(commands.get(id)!)),
    revoke: vi.fn(async () => {}),
  };
  return { io, samples, commands, task: new GraphTask(graph, io, () => Date.now()) };
}
describe('headless graph task', () => {
  it('executes automatically without a browser and submits through its command port', async () => { const { task, io } = bench(); await task.start(); expect(io.request).toHaveBeenCalledWith('led', true); expect(task.status).toMatchObject({ state: 'running', cycles: 1, pending: ['c1'] }); await task.stop(); });
  it('does not repeat an unacknowledged command or resend an unchanged verified target', async () => { const { task, io, commands } = bench(); await task.start(); await vi.advanceTimersByTimeAsync(500); expect(io.request).toHaveBeenCalledTimes(1); commands.get('c1')!.state = 'Verified'; await vi.advanceTimersByTimeAsync(500); expect(io.request).toHaveBeenCalledTimes(1); expect(task.status.pending).toEqual([]); await task.stop(); });
  it('waits for the previous acknowledgement before issuing the newest target', async () => { const { task, io, commands, samples } = bench(); await task.start(); samples.switch = sample(false); await vi.advanceTimersByTimeAsync(200); expect(io.request).toHaveBeenCalledTimes(1); commands.get('c1')!.state = 'Verified'; await vi.advanceTimersByTimeAsync(100); expect(io.request).toHaveBeenLastCalledWith('led', false); expect(io.request).toHaveBeenCalledTimes(2); await task.stop(); });
  it('does not emit an initial command if the output already equals the desired value', async () => { const { task, io, samples } = bench(); samples.led = sample(true); await task.start(); expect(io.request).not.toHaveBeenCalled(); await task.stop(); });
  it.each(['Unknown', 'Rejected', 'Expired', 'Failed', 'Cancelled'] as const)('revokes output authority after a %s command outcome', async (state) => { const { task, io, commands } = bench(); await task.start(); commands.get('c1')!.state = state; await vi.advanceTimersByTimeAsync(100); expect(task.status.state).toBe('faulted'); expect(io.revoke).toHaveBeenCalledTimes(1); await vi.advanceTimersByTimeAsync(1000); expect(io.request).toHaveBeenCalledTimes(1); });
  it('revokes on bad quality instead of converting missing input to false', async () => { const { task, samples, io } = bench(); samples.switch!.quality = 'Disconnected'; await task.start(); expect(task.status.state).toBe('faulted'); expect(io.request).not.toHaveBeenCalled(); expect(io.revoke).toHaveBeenCalledTimes(1); });
  it('revokes on a changed device boot and never auto-rearms', async () => { const { task, samples, io } = bench(); await task.start(); samples.led!.bootId = 'new-boot'; await vi.advanceTimersByTimeAsync(100); expect(task.status.state).toBe('faulted'); expect(io.revoke).toHaveBeenCalledTimes(1); await expect(task.start()).rejects.toThrow(/new task/i); });
  it('bounds its execution period and validates before scheduling', () => { const { io } = bench(); for (const period of [0, 1, 99, 60001, NaN]) expect(() => new GraphTask(graph, io, () => 0, period)).toThrow(); expect(() => new GraphTask({ ...graph, edges: [] }, io, () => 0)).toThrow(); });
  it('does not overlap or catch up cycles when its input reader stalls', async () => { const { task, io } = bench(); let release!: (values: Record<string, SignalSnapshot>) => void; vi.mocked(io.read).mockImplementationOnce(() => new Promise((r) => { release = r; })); const start = task.start(); await vi.advanceTimersByTimeAsync(1000); expect(io.read).toHaveBeenCalledTimes(1); release({ switch: sample(true), led: sample(false) }); await start; expect(task.status.cycles).toBe(1); await vi.advanceTimersByTimeAsync(99); expect(io.read).toHaveBeenCalledTimes(1); await vi.advanceTimersByTimeAsync(1); expect(io.read).toHaveBeenCalledTimes(2); await task.stop(); });
  it('can pause between cycles without releasing its existing output ownership', async () => { const { task, io } = bench(); await task.start(); await task.pause(); expect(task.status.state).toBe('paused'); expect(task.status.pending).toEqual(['c1']); await vi.advanceTimersByTimeAsync(1000); expect(io.request).toHaveBeenCalledTimes(1); expect(io.revoke).not.toHaveBeenCalled(); await task.start(); expect(task.status.state).toBe('running'); await task.stop(); });
  it('does not send an intent after stopping during an asynchronous read', async () => { const { task, io } = bench(); let release!: (v: Record<string, SignalSnapshot>) => void; vi.mocked(io.read).mockImplementationOnce(() => new Promise((r) => { release = r; })); const start = task.start(); await vi.advanceTimersByTimeAsync(0); const stop = task.stop(); release({ switch: sample(true), led: sample(false) }); await Promise.all([start, stop]); expect(io.request).not.toHaveBeenCalled(); expect(io.revoke).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0); });
  it('rejects concurrent starts instead of creating two scheduler loops', async () => { const { task, io } = bench(); const results = await Promise.allSettled([task.start(), task.start()]); expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1); expect(io.read).toHaveBeenCalledTimes(1); await task.stop(); });
  it('bounds a stalled cycle and ignores a late input result after revocation', async () => { const { task, io } = bench(); let release!: (v: Record<string, SignalSnapshot>) => void; vi.mocked(io.read).mockImplementationOnce(() => new Promise((r) => { release = r; })); const start = task.start(); await vi.advanceTimersByTimeAsync(2001); const state = task.status.state; release({ switch: sample(true), led: sample(false) }); await start; expect(state).toBe('faulted'); expect(io.request).not.toHaveBeenCalled(); expect(io.revoke).toHaveBeenCalledTimes(1); });
  it('faults on a journal error and keeps the original reason even when revocation fails', async () => { const { task, io } = bench(); vi.mocked(io.request).mockRejectedValueOnce(new Error('Journal offline')); vi.mocked(io.revoke).mockRejectedValueOnce(new Error('Cleanup offline')); await task.start(); expect(task.status).toMatchObject({ state: 'faulted', error: 'Journal offline; revocation failed' }); });
});

describe('isolated graph scripts', () => {
  const scripted: LogicGraph = { schemaVersion: 1, nodes: [
    { id: 'a', kind: 'constant', label: 'A', x: 0, y: 0, value: true },
    { id: 'b', kind: 'constant', label: 'B', x: 0, y: 100, value: false },
    { id: 'script', kind: 'script', label: 'Script', x: 100, y: 0, source: 'return input.a;', language: 'typescript' },
    { id: 'out', kind: 'output', label: 'Output', x: 200, y: 0, signalId: 'led' },
  ], edges: [{ id: 'a-s', source: 'a', target: 'script', port: 'a' }, { id: 'b-s', source: 'b', target: 'script', port: 'b' }, { id: 's-o', source: 'script', target: 'out', port: 'in' }] };
  it('requires an evaluator before starting and uses a 1 Hz minimum script period', async () => {
    const { io } = bench(); expect(() => new GraphTask(scripted, io, () => 0)).toThrow(/evaluator/i);
    io.evaluate = vi.fn(async () => true); const task = new GraphTask(scripted, io, () => Date.now());
    await task.start(); expect(io.request).toHaveBeenCalledWith('led', true);
    await vi.advanceTimersByTimeAsync(999); expect(io.evaluate).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(io.evaluate).toHaveBeenCalledTimes(2); await task.stop();
  });
  it('revokes and sends no command when a script fails', async () => {
    const { io } = bench(); io.evaluate = async () => { throw new Error('Script execution rejected'); };
    const task = new GraphTask(scripted, io, () => 0); await task.start();
    expect(task.status.state).toBe('faulted'); expect(io.revoke).toHaveBeenCalledTimes(1); expect(io.request).not.toHaveBeenCalled();
  });
  it.each(['stop', 'deadline'])('fences a late script result after %s', async (action) => {
    const { io } = bench(); let release!: (v: boolean) => void;
    io.evaluate = () => new Promise((resolve) => { release = resolve; });
    const task = new GraphTask(scripted, io, () => 0); const start = task.start(); await vi.advanceTimersByTimeAsync(0);
    const stop = action === 'stop' ? task.stop() : vi.advanceTimersByTimeAsync(2001);
    await vi.advanceTimersByTimeAsync(0); release(true); await Promise.all([start, stop]);
    expect(io.request).not.toHaveBeenCalled(); expect(io.revoke).toHaveBeenCalledTimes(1);
  });
});

describe('numeric graph tasks', () => {
  const numeric: LogicGraph = { schemaVersion: 1, nodes: [
    { id: 'sensor', kind: 'analog', label: 'Sensor', signalId: 'sensor', x: 0, y: 0 },
    { id: 'threshold', kind: 'number', label: 'Threshold', value: 10, x: 0, y: 100 },
    { id: 'compare', kind: 'greater', label: 'Compare', x: 100, y: 0 },
    { id: 'out', kind: 'output', label: 'LED', signalId: 'led', x: 200, y: 0 },
  ], edges: [{ id: 'sensor-compare', source: 'sensor', target: 'compare', port: 'a' }, { id: 'threshold-compare', source: 'threshold', target: 'compare', port: 'b' }, { id: 'compare-out', source: 'compare', target: 'out', port: 'in' }] };
  it('reads finite numeric input and submits only the resulting boolean command', async () => {
    const { io, samples } = bench(); samples.sensor = { ...sample(false), value: 12 };
    const task = new GraphTask(numeric, io, () => Date.now()); await task.start();
    expect(task.status.state).toBe('running'); expect(io.request).toHaveBeenCalledWith('led', true);
    samples.sensor.value = NaN; await vi.advanceTimersByTimeAsync(100);
    expect(task.status.state).toBe('faulted'); expect(io.revoke).toHaveBeenCalledTimes(1); expect(io.request).toHaveBeenCalledTimes(1);
  });
  it('rejects numeric-looking strings and never coerces them into control inputs', async () => {
    const { io, samples } = bench(); samples.sensor = { ...sample(false), value: '12' };
    const task = new GraphTask(numeric, io, () => Date.now()); await task.start();
    expect(task.status.state).toBe('faulted'); expect(io.request).not.toHaveBeenCalled(); expect(io.revoke).toHaveBeenCalledTimes(1);
  });
});

it('checks every output before dispatch when another branch has a division fault', async () => {
  const { io, samples } = bench(); samples.other = sample(false);
  const broken: LogicGraph = { schemaVersion: 1, nodes: [
    { id: 'source', kind: 'constant', label: 'Power', value: true, x: 0, y: 0 },
    { id: 'a-led', kind: 'output', label: 'LED', signalId: 'led', x: 0, y: 0 },
    { id: 'zero', kind: 'number', label: 'Zero', value: 0, x: 0, y: 0 },
    { id: 'divide', kind: 'divide', label: 'Division', x: 0, y: 0 },
    { id: 'band', kind: 'hysteresis', label: 'Band', low: 0, high: 1, x: 0, y: 0 },
    { id: 'z-other', kind: 'output', label: 'Other', signalId: 'other', x: 0, y: 0 },
  ], edges: [
    { id: 's-o', source: 'source', target: 'a-led', port: 'in' },
    { id: 'z-a', source: 'zero', target: 'divide', port: 'a' }, { id: 'z-b', source: 'zero', target: 'divide', port: 'b' },
    { id: 'd-b', source: 'divide', target: 'band', port: 'in' }, { id: 'b-o', source: 'band', target: 'z-other', port: 'in' },
  ] };
  const task = new GraphTask(broken, io, () => Date.now()); await task.start();
  expect(task.status).toMatchObject({ state: 'faulted', error: 'Division by zero' });
  expect(io.request).not.toHaveBeenCalled(); expect(io.revoke).toHaveBeenCalledTimes(1);
});
