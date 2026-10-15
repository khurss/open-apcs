import {formatAxisValue,formatSignalValue} from './signal-format.js';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ArchivedSample } from '../../../packages/domain/src/history.js';
import { historyTrend } from '../../../packages/domain/src/history-view.js';
export function HistoryTrend({ rows, boolean, compact = false, presentation = {} }: { rows: ArchivedSample[]; boolean: boolean; compact?: boolean; presentation?: {unit?:string;displayDecimals?:number} }) {
  const svg = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState({ width: 900, height: 240 });
  useEffect(() => {
    if (!compact || !svg.current) return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const width = Math.max(180, Math.round(entry.contentRect.width));
      const height = Math.max(110, Math.round(entry.contentRect.height));
      setSize(before => before.width === width && before.height === height ? before : { width, height });
    });
    observer.observe(svg.current); return () => observer.disconnect();
  }, [compact]);
  const width = compact ? size.width : 900; const height = compact ? size.height : 240;
  const left = Math.min(96, width * 0.4); const right = compact ? width - 16 : 835;
  const top = compact ? 20 : 30; const bottom = compact ? height - 36 : 190;
  const trend = useMemo(() => historyTrend(rows), [rows]);
  const values = trend.points.map((point) => point.value);
  const low = boolean ? 0 : values.length ? Math.min(...values) : 0;
  const high = boolean ? 1 : values.length ? Math.max(...values) : 1;
  const magnitude = Math.max(Math.abs(low), Math.abs(high), 1);
  const floor = low / magnitude; const span = high / magnitude - floor;
  const x = (at: number) => left + (trend.from === trend.to ? 0.5 : (at - trend.from!) / (trend.to! - trend.from!)) * (right - left);
  const y = (value: number) => span === 0 ? (top + bottom) / 2 : bottom - ((value / magnitude - floor) / span) * (bottom - top);
  const label = (value:number) => boolean ? value ? 'ON' : 'OFF' : formatAxisValue(value,presentation);
  const time = (at: number) => compact ? new Date(at).toLocaleTimeString(undefined, { hour12: false }) : new Date(at).toLocaleString();
  return <div className={`history-trend${compact ? ' compact-trend' : ''}`}><svg ref={svg} role="img" aria-label="Signal history trend" viewBox={`0 0 ${width} ${height}`}>
    <title>Loaded signal observations. Gaps indicate unavailable or unplotted intervals.</title>
    {[top, (top + bottom) / 2, bottom].map((at) => <line key={at} x1={left} x2={right} y1={at} y2={at} className="trend-grid" />)}
    <text x={left - 10} y={top + 5} textAnchor="end">{label(high)}</text><text x={left - 10} y={bottom + 5} textAnchor="end">{label(low)}</text>
    {trend.segments.map((segment, index) => <line key={index} x1={x(segment.from)} x2={x(segment.to)} y1={y(segment.value)} y2={y(segment.value)} className="trend-value" />)}
    {trend.points.map((point, index) => <circle key={index} cx={x(point.at)} cy={y(point.value)} r="3" className="trend-point"><title>{new Date(point.at).toLocaleString()} · {boolean?label(point.value):formatSignalValue(point.value,presentation)}</title></circle>)}
    {trend.from !== null && <text x={left} y={height - 12}>{time(trend.from)}</text>}
    {trend.to !== null && <text x={right} y={height - 12} textAnchor="end">{time(trend.to)}</text>}
    {!trend.points.length && <text x={width / 2} y={height / 2} textAnchor="middle">{compact ? 'No Good observations' : 'No Good numeric or boolean observations'}</text>}
  </svg>{!compact&&!boolean&&presentation.unit&&<p className="muted trend-unit">Unit: {presentation.unit}</p>}<p className="muted">Loaded observations only · gaps are unknown · raw values without unit conversion{trend.omitted ? ` · ${trend.omitted} string values remain exact in the table and CSV` : ''}</p></div>;
}
