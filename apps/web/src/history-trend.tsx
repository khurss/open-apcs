import { useMemo } from 'react';
import type { ArchivedSample } from '../../../packages/domain/src/history.js';
import { historyTrend } from '../../../packages/domain/src/history-view.js';
export function HistoryTrend({ rows, boolean }: { rows: ArchivedSample[]; boolean: boolean }) {
  const trend = useMemo(() => historyTrend(rows), [rows]);
  const values = trend.points.map((point) => point.value);
  const low = boolean ? 0 : values.length ? Math.min(...values) : 0;
  const high = boolean ? 1 : values.length ? Math.max(...values) : 1;
  const magnitude = Math.max(Math.abs(low), Math.abs(high), 1);
  const floor = low / magnitude; const span = high / magnitude - floor;
  const x = (at: number) => 65 + (trend.from === trend.to ? 0.5 : (at - trend.from!) / (trend.to! - trend.from!)) * 770;
  const y = (value: number) => span === 0 ? 110 : 190 - ((value / magnitude - floor) / span) * 160;
  const label = (value: number) => boolean ? value ? 'ON' : 'OFF' : Math.abs(value) >= 1e6 || (value !== 0 && Math.abs(value) < 0.001) ? value.toExponential(3) : value.toLocaleString(undefined, { maximumSignificantDigits: 6 });
  return <div className="history-trend"><svg role="img" aria-label="Signal history trend" viewBox="0 0 900 240">
    <title>Loaded signal observations. Gaps indicate unavailable or unplotted intervals.</title>
    {[30, 110, 190].map((at) => <line key={at} x1="65" x2="835" y1={at} y2={at} className="trend-grid" />)}
    <text x="55" y="35" textAnchor="end">{label(high)}</text><text x="55" y="195" textAnchor="end">{label(low)}</text>
    {trend.segments.map((segment, index) => <line key={index} x1={x(segment.from)} x2={x(segment.to)} y1={y(segment.value)} y2={y(segment.value)} className="trend-value" />)}
    {trend.points.map((point, index) => <circle key={index} cx={x(point.at)} cy={y(point.value)} r="3" className="trend-point"><title>{new Date(point.at).toLocaleString()} · {label(point.value)}</title></circle>)}
    {trend.from !== null && <text x="65" y="225">{new Date(trend.from).toLocaleString()}</text>}
    {trend.to !== null && <text x="835" y="225" textAnchor="end">{new Date(trend.to).toLocaleString()}</text>}
    {!trend.points.length && <text x="450" y="115" textAnchor="middle">No Good numeric or boolean observations</text>}
  </svg><p className="muted">Loaded observations only · gaps are unknown · raw values without unit conversion{trend.omitted ? ` · ${trend.omitted} string values remain exact in the table and CSV` : ''}</p></div>;
}
