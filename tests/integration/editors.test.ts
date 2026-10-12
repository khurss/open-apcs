import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { createApi } from '../../apps/api/src/app.js';
import { bootstrapAdmin, migrateApplication } from '../../apps/api/src/store.js';
let admin: Pool; let pool: Pool; let schema: string; let app: Awaited<ReturnType<typeof createApi>>; let headers: Record<string, string>; let projectId: string; let signalId: string;
beforeEach(async () => {
  const connectionString = process.env.APCS_TEST_POSTGRES_URL; if (!connectionString) throw new Error('Docker fixture required');
  schema = `editors_${randomUUID().replaceAll('-', '')}`; admin = new Pool({ connectionString }); await admin.query(`CREATE SCHEMA ${schema}`);
  pool = new Pool({ connectionString, options: `-c search_path=${schema}` }); await migrateApplication(pool); await bootstrapAdmin(pool, 'operator', 'Editor fixture password!');
  app = await createApi({ pool, origin: 'http://localhost:5173', secureCookies: false });
  const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { origin: 'http://localhost:5173' }, payload: { username: 'operator', password: 'Editor fixture password!' } });
  headers = { origin: 'http://localhost:5173', cookie: `apcs_session=${login.cookies[0]!.value}`, 'x-csrf-token': login.json().csrfToken };
  projectId = (await app.inject({ method: 'POST', url: '/api/v1/projects', headers, payload: { name: 'Editor project' } })).json().id;
  signalId = (await app.inject({ method: 'POST', url: '/api/v1/devices', headers, payload: { projectId, name: 'LED', kind: 'virtual-led', siteId: 'test', deviceId: 'led' } })).json().signalId;
});
afterEach(async () => { await app?.close(); await pool?.end(); if (admin) { try { await admin.query(`DROP SCHEMA ${schema} CASCADE`); } finally { await admin.end(); } } });
const graph = () => ({ schemaVersion: 1, nodes: [{ id: 'source', kind: 'constant', label: 'Power', x: 0, y: 0, value: true }, { id: 'output', kind: 'output', label: 'LED', x: 250, y: 0, signalId }], edges: [{ id: 'link', source: 'source', target: 'output', port: 'in' }] });
async function create(kind = 'graphs') { return app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/${kind}`, headers, payload: { name: 'LED logic' } }); }
async function save(id: string, document: unknown, revision = 1, kind = 'graphs') { return app.inject({ method: 'PUT', url: `/api/v1/${kind}/${id}`, headers: { ...headers, 'if-match': `"${revision}"` }, payload: { name: 'LED logic', document } }); }
describe('versioned editor documents with real PostgreSQL', () => {
  it('creates isolated drafts, persists a graph, and lists project documents after restart', async () => {
    const created = await create(); expect(created.statusCode).toBe(201); const id = created.json().id;
    expect(created.json()).toMatchObject({ revision: 1, document: { schemaVersion: 1, nodes: [], edges: [] } });
    const saved = await save(id, graph()); expect(saved.statusCode).toBe(200); expect(saved.headers.etag).toBe('"2"');
    await app.close(); app = await createApi({ pool, origin: 'http://localhost:5173', secureCookies: false });
    expect((await app.inject({ url: `/api/v1/graphs/${id}`, headers })).json().document).toEqual(graph());
    expect((await app.inject({ url: `/api/v1/projects/${projectId}/graphs`, headers })).json().items).toMatchObject([{ id, revision: 2 }]);
  });
  it('rejects concurrent stale saves without overwriting the winning draft', async () => {
    const created = await create(); expect(created.statusCode).toBe(201); const id = created.json().id;
    const results = await Promise.all([save(id, graph()), save(id, { ...graph(), edges: [] })]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 412]);
    const missing = await app.inject({ method: 'PUT', url: `/api/v1/graphs/${id}`, headers, payload: { name: 'Missing precondition', document: graph() } }); expect(missing.statusCode).toBe(428);
  });
  it('validates signal ownership, document shape, and kind before saving', async () => {
    const created = await create(); expect(created.statusCode).toBe(201); const id = created.json().id;
    const foreign = graph(); foreign.nodes[1]!.signalId = randomUUID(); expect((await save(id, foreign)).statusCode).toBe(422);
    const other = (await app.inject({ method: 'POST', url: '/api/v1/projects', headers, payload: { name: 'Other project' } })).json().id;
    foreign.nodes[1]!.signalId = (await app.inject({ method: 'POST', url: '/api/v1/devices', headers, payload: { projectId: other, name: 'Foreign LED', kind: 'virtual-led', siteId: 'other', deviceId: 'other' } })).json().signalId;
    expect((await save(id, foreign)).statusCode).toBe(422);
    expect((await save(id, { ...graph(), script: 'x' })).statusCode).toBe(422);
    expect((await save(id, graph(), 1, 'screens')).statusCode).toBe(404);
    expect((await app.inject({ url: `/api/v1/graphs/${id}` })).statusCode).toBe(401);
  });
  it('creates immutable validated revisions while allowing the draft to evolve', async () => {
    const created = await create(); expect(created.statusCode).toBe(201); const id = created.json().id; await save(id, graph());
    const publish = () => app.inject({ method: 'POST', url: `/api/v1/graphs/${id}/revisions`, headers: { ...headers, 'if-match': '"2"' } });
    const revision = await publish(); expect(revision.statusCode).toBe(201); expect(revision.json()).toMatchObject({ revision: 2, status: 'Prepared', document: graph() }); expect(revision.json().checksum).toMatch(/^[a-f0-9]{64}$/);
    expect((await publish()).statusCode).toBe(200);
    await expect(pool.query('UPDATE apcs_document_revisions SET name = $1 WHERE document_id = $2', ['Tampered', id])).rejects.toThrow(/immutable/i);
    const changed = graph(); changed.nodes[0]!.value = false; expect((await save(id, changed, 2)).statusCode).toBe(200);
    const revisions = await app.inject({ url: `/api/v1/graphs/${id}/revisions`, headers }); expect(revisions.json().items).toHaveLength(1); expect(revisions.json().items[0].document).toEqual(graph());
    expect((await publish()).statusCode).toBe(412);
    expect(Number((await pool.query('SELECT count(*) FROM apcs_commands')).rows[0].count)).toBe(0);
  });
  it('saves incomplete drafts but refuses revision preparation and simulation', async () => {
    const created = await create(); expect(created.statusCode).toBe(201); const id = created.json().id; await save(id, { ...graph(), edges: [] });
    expect((await app.inject({ method: 'POST', url: `/api/v1/graphs/${id}/revisions`, headers: { ...headers, 'if-match': '"2"' } })).statusCode).toBe(422);
    expect((await app.inject({ method: 'POST', url: `/api/v1/graphs/${id}/simulate`, headers, payload: { steps: [{ atMs: 0, inputs: {} }] } })).statusCode).toBe(422);
  });
  it('simulates with virtual time and never emits a command or modifies the draft', async () => {
    const created = await create(); expect(created.statusCode).toBe(201); const id = created.json().id; await save(id, graph());
    const result = await app.inject({ method: 'POST', url: `/api/v1/graphs/${id}/simulate`, headers, payload: { steps: [{ atMs: 0, inputs: {} }, { atMs: 1000, inputs: {} }] } });
    expect(result.statusCode).toBe(200); expect(result.json().steps[1].outputs[signalId]).toEqual({ value: true, quality: 'Good', reason: null });
    expect(Number((await pool.query('SELECT count(*) FROM apcs_commands')).rows[0].count)).toBe(0);
    expect((await app.inject({ url: `/api/v1/graphs/${id}`, headers })).json().revision).toBe(2);
  });
  it('upgrades the existing application schema without modifying its data', async () => {
    const oldSchema = `upgrade_${randomUUID().replaceAll('-', '')}`; await admin.query(`CREATE SCHEMA ${oldSchema}`);
    const old = new Pool({ connectionString: process.env.APCS_TEST_POSTGRES_URL!, options: `-c search_path=${oldSchema}` });
    try {
      const sql = await readFile(new URL('../../apps/api/migrations/001-application.sql', import.meta.url), 'utf8'); await old.query(sql);
      await old.query('CREATE TABLE apcs_app_migrations (version integer PRIMARY KEY, checksum text NOT NULL)');
      await old.query('INSERT INTO apcs_app_migrations VALUES (1,$1)', [createHash('sha256').update(sql).digest('hex')]);
      const id = randomUUID(); await old.query('INSERT INTO apcs_users (id, username, password_hash) VALUES ($1,$2,$3)', [id, 'existing', 'fixture-only']);
      await migrateApplication(old); await migrateApplication(old);
      expect((await old.query('SELECT username FROM apcs_users WHERE id=$1', [id])).rows[0].username).toBe('existing');
      expect((await old.query('SELECT version FROM apcs_app_migrations ORDER BY version')).rows).toEqual([{ version: 1 }, { version: 2 }]);
    } finally { await old.end(); await admin.query(`DROP SCHEMA ${oldSchema} CASCADE`); }
  });
  it('rejects reversed simulation time and oversized runs before creating commands', async () => {
    const created = await create(); const id = created.json().id; await save(id, graph());
    const run = (steps: Array<{ atMs: number; inputs: Record<string, boolean> }>) => app.inject({ method: 'POST', url: `/api/v1/graphs/${id}/simulate`, headers, payload: { steps } });
    expect((await run([{ atMs: 100, inputs: {} }, { atMs: 99, inputs: {} }])).statusCode).toBe(422);
    expect((await run(Array.from({ length: 101 }, (_, atMs) => ({ atMs, inputs: {} })))).statusCode).toBe(400);
    expect(Number((await pool.query('SELECT count(*) FROM apcs_commands')).rows[0].count)).toBe(0);
  });
  it('persists a bound HMI screen and rolls back an unaudited change', async () => {
    const created = await create('screens'); expect(created.statusCode).toBe(201); const id = created.json().id;
    const document = { schemaVersion: 1, width: 1200, height: 800, items: [{ id: 'led', kind: 'indicator', label: 'LED', x: 20, y: 20, width: 150, height: 80, signalId }] };
    expect((await save(id, document, 1, 'screens')).statusCode).toBe(200);
    await pool.query("CREATE FUNCTION reject_editor_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'screen.updated' THEN RAISE EXCEPTION 'fixture'; END IF; RETURN NEW; END $$");
    await pool.query('CREATE TRIGGER reject_editor_audit BEFORE INSERT ON apcs_audit FOR EACH ROW EXECUTE FUNCTION reject_editor_audit()');
    expect((await save(id, document, 2, 'screens')).statusCode).toBe(500);
    expect((await app.inject({ url: `/api/v1/screens/${id}`, headers })).json().revision).toBe(2);
  });
});
