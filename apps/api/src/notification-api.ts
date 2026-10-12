import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { audit, transaction } from './store.js';
const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: 'object', additionalProperties: false, properties, required });
const uuid = { type: 'string', format: 'uuid' }; const params = object({ id: uuid });
class NotificationError extends Error { constructor(readonly statusCode: number, readonly code: string, message: string) { super(message); } }
export function registerNotifications(app: FastifyInstance, pool: Pool) {
  async function owner(id: string, actor: string, project = false) {
    const result = await pool.query(project ? 'SELECT id FROM apcs_projects WHERE id=$1 AND owner_id=$2' : 'SELECT d.id FROM apcs_notification_deliveries d JOIN apcs_projects p ON p.id=d.project_id WHERE d.id=$1 AND p.owner_id=$2', [id, actor]);
    if (!result.rowCount) throw new NotificationError(404, 'NOT_FOUND', 'Notification or project not found');
  }
  app.get<{ Params: { id: string }; Querystring: { before?: string } }>('/api/v1/projects/:id/notifications', { schema: { params, querystring: object({ before: uuid }, []) } }, async (request) => {
    const id = request.params.id; await owner(id, request.sessionUser!.id, true);
    const rows = (await pool.query(`SELECT d.id,d.event_id AS "eventId",d.route_id AS "routeId",d.state,d.attempts,d.created_at AS "createdAt",d.due_at AS "dueAt",d.last_error AS "lastError",a.name AS "alarmName",
      (d.state='Dead' AND d.attempts<8 AND r.enabled AND r.fingerprint=d.fingerprint) AS "canRetry"
      FROM apcs_notification_deliveries d JOIN apcs_alarms a ON a.id=d.alarm_id JOIN apcs_notification_routes r ON r.id=d.route_id WHERE d.project_id=$1
      AND ($2::uuid IS NULL OR (d.created_at,d.id)<(SELECT created_at,id FROM apcs_notification_deliveries WHERE id=$2 AND project_id=$1))
      ORDER BY d.created_at DESC,d.id DESC LIMIT 21`, [id, request.query.before ?? null])).rows;
    const routes = (await pool.query(`SELECT metadata,enabled,dropped FROM apcs_notification_routes WHERE metadata->'projectIds'='[]'::jsonb OR (metadata->'projectIds') ? $1 ORDER BY id LIMIT 100`, [id])).rows.map((row) => ({ ...row.metadata, enabled: row.enabled, dropped: row.dropped }));
    const status = (await pool.query("SELECT state,heartbeat_at AS \"heartbeatAt\",heartbeat_at<clock_timestamp()-interval '10 seconds' AS stale FROM apcs_notification_service")).rows[0];
    return { items: rows.slice(0, 20), nextBefore: rows.length > 20 ? rows[19].id : null, routes, service: status ? { ...status, state: status.stale && status.state === 'running' ? 'unavailable' : status.state } : { state: 'not configured', heartbeatAt: null, stale: true } };
  });
  app.get<{ Params: { id: string } }>('/api/v1/notifications/:id/attempts', { schema: { params } }, async (request) => {
    await owner(request.params.id, request.sessionUser!.id);
    return { items: (await pool.query('SELECT attempt,started_at AS "startedAt",completed_at AS "completedAt",outcome FROM apcs_notification_attempts WHERE delivery_id=$1 ORDER BY attempt LIMIT 8', [request.params.id])).rows };
  });
  app.post<{ Params: { id: string }; Body: { reason: string } }>('/api/v1/notifications/:id/retry', { schema: { params, body: object({ reason: { type: 'string', minLength: 1, maxLength: 256, pattern: '\\S' } }) } }, async (request, reply) => {
    const actor = request.sessionUser!.id; await owner(request.params.id, actor);
    await transaction(pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(9021007)');
      const row = (await client.query(`SELECT d.* FROM apcs_notification_deliveries d JOIN apcs_projects p ON p.id=d.project_id JOIN apcs_notification_routes r ON r.id=d.route_id
        WHERE d.id=$1 AND p.owner_id=$2 AND d.state='Dead' AND d.attempts<8 AND r.enabled AND r.fingerprint=d.fingerprint FOR UPDATE OF d`, [request.params.id, actor])).rows[0];
      if (!row || Number((await client.query("SELECT count(*) FROM apcs_notification_deliveries WHERE route_id=$1 AND state IN ('Pending','Sending')", [row.route_id])).rows[0].count) >= 1000) throw new NotificationError(409, 'RETRY_BLOCKED', 'Notification cannot be retried');
      await client.query("UPDATE apcs_notification_deliveries SET state='Pending',due_at=clock_timestamp(),completed_at=NULL,last_error=NULL WHERE id=$1", [row.id]);
      await audit(client, actor, 'notification.retry', row.id, { reason: request.body.reason.trim(), attempts: row.attempts });
    });
    return reply.code(204).send();
  });
}
