import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { parseNotificationConfig, publicRoute, routeFingerprint, type NotificationRoute, type PublicRoute } from '../../../packages/notifications/src/config.js';
import { transaction } from './store.js';
export interface NotificationJob { id: string; routeId: string; fingerprint: string; eventId: string; body: string; attempt: number; token: string; }
// Synchronization and enqueueing share this lock so route changes and capacity checks are atomic.
const lock = (client: PoolClient) => client.query('SELECT pg_advisory_xact_lock(9021007)');
export async function syncNotificationRoutes(pool: Pool, input: NotificationRoute[]): Promise<void> {
  const { routes } = parseNotificationConfig({ version: 1, routes: input });
  await transaction(pool, async (client) => {
    await lock(client);
    await client.query('UPDATE apcs_notification_routes SET enabled=false,updated_at=clock_timestamp() WHERE enabled AND NOT(id=ANY($1::text[]))', [routes.map((route) => route.id)]);
    for (const route of routes) await client.query(`INSERT INTO apcs_notification_routes(id,metadata,fingerprint) VALUES($1,$2,$3)
      ON CONFLICT(id) DO UPDATE SET metadata=$2,fingerprint=$3,enabled=true,updated_at=clock_timestamp()`, [route.id, publicRoute(route), routeFingerprint(route)]);
    const cancelled = await client.query(`UPDATE apcs_notification_deliveries d SET state='Cancelled',completed_at=clock_timestamp(),lease_token=NULL,lease_until=NULL,last_error='Destination configuration changed'
      FROM apcs_notification_routes r WHERE d.route_id=r.id AND d.state IN ('Pending','Sending') AND (NOT r.enabled OR d.fingerprint<>r.fingerprint) RETURNING d.id`);
    await client.query("UPDATE apcs_notification_attempts SET outcome='Cancelled',completed_at=clock_timestamp() WHERE delivery_id=ANY($1::uuid[]) AND outcome IS NULL", [cancelled.rows.map((row) => row.id)]);
  });
}
export async function enqueueNotifications(client: PoolClient, alarmId: string, event: { version: number; kind: string; occurrence: number; at: string }, state: { active: boolean; acknowledged: boolean; suppressedUntil: string | null }): Promise<void> {
  if (state.suppressedUntil !== null || !['Activated', 'Reactivated', 'Returned', 'Unsuppressed'].includes(event.kind) || (event.kind === 'Unsuppressed' && (!state.active || state.acknowledged))) return;
  await lock(client);
  const alarm = (await client.query('SELECT project_id,name,priority FROM apcs_alarms WHERE id=$1', [alarmId])).rows[0];
  if (!alarm) throw new Error('Alarm missing during notification enqueue');
  const routes = (await client.query<{ id: string; metadata: PublicRoute; fingerprint: string }>('SELECT id,metadata,fingerprint FROM apcs_notification_routes WHERE enabled ORDER BY id')).rows;
  const eventId = `${alarmId}:${event.version}`;
  const body = JSON.stringify({ version: 1, eventId, alarmId, projectId: alarm.project_id, name: alarm.name, priority: alarm.priority, kind: event.kind, occurrence: event.occurrence, at: event.at });
  for (const route of routes) {
    if (!route.metadata.priorities.includes(alarm.priority) || !route.metadata.events.includes(event.kind as PublicRoute['events'][number]) || (route.metadata.projectIds.length && !route.metadata.projectIds.includes(alarm.project_id))) continue;
    if ((await client.query('SELECT 1 FROM apcs_notification_deliveries WHERE route_id=$1 AND event_id=$2', [route.id, eventId])).rowCount) continue;
    const count = Number((await client.query("SELECT count(*) FROM apcs_notification_deliveries WHERE route_id=$1 AND state IN ('Pending','Sending')", [route.id])).rows[0].count);
    if (count >= 1000 || Buffer.byteLength(body) > 8192) { await client.query('UPDATE apcs_notification_routes SET dropped=dropped+1 WHERE id=$1', [route.id]); continue; }
    await client.query("INSERT INTO apcs_notification_deliveries(id,route_id,fingerprint,project_id,alarm_id,event_id,body,state) VALUES($1,$2,$3,$4,$5,$6,$7,'Pending')", [randomUUID(), route.id, route.fingerprint, alarm.project_id, alarmId, eventId, body]);
  }
}
export async function claimNotification(pool: Pool): Promise<NotificationJob | null> {
  return transaction(pool, async (client) => {
    const row = (await client.query(`SELECT d.* FROM apcs_notification_deliveries d JOIN apcs_notification_routes r ON r.id=d.route_id
      WHERE r.enabled AND r.fingerprint=d.fingerprint AND ((d.state='Pending' AND d.due_at<=clock_timestamp()) OR (d.state='Sending' AND d.lease_until<=clock_timestamp()))
      ORDER BY d.due_at,d.id LIMIT 1 FOR UPDATE OF d SKIP LOCKED`)).rows[0];
    if (!row) return null;
    if (row.state === 'Sending') await client.query("UPDATE apcs_notification_attempts SET outcome='Unknown',completed_at=clock_timestamp() WHERE delivery_id=$1 AND attempt=$2 AND outcome IS NULL", [row.id, row.attempts]);
    if (row.attempts >= 8) { await client.query("UPDATE apcs_notification_deliveries SET state='Dead',completed_at=clock_timestamp(),lease_token=NULL,lease_until=NULL,last_error='Attempt limit reached after unknown outcome' WHERE id=$1", [row.id]); return null; }
    const token = randomUUID(); const attempt = row.attempts + 1;
    await client.query("UPDATE apcs_notification_deliveries SET state='Sending',attempts=$2,lease_token=$3,lease_until=clock_timestamp()+interval '30 seconds' WHERE id=$1", [row.id, attempt, token]);
    await client.query('INSERT INTO apcs_notification_attempts(delivery_id,attempt) VALUES($1,$2)', [row.id, attempt]);
    return { id: row.id, routeId: row.route_id, fingerprint: row.fingerprint, eventId: row.event_id, body: row.body, attempt, token };
  });
}
export async function finishNotification(pool: Pool, job: NotificationJob, error?: { retryable: boolean; message: string }): Promise<boolean> {
  return transaction(pool, async (client) => {
    const row = (await client.query("SELECT id FROM apcs_notification_deliveries WHERE id=$1 AND state='Sending' AND lease_token=$2 AND lease_until>clock_timestamp() FOR UPDATE", [job.id, job.token])).rows[0];
    if (!row) return false;
    const state = !error ? 'Delivered' : error.retryable && job.attempt < 8 ? 'Pending' : 'Dead';
    const outcome = state === 'Pending' ? 'Retry' : state;
    await client.query(`UPDATE apcs_notification_deliveries SET state=$2,lease_token=NULL,lease_until=NULL,
      due_at=clock_timestamp()+($3::integer*interval '1 second'),last_error=$4,completed_at=CASE WHEN $2='Pending' THEN NULL ELSE clock_timestamp() END WHERE id=$1`,
    [job.id, state, Math.min(60, 2 ** (job.attempt - 1)), error ? error.retryable ? 'Transport unavailable or rejected; retry permitted' : 'Transport rejected; automatic retry disabled' : null]);
    await client.query('UPDATE apcs_notification_attempts SET outcome=$3,completed_at=clock_timestamp() WHERE delivery_id=$1 AND attempt=$2', [job.id, job.attempt, outcome]);
    return true;
  });
}
/** Terminal rows retain at most one year and 10,000 results per destination. Active work is never pruned. */
export async function pruneNotifications(pool: Pool): Promise<void> {
  await pool.query(`WITH ranked AS (SELECT id,completed_at,row_number() OVER(PARTITION BY route_id ORDER BY completed_at DESC,id) AS position
    FROM apcs_notification_deliveries WHERE state IN ('Delivered','Dead','Cancelled'))
    DELETE FROM apcs_notification_deliveries WHERE id IN (SELECT id FROM ranked WHERE completed_at<clock_timestamp()-interval '365 days' OR position>10000 LIMIT 1000)`);
}
