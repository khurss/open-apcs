import type { ArchivedSample } from './history.js';
export interface HistoryTrend { from: number | null; to: number | null; segments: Array<{ from: number; to: number; value: number }>; points: Array<{ at: number; value: number }>; omitted: number; }
function ordered(rows: ArchivedSample[]): ArchivedSample[] {
  if (rows.length > 1000) throw new Error('History views support at most 1000 samples');
  for (const row of rows) if (!Number.isFinite(Date.parse(row.observedAt)) || !/^[1-9][0-9]{0,17}$/.test(row.id)) throw new Error('Invalid archived sample identity or time');
  return [...rows].sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt) || (BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0));
}
const numeric = (value: ArchivedSample['snapshot']['value']): number | null => typeof value === 'boolean' ? Number(value) : typeof value === 'number' && Number.isFinite(value) ? value : null;
/** No extrapolation past the latest observation; long gaps remain unknown. */
export function historyTrend(rows: ArchivedSample[]): HistoryTrend {
  const samples = ordered(rows); const segments: HistoryTrend['segments'] = []; const points: HistoryTrend['points'] = [];
  for (const [index, row] of samples.entries()) {
    const at = Date.parse(row.observedAt); const value = numeric(row.snapshot.value); const next = samples[index + 1];
    if (row.snapshot.quality !== 'Good' || value === null) continue;
    points.push({ at, value });
    if (!next || !row.snapshot.bootId || next.snapshot.bootId !== row.snapshot.bootId) continue;
    const end = Date.parse(next.observedAt);
    if (end > at && end - at <= 120000) segments.push({ from: at, to: end, value });
  }
  return { from: samples.length ? Date.parse(samples[0]!.observedAt) : null, to: samples.length ? Date.parse(samples.at(-1)!.observedAt) : null, segments, points, omitted: samples.filter((row) => row.snapshot.value !== null && numeric(row.snapshot.value) === null).length };
}
function cell(value: string, protect = true): string {
  const text = protect && /^(?:\s*[=+@-]|[\t\r\n])/.test(value) ? `'${value}` : value;
  return `"${text.replaceAll('"', '""')}"`;
}
/** Metadata is spreadsheet-safe; value_json preserves string/int64/null types. */
export function historyCsv(signal: { id: string; name: string; dataType: string;unit?:string;displayDecimals?:number;revision?:number }, rows: ArchivedSample[], options: {version:1|2}={version:1}): string {
  const lines = ['signal_id,signal_name,data_type,archive_id,observed_at_utc,value_json,quality,boot_id,sequence,source_time_utc,received_time_utc'+(options.version===2?',export_version,unit,display_decimals,signal_revision':'')];
  for (const row of ordered(rows)) {
    const sample = row.snapshot;
    const fields = [signal.id, signal.name, signal.dataType, row.id, new Date(row.observedAt).toISOString(), JSON.stringify(sample.value), sample.quality, sample.bootId ?? '', sample.sequence?.toString() ?? '', sample.sourceTime ?? '', sample.receivedTime ?? '',...(options.version===2?['2',signal.unit??'',signal.displayDecimals?.toString()??'',signal.revision?.toString()??'']:[])];
    lines.push(fields.map((value, index) => cell(value, index !== 5)).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}
