import { ScriptClientError, type ScriptClient } from '../../../packages/script-runtime/src/client.js';
import { diffDocuments } from '../../../packages/domain/src/document-diff.js';
import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { LogicEngine, validateGraph, type LogicGraph, type LogicValue } from '../../../packages/domain/src/logic.js';
import { canonicalJson, validateScreen, type Screen } from '../../../packages/domain/src/screen.js';
import { audit, transaction } from './store.js';

type Kind = 'graph' | 'screen';
interface Document { id: string; projectId: string; name: string; revision: number; document: LogicGraph | Screen; }
const uuid = { type: 'string', format: 'uuid' };
const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: 'object', additionalProperties: false, properties, required });
const name = { type: 'string', minLength: 1, maxLength: 128, pattern: '\\S' };
const params = object({ id: uuid });
const fields = 'id, project_id AS "projectId", name, revision, document';
class EditorError extends Error { constructor(readonly statusCode: number, readonly code: string, message: string) { super(message); } }
const missing = () => new EditorError(404, 'NOT_FOUND', 'Document not found');
const invalid = (message: string) => new EditorError(422, 'INVALID_DOCUMENT', message);
function precondition(value: unknown): number {
  if (typeof value !== 'string' || !/^"[1-9][0-9]{0,8}"$/.test(value)) throw new EditorError(428, 'REVISION_REQUIRED', 'An If-Match revision is required');
  return Number(value.slice(1, -1));
}
function conflict(row: Document, revision: number) { if (row.revision !== revision) throw new EditorError(412, 'REVISION_CONFLICT', 'Document revision changed'); }
function validate(kind: Kind, document: unknown, complete: boolean): LogicGraph | Screen {
  try { return kind === 'graph' ? validateGraph(document, complete) : validateScreen(document); }
  catch (error) { throw invalid(error instanceof Error ? error.message : 'Invalid document'); }
}
async function bindings(client: PoolClient, projectId: string, kind: Kind, document: LogicGraph | Screen) {
  const entries = kind === 'graph' ? (document as LogicGraph).nodes : (document as Screen).items;
  const bound = entries.filter((item) => item.signalId);
  const ids = [...new Set(bound.map((item) => item.signalId!))];
  if (!ids.length) return;
  const result = await client.query<{ id: string; direction: string; data_type: string }>(`SELECT s.id, s.direction, s.data_type FROM apcs_signals s JOIN apcs_devices d ON d.id = s.device_id WHERE d.project_id = $1 AND s.id::text = ANY($2::text[])`, [projectId, ids]);
  if (result.rows.length !== ids.length) throw invalid('A signal binding is missing or belongs to another project');
  for (const item of bound) {
    const signal = result.rows.find((s) => s.id === item.signalId)!;
    const expectedType = ((kind === 'graph' && item.kind === 'analog') || (kind === 'screen' && item.kind === 'value')) ? 'float64' : 'boolean';
    if (signal.data_type !== expectedType || (['output', 'button'].includes(item.kind) && signal.direction !== 'output')) throw invalid('Signal type or direction does not match its binding');
  }
}
async function preparedSnapshot(client: PoolClient, id: string, revision: number, kind: Kind) {
  const result = await client.query<{ name: string; document: LogicGraph | Screen; checksum: string }>('SELECT name,document,checksum FROM apcs_document_revisions WHERE document_id=$1 AND revision=$2', [id, revision]);
  const saved = result.rows[0]; if (!saved) throw new EditorError(404, 'NOT_FOUND', 'Prepared revision not found');
  if (createHash('sha256').update(canonicalJson({ name: saved.name, document: saved.document })).digest('hex') !== saved.checksum) throw invalid('Prepared revision checksum mismatch');
  validate(kind, saved.document, true);
  return saved;
}
export function registerEditors(app: FastifyInstance, pool: Pool, scripts?: ScriptClient) {
  for (const kind of ['graph', 'screen'] as const) {
    const route = `${kind}s`;
    async function owned(client: PoolClient, id: string, actor: string, lock = false) {
      const found = await client.query<Document>(`SELECT ${fields} FROM apcs_documents WHERE id=$1 AND kind=$2 AND project_id IN (SELECT id FROM apcs_projects WHERE owner_id=$3)${lock ? ' FOR UPDATE' : ''}`, [id, kind, actor]);
      if (!found.rows[0]) throw missing(); return found.rows[0];
    }
    app.get<{ Params: { id: string; revision: string }; Querystring: { target?: string } }>(`/api/v1/${route}/:id/revisions/:revision/compare`, {
      schema: { params: object({ id: uuid, revision: { type: 'string', pattern: '^[1-9][0-9]{0,8}$' } }), querystring: object({ target: { type: 'string', pattern: '^(draft|[1-9][0-9]{0,8})$' } }, []) },
    }, async (request) => transaction(pool, async (client) => {
      const row = await owned(client, request.params.id, request.sessionUser!.id);
      const target = request.query.target ?? 'draft';
      if (target === 'draft') conflict(row, precondition(request.headers['if-match']));
      const baseRevision = Number(request.params.revision); const base = await preparedSnapshot(client, row.id, baseRevision, kind);
      const other = target === 'draft' ? row : await preparedSnapshot(client, row.id, Number(target), kind);
      return { baseRevision, target: target === 'draft' ? 'draft' : 'prepared', targetRevision: target === 'draft' ? row.revision : Number(target), baseChecksum: base.checksum, ...diffDocuments({ name: base.name, document: base.document }, { name: other.name, document: other.document }) };
    }));
    app.post<{ Params: { id: string }; Body: { revision: number; reason: string } }>(`/api/v1/${route}/:id/restore`, {
      schema: { params, body: object({ revision: { type: 'integer', minimum: 1, maximum: 999999999 }, reason: { type: 'string', minLength: 1, maxLength: 256, pattern: '\\S' } }) },
    }, async (request, reply) => {
      const expected = precondition(request.headers['if-match']);
      const restored = await transaction(pool, async (client) => {
        const row = await owned(client, request.params.id, request.sessionUser!.id, true); conflict(row, expected);
        if (row.revision >= 999999999) throw invalid('Document revision limit reached');
        const saved = await preparedSnapshot(client, row.id, request.body.revision, kind); await bindings(client, row.projectId, kind, saved.document);
        const updated = await client.query<Document>(`UPDATE apcs_documents SET name=$1,document=$2,revision=revision+1,updated_at=clock_timestamp() WHERE id=$3 RETURNING ${fields}`, [saved.name, saved.document, row.id]);
        await audit(client, request.sessionUser!.id, `${kind}.restored`, row.id, { reason: request.body.reason, sourceRevision: request.body.revision, previousRevision: row.revision, revision: updated.rows[0]!.revision, checksum: saved.checksum });
        return updated.rows[0]!;
      });
      return reply.header('ETag', `"${restored.revision}"`).send(restored);
    });

    app.post<{ Params: { id: string }; Body: { name: string } }>(`/api/v1/projects/:id/${route}`, { schema: { params, body: object({ name }) } }, async (request, reply) => {
      const document = kind === 'graph' ? { schemaVersion: 1, nodes: [], edges: [] } : { schemaVersion: 1, width: 1200, height: 800, items: [] };
      const row = await transaction(pool, async (client) => {
        const result = await client.query<Document>(`INSERT INTO apcs_documents (id, project_id, kind, name, document) VALUES ($1,$2,$3,$4,$5) RETURNING ${fields}`, [randomUUID(), request.params.id, kind, request.body.name, document]);
        const created = result.rows[0]!; await audit(client, request.sessionUser!.id, `${kind}.created`, created.id); return created;
      });
      return reply.code(201).header('ETag', '"1"').send(row);
    });
    app.get<{ Params: { id: string }; Querystring: { cursor?: string; limit?: string } }>(`/api/v1/projects/:id/${route}`, { schema: { params, querystring: object({ cursor: uuid, limit: { type: 'string', pattern: '^(100|[1-9][0-9]?)$' } }, []) } }, async (request) => {
      const limit = Number(request.query.limit ?? 100);
      const result = await pool.query<Document>(`SELECT id, project_id AS "projectId", name, revision FROM apcs_documents WHERE project_id = $1 AND kind = $2 AND ($3::uuid IS NULL OR id > $3) ORDER BY id LIMIT $4`, [request.params.id, kind, request.query.cursor ?? null, limit + 1]);
      return { items: result.rows.slice(0, limit), nextCursor: result.rows.length > limit ? result.rows[limit - 1]!.id : null };
    });
    app.get<{ Params: { id: string } }>(`/api/v1/${route}/:id`, { schema: { params } }, async (request, reply) => {
      const result = await pool.query<Document>(`SELECT ${fields} FROM apcs_documents WHERE id = $1 AND kind = $2`, [request.params.id, kind]);
      if (!result.rows[0]) throw missing();
      return reply.header('ETag', `"${result.rows[0].revision}"`).send(result.rows[0]);
    });
    app.put<{ Params: { id: string }; Body: { name: string; document: unknown } }>(`/api/v1/${route}/:id`, { schema: { params, body: object({ name, document: { type: 'object' } }) } }, async (request, reply) => {
      const expected = precondition(request.headers['if-match']);
      const updated = await transaction(pool, async (client) => {
        const existing = await client.query<Document>(`SELECT ${fields} FROM apcs_documents WHERE id = $1 AND kind = $2 FOR UPDATE`, [request.params.id, kind]);
        if (!existing.rows[0]) throw missing(); const row = existing.rows[0]; conflict(row, expected); const document = validate(kind, request.body.document, false); await bindings(client, row.projectId, kind, document);
        const result = await client.query<Document>(`UPDATE apcs_documents SET name = $1, document = $2, revision = revision + 1, updated_at = clock_timestamp() WHERE id = $3 RETURNING ${fields}`, [request.body.name, document, row.id]);
        await audit(client, request.sessionUser!.id, `${kind}.updated`, row.id, { revision: result.rows[0]!.revision }); return result.rows[0]!;
      });
      return reply.header('ETag', `"${updated.revision}"`).send(updated);
    });
    app.post<{ Params: { id: string } }>(`/api/v1/${route}/:id/revisions`, { schema: { params } }, async (request, reply) => {
      const expected = precondition(request.headers['if-match']);
      const result = await transaction(pool, async (client) => {
        const existing = await client.query<Document>(`SELECT ${fields} FROM apcs_documents WHERE id = $1 AND kind = $2 FOR UPDATE`, [request.params.id, kind]);
        if (!existing.rows[0]) throw missing(); const row = existing.rows[0]; conflict(row, expected);
        const document = validate(kind, row.document, true); await bindings(client, row.projectId, kind, document);
        if (kind === 'graph' && !(document as LogicGraph).nodes.length) throw invalid('An empty graph cannot be prepared');
        if (kind === 'graph') for (const node of (document as LogicGraph).nodes.filter((node) => node.kind === 'script')) {
          if (!scripts) throw new EditorError(503, 'SCRIPT_UNAVAILABLE', 'Script service unavailable');
          await scripts.validate({ source: node.source!, language: node.language! });
        }
        const checksum = createHash('sha256').update(canonicalJson({ name: row.name, document })).digest('hex');
        const inserted = await client.query(`INSERT INTO apcs_document_revisions (document_id, revision, name, document, checksum, actor_id) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`, [row.id, row.revision, row.name, document, checksum, request.sessionUser!.id]);
        if (inserted.rowCount) await audit(client, request.sessionUser!.id, `${kind}.prepared`, row.id, { revision: row.revision, checksum });
        return { created: !!inserted.rowCount, body: { ...row, checksum, status: 'Prepared' } };
      });
      return reply.code(result.created ? 201 : 200).send(result.body);
    });
    app.get<{ Params: { id: string }; Querystring: { before?: string } }>(`/api/v1/${route}/:id/revisions`, { schema: { params, querystring: object({ before: { type: 'string', pattern: '^[1-9][0-9]{0,8}$' } }, []) } }, async (request) => {
      if (!(await pool.query('SELECT id FROM apcs_documents WHERE id = $1 AND kind = $2', [request.params.id, kind])).rowCount) throw missing();
      const result = await pool.query('SELECT revision, name, document, checksum, created_at AS "createdAt" FROM apcs_document_revisions WHERE document_id = $1 AND ($2::integer IS NULL OR revision < $2) ORDER BY revision DESC LIMIT 21', [request.params.id, request.query.before ?? null]);
      return { items: result.rows.slice(0, 20), nextBefore: result.rows.length > 20 ? result.rows[19].revision : null };
    });
  }
  app.post<{ Params: { id: string }; Body: { steps: Array<{ atMs: number; inputs: Record<string, boolean | number | null> }> } }>('/api/v1/graphs/:id/simulate', {
    schema: { params, body: object({ steps: { type: 'array', minItems: 1, maxItems: 100, items: object({ atMs: { type: 'number', minimum: 0, maximum: 86400000 }, inputs: { type: 'object', maxProperties: 256, propertyNames: { pattern: '^[A-Za-z0-9_-]{1,128}$' }, additionalProperties: { anyOf: [{ type: 'boolean' }, { type: 'number' }, { type: 'null' }] } } }) } }) },
  }, async (request) => {
    const found = await pool.query<Document>(`SELECT ${fields} FROM apcs_documents WHERE id = $1 AND kind = 'graph'`, [request.params.id]); if (!found.rows[0]) throw missing();
    const graph = validate('graph', found.rows[0].document, true) as LogicGraph;
    const scripted = graph.nodes.some((node) => node.kind === 'script');
    if (scripted && !scripts) throw new EditorError(503, 'SCRIPT_UNAVAILABLE', 'Script service unavailable');
    if (scripted && request.body.steps.length > 10) throw invalid('Script simulations support at most 10 steps');
    const engine = new LogicEngine(graph); const deadline = performance.now() + 3000;
    try {
      const steps = [];
      for (const step of request.body.steps) {
        if (scripted && performance.now() >= deadline) throw invalid('Script simulation exceeded its time budget');
        const inputs: Record<string, LogicValue> = Object.create(null);
        for (const [id, value] of Object.entries(step.inputs)) inputs[id] = { value, quality: value === null ? 'Bad' : 'Good', reason: value === null ? 'Simulated disconnection' : null };
        steps.push({ atMs: step.atMs, ...(scripted ? await engine.tickAsync(step.atMs, inputs, scripts!.evaluate.bind(scripts)) : engine.tick(step.atMs, inputs)) });
      }
      return { revision: found.rows[0].revision, environment: 'Simulation', steps };
    } catch (error) { if (error instanceof ScriptClientError) throw error; throw invalid(error instanceof Error ? error.message : 'Simulation failed'); }
  });
}
