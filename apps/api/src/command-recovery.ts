import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { PgCommandJournal } from '../../../packages/storage/src/command-journal.js';
import type { RuntimeControl } from './runtime-service.js';
import { audit } from './store.js';
const uuid = { type: 'string', format: 'uuid' };
const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: 'object', additionalProperties: false, properties, required });
const params = object({ id: uuid });
class RecoveryError extends Error { constructor(readonly statusCode: number, readonly code: string, message: string) { super(message); } }
export function registerCommandRecovery(app: FastifyInstance, pool: Pool, journal: PgCommandJournal, runtime?: RuntimeControl) {
  async function signal(id: string, actor: string) {
    const found = await pool.query<{ owner_id: string; kind: string; device_id: string }>('SELECT p.owner_id,d.kind,d.id AS device_id FROM apcs_signals s JOIN apcs_devices d ON d.id=s.device_id JOIN apcs_projects p ON p.id=d.project_id WHERE s.id=$1', [id]);
    if (!found.rows[0]) throw new RecoveryError(404, 'NOT_FOUND', 'Signal not found');
    if (found.rows[0].owner_id !== actor) throw new RecoveryError(403, 'FORBIDDEN', 'Project owner required');
    return found.rows[0];
  }
  app.get<{ Params: { id: string }; Querystring: { before?: string } }>('/api/v1/signals/:id/commands', { schema: { params, querystring: object({ before: uuid }, []) } }, async (request) => {
    const target = request.params.id; const profile = await signal(target, request.sessionUser!.id);
    const before = request.query.before;
    if (before && !(await pool.query('SELECT 1 FROM apcs_commands WHERE id=$1 AND target_signal_id=$2', [before, target])).rowCount) throw new RecoveryError(404, 'NOT_FOUND', 'Command cursor not found');
    const rows = await pool.query<{ id: string; created_at: Date }>(`SELECT id,created_at FROM apcs_commands WHERE target_signal_id=$1 AND ($2::text IS NULL OR (created_at,id) < (SELECT created_at,id FROM apcs_commands WHERE id=$2)) ORDER BY created_at DESC,id DESC LIMIT 11`, [target, before ?? null]);
    const items = [];
    for (const row of rows.rows.slice(0, 10)) items.push({ ...await journal.get(row.id), createdAt: row.created_at.toISOString() });
    const blocked = await pool.query<{ id: string }>("SELECT id FROM apcs_commands WHERE target_signal_id=$1 AND snapshot->>'state' IN ('Accepted','Dispatched','DeviceAccepted','Unknown') AND reconciliation IS NULL", [target]);
    const blocking = blocked.rows[0] ? await journal.get(blocked.rows[0].id) : null;
    return { profile: profile.kind, items, nextCursor: rows.rows.length > 10 ? rows.rows[9]!.id : null, blocking: blocking && ['Accepted', 'Dispatched', 'DeviceAccepted', 'Unknown'].includes(blocking.state) ? blocking : null };
  });
  const commonBody = { reason: { type: 'string', minLength: 1, maxLength: 256, pattern: '\\S' }, acceptUnknownOutcome: { type: 'boolean', const: true } };
  app.post<{ Params: { id: string }; Body: { reason: string; acceptUnknownOutcome: true; gpio?: number; acknowledgeLedOnly?: true } }>('/api/v1/commands/:id/reconcile', {
    schema: { params, body: { oneOf: [object(commonBody), object({ ...commonBody, gpio: { type: 'integer', enum: [5, 18, 19, 21, 22, 23, 25, 26, 27, 32, 33] }, acknowledgeLedOnly: { type: 'boolean', const: true } })] } },
  }, async (request) => {
    const existing = await pool.query<{ target_signal_id: string }>('SELECT target_signal_id FROM apcs_commands WHERE id=$1', [request.params.id]);
    if (!existing.rows[0]) throw new RecoveryError(404, 'NOT_FOUND', 'Command not found');
    const target = existing.rows[0].target_signal_id; const actor = request.sessionUser!.id;
    const profile = await signal(target, actor); const physical = profile.kind === 'esp32-led';
    if (!physical && !['virtual-led', 'virtual-thermal'].includes(profile.kind)) throw new RecoveryError(422, 'PROFILE_UNSUPPORTED', 'Recovery requires a supported LED or virtual profile');
    if (physical !== (request.body.gpio !== undefined && request.body.acknowledgeLedOnly === true)) throw new RecoveryError(422, 'RECOVERY_REVIEW_REQUIRED', 'Physical LED recovery requires a reviewed GPIO and isolated LED acknowledgement');
    if (!runtime) throw new RecoveryError(503, 'RUNTIME_UNAVAILABLE', 'Runtime service is not configured');
    if (physical) {
      const status = await runtime.status(profile.device_id);
      if (status.environment !== 'Hardware bench' || status.state !== 'running' || status.commissionedGpio !== request.body.gpio) throw new RecoveryError(409, 'RECOVERY_BLOCKED', 'Arm the reviewed GPIO through LED commissioning before recovery');
    }
    try {
      return await journal.reconcile(request.params.id, actor, request.body.reason, async (input) => {
        const context = await runtime.context(input); const sample = await runtime.readSignal(target);
        if (sample.bootId !== context.bootId || sample.quality !== 'Good') throw new Error('Good output quality and a stable session are required');
        return { ...context, value: typeof sample.value === 'boolean' ? sample.value : null };
      }, (client, receipt) => audit(client, actor, 'command.reconciled', request.params.id, physical ? { ...receipt, profile: profile.kind, gpio: request.body.gpio, acknowledgeLedOnly: true } : receipt));
    } catch (error) {
      if (error instanceof Error && error.message === 'Live context timeout') throw new RecoveryError(409, 'RECOVERY_BLOCKED', 'Good output context could not be verified in time');
      if (error instanceof Error && /^(Output owner|Good output|Output interlock|A new device|The LED safe|Only an Unknown|Reconciliation conflict)/.test(error.message)) throw new RecoveryError(409, 'RECOVERY_BLOCKED', error.message);
      throw error;
    }
  });
}
