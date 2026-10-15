import {formatSignalValue} from './signal-format.js';
import { useEffect, useRef, useState } from 'react';
import type { AggregatePage } from '../../../packages/storage/src/history-aggregates.js';
import { api, type Signal } from './api.js';
const localInput = (value: string) => { const date = new Date(value); return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 19); };
const recent = () => ({ from: new Date(Date.now() - 86400000).toISOString(), to: new Date().toISOString(), resolution: '60' });
interface Status { state: string; pending: number; blocked: number; backfillComplete: boolean; }
export function HistoryAggregates({ signal }: { signal: Signal }) {
  const initial = useRef(recent()); const loaded = useRef(initial.current);
  const [from, setFrom] = useState(localInput(initial.current.from)); const [to, setTo] = useState(localInput(initial.current.to)); const [resolution, setResolution] = useState('60');
  const [page, setPage] = useState<AggregatePage>({ items: [], nextBefore: null }); const [status, setStatus] = useState<Status | null>(null); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const following = useRef(true); const mounted = useRef(true); const generation = useRef(0); const controller = useRef<AbortController | null>(null);
  async function load(query: { from: string; to: string; resolution: string }, before?: string) {
    const version = ++generation.current; controller.current?.abort(); const abort = new AbortController(); controller.current = abort;
    const deadline = setTimeout(() => abort.abort(), 3000); setBusy(true); setError('');
    try {
      const params = new URLSearchParams({ ...query, limit: '100', ...(before ? { before } : {}) });
      const [result, health] = await Promise.all([api<AggregatePage>(`/signals/${signal.id}/aggregates?${params}`, { signal: abort.signal }), api<Status>('/history/aggregates/status', { signal: abort.signal })]);
      if (mounted.current && version === generation.current) { loaded.current = query; setPage((prior) => ({ ...result, items: before ? [...prior.items, ...result.items] : result.items })); setStatus(health); }
    } catch (cause) { if (mounted.current && version === generation.current) setError(cause instanceof Error ? cause.message : 'Aggregates unavailable'); }
    finally { clearTimeout(deadline); if (mounted.current && version === generation.current) setBusy(false); }
  }
  useEffect(() => {
    mounted.current = true; let active = true; let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      if (following.current) await load(loaded.current);
      if (active) timer = setTimeout(() => { void poll(); }, 2000);
    }
    void poll(); return () => { active = false; mounted.current = false; clearTimeout(timer); controller.current?.abort(); };
  }, [signal.id]);
  return <div className="aggregate-history"><div className="system-copy"><h3>Minute and hour aggregates</h3><p className="muted">Complete UTC buckets whose start is in the selected range. Times below use your local timezone. New buckets appear after a two-minute continuity delay. Missing coverage is not zero.</p></div>
    <form className="history-filters" onSubmit={(event) => { event.preventDefault(); following.current = true; try { void load({ from: new Date(from).toISOString(), to: new Date(to).toISOString(), resolution }); } catch { setError('Choose a valid aggregate range'); } }}>
      <label className="field">Aggregate from<input type="datetime-local" step="1" required value={from} onChange={(event) => { following.current = false; setFrom(event.target.value); }} /></label>
      <label className="field">Aggregate to<input type="datetime-local" step="1" required value={to} onChange={(event) => { following.current = false; setTo(event.target.value); }} /></label>
      <label className="field">Bucket size<select aria-label="Bucket size" value={resolution} onChange={(event) => { following.current = false; setResolution(event.target.value); }}><option value="60">One minute</option><option value="3600">One hour</option></select></label>
      <button className="secondary" disabled={busy}>Apply aggregate range</button>
    </form>
    {error && <p className="alert" role="alert">{error}</p>}
    {status && <p className="history-status">Aggregation {status.state} · Pending buckets: {status.pending} · Blocked: {status.blocked}{status.backfillComplete ? '' : ' · Historical backfill in progress'}</p>}
    <div className="table-scroll"><table aria-label="History aggregates"><thead><tr><th>Bucket start</th><th>State</th><th>Samples</th><th>Good coverage</th><th>Unknown seconds</th><th>Quality details</th><th>Last observed value</th><th>ON seconds</th><th>OFF seconds</th><th>Transitions</th><th>Mean</th><th>Min / max</th></tr></thead><tbody>{page.items.map((item) => {
      const a = item.aggregate; const duration = Date.parse(a.to) - Date.parse(a.from);
      return <tr key={item.bucketStart} data-bucket-start={item.bucketStart}><td>{new Date(item.bucketStart).toLocaleString()}</td><td>{item.stale ? 'Recalculation pending' : 'Calculated'}</td><td>{a.sampleCount}</td><td title={`Bad ${a.qualityMs.Bad / 1000}s; Stale ${a.qualityMs.Stale / 1000}s; Disconnected ${a.qualityMs.Disconnected / 1000}s`}>{(a.qualityMs.Good / duration * 100).toFixed(1)}%</td><td>{(a.qualityMs.Unknown / 1000).toFixed(3)}</td><td><details><summary>Quality details</summary><p>Bad: {a.qualityMs.Bad / 1000}s<br />Stale: {a.qualityMs.Stale / 1000}s<br />Disconnected: {a.qualityMs.Disconnected / 1000}s<br />Invalid Good samples: {a.invalidSamples}</p></details></td><td>{a.last?.value === null || !a.last ? '—' : formatSignalValue(a.last.value,signal)}<br /><span className="muted">{a.last?.quality ?? 'No observation'}</span></td><td>{a.profile === 'digital' ? (a.trueMs / 1000).toFixed(3) : '—'}</td><td>{a.profile === 'digital' ? (a.falseMs / 1000).toFixed(3) : '—'}</td><td>{a.profile === 'digital' ? a.transitions : '—'}</td><td>{a.mean === null ? '—' : formatSignalValue(a.mean,signal)}</td><td>{a.min===null?'—':formatSignalValue(a.min,signal)} / {a.max===null?'—':formatSignalValue(a.max,signal)}</td></tr>;
    })}</tbody></table></div>
    {!page.items.length && !busy && <p className="history-status">No calculated buckets in this range yet.</p>}
    {page.nextBefore && page.items.length < 1000 && <button className="secondary load-more" disabled={busy} onClick={() => { following.current = false; void load(loaded.current, page.nextBefore!); }}>Older aggregates</button>}
    <p className="history-status">{page.items.length} loaded buckets · Maximum range 365 days · Up to 1,000 loaded rows. Exact integer strings are preserved without numeric averaging.</p>
  </div>;
}
