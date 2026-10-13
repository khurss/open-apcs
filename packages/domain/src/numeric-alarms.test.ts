import { describe, expect, it } from 'vitest';
import { AlarmEngine, validateAlarmDefinition, type AlarmDefinition } from './alarms.js';
import type { SignalSnapshot } from './signals.js';
const sample = (value: SignalSnapshot['value'], quality: SignalSnapshot['quality'] = 'Good'): SignalSnapshot => ({ value, quality, bootId: 'boot', sequence: 1, receivedTime: null, sourceTime: null });
const definition = (direction: 'high' | 'low' = 'high', deadband = 2): AlarmDefinition => ({ condition: { kind: 'threshold', direction, threshold: 10, deadband }, activationDelayMs: 0, returnDelayMs: 0 });
function bench(rule = definition()) { let now = 0; const clock = { monotonicNow: () => now, wallNow: () => new Date(1700000000000 + now) }; return { rule, clock, engine: new AlarmEngine(rule, clock), advance: (ms: number) => { now += ms; } }; }
describe('numeric threshold alarms', () => {
  it('trips high at the threshold and clears strictly below its deadband boundary', () => {
    const { engine } = bench(); engine.update(sample(9)); expect(engine.phase).toBe('Normal');
    engine.update(sample(10)); expect(engine.phase).toBe('ActiveUnacknowledged');
    for (const value of [9, 8]) { engine.update(sample(value)); expect(engine.snapshot.active).toBe(true); }
    engine.update(sample(7.9)); expect(engine.phase).toBe('ReturnedUnacknowledged');
    engine.acknowledge(1, 'operator', 'Inspected temperature'); expect(engine.phase).toBe('Normal');
  });
  it('trips low at the threshold and clears strictly above its deadband boundary', () => {
    const { engine } = bench(definition('low')); engine.update(sample(11)); expect(engine.phase).toBe('Normal');
    engine.update(sample(10)); expect(engine.snapshot.active).toBe(true);
    for (const value of [11, 12]) { engine.update(sample(value)); expect(engine.snapshot.active).toBe(true); }
    engine.update(sample(12.1)); expect(engine.phase).toBe('ReturnedUnacknowledged');
  });
  it.each(['high', 'low'] as const)('does not chatter at exact equality with zero deadband for %s', (direction) => {
    const { engine } = bench(definition(direction, 0)); for (let i = 0; i < 20; i++) engine.update(sample(10));
    expect(engine.snapshot).toMatchObject({ active: true, occurrence: 1 });
    expect(engine.drainEvents().filter((event) => event.kind === 'Activated')).toHaveLength(1);
  });
  it('requires the trip threshold continuously during activation delay', () => {
    const { engine, advance } = bench({ ...definition(), activationDelayMs: 1000 });
    engine.update(sample(12)); advance(999); engine.update(sample(9)); advance(1); engine.update(sample(12)); expect(engine.snapshot.active).toBe(false);
    advance(999); engine.update(sample(12)); expect(engine.snapshot.active).toBe(false);
    advance(1); engine.update(sample(12)); expect(engine.snapshot.active).toBe(true);
  });
  it('requires a continuous return beyond the deadband for the return delay', () => {
    const { engine, advance } = bench({ ...definition(), returnDelayMs: 1000 }); engine.update(sample(12));
    engine.update(sample(7)); advance(999); engine.update(sample(9)); advance(1); engine.update(sample(7)); expect(engine.snapshot.active).toBe(true);
    advance(1000); engine.update(sample(7)); expect(engine.snapshot.active).toBe(false);
  });
  it('retains an active alarm on invalid numeric data without coercion and recovers within its band', () => {
    const { engine } = bench(); engine.update(sample(12));
    for (const value of [NaN, Infinity, '7', true, null]) { engine.update(sample(value)); expect(engine.snapshot).toMatchObject({ active: true, available: false }); }
    engine.update(sample(7, 'Stale')); expect(engine.snapshot).toMatchObject({ active: true, available: false });
    engine.update(sample(9)); expect(engine.snapshot).toMatchObject({ active: true, available: true });
    engine.update(sample(7)); expect(engine.snapshot.active).toBe(false);
  });
  it('resets a pending trip after unavailable input and preserves acknowledged active state across restart', () => {
    const { engine, clock, rule, advance } = bench({ ...definition(), activationDelayMs: 1000 });
    engine.update(sample(12)); advance(999); engine.update(sample(null, 'Disconnected')); advance(1000); engine.update(sample(12)); expect(engine.snapshot.active).toBe(false);
    advance(1000); engine.update(sample(12)); engine.acknowledge(1, 'operator', 'Inspected high reading');
    const restored = new AlarmEngine(rule, clock, engine.snapshot); restored.update(sample(9)); expect(restored.phase).toBe('ActiveAcknowledged');
    restored.update(sample(7)); expect(restored.phase).toBe('Normal');
  });
  it('validates numeric limits, direction, finite reset boundaries and unrelated fields', () => {
    expect(validateAlarmDefinition(definition())).toEqual(definition());
    for (const fields of [{ threshold: NaN }, { threshold: Infinity }, { threshold: '10' }, { deadband: -1 }, { deadband: Infinity }, { direction: 'above' }, { direction: 'low', threshold: Number.MAX_VALUE, deadband: Number.MAX_VALUE }, { value: true }, { values: ['Bad'] }]) {
      expect(() => validateAlarmDefinition({ ...definition(), condition: { ...definition().condition, ...fields } })).toThrow();
    }
    expect(() => validateAlarmDefinition({ ...definition(), condition: { kind: 'boolean', value: true, threshold: 10 } })).toThrow();
    expect(() => validateAlarmDefinition({ ...definition(), condition: { kind: 'quality', values: ['Bad'], deadband: 0 } })).toThrow();
  });
});
