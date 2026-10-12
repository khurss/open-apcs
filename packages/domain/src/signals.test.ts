import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { SignalStore, type SignalDefinition, type SignalSample } from './signals.js';

const definition: SignalDefinition = {
  id: 'temperature', deviceId: 'esp32-demo', dataType: 'float64', freshnessMs: 3_000,
};

function fixture(overrides: Partial<SignalDefinition> = {}) {
  let monotonic = 0;
  let wall = Date.parse('2026-10-12T12:00:00Z');
  const store = new SignalStore({
    wallNow: () => new Date(wall),
    monotonicNow: () => monotonic,
  });
  store.register({ ...definition, ...overrides });
  store.beginSession('esp32-demo', 'boot-1');
  return {
    store,
    advance: (ms: number) => { monotonic += ms; wall += ms; },
    shiftWall: (ms: number) => { wall += ms; },
  };
}

function sample(overrides: Partial<SignalSample> = {}): SignalSample {
  return {
    signalId: 'temperature', value: 21.5, bootId: 'boot-1', sequence: 1,
    sourceTime: null, quality: 'Good', ...overrides,
  };
}

describe('AT-02: signal quality, chronology and exact values', () => {
  it('does not invent zero before the first sample', () => {
    const { store } = fixture();
    expect(store.get('temperature')).toMatchObject({ value: null, quality: 'Disconnected' });
  });

  it('records receipt time while keeping unknown source time null', () => {
    const { store } = fixture();
    expect(store.ingest(sample())).toBe('accepted');
    expect(store.get('temperature')).toEqual({
      value: 21.5, quality: 'Good', sourceTime: null,
      receivedTime: '2026-10-12T12:00:00.000Z', bootId: 'boot-1', sequence: 1,
    });
  });

  it('marks a value stale at the freshness deadline and retains its last value', () => {
    const { store, advance } = fixture();
    store.ingest(sample());
    advance(2_999);
    expect(store.get('temperature').quality).toBe('Good');
    advance(1);
    expect(store.get('temperature')).toMatchObject({ value: 21.5, quality: 'Stale' });
  });

  it('uses monotonic time when the wall clock jumps backwards', () => {
    const { store, advance, shiftWall } = fixture();
    store.ingest(sample());
    shiftWall(-3_600_000);
    advance(3_000);
    expect(store.get('temperature').quality).toBe('Stale');
  });

  it('duplicates cannot refresh a stale sample', () => {
    const { store, advance } = fixture();
    store.ingest(sample());
    advance(3_000);
    expect(store.ingest(sample())).toBe('duplicate');
    expect(store.get('temperature').quality).toBe('Stale');
  });

  it('rejects an older sequence without changing the current value', () => {
    const { store } = fixture();
    store.ingest(sample({ sequence: 10, value: 30 }));
    expect(store.ingest(sample({ sequence: 9, value: 2 }))).toBe('out-of-order');
    expect(store.get('temperature').value).toBe(30);
  });

  it('new device sessions invalidate the previous value and permit sequence reset', () => {
    const { store } = fixture();
    store.ingest(sample({ sequence: 500 }));
    store.beginSession('esp32-demo', 'boot-2');
    expect(store.get('temperature').quality).toBe('Disconnected');
    expect(store.ingest(sample({ bootId: 'boot-2', sequence: 0, value: 10 }))).toBe('accepted');
    expect(store.get('temperature').value).toBe(10);
  });

  it('late messages from an old boot cannot restore the old session', () => {
    const { store } = fixture();
    store.beginSession('esp32-demo', 'boot-2');
    store.ingest(sample({ bootId: 'boot-2', sequence: 0, value: 10 }));
    expect(store.ingest(sample({ bootId: 'boot-1', sequence: 999 }))).toBe('stale-session');
    expect(store.get('temperature').value).toBe(10);
  });

  it.each([Number.NaN, Infinity, -Infinity, '21.5', true])('rejects invalid float64 value %s', (value) => {
    const { store } = fixture();
    expect(() => store.ingest(sample({ value }))).toThrow(/value|type|finite/i);
    expect(store.get('temperature').value).toBeNull();
  });

  it('preserves int64 values as exact decimal strings', () => {
    const { store } = fixture({ dataType: 'int64' });
    store.ingest(sample({ value: '9223372036854775807' }));
    expect(store.get('temperature').value).toBe('9223372036854775807');
    expect(() => store.ingest(sample({ sequence: 2, value: '9223372036854775808' }))).toThrow(/range|int64/i);
  });

  it('rejects negative uint64 without replacing its previous valid value', () => {
    const { store } = fixture({ dataType: 'uint64' });
    store.ingest(sample({ value: '18446744073709551615' }));
    expect(() => store.ingest(sample({ sequence: 2, value: '-1' }))).toThrow(/range|uint64/i);
    expect(store.get('temperature').value).toBe('18446744073709551615');
  });

  it('does not coerce a boolean into a numeric value', () => {
    const { store } = fixture({ dataType: 'boolean' });
    store.ingest(sample({ value: false }));
    expect(store.get('temperature').value).toBe(false);
    expect(() => store.ingest(sample({ sequence: 2, value: 1 }))).toThrow(/value|type|boolean/i);
  });

  it('returned snapshots cannot mutate internal state', () => {
    const { store } = fixture();
    store.ingest(sample());
    const snapshot = store.get('temperature');
    snapshot.value = 999;
    expect(store.get('temperature').value).toBe(21.5);
  });

  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid sequence %s atomically', (sequence) => {
    const { store } = fixture();
    store.ingest(sample());
    expect(() => store.ingest(sample({ sequence, value: 99 }))).toThrow(/sequence/i);
    expect(store.get('temperature')).toMatchObject({ sequence: 1, value: 21.5 });
  });

  it.each([0, -1, NaN, Infinity])('rejects invalid freshness %s', (freshnessMs) => {
    expect(() => fixture({ freshnessMs })).toThrow(/freshness/i);
  });

  it.each([
    { id: '' }, { deviceId: ' ' }, { dataType: 'float32' as 'float64' },
  ])('rejects malformed signal definitions %j', (overrides) => {
    expect(() => fixture(overrides)).toThrow(/definition|type|id/i);
  });

  it('does not register empty or unknown device sessions', () => {
    const { store } = fixture();
    expect(() => store.beginSession('unknown', 'boot-1')).toThrow(/unknown|device/i);
    expect(() => store.beginSession('esp32-demo', '')).toThrow(/boot|session/i);
    expect(store.ingest(sample())).toBe('accepted');
  });

  it('does not allow duplicate registration to erase a signal', () => {
    const { store } = fixture();
    store.ingest(sample());
    expect(() => store.register(definition)).toThrow(/already|duplicate/i);
    expect(store.get('temperature').value).toBe(21.5);
  });

  it('repeated hello for the same boot cannot reset freshness or sequence', () => {
    const { store, advance } = fixture();
    store.ingest(sample());
    advance(3_000);
    store.beginSession('esp32-demo', 'boot-1');
    expect(store.ingest(sample())).toBe('duplicate');
    expect(store.get('temperature').quality).toBe('Stale');
  });

  it('keeps Bad until its deadline, then reports Stale', () => {
    const { store, advance } = fixture();
    store.ingest(sample({ quality: 'Bad' }));
    expect(store.get('temperature').quality).toBe('Bad');
    advance(3_000);
    expect(store.get('temperature').quality).toBe('Stale');
  });

  it('disconnect invalidates only that device and rejects late telemetry', () => {
    const { store } = fixture();
    store.register({ ...definition, id: 'other', deviceId: 'other-device' });
    store.beginSession('other-device', 'boot-1');
    store.ingest(sample());
    store.ingest(sample({ signalId: 'other' }));
    store.disconnect('esp32-demo');
    expect(store.get('temperature')).toMatchObject({ quality: 'Disconnected', value: 21.5 });
    expect(store.get('other').quality).toBe('Good');
    expect(store.ingest(sample({ sequence: 2 }))).toBe('stale-session');
    store.beginSession('esp32-demo', 'boot-1');
    expect(store.get('temperature').quality).toBe('Disconnected');
    expect(store.ingest(sample({ sequence: 2 }))).toBe('accepted');
  });

  it('rejects invalid quality and timestamp from an untyped caller', () => {
    const { store } = fixture();
    expect(() => store.ingest(sample({ quality: 'Good-ish' as 'Good' }))).toThrow(/quality/i);
    expect(() => store.ingest(sample({ sourceTime: 'not a date' }))).toThrow(/time/i);
    expect(store.get('temperature').value).toBeNull();
  });

  it.each(['1.0', '+1', '01', '-0', '1e3', '', ' 1', 1])('rejects noncanonical int64 %s', (value) => {
    const { store } = fixture({ dataType: 'int64' });
    expect(() => store.ingest(sample({ value }))).toThrow(/value|int64/i);
  });

  it('keeps the latest sequence under arbitrary replay order', () => {
    fc.assert(fc.property(
      fc.array(fc.integer({ min: 0, max: 10_000 }), { minLength: 1, maxLength: 100 }),
      (sequences) => {
        const { store } = fixture();
        for (const sequence of sequences) store.ingest(sample({ sequence, value: sequence }));
        expect(store.get('temperature').value).toBe(Math.max(...sequences));
      },
    ), { seed: 42, numRuns: 100 });
  });
});
