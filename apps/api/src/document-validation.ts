import type { Pool, PoolClient } from 'pg';
import { validateGraph, type LogicGraph } from '../../../packages/domain/src/logic.js';
import { validateScreen, type Screen } from '../../../packages/domain/src/screen.js';
type Kind = 'graph' | 'screen';
class DocumentValidationError extends Error {
  readonly statusCode = 422;
  readonly code = 'INVALID_DOCUMENT';
}
const invalid = (message: string) => new DocumentValidationError(message);
export function validateDocument(kind: Kind, document: unknown, complete: boolean): LogicGraph | Screen {
  try { return kind === 'graph' ? validateGraph(document, complete) : validateScreen(document); }
  catch (error) { throw invalid(error instanceof Error ? error.message : 'Invalid document'); }
}
export async function validateBindings(client: Pool | PoolClient, projectId: string, kind: Kind, document: LogicGraph | Screen) {
  const entries = kind === 'graph' ? (document as LogicGraph).nodes : (document as Screen).items;
  const bound = entries.filter((item) => item.signalId);
  const ids = [...new Set(bound.map((item) => item.signalId!))];
  if (!ids.length) return;
  const result = await client.query<{ id: string; direction: string; data_type: string }>(`SELECT s.id, s.direction, s.data_type FROM apcs_signals s JOIN apcs_devices d ON d.id = s.device_id WHERE d.project_id = $1 AND s.id::text = ANY($2::text[])`, [projectId, ids]);
  if (result.rows.length !== ids.length) throw invalid('A signal binding is missing or belongs to another project');
  for (const item of bound) {
    const signal = result.rows.find((s) => s.id === item.signalId)!;
    const expectedType = ((kind === 'graph' && item.kind === 'analog') || (kind === 'screen' && item.kind === 'value')) ? 'float64' : 'boolean';
    const matchingType = kind === 'screen' && item.kind === 'trend' ? ['boolean','float64'].includes(signal.data_type) : signal.data_type === expectedType;
    if (!matchingType || (['output', 'button'].includes(item.kind) && signal.direction !== 'output')) throw invalid('Signal type or direction does not match its binding');
  }
}
