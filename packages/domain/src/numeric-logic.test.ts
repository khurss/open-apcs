import { describe, expect, it } from 'vitest';
import { LogicEngine, validateGraph, type LogicGraph, type LogicNode, type LogicValue } from './logic.js';
const node = (id: string, kind: LogicNode['kind'], fields: Partial<LogicNode> = {}): LogicNode => ({ id, kind, label: id, x: 0, y: 0, ...fields });
const good = (value: boolean | number): LogicValue => ({ value, quality: 'Good', reason: null });
function binary(kind: LogicNode['kind'], a = 2, b = 3): LogicGraph {
  return { schemaVersion: 1, nodes: [node('a', 'number', { value: a }), node('b', 'number', { value: b }), node('op', kind)], edges: [{ id: 'a-op', source: 'a', target: 'op', port: 'a' }, { id: 'b-op', source: 'b', target: 'op', port: 'b' }] };
}
describe('typed numeric graph blocks', () => {
  it.each([['add', 2, 3, 5], ['subtract', 2, 3, -1], ['multiply', 2, 3, 6], ['divide', 6, 3, 2]] as const)('evaluates %s with finite numbers', (kind, a, b, expected) => {
    expect(new LogicEngine(binary(kind, a, b)).tick(0).nodes.op).toEqual(good(expected));
  });
  it('rejects incompatible edges and conflicting signal types before execution', () => {
    const graph = binary('add'); graph.nodes[0] = node('a', 'constant', { value: true }); expect(() => validateGraph(graph)).toThrow(/type/i);
    const direct: LogicGraph = { schemaVersion: 1, nodes: [node('a', 'number', { value: 1 }), node('out', 'output', { signalId: 'led' })], edges: [{ id: 'a-out', source: 'a', target: 'out', port: 'in' }] };
    expect(() => validateGraph(direct)).toThrow(/type/i);
    expect(() => validateGraph({ schemaVersion: 1, nodes: [node('a', 'analog', { signalId: 'same' }), node('b', 'input', { signalId: 'same' })], edges: [] })).toThrow(/type/i);
  });
  it('marks division by zero and numeric overflow Bad without manufacturing a boolean', () => {
    expect(new LogicEngine(binary('divide', 1, 0)).tick(0).nodes.op).toMatchObject({ value: null, quality: 'Bad' });
    expect(new LogicEngine(binary('multiply', Number.MAX_VALUE, 2)).tick(0).nodes.op).toMatchObject({ value: null, quality: 'Bad' });
  });
  it('accepts only finite numeric input and propagates unavailable data through comparisons', () => {
    const graph = binary('greater', 0, 10); graph.nodes[0] = node('a', 'analog', { signalId: 'sensor' });
    const engine = new LogicEngine(graph); expect(engine.tick(0, { sensor: good(11) }).nodes.op).toEqual(good(true));
    for (const [index, value] of [true, NaN, Infinity, '11', null].entries()) expect(engine.tick(index + 1, { sensor: { value, quality: 'Good', reason: null } as LogicValue }).nodes.op).toMatchObject({ value: null, quality: 'Bad' });
  });
  it('uses strict numeric comparisons with no implicit conversion', () => {
    expect(new LogicEngine(binary('greater', 3, 3)).tick(0).nodes.op).toEqual(good(false));
    expect(new LogicEngine(binary('less', 2, 3)).tick(0).nodes.op).toEqual(good(true));
  });
  it('holds hysteresis state within the band and resets it after invalid input', () => {
    const graph: LogicGraph = { schemaVersion: 1, nodes: [node('sensor', 'analog', { signalId: 'sensor' }), node('band', 'hysteresis', { low: 10, high: 20 })], edges: [{ id: 'sensor-band', source: 'sensor', target: 'band', port: 'in' }] };
    const engine = new LogicEngine(graph);
    for (const [at, [value, expected]] of [[15, false], [20, true], [19, true], [10, false], [15, false], [21, true]].entries()) expect(engine.tick(at, { sensor: good(value!) }).nodes.band).toEqual(good(expected!));
    expect(engine.tick(6, { sensor: { value: null, quality: 'Bad', reason: 'Disconnected' } }).nodes.band?.quality).toBe('Bad');
    expect(engine.tick(7, { sensor: good(15) }).nodes.band).toEqual(good(false));
  });
  it('requires finite constants and an ordered nonempty hysteresis band', () => {
    expect(() => validateGraph(binary('add', Infinity, 1))).toThrow(/finite/i);
    for (const fields of [{ low: 10, high: 10 }, { low: 11, high: 10 }, { low: NaN, high: 10 }]) expect(() => validateGraph({ schemaVersion: 1, nodes: [node('band', 'hysteresis', fields)], edges: [] }, false)).toThrow(/hysteresis/i);
    expect(() => validateGraph({ schemaVersion: 1, nodes: [node('a', 'number', { value: 1, low: 0 })], edges: [] }, false)).toThrow(/unexpected/i);
  });
});
