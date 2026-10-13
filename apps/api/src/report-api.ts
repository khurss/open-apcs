import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { reportRange } from '../../../packages/domain/src/history-report.js';
import { audit, transaction } from './store.js';
const object = (properties: Record<string, unknown>) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const uuid = { type: 'string', format: 'uuid' }; const params = object({ id: uuid });
class ReportError extends Error { constructor(readonly statusCode: number, readonly code: string, message: string) { super(message); } }
const missing = () => new ReportError(404, 'NOT_FOUND', 'Report or signal not found');
const fields = 'r.id,r.signal_id AS "signalId",r.period,r.date,r.state,r.created_at AS "createdAt",r.completed_at AS "completedAt",r.error';
const owned = 'FROM apcs_report_jobs r JOIN apcs_signals s ON s.id=r.signal_id JOIN apcs_devices d ON d.id=s.device_id JOIN apcs_projects p ON p.id=d.project_id WHERE r.actor_id=$1 AND p.owner_id=$1';
export async function pruneReports(client: Pool | PoolClient): Promise<void> {
  await client.query(`DELETE FROM apcs_report_jobs WHERE id IN (
    SELECT id FROM apcs_report_jobs WHERE state IN ('Ready','Failed') AND created_at<clock_timestamp()-interval '7 days'
    UNION SELECT id FROM (SELECT id FROM apcs_report_jobs WHERE state IN ('Ready','Failed') ORDER BY created_at DESC,id DESC OFFSET 92) excess)`);
}
export function registerReports(app: FastifyInstance, pool: Pool, enabled: boolean) {
  app.post<{ Params: { id: string }; Body: { period: 'day' | 'month'; date: string; requestKey: string } }>('/api/v1/signals/:id/reports', {
    schema: { params, body: object({ period: { enum: ['day', 'month'] }, date: { type: 'string', maxLength: 10 }, requestKey: uuid }) },
  }, async (request, reply) => {
    if (!enabled) throw new ReportError(503, 'REPORTS_UNAVAILABLE', 'Report service unavailable');
    try { reportRange(request.body.period, request.body.date); } catch (error) { throw new ReportError(422, 'INVALID_REPORT', (error as Error).message); }
    return transaction(pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext(current_schema()),9021011)');
      const signal = (await client.query('SELECT s.data_type FROM apcs_signals s JOIN apcs_devices d ON d.id=s.device_id JOIN apcs_projects p ON p.id=d.project_id WHERE s.id=$1 AND p.owner_id=$2', [request.params.id, request.sessionUser!.id])).rows[0];
      if (!signal) throw missing(); if (!['boolean', 'float64'].includes(signal.data_type)) throw new ReportError(422, 'UNSUPPORTED_REPORT', 'Reports currently support boolean and float64 signals');
      const existing = (await client.query(`SELECT ${fields} ${owned} AND r.request_key=$2`, [request.sessionUser!.id, request.body.requestKey])).rows[0];
      if (existing) { if (existing.signalId !== request.params.id || existing.period !== request.body.period || existing.date !== request.body.date) throw new ReportError(409, 'REQUEST_CONFLICT', 'Report request key changed'); return existing; }
      await pruneReports(client);
      const counts = (await client.query("SELECT count(*)::int AS total,count(*) FILTER(WHERE state IN ('Queued','Generating'))::int AS pending FROM apcs_report_jobs")).rows[0];
      if (counts.total >= 100 || counts.pending >= 8) throw new ReportError(429, 'REPORT_CAPACITY', 'Report queue capacity reached');
      const id = randomUUID(); await client.query('INSERT INTO apcs_report_jobs(id,actor_id,signal_id,request_key,period,date) VALUES($1,$2,$3,$4,$5,$6)', [id, request.sessionUser!.id, request.params.id, request.body.requestKey, request.body.period, request.body.date]);
      await audit(client, request.sessionUser!.id, 'report.requested', id, { signalId: request.params.id, period: request.body.period, date: request.body.date });
      reply.code(202); return (await client.query(`SELECT ${fields} ${owned} AND r.id=$2`, [request.sessionUser!.id, id])).rows[0];
    });
  });
  app.get<{ Params: { id: string } }>('/api/v1/signals/:id/reports', { schema: { params } }, async (request) => {
    const signal = await pool.query('SELECT s.id FROM apcs_signals s JOIN apcs_devices d ON d.id=s.device_id JOIN apcs_projects p ON p.id=d.project_id WHERE s.id=$1 AND p.owner_id=$2', [request.params.id, request.sessionUser!.id]); if (!signal.rowCount) throw missing();
    return { enabled, items: (await pool.query(`SELECT ${fields} ${owned} AND r.signal_id=$2 ORDER BY r.created_at DESC,r.id DESC LIMIT 20`, [request.sessionUser!.id, request.params.id])).rows };
  });
  app.get<{ Params: { id: string } }>('/api/v1/reports/:id', { schema: { params } }, async (request) => {
    const row = (await pool.query(`SELECT ${fields},r.report ${owned} AND r.id=$2`, [request.sessionUser!.id, request.params.id])).rows[0]; if (!row) throw missing(); return row;
  });
  for (const format of ['csv', 'pdf'] as const) app.get<{ Params: { id: string } }>(`/api/v1/reports/:id/${format}`, { schema: { params } }, async (request, reply) => {
    const row = (await pool.query(`SELECT r.state,r.${format} AS artifact ${owned} AND r.id=$2`, [request.sessionUser!.id, request.params.id])).rows[0]; if (!row) throw missing();
    if (row.state !== 'Ready') throw new ReportError(409, 'REPORT_NOT_READY', 'Report artifact is not ready');
    reply.header('Content-Disposition', `attachment; filename="open-apcs-report-${request.params.id}.${format}"`).type(format === 'pdf' ? 'application/pdf' : 'text/csv; charset=utf-8'); return row.artifact;
  });
}
