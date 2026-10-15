import {formatSignalValue} from './signal-format.js';
import { SignalReports } from './signal-reports.js';
import { HistoryAggregates } from './history-aggregates.js';
import { HistoryTrend } from './history-trend.js';
import { historyCsv } from '../../../packages/domain/src/history-view.js';
import { useEffect, useRef, useState } from 'react';
import type { HistoryPage } from '../../../packages/domain/src/history.js';
import { api, type Signal } from './api.js';
const localInput = (value: string) => { const date = new Date(value); return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 19); };
const recent = () => ({ from: new Date(Date.now() - 3600000).toISOString(), to: new Date().toISOString() });
interface Status { queued: number; dropped: number; error: string | null; maintenanceError: string | null; }
export function SignalHistory({ signal, close }: { signal: Signal; close: () => void }) {
  const initial = useRef(recent()); const range = useRef(initial.current);
  const [from, setFrom] = useState(localInput(initial.current.from)); const [to, setTo] = useState(localInput(initial.current.to));
  const [page, setPage] = useState<HistoryPage>({ items: [], nextBefore: null }); const [status, setStatus] = useState<Status | null>(null);
  const [showReports, setShowReports] = useState(false);
  const [showAggregates, setShowAggregates] = useState(false);
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const [following, setFollowing] = useState(true);
  const follow = useRef(true); const mounted = useRef(true); const generation = useRef(0); const controller = useRef<AbortController | null>(null);
  function exportCsv() {
    try {
      const url = URL.createObjectURL(new Blob([historyCsv(signal, page.items)], { type: 'text/csv;charset=utf-8' }));
      const link = document.createElement('a'); link.href = url; link.download = `open-apcs-history-${signal.id}.csv`;
      document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch { setError('History export failed'); }
  }
  function pause() { follow.current = false; setFollowing(false); }
  async function load(window: { from: string; to: string }, before?: string) {
    const version = ++generation.current; controller.current?.abort(); const abort = new AbortController(); controller.current = abort;
    const deadline = setTimeout(() => abort.abort(), 3000); setBusy(true); setError('');
    try {
      const query = new URLSearchParams({ ...window, limit: '100', ...(before ? { before } : {}) });
      const [result, health] = await Promise.all([api<HistoryPage>(`/signals/${signal.id}/history?${query}`, { signal: abort.signal }), api<Status>('/history/status', { signal: abort.signal })]);
      if (mounted.current && version === generation.current) { range.current = window; setPage((prior) => ({ ...result, items: before ? [...prior.items, ...result.items] : result.items })); setStatus(health); }
    } catch (cause) { if (mounted.current && version === generation.current) setError(cause instanceof Error ? cause.message : 'History unavailable'); }
    finally { clearTimeout(deadline); if (mounted.current && version === generation.current) setBusy(false); }
  }
  useEffect(() => {
    mounted.current = true; let active = true; let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      if (follow.current) { const window = recent(); setFrom(localInput(window.from)); setTo(localInput(window.to)); await load(window); }
      if (active) timer = setTimeout(() => { void poll(); }, 2000);
    }
    void poll(); return () => { active = false; mounted.current = false; clearTimeout(timer); controller.current?.abort(); };
  }, [signal.id]);
  return <section className="panel history-panel"><div className="panel-heading"><div><h2>{signal.name} · History</h2><p className="muted">Raw changes and checkpoints · current display settings · exports preserve raw values · times shown in your local timezone</p></div><button className="text-button" onClick={close}>Close history</button></div>
    <form className="history-filters" onSubmit={(event) => { event.preventDefault(); pause(); try { void load({ from: new Date(from).toISOString(), to: new Date(to).toISOString() }); } catch { setError('Choose a valid time range'); } }}><label className="field"><span>History from</span><input type="datetime-local" step="1" required value={from} onChange={(event) => { pause(); setFrom(event.target.value); }} /></label><label className="field"><span>History to</span><input type="datetime-local" step="1" required value={to} onChange={(event) => { pause(); setTo(event.target.value); }} /></label><button className="secondary" disabled={busy}>Apply range</button><button type="button" className="secondary" disabled={following} onClick={() => { follow.current = true; setFollowing(true); }}>Follow last hour</button></form>
    {error && <p className="alert" role="alert">{error}</p>}{status && <p className="history-status">Archive queue: {status.queued} · Dropped samples: {status.dropped}{status.error ? ` · ${status.error}` : ''}{status.maintenanceError ? ` · ${status.maintenanceError}` : ''}</p>}
    <div className="history-export"><p className="muted">{page.items.length} loaded samples{page.nextBefore ? ' · older samples are not included' : ''}</p><button className="secondary" disabled={busy || !page.items.length} onClick={exportCsv}>Export loaded CSV</button></div>
    <HistoryTrend rows={page.items} boolean={signal.dataType === 'boolean'} presentation={signal} />
    <div className="table-scroll"><table aria-label="Signal history"><thead><tr><th>Observed</th><th>Value</th><th>Quality</th><th>Device session</th></tr></thead><tbody>{page.items.map((item) => <tr key={item.id}><td><time dateTime={item.observedAt}>{new Date(item.observedAt).toLocaleString()}</time></td><td className="signal-value" title={`Raw value: ${JSON.stringify(item.snapshot.value)}`}>{formatSignalValue(item.snapshot.value,signal)}</td><td><span className={`badge ${item.snapshot.quality === 'Good' ? 'good' : 'warning'}`}>{item.snapshot.quality}</span></td><td><code>{item.snapshot.bootId?.slice(0, 12) ?? 'No session'}</code></td></tr>)}</tbody></table></div>
    {!page.items.length && !busy && <p className="history-status">No archived samples in this range.</p>}{page.nextBefore && page.items.length < 1000 && <button className="secondary load-more" disabled={busy} onClick={() => { pause(); void load(range.current, page.nextBefore!); }}>Older samples</button>}{page.items.length >= 1000 && <p className="history-status">Narrow the time range to inspect more samples.</p>}
    <div className="system-copy"><button className="secondary" onClick={() => setShowAggregates((value) => !value)}>{showAggregates ? 'Hide aggregates' : 'Show aggregates'}</button></div>
    {showAggregates && <HistoryAggregates signal={signal} />}
    <div className="system-copy"><button className="secondary" onClick={() => setShowReports((value) => !value)}>{showReports ? 'Hide reports' : 'Show reports'}</button></div>
    {showReports && <SignalReports signal={signal} />}
  </section>;
}
