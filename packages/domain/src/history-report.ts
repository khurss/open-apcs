import type { HistoryAggregate } from './history-aggregate.js';
export type ReportPeriod = 'day' | 'month';
export type ReportProfile = 'digital' | 'analog';
export interface ReportBucket { bucketStart: string; calculatedAt: string | null; stale: boolean; aggregate: HistoryAggregate | null; }
export interface ReportSummary {
  from: string; to: string; expectedHours: number; usedHours: number; missingHours: number; pendingHours: number;
  sampleCount: number; invalidSamples: number; qualityMs: HistoryAggregate['qualityMs'];
  trueMs: number; falseMs: number; transitions: number; mean: number | null; min: number | null; max: number | null;
}
export interface ReportData { templateVersion: 1; timezone: 'UTC'; period: ReportPeriod; date: string; profile: ReportProfile; summary: ReportSummary; rows: ReportSummary[]; }
export interface SignalReport extends ReportData { id: string; generatedAt: string; signal: { id: string; name: string; dataType: string }; }
const HOUR = 3600000; const DAY = 24 * HOUR;
const qualities = ['Good', 'Bad', 'Stale', 'Disconnected', 'Unknown'] as const;
export function reportRange(period: string, date: string): { from: string; to: string } {
  if ((period !== 'day' && period !== 'month') || typeof date !== 'string' || !(period === 'day' ? /^\d{4}-\d{2}-\d{2}$/ : /^\d{4}-\d{2}$/).test(date)) throw new Error('Invalid report period or date');
  const start = `${date}${period === 'month' ? '-01' : ''}T00:00:00.000Z`; const from = Date.parse(start);
  if (!Number.isFinite(from) || new Date(from).toISOString() !== start || from < Date.UTC(1900, 0, 1) || from >= Date.UTC(2101, 0, 1)) throw new Error('Report date must be a real UTC date from 1900 through 2100');
  const end = new Date(from); if (period === 'month') end.setUTCMonth(end.getUTCMonth() + 1); else end.setUTCDate(end.getUTCDate() + 1);
  return { from: start, to: end.toISOString() };
}
const nonnegative = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;
function validateBucket(bucket: ReportBucket, from: number, to: number, profile: ReportProfile) {
  const at = Date.parse(bucket.bucketStart);
  if (!Number.isFinite(at) || at % HOUR !== 0 || at < from || at >= to || typeof bucket.stale !== 'boolean') throw new Error('Invalid report bucket boundary');
  if (bucket.stale) return;
  const a = bucket.aggregate;
  if (!a || a.profile !== profile || Date.parse(a.from) !== at || Date.parse(a.to) !== at + HOUR || !bucket.calculatedAt || !Number.isFinite(Date.parse(bucket.calculatedAt))) throw new Error('Invalid report aggregate identity');
  if (!a.qualityMs || qualities.some((q) => !nonnegative(a.qualityMs[q])) || qualities.reduce((sum, q) => sum + a.qualityMs[q], 0) !== HOUR) throw new Error('Invalid report quality coverage');
  if (![a.sampleCount, a.validSampleCount, a.invalidSamples, a.transitions, a.trueMs, a.falseMs].every(nonnegative) || a.sampleCount > 10000 || a.transitions > a.sampleCount || a.validSampleCount + a.invalidSamples > a.sampleCount) throw new Error('Invalid report counts');
  if (profile === 'digital' && (a.trueMs + a.falseMs !== a.qualityMs.Good || a.mean !== null || a.min !== null || a.max !== null)) throw new Error('Invalid digital report durations');
  if (profile === 'analog') {
    if ([a.min, a.max, a.mean].some((v) => v !== null && (typeof v !== 'number' || !Number.isFinite(v))) || (a.min === null) !== (a.max === null) || (a.min !== null && a.max !== null && a.min > a.max) || (a.qualityMs.Good > 0) !== (a.mean !== null) || (a.mean !== null && (a.min === null || a.max === null || a.mean < (a.min as number) - Math.abs(a.mean) * 1e-12 || a.mean > (a.max as number) + Math.abs(a.mean) * 1e-12))) throw new Error('Invalid analog report statistics');
  }
}
function summarize(from: number, to: number, buckets: ReportBucket[]): ReportSummary {
  const result: ReportSummary = { from: new Date(from).toISOString(), to: new Date(to).toISOString(), expectedHours: (to - from) / HOUR, usedHours: 0, missingHours: (to - from) / HOUR - buckets.length, pendingHours: 0, sampleCount: 0, invalidSamples: 0, qualityMs: { Good: 0, Bad: 0, Stale: 0, Disconnected: 0, Unknown: to - from }, trueMs: 0, falseMs: 0, transitions: 0, mean: null, min: null, max: null };
  let weight = 0;
  for (const bucket of buckets) {
    if (bucket.stale) { result.pendingHours++; continue; }
    const a = bucket.aggregate!; result.usedHours++; result.sampleCount += a.sampleCount; result.invalidSamples += a.invalidSamples;
    for (const q of qualities) if (q !== 'Unknown') { result.qualityMs[q] += a.qualityMs[q]; result.qualityMs.Unknown -= a.qualityMs[q]; }
    result.trueMs += a.trueMs; result.falseMs += a.falseMs; result.transitions += a.transitions;
    if (typeof a.min === 'number') result.min = result.min === null ? a.min : Math.min(result.min, a.min);
    if (typeof a.max === 'number') result.max = result.max === null ? a.max : Math.max(result.max, a.max);
    if (a.mean !== null && a.qualityMs.Good > 0) {
      const fraction = a.qualityMs.Good / (weight + a.qualityMs.Good);
      result.mean = result.mean === null ? a.mean : result.mean * (1 - fraction) + a.mean * fraction;
      weight += a.qualityMs.Good;
    }
  }
  return result;
}
export function summarizeReport(period: string, date: string, profile: ReportProfile, buckets: ReportBucket[]): ReportData {
  const range = reportRange(period, date); const from = Date.parse(range.from); const to = Date.parse(range.to);
  if (!['digital', 'analog'].includes(profile) || buckets.length > 744) throw new Error('Invalid report profile or bucket count');
  const used = new Set<number>();
  for (const bucket of buckets) { validateBucket(bucket, from, to, profile); const at = Date.parse(bucket.bucketStart); if (used.has(at)) throw new Error('Duplicate report bucket'); used.add(at); }
  const ordered = [...buckets].sort((a, b) => Date.parse(a.bucketStart) - Date.parse(b.bucketStart));
  const rows: ReportSummary[] = []; const step = period === 'day' ? HOUR : DAY;
  for (let at = from; at < to; at += step) rows.push(summarize(at, at + step, ordered.filter((b) => Date.parse(b.bucketStart) >= at && Date.parse(b.bucketStart) < at + step)));
  return { templateVersion: 1, timezone: 'UTC', period: period as ReportPeriod, date, profile, summary: summarize(from, to, ordered), rows };
}
function cell(value: unknown): string { const text = value === null ? '' : String(value); const safe = typeof value === 'string' && /^(?:\s*[=+@-]|[\t\r\n])/.test(text) ? `'${text}` : text; return `"${safe.replaceAll('"', '""')}"`; }
export function reportCsv(report: SignalReport): string {
  const header = 'report_id,generated_at_utc,template_version,signal_id,signal_name,data_type,timezone,row_type,from_utc,to_utc,expected_hours,used_hours,pending_hours,missing_hours,samples,invalid_samples,good_seconds,bad_seconds,stale_seconds,disconnected_seconds,unknown_seconds,on_seconds,off_seconds,transitions,mean,min,max';
  const lines = [header];
  for (const [index, row] of [report.summary, ...report.rows].entries()) lines.push([report.id, report.generatedAt, report.templateVersion, report.signal.id, report.signal.name, report.signal.dataType, report.timezone, index === 0 ? 'total' : report.period === 'day' ? 'hour' : 'day', row.from, row.to, row.expectedHours, row.usedHours, row.pendingHours, row.missingHours, row.sampleCount, row.invalidSamples, ...qualities.map((q) => row.qualityMs[q] / 1000), report.profile === 'digital' ? row.trueMs / 1000 : null, report.profile === 'digital' ? row.falseMs / 1000 : null, report.profile === 'digital' ? row.transitions : null, row.mean, row.min, row.max].map(cell).join(','));
  return `${lines.join('\r\n')}\r\n`;
}
