import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { alarmPhase, validateAlarmDefinition } from '../../../packages/domain/src/alarms.js';
import type { RuntimeControl } from './runtime-service.js';
import type { AlarmAction } from './alarm-service.js';
import { audit, transaction } from './store.js';
const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: 'object', additionalProperties: false, properties, required });
const params = object({ id: { type: 'string', format: 'uuid' } });
const reason = { type: 'string', minLength: 1, maxLength: 256, pattern: '\\S' };
class AlarmError extends Error { constructor(readonly statusCode: number, readonly code: string, message: string) { super(message); } }
export function registerAlarms(app: FastifyInstance, pool: Pool, runtime?: RuntimeControl) {
  async function owner(id: string, actor: string, project = false) {
    const result = await pool.query(project ? 'SELECT id FROM apcs_projects WHERE id=$1 AND owner_id=$2' : 'SELECT a.id FROM apcs_alarms a JOIN apcs_projects p ON p.id=a.project_id WHERE a.id=$1 AND p.owner_id=$2', [id, actor]);
    if (!result.rowCount) throw new AlarmError(404, 'NOT_FOUND', 'Alarm or project not found');
  }
  app.get('/api/v1/alarms/status', async () => runtime?.alarmStatus() ?? { state: 'stopped', rules: 0, error: 'Runtime service is not configured' });
  app.get<{ Params: { id: string } }>('/api/v1/projects/:id/alarms', { schema: { params } }, async (request) => {
    await owner(request.params.id, request.sessionUser!.id, true);
    const result = await pool.query('SELECT id,name,signal_id AS "signalId",priority,definition,state,last_evaluated_at AS "lastEvaluatedAt",(last_evaluated_at IS NULL OR last_evaluated_at < clock_timestamp()-interval \'3 seconds\') AS "evaluationStale" FROM apcs_alarms WHERE project_id=$1 ORDER BY name,id LIMIT 100', [request.params.id]);
    return { items: result.rows.map((row) => ({ ...row, phase: alarmPhase(row.state) })) };
  });
  app.post<{ Params: { id: string }; Body: { name: string; signalId: string; priority: string; definition: unknown } }>('/api/v1/projects/:id/alarms', {
    schema: { params, body: object({ name: { type: 'string', minLength: 1, maxLength: 128, pattern: '\\S' }, signalId: { type: 'string', format: 'uuid' }, priority: { enum: ['low', 'medium', 'high'] }, definition: { type: 'object' } }) },
  }, async (request, reply) => {
    const actor = request.sessionUser!.id; const projectId = request.params.id; await owner(projectId, actor, true);
    let definition; try { definition = validateAlarmDefinition(request.body.definition); } catch { throw new AlarmError(422, 'INVALID_ALARM', 'Invalid alarm definition'); }
    const id = randomUUID();
    await transaction(pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(9021004)');
      const signal = await client.query('SELECT s.data_type FROM apcs_signals s JOIN apcs_devices d ON d.id=s.device_id JOIN apcs_projects p ON p.id=d.project_id WHERE s.id=$1 AND p.id=$2 AND p.owner_id=$3', [request.body.signalId, projectId, actor]);
      if (!signal.rowCount || (definition.condition.kind === 'boolean' && signal.rows[0].data_type !== 'boolean') || (definition.condition.kind === 'threshold' && signal.rows[0].data_type !== 'float64')) throw new AlarmError(422, 'INVALID_SIGNAL', 'Alarm signal must belong to this project and match the condition');
      if (Number((await client.query('SELECT count(*) FROM apcs_alarms')).rows[0].count) >= 100) throw new AlarmError(409, 'ALARM_LIMIT', 'Initial alarm limit is 100 rules');
      await client.query('INSERT INTO apcs_alarms(id,project_id,signal_id,name,priority,definition) VALUES($1,$2,$3,$4,$5,$6)', [id, projectId, request.body.signalId, request.body.name.trim(), request.body.priority, definition]);
      await audit(client, actor, 'alarm.created', id, { projectId, signalId: request.body.signalId });
    });
    return reply.code(201).send({ id });
  });
  app.get<{ Params: { id: string }; Querystring: { before?: string } }>('/api/v1/alarms/:id/events', { schema: { params, querystring: object({ before: { type: 'string', pattern: '^[1-9][0-9]{0,17}$' } }, []) } }, async (request) => {
    await owner(request.params.id, request.sessionUser!.id);
    const rows = (await pool.query('SELECT id,kind,occurrence,actor_id AS "actorId",reason,at FROM apcs_alarm_events WHERE alarm_id=$1 AND ($2::bigint IS NULL OR id<$2) ORDER BY id DESC LIMIT 21', [request.params.id, request.query.before ?? null])).rows;
    return { items: rows.slice(0, 20), nextBefore: rows.length > 20 ? rows[19].id : null };
  });
  app.post<{ Params: { id: string }; Body: AlarmAction }>('/api/v1/alarms/:id/actions', { schema: { params, body: { oneOf: [object({ kind: { const: 'acknowledge' }, occurrence: { type: 'integer', minimum: 1 }, reason }), object({ kind: { const: 'suppress' }, durationMs: { type: 'integer', minimum: 1000, maximum: 86400000 }, reason }), object({ kind: { const: 'unsuppress' }, reason })] } } }, async (request, reply) => {
    await owner(request.params.id, request.sessionUser!.id);
    if (!runtime) throw new AlarmError(409, 'ALARM_UNAVAILABLE', 'Alarm monitoring is unavailable');
    try { await runtime.alarmAction(request.params.id, request.sessionUser!.id, request.body); }
    catch (error) { throw new AlarmError(409, 'ALARM_ACTION_FAILED', error instanceof Error && /^Alarm /.test(error.message) ? error.message : 'Alarm action failed; refresh state before retrying'); }
    return reply.code(204).send();
  });
}
