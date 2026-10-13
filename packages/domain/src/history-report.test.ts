import { expect, it } from 'vitest';
import { reportRange, summarizeReport, reportCsv, type ReportBucket } from './history-report.js';
import { aggregateHistory } from './history-aggregate.js';
const hour = 3600000; const base = Date.parse('2026-10-12T00:00:00Z');
function bucket(offset = 0, value: boolean | number = true): ReportBucket {
  const from = base + offset * hour; const iso = (n: number) => new Date(from + n * 60000).toISOString();
  const aggregate = aggregateHistory(Array.from({ length: 61 }, (_, i) => ({ id: String(i + 1), observedAt: iso(i), snapshot: { value, quality: 'Good' as const, bootId: 'report-fixture', sequence: i, receivedTime: iso(i), sourceTime: null } })), { from: iso(0), to: iso(60), profile: typeof value === 'boolean' ? 'digital' : 'analog' });
  return { bucketStart: iso(0), calculatedAt: iso(62), stale: false, aggregate };
}
it('uses exact UTC calendar boundaries including leap months and rejects normalized invalid dates', () => {
  expect(reportRange('day', '2026-10-12')).toEqual({ from: '2026-10-12T00:00:00.000Z', to: '2026-10-13T00:00:00.000Z' });
  expect(reportRange('month', '2024-02')).toEqual({ from: '2024-02-01T00:00:00.000Z', to: '2024-03-01T00:00:00.000Z' });
  for (const [period, date] of [['day', '2026-02-29'], ['month', '2026-13'], ['week', '2026-10-12'], ['day', '2026-10-12T00:00:00Z'], ['day', '1899-01-01']]) expect(() => reportRange(period!, date!)).toThrow();
});
it('accounts for missing hours as unknown and combines digital duration without inventing transitions', () => {
  const report = summarizeReport('day', '2026-10-12', 'digital', [bucket(0, true), bucket(1, false)]);
  expect(report.rows).toHaveLength(24);
  expect(report.summary).toMatchObject({ expectedHours: 24, usedHours: 2, missingHours: 22, pendingHours: 0, sampleCount: 120, trueMs: hour, falseMs: hour, transitions: 0, mean: null, qualityMs: { Good: 2 * hour, Unknown: 22 * hour } });
});
it('excludes stale buckets entirely and preserves a distinction between pending and missing hours', () => {
  const stale = bucket(); stale.stale = true;
  const report = summarizeReport('day', '2026-10-12', 'digital', [stale]);
  expect(report.summary).toMatchObject({ usedHours: 0, missingHours: 23, pendingHours: 1, trueMs: 0, qualityMs: { Good: 0, Unknown: 24 * hour } });
});
it('weights analog means by Good duration, not bucket or sample count, and bounds extremes', () => {
  const short = bucket(0, 10); short.aggregate!.qualityMs.Good = hour / 2; short.aggregate!.qualityMs.Unknown = hour / 2;
  const report = summarizeReport('day', '2026-10-12', 'analog', [short, bucket(1, 30)]);
  expect(report.summary.mean).toBeCloseTo(70 / 3); expect(report.summary.min).toBe(10); expect(report.summary.max).toBe(30);
  expect(report.summary.qualityMs.Unknown).toBe(22.5 * hour);
  const extreme = summarizeReport('day', '2026-10-12', 'analog', [bucket(0, Number.MAX_VALUE), bucket(1, -Number.MAX_VALUE)]);
  expect(extreme.summary.mean).toBe(0);
});
it('builds all monthly daily rows, including absent days, and never treats an empty archive as zero quality', () => {
  const report = summarizeReport('month', '2026-10', 'digital', [bucket()]);
  expect(report.rows).toHaveLength(31); expect(report.rows[11]!.usedHours).toBe(1);
  expect(report.summary.expectedHours).toBe(744);
  expect(summarizeReport('day', '2026-10-12', 'analog', []).summary).toMatchObject({ mean: null, min: null, max: null, qualityMs: { Good: 0, Unknown: 24 * hour } });
});
it('rejects overlapping, misaligned, mismatched or corrupt aggregate inputs instead of publishing false totals', () => {
  const invalid = [() => [bucket(), bucket()], () => [{ ...bucket(), bucketStart: '2026-10-12T00:01:00.000Z' }], () => [bucket(0, 10)], () => { const b = bucket(); b.aggregate!.qualityMs.Unknown = -1; return [b]; }, () => { const b = bucket(); b.aggregate!.trueMs = hour + 1; return [b]; }, () => [bucket(-1)], () => { const b = bucket(); b.aggregate!.sampleCount = 10001; return [b]; }];
  for (const make of invalid) expect(() => summarizeReport('day', '2026-10-12', 'digital', make())).toThrow();
});
it('exports the entire report with UTC bounds, quality coverage and spreadsheet-safe metadata', () => {
  const report = summarizeReport('day', '2026-10-12', 'digital', [bucket()]);
  const csv = reportCsv({ ...report, id: 'fixture', generatedAt: '2026-10-13T01:00:00.000Z', signal: { id: 'signal', name: '=1+1,"quoted"', dataType: 'boolean' } });
  expect(csv).toContain('unknown_seconds'); expect(csv).toContain("\"'=1+1,\"\"quoted\"\"\"");
  expect(csv).toContain('2026-10-12T00:00:00.000Z'); expect(csv).toContain('2026-10-13T00:00:00.000Z');
  expect(csv.split('\r\n')).toHaveLength(27);
});

it('exports negative measurements as numeric CSV cells while protecting only text metadata', () => {
  const report = summarizeReport('day', '2026-10-12', 'analog', [bucket(0, -10)]);
  const csv = reportCsv({ ...report, id: 'fixture', generatedAt: '2026-10-13T01:00:00.000Z', signal: { id: 'signal', name: 'Temperature', dataType: 'float64' } });
  expect(csv).toContain('"-10"'); expect(csv).not.toContain('"\'-10"');
});
