import { useEffect, useState } from 'react';
import type { GraphEvaluation } from '../../../packages/domain/src/graph-evaluation.js';
export function GraphEvaluationView({ evaluation, state, revision, pending }: { evaluation: GraphEvaluation | null; state: string; revision: number | null; pending: string[] }) {
  const [limit, setLimit] = useState(50); const [, refresh] = useState(0);
  useEffect(() => { const timer = setInterval(() => refresh((value) => value + 1), 1000); return () => clearInterval(timer); }, []);
  const age = evaluation ? Date.now() - Date.parse(evaluation.at) : NaN;
  const recent = state === 'running' && Number.isFinite(age) && age >= 0 && age <= 3000;
  return <details className="graph-evaluation"><summary>Last server evaluation</summary>
    <p className="muted">Calculated values belong to activated revision {revision === null ? '—' : `r${revision}`}. They are not equipment feedback or command acknowledgements.</p>
    <p role="status" aria-label="Evaluation freshness" className={`badge ${recent ? 'good' : 'warning'}`}>{!evaluation ? 'No calculation available' : recent ? 'Recent calculation' : 'Historical or overdue calculation'}</p>
    <p>Tracked pending commands: {pending.length}</p>
    {evaluation && <><p>Cycle {evaluation.cycle} · <time dateTime={evaluation.at}>{evaluation.at}</time></p>
      <div className="table-scroll"><table aria-label="Active revision values"><thead><tr><th>Block</th><th>Calculated value</th><th>Quality at calculation</th><th>Sequence / reason</th></tr></thead><tbody>{evaluation.blocks.slice(0, limit).map((block) => {
        const value = evaluation.result.nodes[block.id];
        return <tr key={block.id}><td>{block.label}<small>{block.kind}</small></td><td>{value?.value == null ? 'Unavailable' : typeof value.value === 'boolean' ? value.value ? 'ON' : 'OFF' : String(value.value)}</td><td>{value?.quality ?? 'Unavailable'}</td><td>{value?.sequence ? `${value.sequence.state}${value.sequence.step === null ? '' : ` · Step ${value.sequence.step + 1}: ${value.sequence.label}`}` : value?.reason ?? '—'}</td></tr>;
      })}</tbody></table></div>
      {evaluation.blocks.length > limit && <button type="button" className="secondary" onClick={() => setLimit(Math.min(256, limit + 50))}>Show 50 more blocks</button>}
    </>}
  </details>;
}
