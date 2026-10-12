import { describe, expect, it } from 'vitest';
import { AlarmEngine, type AlarmDefinition } from './alarms.js';
import type { SignalSnapshot } from './signals.js';
const sample = (value: boolean | null, quality: SignalSnapshot['quality'] = 'Good'): SignalSnapshot => ({ value, quality, bootId: 'boot', sequence: 1, receivedTime: null, sourceTime: null });
function bench(override: Partial<AlarmDefinition> = {}) {
  let now = 0; let wall = Date.parse('2026-10-12T12:00:00Z');
  const clock = { monotonicNow: () => now, wallNow: () => new Date(wall) };
  const definition: AlarmDefinition = { condition: { kind: 'boolean', value: true }, activationDelayMs: 0, returnDelayMs: 0, ...override };
  return { engine: new AlarmEngine(definition, clock), definition, clock, advance: (ms: number) => { now += ms; wall += ms; }, shiftWall: (ms: number) => { wall += ms; } };
}
describe('alarm lifecycle and timing', () => {
  it('retains a returned unacknowledged occurrence until an explicit acknowledgement', () => {
    const { engine } = bench(); engine.update(sample(false)); expect(engine.phase).toBe('Normal');
    engine.update(sample(true)); expect(engine.phase).toBe('ActiveUnacknowledged'); expect(engine.notificationDue).toBe(true);
    engine.update(sample(false)); expect(engine.phase).toBe('ReturnedUnacknowledged');
    engine.acknowledge(1, 'operator', 'Inspected the return'); expect(engine.phase).toBe('Normal');
    expect(engine.drainEvents().map((event) => event.kind)).toEqual(['Available', 'Activated', 'Returned', 'Acknowledged']);
  });
  it('acknowledgement never clears the cause and a new occurrence needs a new acknowledgement', () => {
    const { engine } = bench(); engine.update(sample(true)); engine.acknowledge(1, 'operator', 'Investigating');
    expect(engine.phase).toBe('ActiveAcknowledged'); expect(engine.snapshot.active).toBe(true); expect(engine.notificationDue).toBe(false);
    engine.update(sample(false)); engine.update(sample(true)); expect(engine.snapshot.occurrence).toBe(2); expect(engine.phase).toBe('ActiveUnacknowledged');
    expect(() => engine.acknowledge(1, 'operator', 'Stale page')).toThrow(/occurrence/i);
  });
  it('keeps a returned incident open when the condition reactivates before acknowledgement', () => {
    const { engine } = bench(); engine.update(sample(true)); engine.update(sample(false)); engine.update(sample(true));
    expect(engine.snapshot.occurrence).toBe(1); expect(engine.phase).toBe('ActiveUnacknowledged');
    expect(engine.drainEvents().map((event) => event.kind)).toContain('Reactivated');
  });
  it('does not clear an active boolean alarm or convert missing data into false', () => {
    const { engine } = bench(); engine.update(sample(true)); engine.update(sample(null, 'Disconnected'));
    expect(engine.snapshot).toMatchObject({ active: true, available: false });
    engine.update(sample(null, 'Disconnected')); expect(engine.drainEvents().filter((event) => event.kind === 'Unavailable')).toHaveLength(1);
  });
  it('evaluates connection-quality alarms independently of the signal value', () => {
    const { engine } = bench({ condition: { kind: 'quality', values: ['Disconnected', 'Stale'] } });
    engine.update(sample(null, 'Disconnected')); expect(engine.snapshot).toMatchObject({ active: true, available: true });
    engine.update(sample(null, 'Good')); expect(engine.phase).toBe('ReturnedUnacknowledged');
  });
  it('requires the condition to remain stable for the activation delay and resets on unavailable input', () => {
    const { engine, advance } = bench({ activationDelayMs: 1000 });
    engine.update(sample(true)); advance(999); engine.update(sample(true)); expect(engine.snapshot.active).toBe(false);
    engine.update(sample(null, 'Stale')); advance(2000); engine.update(sample(true)); expect(engine.snapshot.active).toBe(false);
    advance(1000); engine.update(sample(true)); expect(engine.snapshot.active).toBe(true);
  });
  it('resets a pending activation when the condition returns before its delay', () => {
    const { engine, advance } = bench({ activationDelayMs: 1000 }); engine.update(sample(true)); advance(900); engine.update(sample(false)); advance(900); engine.update(sample(true));
    expect(engine.snapshot.active).toBe(false); advance(1000); engine.update(sample(true)); expect(engine.snapshot.active).toBe(true);
  });
  it('applies return delay without an acknowledgement resetting its timer', () => {
    const { engine, advance } = bench({ returnDelayMs: 1000 }); engine.update(sample(true)); engine.update(sample(false)); advance(999);
    engine.acknowledge(1, 'operator', 'Cause cleared'); engine.update(sample(false)); expect(engine.snapshot.active).toBe(true);
    advance(1); engine.update(sample(false)); expect(engine.phase).toBe('Normal');
  });
  it('records suppression without discarding lifecycle events and expires it on monotonic time', () => {
    const { engine, advance, shiftWall } = bench(); engine.update(sample(true)); engine.suppress(1000, 'operator', 'Bench maintenance');
    expect(engine.notificationDue).toBe(false); shiftWall(-86400000); advance(999); engine.update(sample(true)); expect(engine.notificationDue).toBe(false);
    advance(1); engine.update(sample(true)); expect(engine.notificationDue).toBe(true);
    expect(engine.drainEvents().map((event) => event.kind)).toEqual(['Available', 'Activated', 'Suppressed', 'Unsuppressed']);
  });
  it('supports explicit unsuppression and idempotent repeated acknowledgement', () => {
    const { engine } = bench(); engine.update(sample(true)); engine.suppress(1000, 'operator', 'Maintenance'); engine.unsuppress('operator', 'Maintenance finished');
    expect(engine.notificationDue).toBe(true); engine.acknowledge(1, 'operator', 'Inspected'); engine.acknowledge(1, 'operator', 'Inspected again');
    expect(engine.drainEvents().filter((event) => event.kind === 'Acknowledged')).toHaveLength(1);
  });
  it('restores the occurrence and acknowledgement but clears suppression after restart with an event', () => {
    const { engine, definition, clock } = bench(); engine.update(sample(true)); engine.acknowledge(1, 'operator', 'Inspected'); engine.suppress(1000, 'operator', 'Maintenance');
    const restored = new AlarmEngine(definition, clock, engine.snapshot);
    expect(restored.snapshot).toMatchObject({ active: true, acknowledged: true, occurrence: 1, available: false, suppressedUntil: null });
    expect(restored.drainEvents().map((event) => event.kind)).toContain('Unsuppressed');
  });
  it('resets volatile pending timers after restart', () => {
    const { engine, definition, clock, advance } = bench({ activationDelayMs: 1000 }); engine.update(sample(true)); advance(999);
    const restored = new AlarmEngine(definition, clock, engine.snapshot); restored.update(sample(true)); advance(1); restored.update(sample(true)); expect(restored.snapshot.active).toBe(false);
  });
  it('rejects reverse monotonic time without inventing a new transition', () => {
    const { engine, advance } = bench(); engine.update(sample(true)); advance(-1); expect(() => engine.update(sample(false))).toThrow(/time/i); expect(engine.snapshot.active).toBe(true);
  });
  it('requires an occurrence, actor, comment, and bounded suppression duration', () => {
    const { engine } = bench(); expect(() => engine.acknowledge(0, 'operator', 'Nothing active')).toThrow(); engine.update(sample(true));
    expect(() => engine.acknowledge(1, '', 'Reason')).toThrow(); expect(() => engine.acknowledge(1, 'operator', ' ')).toThrow();
    for (const duration of [0, 999, 86400001, NaN]) expect(() => engine.suppress(duration, 'operator', 'Maintenance')).toThrow();
  });
  it('validates definitions and copies state before exposing it', () => {
    for (const delay of [-1, 1.5, 86400001, NaN]) expect(() => bench({ activationDelayMs: delay })).toThrow();
    expect(() => bench({ condition: { kind: 'quality', values: [] } })).toThrow();
    const { engine } = bench(); const state = engine.snapshot; state.active = true; expect(engine.snapshot.active).toBe(false);
  });
});
