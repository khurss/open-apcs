import { describe, expect, it, vi } from 'vitest';
import { LogicEngine, validateGraph, type LogicGraph } from './logic.js';
const graph = (): LogicGraph => ({ schemaVersion: 1, nodes: [
  { id: 'a', kind: 'constant', label: 'A', x: 0, y: 0, value: true },
  { id: 'b', kind: 'constant', label: 'B', x: 0, y: 100, value: false },
  { id: 'script', kind: 'script', label: 'Script', x: 200, y: 0, language: 'typescript', source: 'return input.a && !input.b;' },
  { id: 'output', kind: 'output', label: 'LED', x: 400, y: 0, signalId: 'led' },
], edges: [{ id: 'a-s', source: 'a', target: 'script', port: 'a' }, { id: 'b-s', source: 'b', target: 'script', port: 'b' }, { id: 's-o', source: 'script', target: 'output', port: 'in' }] } as unknown as LogicGraph);
describe('asynchronous isolated script blocks', () => {
  it('validates bounded source and requires both declared inputs', () => {
    expect(validateGraph(graph()).nodes).toHaveLength(4);
    for (const fields of [{ source: '' }, { language: 'python' }, { source: 'x'.repeat(16385) }]) {
      const value = graph(); Object.assign(value.nodes[2]!, fields); expect(() => validateGraph(value)).toThrow(/script/i);
    }
    const missing = graph(); missing.edges.shift(); expect(() => validateGraph(missing)).toThrow(/Unconnected/);
  });
  it('delegates only copied boolean inputs and explicit time, then propagates the result', async () => {
    const execute = vi.fn(async () => true); const engine = new LogicEngine(graph());
    expect((await engine.tickAsync(1200, {}, execute)).outputs.led).toMatchObject({ value: true, quality: 'Good' });
    expect(execute).toHaveBeenCalledWith({ source: 'return input.a && !input.b;', language: 'typescript', inputs: { a: true, b: false }, nowMs: 1200 });
  });
  it('skips script execution for unavailable inputs and keeps the output invalid', async () => {
    const value = graph(); value.nodes[0] = { id: 'a', kind: 'input', label: 'A', x: 0, y: 0, signalId: 'unavailable' };
    const execute = vi.fn(async () => true); const result = await new LogicEngine(value).tickAsync(0, {}, execute);
    expect(execute).not.toHaveBeenCalled(); expect(result.outputs.led?.quality).toBe('Bad');
  });
  it('rejects synchronous evaluation, invalid results and overlapping ticks', async () => {
    expect(() => new LogicEngine(graph()).tick(0)).toThrow(/asynchronous/i);
    await expect(new LogicEngine(graph()).tickAsync(0, {}, async () => 1 as unknown as boolean)).rejects.toThrow(/boolean/i);
    const engine = new LogicEngine(graph()); let finish!: (value: boolean) => void;
    const pending = engine.tickAsync(0, {}, () => new Promise<boolean>((resolve) => { finish = resolve; }));
    expect(() => engine.tick(1)).toThrow(/progress/i); finish(true); await pending;
    expect((await engine.tickAsync(2, {}, async () => false)).outputs.led?.value).toBe(false);
  });
  it('propagates evaluator failure and releases its evaluation guard', async () => {
    const engine = new LogicEngine(graph()); await expect(engine.tickAsync(0, {}, async () => { throw new Error('Script deadline exceeded'); })).rejects.toThrow(/deadline/);
    expect((await engine.tickAsync(1, {}, async () => true)).outputs.led?.value).toBe(true);
  });
});
