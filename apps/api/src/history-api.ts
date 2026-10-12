import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { PgSignalArchive } from '../../../packages/storage/src/signal-archive.js';
import type { RuntimeControl } from './runtime-service.js';
const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: 'object', additionalProperties: false, properties, required });
class HistoryError extends Error { constructor(readonly statusCode: number, readonly code: string, message: string) { super(message); } }
export function registerHistory(app: FastifyInstance, pool: Pool, runtime?: RuntimeControl) {
  const archive = new PgSignalArchive(pool);
  app.get('/api/v1/history/status', async () => runtime?.historyStatus() ?? { active: false, queued: 0, dropped: 0, failures: 0, written: 0, pruned: 0, maintenanceError: null, observerFailures: 0, error: 'Runtime service is not configured' });
  app.get<{ Params: { id: string }; Querystring: { from: string; to: string; before?: string; limit?: string } }>('/api/v1/signals/:id/history', {
    schema: { params: object({ id: { type: 'string', format: 'uuid' } }), querystring: object({ from: { type: 'string', format: 'date-time' }, to: { type: 'string', format: 'date-time' }, before: { type: 'string', pattern: '^[1-9][0-9]{0,17}$' }, limit: { type: 'string', pattern: '^(1000|[1-9][0-9]{0,2})$' } }, ['from', 'to']) },
  }, async (request) => {
    const found = await pool.query('SELECT s.id FROM apcs_signals s JOIN apcs_devices d ON d.id=s.device_id JOIN apcs_projects p ON p.id=d.project_id WHERE s.id=$1 AND p.owner_id=$2', [request.params.id, request.sessionUser!.id]);
    if (!found.rowCount) throw new HistoryError(404, 'NOT_FOUND', 'Signal not found');
    try { return await archive.read(request.params.id, { ...request.query, limit: Number(request.query.limit ?? 100) }); }
    catch (error) {
      if (error instanceof Error && /^(History range|History limit|Invalid history cursor)/.test(error.message)) throw new HistoryError(422, 'INVALID_HISTORY_QUERY', error.message);
      throw error;
    }
  });
}
