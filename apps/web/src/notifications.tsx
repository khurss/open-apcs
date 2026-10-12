import { useEffect, useState } from 'react';
import { api } from './api.js';
interface Delivery { id: string; alarmName: string; routeId: string; state: string; attempts: number; createdAt: string; dueAt: string; lastError: string | null; canRetry: boolean; }
interface Attempt { attempt: number; startedAt: string; completedAt: string | null; outcome: string | null; }
interface Log { items: Delivery[]; nextBefore: string | null; routes: Array<{ id: string; name: string; kind: string; enabled: boolean; dropped: string }>; service: { state: string }; }
export function NotificationLog({ project }: { project: string }) {
  const [log, setLog] = useState<Log | null>(null); const [before, setBefore] = useState(''); const [selected, setSelected] = useState('');
  const [attempts, setAttempts] = useState<Attempt[]>([]); const [reason, setReason] = useState(''); const [online, setOnline] = useState(false); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const active = log?.items.find((item) => item.id === selected);
  async function refresh(signal?: AbortSignal) {
    const options = signal ? { signal } : {};
    const [next, history] = await Promise.all([api<Log>(`/projects/${project}/notifications${before ? `?before=${before}` : ''}`, options), selected ? api<{ items: Attempt[] }>(`/notifications/${selected}/attempts`, options) : Promise.resolve({ items: [] })]);
    if (signal?.aborted) return; setLog(next); setAttempts(history.items); setOnline(true);
  }
  useEffect(() => {
    let stopped = false; let timer: ReturnType<typeof setTimeout>; let controller: AbortController;
    async function poll() {
      controller = new AbortController(); const deadline = setTimeout(() => controller.abort(), 2500);
      try { await refresh(controller.signal); } catch { if (!stopped) setOnline(false); }
      finally { clearTimeout(deadline); if (!stopped) timer = setTimeout(() => { void poll(); }, 1000); }
    }
    if (project) void poll(); return () => { stopped = true; clearTimeout(timer); controller?.abort(); };
  }, [project, before, selected]);
  function page(cursor: string) { setBefore(cursor); setSelected(''); setLog(null); setOnline(false); setError(''); }
  async function retry() {
    if (!active) return; setBusy(true); setError('');
    try { await api(`/notifications/${active.id}/retry`, { method: 'POST', body: { reason } }); setReason(''); await refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Notification retry failed'); }
    finally { setBusy(false); }
  }
  return <section className="panel"><div className="panel-heading"><h2>Notifications</h2><span>{online ? `Delivery service ${log?.service.state}` : 'Delivery status unavailable'}</span></div>
    <div className="system-copy"><p className="muted">Delivery results are independent of alarm acknowledgement. Recipients are configured on the local server.</p>
      {log?.routes.length ? <ul>{log.routes.map((route) => <li key={route.id}>{route.name} · {route.kind} · {route.enabled ? 'Enabled' : 'Disabled'} · Dropped: {route.dropped}</li>)}</ul> : <p>No notification destinations configured.</p>}
      {error && <p role="alert" className="alert">{error}</p>}
    </div>
    <div className="table-scroll"><table aria-label="Notification deliveries"><thead><tr><th>Created</th><th>Alarm</th><th>Destination</th><th>Delivery</th><th>Attempts</th><th>Next attempt</th><th>Details</th></tr></thead><tbody>{log?.items.map((item) => <tr key={item.id}>
      <td>{new Date(item.createdAt).toLocaleString()}</td><td>{item.alarmName}</td><td>{log.routes.find((route) => route.id === item.routeId)?.name ?? item.routeId}</td><td>{item.state}</td><td>{item.attempts}/8</td><td>{item.state === 'Pending' ? new Date(item.dueAt).toLocaleString() : '—'}</td><td><button className="secondary" onClick={() => { setSelected(item.id); setReason(''); setError(''); setAttempts([]); }}>Delivery details</button></td>
    </tr>)}</tbody></table></div>
    <div className="system-copy inline-form"><button className="secondary" disabled={!before || busy} onClick={() => page('')}>Latest deliveries</button><button className="secondary" disabled={!log?.nextBefore || busy} onClick={() => page(log!.nextBefore!)}>Older deliveries</button><span className="muted">Up to 20 results per page</span></div>
    {active && <div className="system-copy"><h3>Delivery attempts</h3><p>{active.lastError ?? 'No transport error recorded.'}</p><p className="muted">A lost response can cause duplicate delivery. Manual retries share the eight-attempt limit.</p>
      <div className="table-scroll"><table aria-label="Notification attempts"><thead><tr><th>Attempt</th><th>Started</th><th>Result</th></tr></thead><tbody>{attempts.map((attempt) => <tr key={attempt.attempt}><td>{attempt.attempt}</td><td>{new Date(attempt.startedAt).toLocaleString()}</td><td>{attempt.outcome ?? 'In progress'}</td></tr>)}</tbody></table></div>
      <label className="field">Notification retry reason<input maxLength={256} value={reason} onChange={(e) => setReason(e.target.value)} /></label>
      <button className="secondary" disabled={busy || !online || !active.canRetry || !reason.trim()} onClick={() => { void retry(); }}>Retry notification</button>
    </div>}
  </section>;
}
