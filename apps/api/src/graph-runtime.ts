import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { RuntimeControl } from './runtime-service.js';
import { audit, transaction } from './store.js';
const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: 'object', additionalProperties: false, properties, required });
const params = object({ id: { type: 'string', format: 'uuid' } });
class RuntimeError extends Error { constructor(readonly statusCode: number, readonly code: string, message: string) { super(message); } }
export function registerGraphRuntime(app: FastifyInstance, pool: Pool, runtime?: RuntimeControl) {
  async function graph(id: string, actorId: string) {
    const result = await pool.query<{ owner_id: string }>("SELECT p.owner_id FROM apcs_documents d JOIN apcs_projects p ON p.id=d.project_id WHERE d.id=$1 AND d.kind='graph'", [id]);
    if (!result.rows[0]) throw new RuntimeError(404, 'NOT_FOUND', 'Graph not found');
    if (result.rows[0].owner_id !== actorId) throw new RuntimeError(403, 'FORBIDDEN', 'Project owner required');
  }
  app.get<{ Params: { id: string } }>('/api/v1/graphs/:id/runtime', { schema: { params } }, async (request) => {
    await graph(request.params.id, request.sessionUser!.id);
    return runtime?.graphStatus(request.params.id) ?? { graphId: request.params.id, revision: null, activationId: null, state: 'stopped', error: 'Runtime service is not configured', cycles: 0 };
  });
  app.post<{ Params: { id: string }; Body: { action: 'activate' | 'stop'; revision?: number; reason: string } }>('/api/v1/graphs/:id/runtime', {
    schema: { params, body: object({ action: { type: 'string', enum: ['activate', 'stop'] }, revision: { type: 'integer', minimum: 1, maximum: 999999999 }, reason: { type: 'string', minLength: 1, maxLength: 256, pattern: '\\S' } }, ['action', 'reason']) },
  }, async (request) => {
    const id = request.params.id; const actor = request.sessionUser!.id; const { action, revision, reason } = request.body;
    await graph(id, actor);
    if (!runtime) throw new RuntimeError(503, 'RUNTIME_UNAVAILABLE', 'Runtime service is not configured');
    if (action === 'activate' && (!revision || !(await pool.query('SELECT 1 FROM apcs_document_revisions WHERE document_id=$1 AND revision=$2', [id, revision])).rowCount)) throw new RuntimeError(422, 'REVISION_REQUIRED', 'A prepared graph revision is required');
    const activationId = randomUUID();
    const data = { reason, revision: revision ?? null, activationId };
    try { await transaction(pool, (client) => audit(client, actor, `graph.${action}.requested`, id, data)); }
    catch (error) { if (action === 'stop') await runtime.stopGraph(id); throw error; }
    let status;
    try { status = action === 'activate' ? await runtime.activateGraph(id, revision!, actor, activationId) : await runtime.stopGraph(id); }
    catch { throw new RuntimeError(503, 'RUNTIME_UNAVAILABLE', 'Graph operation failed; inspect runtime and device status before retrying'); }
    try { await transaction(pool, (client) => audit(client, actor, `graph.${action}.completed`, id, { ...data, state: status.state, revision: status.revision, activationId: status.activationId })); }
    catch {
      // Only revoke this activation; a later concurrent activation has its own audit.
      await runtime.stopGraph(id, action === 'activate' ? activationId : undefined).catch(() => {});
      throw new RuntimeError(503, 'AUDIT_UNAVAILABLE', 'Graph completion could not be recorded; control was revoked');
    }
    return status;
  });
}
