import { describe, expect, it } from 'vitest';
import { aggregateHistory } from './history-aggregate.js';
import type { ArchivedSample } from './history.js';
import type { SignalSnapshot } from './signals.js';
const base = Date.parse('2026-10-12T12:00:00Z');
const at = (seconds: number) => new Date(base + seconds * 1000).toISOString();
const row = (id: number, seconds: number, value: SignalSnapshot['value'], quality: SignalSnapshot['quality'] = 'Good', bootId = 'boot'): ArchivedSample => ({ id: String(id), observedAt: at(seconds), snapshot: { value, quality, bootId, sequence: id, sourceTime: null, receivedTime: at(seconds) } });
const options = { from: at(0), to: at(60), profile: 'analog' as const };
describe('quality-aware time-weighted history aggregates', () => {
  it('uses held durations rather than sample averages, including the preceding value', () => {
    const result = aggregateHistory([row(1, -10, 10), row(2, 10, 20), row(3, 40, 40), row(4, 60, 999)], options);
    expect(result).toMatchObject({ sampleCount: 2, validSampleCount: 2, min: 10, max: 40, mean: 25, qualityMs: { Good: 60000, Bad: 0, Stale: 0, Disconnected: 0, Unknown: 0 } });
    expect(result.first).toMatchObject({ value: 20, at: at(10) }); expect(result.last).toMatchObject({ value: 40, at: at(40) });
  });
  it('keeps invalid quality, session changes, long gaps and uncovered tails out of averages', () => {
    const result = aggregateHistory([row(1, 0, 10), row(2, 10, 999, 'Bad'), row(3, 20, 20), row(4, 30, 30, 'Good', 'reboot'), row(5, 40, 40, 'Good', 'reboot')], options);
    expect(result.qualityMs).toEqual({ Good: 20000, Bad: 10000, Stale: 0, Disconnected: 0, Unknown: 30000 }); expect(result.mean).toBe(20);
    const gap = aggregateHistory([row(1, -200, 100), row(2, 30, 20), row(3, 60, 20)], options);
    expect(gap.qualityMs.Unknown).toBe(30000); expect(gap.mean).toBe(20);
    expect(aggregateHistory([], options)).toMatchObject({ mean: null, min: null, max: null, first: null, last: null, qualityMs: { Unknown: 60000 } });
  });
  it('accounts for ON/OFF duration and counts only continuous observed transitions', () => {
    const result = aggregateHistory([row(1, -10, false), row(2, 10, true), row(3, 30, false), row(4, 40, true, 'Good', 'reboot'), row(5, 60, false, 'Good', 'reboot')], { ...options, profile: 'digital' });
    expect(result).toMatchObject({ trueMs: 40000, falseMs: 10000, transitions: 2, qualityMs: { Good: 50000, Unknown: 10000 } });
    expect(result.mean).toBeNull();
  });
  it('preserves exact counter increments, attributes deltas to the newer sample and accounts for zero resets', () => {
    const rows = [row(1, -1, '18446744073709551600'), row(2, 10, '18446744073709551610'), row(3, 20, '4'), row(4, 30, '9'), row(5, 40, '19', 'Bad'), row(6, 50, '30'), row(7, 60, '40')];
    const result = aggregateHistory(rows, { ...options, profile: 'counter64' });
    expect(result).toMatchObject({ counterDelta: '19', resets: 1, min: '4', max: '18446744073709551610', mean: null });
    expect(result.last!.value).toBe('30');
  });
  it('preserves exact non-numeric values and handles tied timestamps deterministically without mutation', () => {
    const rows = [row(3, 10, '9007199254740993'), row(1, 0, '9007199254740992'), row(2, 10, '9007199254740994'), row(4, 60, '0')]; const original = structuredClone(rows);
    const result = aggregateHistory(rows, { ...options, profile: 'exact' });
    expect(result).toMatchObject({ sampleCount: 3, mean: null, min: null, max: null, counterDelta: null, qualityMs: { Good: 60000 } }); expect(result.last!.value).toBe('9007199254740993'); expect(rows).toEqual(original);
  });
  it('does not overflow a valid weighted mean and treats mismatched Good values as unknown coverage', () => {
    const result = aggregateHistory([row(1, 0, 1e308), row(2, 30, -1e308), row(3, 60, 0)], options); expect(result.mean).toBe(0);
    expect(aggregateHistory([row(1, 0, 'wrong'), row(2, 30, 20), row(3, 60, 20)], options)).toMatchObject({ invalidSamples: 1, validSampleCount: 1, qualityMs: { Unknown: 30000, Good: 30000 } });
  });
  it('orders late arrivals by observation time without mistaking insertion order for a clock epoch', () => {
    const result = aggregateHistory([row(1, 0, false), row(2, 20, true), row(3, 10, false), row(4, 30, true), row(5, 60, true)], { ...options, profile: 'digital' });
    expect(result).toMatchObject({ trueMs: 40000, falseMs: 20000, transitions: 1, qualityMs: { Good: 60000, Unknown: 0 } });
  });
  it('rejects malformed identities, duplicate ordinals and unbounded intervals or batches', () => {
    expect(() => aggregateHistory([row(1, 0, 1), row(1, 1, 2)], options)).toThrow(/identity/i);
    expect(() => aggregateHistory([{ ...row(1, 0, 1), id: '1e3' }], options)).toThrow(/identity/i);
    expect(() => aggregateHistory([], { ...options, to: at(3601) })).toThrow(/interval/i);
    expect(() => aggregateHistory([], { ...options, to: at(0) })).toThrow(/interval/i);
    expect(() => aggregateHistory(Array.from({ length: 10003 }, (_, i) => row(i + 1, i, 1)), options)).toThrow(/samples/i);
  });
});
