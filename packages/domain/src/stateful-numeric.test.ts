import { describe, expect, it } from 'vitest';
import { LogicEngine, validateGraph, type LogicGraph, type LogicNode, type LogicValue } from './logic.js';
const good = (value: boolean | number): LogicValue => ({ value, quality: 'Good', reason: null });
const node = (id: string, kind: LogicNode['kind'], extra: Partial<LogicNode> = {}): LogicNode => ({ id, kind, label: id, x: 0, y: 0, ...extra });
const filter = (timeConstantMs = 1000): LogicGraph => ({ schemaVersion: 1, nodes: [node('sensor', 'analog', { signalId: 'sensor' }), node('filter', 'filter', { timeConstantMs })], edges: [{ id: 'wire', source: 'sensor', target: 'filter', port: 'in' }] });
const counter = (maxCount = 3): LogicGraph => ({ schemaVersion: 1, nodes: [node('pulse', 'input', { signalId: 'pulse' }), node('reset', 'input', { signalId: 'reset' }), node('count', 'counter', { maxCount })], edges: [{ id: 'p', source: 'pulse', target: 'count', port: 'in' }, { id: 'r', source: 'reset', target: 'count', port: 'reset' }] });
describe('time-aware numeric filtering', () => {
  it('initializes from the first valid sample and follows actual elapsed time', () => {
    const engine = new LogicEngine(filter());
    expect(engine.tick(5000, { sensor: good(10) }).nodes.filter).toEqual(good(10));
    expect(engine.tick(5500, { sensor: good(20) }).nodes.filter!.value).toBeCloseTo(20 - 10 * Math.exp(-0.5), 12);
    expect(engine.tick(6000, { sensor: good(20) }).nodes.filter!.value).toBeCloseTo(20 - 10 * Math.exp(-1), 12);
    expect(engine.tick(6000, { sensor: good(100) }).nodes.filter!.value).toBeCloseTo(20 - 10 * Math.exp(-1), 12);
  });
  it('resets on unavailable data and on a new engine instead of retaining an old process state', () => {
    const engine = new LogicEngine(filter()); engine.tick(0, { sensor: good(50) });
    expect(engine.tick(1000).nodes.filter!.quality).toBe('Bad');
    expect(engine.tick(2000, { sensor: good(10) }).nodes.filter).toEqual(good(10));
    expect(new LogicEngine(filter()).tick(2000, { sensor: good(5) }).nodes.filter).toEqual(good(5));
  });
  it('remains finite for extreme opposite-sign inputs and settles across a long time gap', () => {
    const engine = new LogicEngine(filter()); engine.tick(0, { sensor: good(Number.MAX_VALUE) });
    const middle = engine.tick(1000, { sensor: good(-Number.MAX_VALUE) }).nodes.filter!;
    expect(middle.quality).toBe('Good'); expect(Number.isFinite(middle.value)).toBe(true);
    expect(engine.tick(1000000, { sensor: good(12) }).nodes.filter).toEqual(good(12));
  });
});
describe('bounded rising-edge counter', () => {
  it('counts observed false-to-true edges without inventing an initial edge or counting held input', () => {
    const engine = new LogicEngine(counter()); let now = 0;
    const tick = (pulse: boolean, reset = false) => engine.tick(now++, { pulse: good(pulse), reset: good(reset) }).nodes.count!;
    expect(tick(true)).toEqual(good(0)); expect(tick(true)).toEqual(good(0));
    expect(tick(false)).toEqual(good(0)); expect(tick(true)).toEqual(good(1)); expect(tick(true)).toEqual(good(1));
    expect(tick(false)).toEqual(good(1)); expect(tick(true)).toEqual(good(2));
  });
  it('gives reset priority and does not count a high input when reset is released', () => {
    const engine = new LogicEngine(counter()); let now = 0;
    const tick = (pulse: boolean, reset = false) => engine.tick(now++, { pulse: good(pulse), reset: good(reset) }).nodes.count!;
    tick(false); tick(true); expect(tick(true, true)).toEqual(good(0));
    expect(tick(true)).toEqual(good(0)); tick(false); expect(tick(true)).toEqual(good(1));
  });
  it('saturates at the configured limit and resumes after explicit reset', () => {
    const engine = new LogicEngine(counter(2)); let now = 0;
    const tick = (pulse: boolean, reset = false) => engine.tick(now++, { pulse: good(pulse), reset: good(reset) }).nodes.count!;
    tick(false); for (let i = 0; i < 5; i++) { tick(true); tick(false); }
    expect(tick(true)).toEqual(good(2)); expect(tick(false, true)).toEqual(good(0)); expect(tick(true)).toEqual(good(1));
  });
  it('invalidates and resets on a missing input without inventing a recovery edge', () => {
    const engine = new LogicEngine(counter()); engine.tick(0, { pulse: good(false), reset: good(false) }); engine.tick(1, { pulse: good(true), reset: good(false) });
    expect(engine.tick(2, { pulse: good(false) }).nodes.count!.quality).toBe('Bad');
    expect(engine.tick(3, { pulse: good(true), reset: good(false) }).nodes.count).toEqual(good(0));
  });
});
it('validates stateful numeric parameters and port types', () => {
  expect(validateGraph(filter())).toEqual(filter()); expect(validateGraph(counter())).toEqual(counter());
  for (const value of [0, -1, 1.5, Infinity, NaN, '1000', 86400001]) expect(() => validateGraph(filter(value as number))).toThrow();
  for (const value of [0, -1, 1.5, Infinity, NaN, '3', Number.MAX_SAFE_INTEGER + 1]) expect(() => validateGraph(counter(value as number))).toThrow();
  const wrong = counter(); wrong.nodes[0] = node('pulse', 'number', { value: 1 }); expect(() => validateGraph(wrong)).toThrow(/type/i);
  const extra = filter(); extra.nodes[0]!.maxCount = 1; expect(() => validateGraph(extra)).toThrow();
});
