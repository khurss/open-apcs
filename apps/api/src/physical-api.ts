import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { RuntimeControl } from './runtime-service.js';
import { audit, transaction } from './store.js';
const object = (properties: Record<string, unknown>) => ({ type: 'object', additionalProperties: false, properties, required: Object.keys(properties) });
const reason = { type: 'string', minLength: 1, maxLength: 256, pattern: '\\S' };
class CommissionError extends Error { constructor(readonly statusCode: number, readonly code: string, message: string) { super(message); } }
export function registerPhysicalRuntime(app: FastifyInstance, pool: Pool, runtime?: RuntimeControl) {
  const busy = new Set<string>();
  app.post<{ Params: { id: string }; Body: { action: 'start'; reason: string; gpio: number; acknowledgeLedOnly: true } | { action: 'stop'; reason: string } }>('/api/v1/devices/:id/commission', {
    schema: { params: object({ id: { type: 'string', format: 'uuid' } }), body: { oneOf: [
      object({ action: { const: 'start' }, reason, gpio: { type: 'integer', enum: [5, 18, 19, 21, 22, 23, 25, 26, 27, 32, 33] }, acknowledgeLedOnly: { const: true } }),
      object({ action: { const: 'stop' }, reason }),
    ] } },
  }, async (request) => {
    const id = request.params.id; const actor = request.sessionUser!.id; const body = request.body;
    const found = await pool.query<{ kind: string }>('SELECT d.kind FROM apcs_devices d JOIN apcs_projects p ON p.id=d.project_id WHERE d.id=$1 AND p.owner_id=$2', [id, actor]);
    if (!found.rows[0]) throw new CommissionError(404, 'NOT_FOUND', 'Device not found');
    if (found.rows[0].kind !== 'esp32-led') throw new CommissionError(422, 'PROFILE_UNSUPPORTED', 'Commissioning requires an ESP32 LED profile');
    if (!runtime) throw new CommissionError(503, 'RUNTIME_UNAVAILABLE', 'Runtime service is not configured');
    if (busy.has(id)) throw new CommissionError(409, 'COMMISSION_BUSY', 'A commissioning operation is already in progress');
    busy.add(id);
    try {
      const data = body.action === 'start' ? { reason: body.reason, gpio: body.gpio, acknowledgeLedOnly: true } : { reason: body.reason };
      try { await transaction(pool, (client) => audit(client, actor, `physical.${body.action}.requested`, id, data)); }
      catch (error) { if (body.action === 'stop') await runtime.stop(id); throw error; }
      try {
        const status = body.action === 'start' ? await runtime.startPhysical(id, actor, body.gpio) : await runtime.stop(id);
        await transaction(pool, (client) => audit(client, actor, `physical.${body.action}.completed`, id, { ...data, state: status.state }));
        return status;
      } catch {
        await runtime.stop(id).catch(() => {});
        throw new CommissionError(503, 'COMMISSION_UNAVAILABLE', 'Commissioning failed; inspect the private server configuration and device. Control was revoked or is unavailable.');
      }
    } finally { busy.delete(id); }
  });
}
