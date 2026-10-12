import { describe, expect, it } from 'vitest';
import { LogicEngine, validateGraph, type BlockKind, type LogicGraph, type LogicNode, type LogicValue } from './logic.js';
const good = (value: boolean): LogicValue => ({ value, quality: 'Good', reason: null });
const bad: LogicValue = { value: null, quality: 'Bad', reason: 'Disconnected' };
const node = (id: string, kind: BlockKind, extra: Partial<LogicNode> = {}): LogicNode => ({ id, kind, label: id, x: 0, y: 0, ...extra });
function unary(kind: BlockKind, delayMs = 100): LogicGraph {
  return { schemaVersion: 1, nodes: [node('out', 'output', { signalId: 'led' }), node('fn', kind, ['ton','tof','pulse','debounce'].includes(kind) ? { delayMs } : {}), node('src', 'input', { signalId: 'switch' })],
    edges: [{ id: 'a', source: 'src', target: 'fn', port: 'in' }, { id: 'b', source: 'fn', target: 'out', port: 'in' }] };
}
const sample = (engine: LogicEngine, time: number, value: boolean) => engine.tick(time, { switch: good(value) }).outputs.led;
describe('validated deterministic boolean logic', () => {
  it('orders dependencies independently of node and edge array order', () => { const engine = new LogicEngine(unary('not')); expect(sample(engine, 0, true)).toEqual(good(false)); expect(sample(engine, 1, false)).toEqual(good(true)); });
  it('does not mutate or retain a caller-owned graph', () => { const graph = unary('not'); const before = structuredClone(graph); const engine = new LogicEngine(graph); expect(graph).toEqual(before); graph.nodes[1]!.kind = 'ton'; expect(sample(engine, 0, true)).toEqual(good(false)); });
  it('rejects unknown fields, kinds, versions, invalid numbers, and oversized graphs', () => {
    const graph = unary('not');
    for (const invalid of [null, { ...graph, schemaVersion: 2 }, { ...graph, script: 'unsafe' }, { ...graph, nodes: [{ ...graph.nodes[0], x: NaN }] }, { ...graph, nodes: [node('a', 'unknown' as BlockKind)] }, { ...graph, nodes: Array.from({ length: 257 }, (_, i) => node(`n${i}`, 'constant', { value: false })) }]) expect(() => validateGraph(invalid)).toThrow();
  });
  it('rejects duplicate identities, missing references, duplicate ports, and cycles', () => {
    const graph = unary('not');
    const variants = [
      { ...graph, nodes: [...graph.nodes, graph.nodes[0]!] },
      { ...graph, edges: [...graph.edges, { id: 'x', source: 'missing', target: 'fn', port: 'in' }] },
      { ...graph, edges: [...graph.edges, { id: 'x', source: 'out', target: 'fn', port: 'in' }] },
      { schemaVersion: 1, nodes: [node('a', 'not'), node('b', 'not')], edges: [{ id: 'a', source: 'a', target: 'b', port: 'in' }, { id: 'b', source: 'b', target: 'a', port: 'in' }] },
    ];
    for (const invalid of variants) expect(() => validateGraph(invalid)).toThrow();
  });
  it('allows incomplete drafts but refuses to execute them', () => { const graph = unary('not'); graph.edges = []; expect(validateGraph(graph, false)).toEqual(graph); expect(() => new LogicEngine(graph)).toThrow(/port/i); });
  it('requires signal bindings, boolean constants, and bounded integer delays', () => {
    for (const n of [node('x', 'input'), node('x', 'output'), node('x', 'constant'), node('x', 'ton', { delayMs: -1 }), node('x', 'ton', { delayMs: 1.5 }), node('x', 'ton', { delayMs: 86400001 })]) expect(() => validateGraph({ schemaVersion: 1, nodes: [n], edges: [] }, false)).toThrow();
  });
  it('prevents multiple writers and output blocks as sources', () => {
    const graph = unary('not'); graph.nodes.push(node('second', 'output', { signalId: 'led' })); expect(() => validateGraph(graph, false)).toThrow(/writer/i);
    const other = unary('not'); other.edges[0]!.source = 'out'; expect(() => validateGraph(other, false)).toThrow(/output/i);
  });
  it('propagates missing or bad input quality without manufacturing a false reading', () => { const engine = new LogicEngine(unary('not')); expect(engine.tick(0).outputs.led).toMatchObject({ value: null, quality: 'Bad' }); expect(engine.tick(1, { switch: bad }).outputs.led).toMatchObject({ value: null, quality: 'Bad' }); });
  it('rejects bad clocks before updating state', () => { const engine = new LogicEngine(unary('ton')); sample(engine, 100, true); for (const time of [-1, 99, NaN, Infinity]) expect(() => sample(engine, time, true)).toThrow(/time/i); expect(sample(engine, 200, true)).toEqual(good(true)); });
  it('uses safe maps for user-defined identifiers', () => { const graph = unary('not'); graph.nodes[0]!.signalId = '__proto__'; const result = new LogicEngine(graph).tick(0, { switch: good(true) }); expect(Object.hasOwn(result.outputs, '__proto__')).toBe(true); expect(result.outputs['__proto__']).toEqual(good(false)); });
  it.each(['and', 'or', 'xor'] as const)('evaluates the %s truth table', (kind) => {
    const graph: LogicGraph = { schemaVersion: 1, nodes: [node('a', 'input', { signalId: 'a' }), node('b', 'input', { signalId: 'b' }), node('fn', kind)], edges: [{ id: 'a', source: 'a', target: 'fn', port: 'a' }, { id: 'b', source: 'b', target: 'fn', port: 'b' }] };
    const engine = new LogicEngine(graph);
    for (const a of [false, true]) for (const b of [false, true]) expect(engine.tick(0, { a: good(a), b: good(b) }).nodes.fn).toEqual(good(kind === 'and' ? a && b : kind === 'or' ? a || b : a !== b));
    expect(engine.tick(1, { a: good(false), b: bad }).nodes.fn?.quality).toBe('Bad');
  });
  it('TON starts on a valid rising input and resets on false or bad quality', () => { const engine = new LogicEngine(unary('ton')); expect(sample(engine, 0, true)).toEqual(good(false)); expect(sample(engine, 99, true)).toEqual(good(false)); expect(sample(engine, 100, true)).toEqual(good(true)); expect(sample(engine, 101, false)).toEqual(good(false)); sample(engine, 102, true); engine.tick(150, { switch: bad }); expect(sample(engine, 1000, true)).toEqual(good(false)); });
  it('TOF begins OFF, holds after falling input, and cancels on a rising input', () => { const engine = new LogicEngine(unary('tof')); expect(sample(engine, 0, false)).toEqual(good(false)); expect(sample(engine, 1, true)).toEqual(good(true)); expect(sample(engine, 2, false)).toEqual(good(true)); expect(sample(engine, 101, false)).toEqual(good(true)); expect(sample(engine, 102, false)).toEqual(good(false)); sample(engine, 103, true); sample(engine, 104, false); expect(sample(engine, 150, true)).toEqual(good(true)); expect(sample(engine, 1000, true)).toEqual(good(true)); });
  it('pulse is non-retriggerable while active and needs a new rising edge', () => { const engine = new LogicEngine(unary('pulse')); expect(sample(engine, 0, true)).toEqual(good(true)); sample(engine, 10, false); expect(sample(engine, 20, true)).toEqual(good(true)); expect(sample(engine, 100, true)).toEqual(good(false)); sample(engine, 101, false); expect(sample(engine, 102, true)).toEqual(good(true)); });
  it('debounce requires a stable value in either direction', () => { const engine = new LogicEngine(unary('debounce')); expect(sample(engine, 0, true)).toEqual(good(false)); sample(engine, 50, false); sample(engine, 60, true); expect(sample(engine, 159, true)).toEqual(good(false)); expect(sample(engine, 160, true)).toEqual(good(true)); expect(sample(engine, 161, false)).toEqual(good(true)); expect(sample(engine, 261, false)).toEqual(good(false)); });
  it('reset dominates a latched set and bad inputs clear volatile state', () => {
    const graph: LogicGraph = { schemaVersion: 1, nodes: [node('s', 'input', { signalId: 's' }), node('r', 'input', { signalId: 'r' }), node('l', 'latch')], edges: [{ id: 's', source: 's', target: 'l', port: 'set' }, { id: 'r', source: 'r', target: 'l', port: 'reset' }] };
    const engine = new LogicEngine(graph); const tick = (time: number, s: LogicValue, r: LogicValue) => engine.tick(time, { s, r }).nodes.l;
    expect(tick(0, good(true), good(false))).toEqual(good(true)); expect(tick(1, good(false), good(false))).toEqual(good(true)); expect(tick(2, good(true), good(true))).toEqual(good(false)); tick(3, good(true), good(false)); tick(4, bad, good(false)); expect(tick(5, good(false), good(false))).toEqual(good(false));
  });
  it('manual selection never bypasses an interlock', () => {
    const sources = ['auto', 'manual', 'isAuto', 'permit']; const graph: LogicGraph = { schemaVersion: 1, nodes: [...sources.map((id) => node(id, 'input', { signalId: id })), node('mode', 'mode')], edges: sources.map((id) => ({ id, source: id, target: 'mode', port: id })) };
    const engine = new LogicEngine(graph);
    expect(engine.tick(0, { auto: good(false), manual: good(true), isAuto: good(false), permit: good(true) }).nodes.mode).toEqual(good(true));
    expect(engine.tick(1, { auto: good(false), manual: good(true), isAuto: good(false), permit: good(false) }).nodes.mode).toMatchObject({ value: null, quality: 'Bad', reason: 'Interlock is not permitted' });
  });
  it('validates input samples at runtime instead of trusting a cast', () => { const engine = new LogicEngine(unary('not')); expect(engine.tick(0, { switch: { value: 1, quality: 'Good', reason: null } as unknown as LogicValue }).outputs.led).toMatchObject({ value: null, quality: 'Bad' }); });
});
