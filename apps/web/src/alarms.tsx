import type { AlarmDefinition } from '../../../packages/domain/src/alarms.js';
import { NotificationLog } from './notifications.js';
import { useEffect, useState, type FormEvent } from 'react';
import { api, type Project, type Device, type Signal } from './api.js';
interface Alarm { id: string; name: string; priority: string; definition: AlarmDefinition; phase: string; evaluationStale: boolean; state: { occurrence: number; acknowledged: boolean; available: boolean; suppressedUntil: string | null }; }
interface Event { id: string; kind: string; at: string; reason: string | null; }
export function AlarmWorkspace({ projects, devices, signals, initialProject }: { projects: Project[]; devices: Device[]; signals: Signal[]; initialProject: string }) {
  const [project, setProject] = useState(initialProject || projects[0]?.id || '');
  const [name, setName] = useState(''); const [signal, setSignal] = useState(''); const [condition, setCondition] = useState('unavailable');
  const [priority, setPriority] = useState('medium'); const [delay, setDelay] = useState(0);
  const [returnDelay, setReturnDelay] = useState(0); const [threshold, setThreshold] = useState(24); const [deadband, setDeadband] = useState(1);
  const [items, setItems] = useState<Alarm[]>([]); const [selected, setSelected] = useState(''); const [events, setEvents] = useState<Event[]>([]);
  const [reason, setReason] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const [online, setOnline] = useState(false); const [monitor, setMonitor] = useState('stopped');
  const numeric = condition === 'high' || condition === 'low';
  const eligible = signals.filter((s) => devices.some((d) => d.id === s.deviceId && d.projectId === project) && (condition === 'unavailable' || s.dataType === (numeric ? 'float64' : 'boolean')));
  const active = items.find((item) => item.id === selected);
  async function refresh(abort?: AbortSignal) {
    if (!project) return;
    const options = abort ? { signal: abort } : {};
    const [list, status, history] = await Promise.all([api<{ items: Alarm[] }>(`/projects/${project}/alarms`, options), api<{ state: string }>('/alarms/status', options), selected ? api<{ items: Event[] }>(`/alarms/${selected}/events`, options) : Promise.resolve({ items: [] })]);
    if (abort?.aborted) return; setItems(list.items); setMonitor(status.state); setEvents(history.items); setOnline(true);
  }
  useEffect(() => {
    let cancelled = false; let timer: ReturnType<typeof setTimeout>; let controller: AbortController;
    async function poll() {
      controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 2500);
      try { await refresh(controller.signal); } catch { if (!cancelled) setOnline(false); }
      finally { clearTimeout(timeout); if (!cancelled) timer = setTimeout(() => { void poll(); }, 1000); }
    }
    void poll(); return () => { cancelled = true; clearTimeout(timer); controller?.abort(); };
  }, [project, selected]);
  async function perform(job: () => Promise<unknown>) { setBusy(true); setError(''); try { await job(); await refresh(); } catch (e) { setError(e instanceof Error ? e.message : 'Alarm request failed'); } finally { setBusy(false); } }
  function create(event: FormEvent) {
    event.preventDefault(); void perform(async () => {
      await api(`/projects/${project}/alarms`, { method: 'POST', body: { name, signalId: signal || eligible[0]?.id, priority, definition: { condition: numeric ? { kind: 'threshold', direction: condition, threshold, deadband } : condition === 'unavailable' ? { kind: 'quality', values: ['Bad', 'Stale', 'Disconnected'] } : { kind: 'boolean', value: condition === 'on' }, activationDelayMs: delay * 1000, returnDelayMs: returnDelay * 1000 } } }); setName('');
    });
  }
  function action(kind: string) { if (!active) return; void perform(() => api(`/alarms/${active.id}/actions`, { method: 'POST', body: { kind, reason, ...(kind === 'acknowledge' ? { occurrence: active.state.occurrence } : kind === 'suppress' ? { durationMs: 60000 } : {}) } })); }
  const disabled = busy || !online || monitor !== 'running' || !reason.trim();
  return <>
    {error && <div role="alert" className="alert">{error}</div>}
    <section className="panel form-panel"><h2>Create an alarm rule</h2><form className="device-form" onSubmit={create}>
      <label className="field">Project<select value={project} onChange={(e) => { setProject(e.target.value); setSignal(''); setSelected(''); setItems([]); setOnline(false); }}>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
      <label className="field">Alarm name<input required maxLength={128} value={name} onChange={(e) => setName(e.target.value)} /></label>
      <label className="field">Alarm signal<select aria-label="Alarm signal" required value={signal || eligible[0]?.id || ''} onChange={(e) => setSignal(e.target.value)}>{eligible.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
      <label className="field">Alarm condition<select aria-label="Alarm condition" value={condition} onChange={(e) => { setCondition(e.target.value); setSignal(''); }}><option value="unavailable">Data unavailable</option><option value="on">Boolean ON</option><option value="off">Boolean OFF</option><option value="high">High threshold</option><option value="low">Low threshold</option></select></label>
      {numeric && <><label className="field">Threshold<input aria-label="Threshold" type="number" step="any" required value={threshold} onChange={(e) => setThreshold(Number(e.target.value))} /></label><label className="field">Deadband<input aria-label="Deadband" type="number" min="0" step="any" required value={deadband} onChange={(e) => setDeadband(Number(e.target.value))} /></label></>}
      <label className="field">Priority<select aria-label="Priority" value={priority} onChange={(e) => setPriority(e.target.value)}>{['low', 'medium', 'high'].map((p) => <option key={p}>{p}</option>)}</select></label>
      <label className="field">Activation delay (seconds)<input type="number" min="0" max="86400" step="1" required value={delay} onChange={(e) => setDelay(Number(e.target.value))} /></label>
      <label className="field">Return delay (seconds)<input type="number" min="0" max="86400" step="1" required value={returnDelay} onChange={(e) => setReturnDelay(Number(e.target.value))} /></label>
      <button className="primary" disabled={busy || !project || !eligible.length}>Create alarm</button>
    </form></section>
    <section className="panel"><div className="panel-heading"><h2>Alarm monitor</h2><span role="status">{online ? `Monitor ${monitor}` : 'Monitor connection unavailable'}</span></div><p className="muted system-copy">Acknowledgement records inspection. It does not clear the cause or operate equipment. Start a virtual simulator to begin monitoring.</p>
      <div className="table-scroll"><table aria-label="Alarm states"><thead><tr><th>Alarm</th><th>Priority</th><th>State</th><th>Evaluation</th><th>Suppression</th><th>Actions</th></tr></thead><tbody>{items.map((item) => <tr key={item.id}><td>{item.name}<div className="muted">{describeCondition(item.definition.condition)}</div></td><td>{item.priority}</td><td>{item.phase}</td><td>{!online || monitor !== 'running' || item.evaluationStale ? 'Not current' : item.state.available ? 'Current' : 'Input unavailable'}</td><td>{item.state.suppressedUntil ? 'Suppressed' : 'None'}</td><td><button className="secondary" onClick={() => { setSelected(item.id); setReason(''); }}>Inspect</button></td></tr>)}</tbody></table></div>
    </section>
    {active && <section className="panel"><div className="panel-heading"><h2>{active.name}</h2><span>Occurrence {active.state.occurrence}</span></div><div className="system-copy"><label className="field">Alarm action reason<input required maxLength={256} value={reason} onChange={(e) => setReason(e.target.value)} /></label><div className="inline-form">
      <button className="secondary" disabled={disabled || active.state.acknowledged || active.evaluationStale} onClick={() => action('acknowledge')}>Acknowledge</button>
      <button className="secondary" disabled={disabled || active.evaluationStale} onClick={() => action('suppress')}>Suppress for one minute</button>
      <button className="secondary" disabled={disabled || !active.state.suppressedUntil} onClick={() => action('unsuppress')}>Remove suppression</button>
    </div><p className="muted">Suppression expires automatically and is cleared on runtime restart. Latest 20 lifecycle events:</p></div><div className="table-scroll"><table aria-label="Alarm events"><thead><tr><th>Time</th><th>Event</th><th>Reason</th></tr></thead><tbody>{events.map((event) => <tr key={event.id}><td>{new Date(event.at).toLocaleString()}</td><td>{event.kind}</td><td>{event.reason ?? '—'}</td></tr>)}</tbody></table></div></section>}
    {project && <NotificationLog key={project} project={project} />}
  </>;
}

function describeCondition(condition: AlarmDefinition['condition']): string {
  if (condition.kind === 'boolean') return `Boolean ${condition.value ? 'ON' : 'OFF'}`;
  if (condition.kind === 'quality') return `Quality: ${condition.values.join(', ')}`;
  const high = condition.direction === 'high';
  return `${high ? 'High ≥' : 'Low ≤'} ${condition.threshold} · reset ${high ? '<' : '>'} ${condition.threshold + (high ? -condition.deadband : condition.deadband)}`;
}
