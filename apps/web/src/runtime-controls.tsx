import { useEffect, useRef, useState } from 'react';
import { api, type Signal } from './api.js';
interface Status { state: 'running' | 'stopped' | 'faulted'; error: string | null; }
interface Command { id: string; state: string; reason: string | null; reconciliation?: { reason: string; at: string }; }
interface History { items: Command[]; blocking: Command | null; nextCursor: string | null; }
const pendingStates = new Set(['Requested', 'Accepted', 'Dispatched', 'DeviceAccepted']);
export function VirtualDeviceControl({ deviceId }: { deviceId: string }) {
  const [status, setStatus] = useState<Status | null>(null); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const version = useRef(0);
  useEffect(() => {
    let cancelled = false; let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const current = version.current;
      try { const result = await api<Status>(`/devices/${deviceId}/runtime`); if (!cancelled && current === version.current) setStatus(result); }
      catch { if (!cancelled && current === version.current) setError('Runtime status unavailable'); }
      if (!cancelled) timer = setTimeout(() => { void poll(); }, 1000);
    };
    void poll(); return () => { cancelled = true; clearTimeout(timer); };
  }, [deviceId]);
  async function action() {
    const operation = status?.state === 'running' ? 'stop' : 'start'; version.current++; setBusy(true); setError('');
    try { setStatus(await api<Status>(`/devices/${deviceId}/runtime`, { method: 'POST', body: { action: operation, reason: operation === 'start' ? 'Operator started virtual LED simulation' : 'Operator stopped virtual LED simulation' } })); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Runtime action failed'); }
    finally { version.current++; setBusy(false); }
  }
  return <div className="virtual-device-control"><span className={`badge ${status?.state === 'running' ? 'good' : 'warning'}`}><span className="dot" />{status ? `Simulation ${status.state}` : 'Checking runtime'}</span><button className="secondary" disabled={busy || !status} onClick={() => { void action(); }}>{busy ? 'Please wait…' : status?.state === 'running' ? 'Stop simulator' : 'Start simulator'}</button>{error && <p role="alert">{error}</p>}{status?.error && <small>{status.error}</small>}</div>;
}
export function ManualControl({ signal, revision, quality, close }: { signal: Signal; revision: number; quality: string; close: () => void }) {
  const [reason, setReason] = useState(''); const [command, setCommand] = useState<Command | null>(null); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const [uncertain, setUncertain] = useState(false); const [historyReady, setHistoryReady] = useState(false);
  const [history, setHistory] = useState<History>({ items: [], blocking: null, nextCursor: null });
  const [recoveryReason, setRecoveryReason] = useState(''); const [accepted, setAccepted] = useState(false);
  const mounted = useRef(true);
  const unresolved = (value: Command) => pendingStates.has(value.state) || (value.state === 'Unknown' && !value.reconciliation);
  async function loadHistory() {
    try {
      const result = await api<History>(`/signals/${signal.id}/commands`);
      if (mounted.current) { setHistory(result); setCommand(result.blocking ?? result.items[0] ?? null); setUncertain(!!result.blocking); setHistoryReady(true); }
    } catch { if (mounted.current) { setError('Command history unavailable'); setHistoryReady(false); } }
  }
  useEffect(() => { mounted.current = true; void loadHistory(); return () => { mounted.current = false; }; }, [signal.id]);
  async function check(id: string) {
    const latest = await api<Command>(`/commands/${id}`);
    if (mounted.current) { setCommand(latest); setUncertain(unresolved(latest)); }
    return latest;
  }
  async function send(value: boolean) {
    setBusy(true); setError(''); setCommand(null);
    try {
      // A timeout never retries a physical intent with a new idempotency key.
      const result = await api<Command>('/commands', { method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() }, body: { targetSignalId: signal.id, value, ttlMs: 2000, expectedProjectRevision: revision, reason } });
      if (!mounted.current) return; setCommand(result);
      let latest = result; const deadline = performance.now() + 5000;
      while (mounted.current && pendingStates.has(latest.state) && performance.now() < deadline) { await new Promise((resolve) => setTimeout(resolve, 200)); if (mounted.current) latest = await check(result.id); }
      if (mounted.current) { setUncertain(unresolved(latest)); setHistory((before) => ({ ...before, items: [latest, ...before.items.filter((item) => item.id !== latest.id)].slice(0, 10) })); }
    } catch (cause) { if (mounted.current) { setError(cause instanceof Error ? cause.message : 'Command status unavailable'); setUncertain(true); } }
    finally { if (mounted.current) setBusy(false); }
  }
  async function reconcile() {
    if (!command || !accepted) return;
    setBusy(true); setError('');
    try {
      const result = await api<Command>(`/commands/${command.id}/reconcile`, { method: 'POST', body: { reason: recoveryReason, acceptUnknownOutcome: true } });
      if (mounted.current) { setCommand(result); setUncertain(unresolved(result)); setHistory((before) => ({ ...before, items: before.items.map((item) => item.id === result.id ? result : item) })); }
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : 'Reconciliation unavailable'); }
    finally { if (mounted.current) setBusy(false); }
  }
  const disabled = busy || uncertain || !historyReady || quality !== 'Good' || !reason.trim();
  return <section className="panel command-panel">
    <div className="panel-heading"><div><h2>{signal.name}</h2><p className="muted">Manual control · revision {revision} · {quality}</p></div><button className="text-button" onClick={close}>Close control</button></div>
    <div className="command-fields"><label className="field"><span>Command reason</span><input aria-label="Command reason" maxLength={256} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Describe the purpose of this command" /></label><div><button className="primary" disabled={disabled} onClick={() => { void send(true); }}>Send ON</button><button className="secondary" disabled={disabled} onClick={() => { void send(false); }}>Send OFF</button></div></div>
    {command && <div role="status" aria-label="Command status" className="command-status"><span className={`badge ${command.state === 'Verified' ? 'good' : 'warning'}`}>{command.state}</span><code>{command.id}</code>{command.reason && <p>{command.reason}</p>}{command.reconciliation && <p>Reconciled · original outcome remains Unknown. {command.reconciliation.reason}</p>}</div>}
    {error && <div className="alert" role="alert">{error}</div>}
    {uncertain && <div className="command-status"><p>Outcome is not confirmed. Check the command journal before issuing another command.</p>{command && <button className="secondary" disabled={busy} onClick={() => { void check(command.id).catch(() => setError('Command status unavailable')); }}>Check status</button>}</div>}
    {command?.state === 'Unknown' && !command.reconciliation && <div className="recovery-panel"><h3>Recover a virtual LED</h3><p>Stop and restart its simulator in Devices, then reopen this control. Recovery requires Good data, a new boot session, and an observed OFF output. It never retries or verifies the original command.</p><label className="field"><span>Recovery reason</span><input maxLength={256} value={recoveryReason} onChange={(event) => setRecoveryReason(event.target.value)} /></label><label className="checkbox-field"><input type="checkbox" checked={accepted} onChange={(event) => setAccepted(event.target.checked)} />I accept that the original command outcome remains unknown</label><button className="secondary" disabled={busy || quality !== 'Good' || !recoveryReason.trim() || !accepted} onClick={() => { void reconcile(); }}>Reconcile Unknown</button></div>}
    <details className="command-history"><summary>Recent commands</summary><button className="text-button" disabled={busy} onClick={() => { void loadHistory(); }}>Reload history</button>{history.items.map((item) => <div key={item.id}><span>{item.state}{item.reconciliation ? ' · Reconciled' : ''}</span><code>{item.id}</code></div>)}{history.nextCursor && <button className="secondary" disabled={busy} onClick={() => { setBusy(true); void api<History>(`/signals/${signal.id}/commands?before=${history.nextCursor}`).then((next) => { if (mounted.current) setHistory((before) => ({ ...next, items: [...before.items, ...next.items] })); }).catch(() => setError('Command history unavailable')).finally(() => { if (mounted.current) setBusy(false); }); }}>Older commands</button>}</details>
  </section>;
}
