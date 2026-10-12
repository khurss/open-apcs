import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { PgHistoryAggregates } from '../../../packages/storage/src/history-aggregates.js';
const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: 'object', additionalProperties: false, properties, required });
class AggregateError extends Error { constructor(readonly statusCode: number, readonly code: string, message: string) { super(message); } }
export function registerAggregates(app: FastifyInstance, pool: Pool) {
  const aggregates = new PgHistoryAggregates(pool);
  app.get('/api/v1/history/aggregates/status', async () => {
    const service = (await pool.query("SELECT state,heartbeat_at AS \"heartbeatAt\",heartbeat_at<clock_timestamp()-interval '10 seconds' AS stale FROM apcs_history_aggregate_service")).rows[0];
    const counts = (await pool.query('SELECT count(*) AS pending,count(*) FILTER(WHERE last_error IS NOT NULL) AS blocked FROM apcs_history_aggregate_jobs')).rows[0];
    const backfill = (await pool.query('SELECT done FROM apcs_history_aggregate_backfill')).rows[0];
    return { state: !service ? 'not running' : service.stale && service.state === 'running' ? 'unavailable' : service.state, heartbeatAt: service?.heartbeatAt ?? null, pending: Number(counts.pending), blocked: Number(counts.blocked), backfillComplete: backfill?.done ?? false };
  });
  app.get<{ Params: { id: string }; Querystring: { from: string; to: string; resolution: '60' | '3600'; before?: string; limit?: string } }>('/api/v1/signals/:id/aggregates', {
    schema: { params: object({ id: { type: 'string', format: 'uuid' } }), querystring: object({ from: { type: 'string', format: 'date-time' }, to: { type: 'string', format: 'date-time' }, resolution: { enum: ['60', '3600'] }, before: { type: 'string', format: 'date-time' }, limit: { type: 'string', pattern: '^(1000|[1-9][0-9]{0,2})$' } }, ['from', 'to', 'resolution']) },
  }, async (request) => {
    const found = await pool.query('SELECT s.id FROM apcs_signals s JOIN apcs_devices d ON d.id=s.device_id JOIN apcs_projects p ON p.id=d.project_id WHERE s.id=$1 AND p.owner_id=$2', [request.params.id, request.sessionUser!.id]);
    if (!found.rowCount) throw new AggregateError(404, 'NOT_FOUND', 'Signal not found');
    try { return await aggregates.read(request.params.id, { ...request.query, resolution: Number(request.query.resolution) as 60 | 3600, limit: Number(request.query.limit ?? 100) }); }
    catch (error) { if (error instanceof Error && /^(Aggregate range|Invalid aggregate page)/.test(error.message)) throw new AggregateError(422, 'INVALID_AGGREGATE_QUERY', error.message); throw error; }
  });
}
