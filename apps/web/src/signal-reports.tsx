import { useEffect, useRef, useState } from 'react';
import { reportMeasurement, type SignalReport } from '../../../packages/domain/src/history-report.js';
import { api, type Signal } from './api.js';
interface Job { id: string; period: 'day' | 'month'; date: string; state: string; createdAt: string; error: string | null; }
const number = (v: number | null) => v === null ? 'Not available' : v.toLocaleString('en-US', { maximumFractionDigits: 3 });
export function SignalReports({ signal }: { signal: Signal }) {
  const [period, setPeriod] = useState<'day' | 'month'>('day'); const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [jobs, setJobs] = useState<Job[]>([]); const [enabled, setEnabled] = useState(false); const [report, setReport] = useState<SignalReport | null>(null);
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const key = useRef(crypto.randomUUID()); const mounted = useRef(true); const previewRequest = useRef(0);
  useEffect(() => {
    mounted.current = true; const abort = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try { const result = await api<{ enabled: boolean; items: Job[] }>(`/signals/${signal.id}/reports`, { signal: AbortSignal.any([abort.signal, AbortSignal.timeout(3000)]) }); if (mounted.current) { setJobs(result.items); setEnabled(result.enabled); } }
      catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : 'Reports unavailable'); }
      finally { if (mounted.current) timer = setTimeout(() => { void poll(); }, 1000); }
    }
    void poll(); return () => { mounted.current = false; abort.abort(); clearTimeout(timer); };
  }, [signal.id]);
  async function generate() {
    setBusy(true); setError('');
    try { const job = await api<Job>(`/signals/${signal.id}/reports`, { method: 'POST', body: { period, date, requestKey: key.current }, signal: AbortSignal.timeout(5000) }); if (mounted.current) { key.current = crypto.randomUUID(); setJobs((previous) => [job, ...previous.filter((item) => item.id !== job.id)].slice(0, 20)); } }
    catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : 'Report request failed'); }
    finally { if (mounted.current) setBusy(false); }
  }
  async function view(id: string) {
    const epoch = ++previewRequest.current; setError('');
    try { const result = await api<{ report: SignalReport | null }>(`/reports/${id}`, { signal: AbortSignal.timeout(3000) }); if (mounted.current && previewRequest.current === epoch) setReport(result.report); }
    catch (cause) { if (mounted.current && previewRequest.current === epoch) setError(cause instanceof Error ? cause.message : 'Report unavailable'); }
  }
  return <section className="signal-reports" aria-label="Signal reports"><div className="system-copy"><h3>Daily and monthly reports</h3><p className="muted">Generate a fixed snapshot from hourly aggregates. All report intervals use UTC. Missing data remains Unknown. Unit and precision are captured when generation starts, not when queued. PDF and CSV are generated in the background and retained for up to 7 days or the latest 92 completed jobs in this workspace.</p></div>
    <form className="history-filters" onSubmit={(event) => { event.preventDefault(); void generate(); }}>
      <label className="field">Report period<select aria-label="Report period" value={period} onChange={(e) => { const value = e.target.value as 'day' | 'month'; setPeriod(value); setDate(value === 'month' ? date.slice(0, 7) : `${date.slice(0, 7)}-01`); key.current = crypto.randomUUID(); }}><option value="day">Daily</option><option value="month">Monthly</option></select></label>
      <label className="field">Report date (UTC)<input aria-label="Report date (UTC)" type={period === 'day' ? 'date' : 'month'} required min={period === 'day' ? '1900-01-01' : '1900-01'} max={period === 'day' ? '2100-12-31' : '2100-12'} value={date} onChange={(e) => { setDate(e.target.value); key.current = crypto.randomUUID(); }} /></label>
      <button className="primary" disabled={!enabled || busy}>Generate report</button>
    </form>
    {!enabled && <p className="history-status">Report generation is not configured.</p>}{error && <p className="alert" role="alert">{error}</p>}
    <div className="table-scroll"><table aria-label="Report jobs"><thead><tr><th>UTC period</th><th>Requested</th><th>State</th><th>Files</th></tr></thead><tbody>{jobs.map((job) => <tr key={job.id}><td>{job.period === 'day' ? 'Daily' : 'Monthly'} · {job.date}</td><td>{new Date(job.createdAt).toLocaleString()}</td><td><span className={`badge ${job.state === 'Ready' ? 'good' : 'warning'}`}>{job.state}</span>{job.error && <p>{job.error}</p>}</td><td><div className="report-actions">{job.state === 'Ready' && <><button className="text-button" onClick={() => { void view(job.id); }}>View report</button><a href={`/api/v1/reports/${job.id}/pdf`}>Download PDF</a><a href={`/api/v1/reports/${job.id}/csv`}>Download report CSV</a></>}</div></td></tr>)}</tbody></table></div>
    {!jobs.length && <p className="history-status">No report jobs for this signal.</p>}
    {report && <section className="report-preview" aria-label="Report preview"><div className="report-heading"><div><span className="eyebrow">Open APCS · Template {report.templateVersion}</span><h3>{report.period === 'day' ? 'Daily' : 'Monthly'} report · {report.date}</h3><p>{report.signal.name}</p></div><button className="text-button" onClick={() => setReport(null)}>Close report</button></div>
      <p className="muted">{report.summary.from} — {report.summary.to} (exclusive) · UTC<br />Generated {report.generatedAt}<br />{report.profile === 'digital' ? 'Boolean state and durations in seconds' : report.templateVersion===2?`Unit: ${report.signal.unit||'not configured'} · ${report.signal.displayDecimals} decimal places · signal revision ${report.signal.revision}`:'Measurement units were not captured (legacy template)'}</p>
      <div className="report-metrics">{(['Good', 'Bad', 'Stale', 'Disconnected', 'Unknown'] as const).map((quality) => <div key={quality}><span>{quality}</span><strong>{number(report.summary.qualityMs[quality] / 1000)} s</strong></div>)}</div>
      <p>Calculated hours: {report.summary.usedHours} / {report.summary.expectedHours} · Pending: {report.summary.pendingHours} · Missing: {report.summary.missingHours}</p>
      <p className="muted">Means use Good duration. Missing or recalculation-pending hours are Unknown. Current and future periods are provisional.</p>
      <div className="table-scroll"><table aria-label="Report breakdown"><thead><tr><th>UTC start</th><th>Good seconds</th><th>Unknown seconds</th>{report.profile === 'digital' ? <><th>ON seconds</th><th>OFF seconds</th><th>Transitions</th></> : <><th>Mean</th><th>Minimum</th><th>Maximum</th></>}<th>Pending / missing hours</th></tr></thead><tbody>{[report.summary, ...report.rows].map((row, i) => <tr key={i}><td>{i === 0 ? 'Period total' : report.period === 'day' ? row.from.slice(11, 16) : row.from.slice(0, 10)}</td><td>{number(row.qualityMs.Good / 1000)}</td><td>{number(row.qualityMs.Unknown / 1000)}</td>{report.profile === 'digital' ? <><td>{number(row.trueMs / 1000)}</td><td>{number(row.falseMs / 1000)}</td><td>{number(row.transitions)}</td></> : <><td>{reportMeasurement(row.mean,report)}</td><td>{reportMeasurement(row.min,report)}</td><td>{reportMeasurement(row.max,report)}</td></>}<td>{row.pendingHours} / {row.missingHours}</td></tr>)}</tbody></table></div>
      <p className="muted report-identity">Report {report.id} · Signal {report.signal.id} · This snapshot is not digitally signed.</p>
    </section>}
  </section>;
}
