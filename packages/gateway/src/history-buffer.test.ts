import { describe, expect, it, vi } from 'vitest';
import { HistoryBuffer, type HistoryRow } from './history-buffer.js';
import type { SignalObservation } from '../../domain/src/signals.js';
const event = (value: boolean, extra: Partial<SignalObservation['snapshot']> = {}): SignalObservation => ({ signalId: 'led', observedAt: '2026-10-12T12:00:00.000Z', snapshot: { value, quality: 'Good', sourceTime: null, receivedTime: '2026-10-12T12:00:00.000Z', bootId: 'boot', sequence: 1, ...extra } });
describe('bounded history buffer', () => {
  it('keeps every digital edge and quality or boot change while suppressing unchanged heartbeats', async () => {
    const buffer = new HistoryBuffer('run', () => 0); const rows: HistoryRow[] = [];
    for (const sample of [event(false), event(false, { sequence: 2 }), event(true), event(false), event(false, { quality: 'Stale' }), event(false, { bootId: 'new' })]) buffer.offer(sample);
    await buffer.flush(async (batch) => { rows.push(...batch); });
    expect(rows.map((row) => [row.snapshot.value, row.snapshot.quality, row.snapshot.bootId])).toEqual([[false, 'Good', 'boot'], [true, 'Good', 'boot'], [false, 'Good', 'boot'], [false, 'Stale', 'boot'], [false, 'Good', 'new']]);
    expect(new Set(rows.map((row) => row.eventId)).size).toBe(5);
  });
  it('records checkpoint samples using monotonic elapsed time', async () => {
    let now = 0; const buffer = new HistoryBuffer('run', () => now); const rows: HistoryRow[] = [];
    buffer.offer(event(false)); now = 59999; buffer.offer(event(false)); now = 60000; buffer.offer(event(false));
    await buffer.flush(async (batch) => { rows.push(...batch); }); expect(rows).toHaveLength(2);
  });
  it('bounds memory and exposes data loss without throwing into acquisition', async () => {
    const buffer = new HistoryBuffer('run', () => 0, 2); buffer.offer(event(false)); buffer.offer(event(true)); buffer.offer(event(false));
    expect(buffer.status).toMatchObject({ queued: 2, dropped: 1 });
    const rows: HistoryRow[] = []; await buffer.flush(async (batch) => { rows.push(...batch); });
    buffer.offer(event(false)); await buffer.flush(async (batch) => { rows.push(...batch); });
    expect(rows.map((row) => row.snapshot.value)).toEqual([false, true, false]); expect(buffer.status.dropped).toBe(1);
  });
  it('retries a failed storage batch with the same event identities', async () => {
    const buffer = new HistoryBuffer('run', () => 0); buffer.offer(event(true)); let failed: HistoryRow[] = [];
    await buffer.flush(async (batch) => { failed = structuredClone(batch); throw new Error('Storage unavailable'); });
    expect(buffer.status).toMatchObject({ queued: 1, failures: 1, error: 'Storage unavailable' });
    await buffer.flush(async (batch) => { expect(batch).toEqual(failed); });
    expect(buffer.status).toMatchObject({ queued: 0, written: 1, error: null });
  });
  it('does not overlap writes or remove observations added while a batch is in flight', async () => {
    const buffer = new HistoryBuffer('run', () => 0); buffer.offer(event(false)); let release!: () => void;
    const write = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const first = buffer.flush(write); const second = buffer.flush(write); await Promise.resolve(); buffer.offer(event(true)); release(); await Promise.all([first, second]);
    expect(write).toHaveBeenCalledTimes(1); expect(buffer.status.queued).toBe(1);
  });
  it('copies observations and isolates a mutating failed writer', async () => {
    const buffer = new HistoryBuffer('run', () => 0); const original = event(true); buffer.offer(original); original.snapshot.value = false;
    await buffer.flush(async (rows) => { rows[0]!.snapshot.value = false; throw new Error('Failed after mutation'); });
    await buffer.flush(async (rows) => { expect(rows[0]!.snapshot.value).toBe(true); });
  });
  it('rejects invalid capacity or checkpoint policy', () => {
    for (const limit of [0, -1, 1.5, 100001]) expect(() => new HistoryBuffer('run', () => 0, limit)).toThrow();
    expect(() => new HistoryBuffer('run', () => 0, 10, 0)).toThrow();
  });
});
