import { GraphEvaluationView } from './graph-evaluation.js';
import type { GraphEvaluation } from '../../../packages/domain/src/graph-evaluation.js';
import { useEffect, useRef, useState } from 'react';
import { api } from './api.js';
interface Status { state: string; revision: number | null; error: string | null; cycles: number; activationId: string | null; pending: string[]; evaluation: GraphEvaluation | null; }
export function GraphRuntimePanel({ id, revisions, dirty }: { id: string; revisions: number[]; dirty: boolean }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [reason, setReason] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const epoch = useRef(0);
  useEffect(() => {
    let active = true; let timer: ReturnType<typeof setTimeout>; let controller: AbortController | undefined;
    async function read() {
      const generation = epoch.current; controller = new AbortController();
      const deadline = setTimeout(() => controller?.abort(), 3000);
      try { const result = await api<Status>(`/graphs/${id}/runtime`, { signal: controller.signal }); if (active && generation === epoch.current) setStatus(result); }
      catch { if (active && generation === epoch.current) setStatus(null); }
      finally { clearTimeout(deadline); }
      if (active) timer = setTimeout(() => { void read(); }, 1000);
    }
    void read(); return () => { active = false; clearTimeout(timer); controller?.abort(); };
  }, [id]);
  async function change(action: 'activate' | 'stop', revision?: number) {
    setBusy(true); setError(''); epoch.current++;
    try { setStatus(await api<Status>(`/graphs/${id}/runtime`, { method: 'POST', body: { action, reason, ...(revision ? { revision } : {}) } })); }
    catch (cause) { setStatus(null); setError(cause instanceof Error ? cause.message : 'Graph operation failed'); }
    finally { epoch.current++; setBusy(false); }
  }
  return <section className="panel graph-runtime-panel"><div className="panel-heading"><div><h2>Server execution</h2><p className="muted">Start bound simulators or explicitly arm LED benches before activation. Stopping revokes their control sessions.</p></div><span role="status" aria-label="Graph runtime" className={`badge ${status?.state === 'running' ? 'good' : 'warning'}`}>{status ? `${status.state}${status.revision ? ` · r${status.revision}` : ''} · ${status.cycles} cycles` : 'Status unavailable'}</span></div>
    <label className="field"><span>Activation reason</span><input maxLength={256} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Why are you changing the running logic?" /></label>
    <div className="graph-runtime-actions">{revisions.map((revision) => <button key={revision} className="primary" disabled={busy || dirty || !reason.trim() || !status} onClick={() => { void change('activate', revision); }}>Activate revision {revision}</button>)}<button className="secondary" disabled={busy || !reason.trim() || !status || status.state === 'stopped'} onClick={() => { void change('stop'); }}>Stop graph</button></div>
    {status && <GraphEvaluationView key={status.activationId ?? 'inactive'} evaluation={status.evaluation} state={status.state} revision={status.revision} pending={status.pending} />}
    {dirty && <p className="muted">Save or discard draft changes before choosing a prepared revision.</p>}{status?.error && <p role="alert">{status.error}</p>}{error && <p className="alert" role="alert">{error}</p>}
  </section>;
}
