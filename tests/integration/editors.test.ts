import { ScriptClient } from '../../packages/script-runtime/src/client.js';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { RuntimeProcess } from '../../apps/api/src/runtime-process.js';
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
  it('compares a prepared graph with its draft and restores a new audited draft without activating equipment', async () => {
    const id = (await create()).json().id; await save(id, graph());
    await app.inject({ method: 'POST', url: `/api/v1/graphs/${id}/revisions`, headers: { ...headers, 'if-match': '"2"' } });
    const changed = graph(); changed.nodes[0]!.value = false; await save(id, changed, 2);
    const compare = await app.inject({ url: `/api/v1/graphs/${id}/revisions/2/compare?target=draft`, headers: { ...headers, 'if-match': '"3"' } });
    expect(compare.statusCode).toBe(200); expect(compare.json()).toMatchObject({ baseRevision: 2, targetRevision: 3, target: 'draft', total: 1, changes: [{ path: '/document/nodes/0/value', before: true, after: false }] });
    const restore = () => app.inject({ method: 'POST', url: `/api/v1/graphs/${id}/restore`, headers: { ...headers, 'if-match': '"3"' }, payload: { revision: 2, reason: 'Restore reviewed LED behavior' } });
    const restored = await restore(); expect(restored.statusCode).toBe(200); expect(restored.headers.etag).toBe('"4"'); expect(restored.json().document).toEqual(graph());
    expect((await restore()).statusCode).toBe(412);
    expect((await app.inject({ url: `/api/v1/graphs/${id}/revisions`, headers })).json().items).toHaveLength(1);
    expect(Number((await pool.query('SELECT count(*) FROM apcs_commands')).rows[0].count)).toBe(0);
    expect((await pool.query("SELECT data FROM apcs_audit WHERE action='graph.restored'")).rows[0].data).toMatchObject({ sourceRevision: 2, previousRevision: 3, revision: 4, reason: 'Restore reviewed LED behavior' });
  });
  it('requires owner, CSRF, matching draft revision and a valid immutable checksum for restore or comparison', async () => {
    const id = (await create()).json().id; await save(id, graph());
    await app.inject({ method: 'POST', url: `/api/v1/graphs/${id}/revisions`, headers: { ...headers, 'if-match': '"2"' } });
    const url = `/api/v1/graphs/${id}/restore`; const payload = { revision: 2, reason: 'Reviewed revision' };
    expect((await app.inject({ method: 'POST', url, headers, payload })).statusCode).toBe(428);
    expect((await app.inject({ method: 'POST', url, headers: { cookie: headers.cookie! }, payload })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url, headers: { ...headers, 'if-match': '"2"' }, payload: { ...payload, actorId: 'forged' } })).statusCode).toBe(400);
    expect((await app.inject({ url: `/api/v1/graphs/${id}/revisions/2/compare?target=draft`, headers: { ...headers, 'if-match': '"1"' } })).statusCode).toBe(412);
    const owner = (await pool.query('SELECT owner_id FROM apcs_projects WHERE id=$1', [projectId])).rows[0].owner_id;
    await pool.query('INSERT INTO apcs_document_revisions(document_id,revision,name,document,checksum,actor_id) VALUES($1,99,$2,$3,$4,$5)', [id, 'Corrupt', graph(), '0'.repeat(64), owner]);
    expect((await app.inject({ method: 'POST', url, headers: { ...headers, 'if-match': '"2"' }, payload: { ...payload, revision: 99 } })).statusCode).toBe(422);
    expect((await app.inject({ url: `/api/v1/graphs/${id}/revisions/99/compare?target=2`, headers })).statusCode).toBe(422);
    const other = randomUUID(); await pool.query("INSERT INTO apcs_users(id,username,password_hash) VALUES($1,'other','fixture')", [other]); await pool.query('UPDATE apcs_projects SET owner_id=$1 WHERE id=$2', [other, projectId]);
    expect((await app.inject({ method: 'POST', url, headers: { ...headers, 'if-match': '"2"' }, payload })).statusCode).toBe(404);
    expect((await app.inject({ url: `/api/v1/graphs/${id}/revisions/2/compare?target=2`, headers })).statusCode).toBe(404);
  });
  it('rolls back an unaudited restore and serializes concurrent restores with If-Match', async () => {
    const id = (await create()).json().id; await save(id, graph());
    await app.inject({ method: 'POST', url: `/api/v1/graphs/${id}/revisions`, headers: { ...headers, 'if-match': '"2"' } });
    await pool.query("CREATE FUNCTION deny_restore() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='graph.restored' THEN RAISE EXCEPTION 'Fixture audit unavailable'; END IF; RETURN NEW; END $$");
    await pool.query('CREATE TRIGGER deny_restore BEFORE INSERT ON apcs_audit FOR EACH ROW EXECUTE FUNCTION deny_restore()');
    const restore = () => app.inject({ method: 'POST', url: `/api/v1/graphs/${id}/restore`, headers: { ...headers, 'if-match': '"2"' }, payload: { revision: 2, reason: 'Restore fixture' } });
    expect((await restore()).statusCode).toBe(500); expect((await app.inject({ url: `/api/v1/graphs/${id}`, headers })).json().revision).toBe(2);
    await pool.query('DROP TRIGGER deny_restore ON apcs_audit');
    expect((await Promise.all([restore(), restore()])).map((response) => response.statusCode).sort()).toEqual([200, 412]);
  });
  it('compares and restores prepared HMI dimensions without altering the immutable screen', async () => {
    const id = (await create('screens')).json().id; const screen = { schemaVersion: 1, width: 1200, height: 800, items: [] };
    await save(id, screen, 1, 'screens'); await app.inject({ method: 'POST', url: `/api/v1/screens/${id}/revisions`, headers: { ...headers, 'if-match': '"2"' } });
    await save(id, { ...screen, width: 600 }, 2, 'screens'); await app.inject({ method: 'POST', url: `/api/v1/screens/${id}/revisions`, headers: { ...headers, 'if-match': '"3"' } });
    const diff = await app.inject({ url: `/api/v1/screens/${id}/revisions/2/compare?target=3`, headers }); expect(diff.statusCode).toBe(200); expect(diff.json().changes).toEqual([{ path: '/document/width', kind: 'changed', before: 1200, after: 600 }]);
    const restored = await app.inject({ method: 'POST', url: `/api/v1/screens/${id}/restore`, headers: { ...headers, 'if-match': '"3"' }, payload: { revision: 2, reason: 'Restore overview size' } });
    expect(restored.statusCode).toBe(200); expect(restored.json().document).toEqual(screen);
    expect((await app.inject({ url: `/api/v1/screens/${id}/revisions`, headers })).json().items[0].document.width).toBe(600);
  });

  it('refuses restoring a prepared binding whose signal no longer exists', async () => {
    const id = (await create()).json().id; await save(id, graph());
    await app.inject({ method: 'POST', url: `/api/v1/graphs/${id}/revisions`, headers: { ...headers, 'if-match': '"2"' } });
    await pool.query('DELETE FROM apcs_signals WHERE id=$1', [signalId]);
    const restored = await app.inject({ method: 'POST', url: `/api/v1/graphs/${id}/restore`, headers: { ...headers, 'if-match': '"2"' }, payload: { revision: 2, reason: 'Unavailable binding' } });
    expect(restored.statusCode).toBe(422); expect((await app.inject({ url: `/api/v1/graphs/${id}`, headers })).json().revision).toBe(2);
  });
  it('activates prepared logic through private IPC, audits the revision, and stops outputs if completion audit fails', async () => {
    await app.close();
    const runtime = new RuntimeProcess({ connectionString: process.env.APCS_TEST_POSTGRES_URL!, mqttUrl: process.env.APCS_TEST_MQTT_URL!, databaseOptions: `-c search_path=${schema}` });
    app = await createApi({ pool, origin: 'http://localhost:5173', secureCookies: false, runtime });
    const id = (await create()).json().id; await save(id, graph());
    const device = await pool.query('SELECT device_id FROM apcs_signals WHERE id=$1', [signalId]);
    expect((await app.inject({ method: 'POST', url: `/api/v1/devices/${device.rows[0].device_id}/runtime`, headers, payload: { action: 'start', reason: 'Graph test' } })).statusCode).toBe(200);
    const url = `/api/v1/graphs/${id}/runtime`;
    expect((await app.inject({ method: 'POST', url, headers, payload: { action: 'activate', revision: 2, reason: 'Unprepared' } })).statusCode).toBe(422);
    await app.inject({ method: 'POST', url: `/api/v1/graphs/${id}/revisions`, headers: { ...headers, 'if-match': '"2"' } });
    expect((await app.inject({ method: 'POST', url, headers: { cookie: headers.cookie! }, payload: { action: 'activate', revision: 2, reason: 'No CSRF' } })).statusCode).toBe(403);
    const started = await app.inject({ method: 'POST', url, headers, payload: { action: 'activate', revision: 2, reason: 'Test headless graph' } });
    expect(started.statusCode).toBe(200); expect(started.json()).toMatchObject({ revision: 2, state: 'running' });
    expect((await app.inject({ url, headers })).json()).toMatchObject({ revision: 2, state: 'running' });
    const events = await pool.query("SELECT data FROM apcs_audit WHERE action='graph.activate.completed' AND resource_id=$1", [id]);
    expect(events.rows[0].data).toMatchObject({ revision: 2, activationId: started.json().activationId });
    expect((await app.inject({ method: 'POST', url, headers, payload: { action: 'activate', revision: 99, reason: 'Missing revision' } })).statusCode).toBe(422);
    expect((await runtime.graphStatus(id)).state).toBe('running');
    const changed = graph(); changed.nodes[0]!.value = false; await save(id, changed, 2);
    const restored = await app.inject({ method: 'POST', url: `/api/v1/graphs/${id}/restore`, headers: { ...headers, 'if-match': '"3"' }, payload: { revision: 2, reason: 'Restore draft while active' } });
    expect(restored.statusCode).toBe(200); expect(restored.json().revision).toBe(4);
    expect(await runtime.graphStatus(id)).toMatchObject({ state: 'running', revision: 2, activationId: started.json().activationId });

    await pool.query("CREATE FUNCTION deny_graph_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='graph.activate.completed' THEN RAISE EXCEPTION 'Fixture audit failure'; END IF; RETURN NEW; END $$");
    await pool.query('CREATE TRIGGER deny_graph_audit BEFORE INSERT ON apcs_audit FOR EACH ROW EXECUTE FUNCTION deny_graph_audit()');
    expect((await app.inject({ method: 'POST', url, headers, payload: { action: 'activate', revision: 2, reason: 'Audit failure' } })).statusCode).toBe(503);
    expect((await runtime.readSignal(signalId)).quality).toBe('Disconnected');
  });

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
      expect((await old.query('SELECT version FROM apcs_app_migrations ORDER BY version')).rows).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }]);
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

const scriptGraph = (source = 'const enabled: boolean = input.a; return enabled && !input.b;') => ({ schemaVersion: 1, nodes: [
  { id: 'a', kind: 'constant', label: 'A', x: 0, y: 0, value: true },
  { id: 'b', kind: 'constant', label: 'B', x: 0, y: 100, value: false },
  { id: 'script', kind: 'script', label: 'Script', x: 150, y: 0, language: 'typescript', source },
  { id: 'output', kind: 'output', label: 'LED', x: 300, y: 0, signalId },
], edges: [{ id: 'a-s', source: 'a', target: 'script', port: 'a' }, { id: 'b-s', source: 'b', target: 'script', port: 'b' }, { id: 's-o', source: 'script', target: 'output', port: 'in' }] });
it('validates, simulates and runs an isolated TypeScript block through private runtime IPC', async () => {
  await app.close();
  const runtime = new RuntimeProcess({ connectionString: process.env.APCS_TEST_POSTGRES_URL!, mqttUrl: process.env.APCS_TEST_MQTT_URL!, databaseOptions: `-c search_path=${schema}`, scriptUrl: process.env.APCS_SCRIPT_URL! });
  app = await createApi({ pool, origin: 'http://localhost:5173', secureCookies: false, runtime, scripts: new ScriptClient(process.env.APCS_SCRIPT_URL!) });
  const id = (await create()).json().id; expect((await save(id, scriptGraph())).statusCode).toBe(200);
  const prepare = () => app.inject({ method: 'POST', url: `/api/v1/graphs/${id}/revisions`, headers: { ...headers, 'if-match': '"2"' } });
  expect((await prepare()).statusCode).toBe(201);
  const simulated = await app.inject({ method: 'POST', url: `/api/v1/graphs/${id}/simulate`, headers, payload: { steps: [{ atMs: 0, inputs: {} }, { atMs: 1000, inputs: {} }] } });
  expect(simulated.statusCode).toBe(200); expect(simulated.json().steps[1].outputs[signalId]).toMatchObject({ value: true, quality: 'Good' });
  const device = (await pool.query('SELECT device_id FROM apcs_signals WHERE id=$1', [signalId])).rows[0].device_id;
  expect((await app.inject({ method: 'POST', url: `/api/v1/devices/${device}/runtime`, headers, payload: { action: 'start', reason: 'Script fixture' } })).statusCode).toBe(200);
  expect((await app.inject({ method: 'POST', url: `/api/v1/graphs/${id}/runtime`, headers, payload: { action: 'activate', revision: 2, reason: 'Reviewed script' } })).statusCode).toBe(200);
  await expect.poll(async () => (await runtime.readSignal(signalId)).value, { timeout: 4000 }).toBe(true);
  await runtime.stopGraph(id);
  await save(id, scriptGraph('return (;'), 2);
  expect((await app.inject({ method: 'POST', url: `/api/v1/graphs/${id}/revisions`, headers: { ...headers, 'if-match': '"3"' } })).statusCode).toBe(422);
  expect((await pool.query('SELECT revision FROM apcs_document_revisions WHERE document_id=$1', [id])).rows.map((r) => r.revision)).toEqual([2]);
});
it('keeps script drafts editable but refuses preparation and simulation without an isolated service', async () => {
  const id = (await create()).json().id; expect((await save(id, scriptGraph())).statusCode).toBe(200);
  expect((await app.inject({ method: 'POST', url: `/api/v1/graphs/${id}/revisions`, headers: { ...headers, 'if-match': '"2"' } })).statusCode).toBe(503);
  expect((await app.inject({ method: 'POST', url: `/api/v1/graphs/${id}/simulate`, headers, payload: { steps: [{ atMs: 0, inputs: {} }] } })).statusCode).toBe(503);
  expect((await pool.query('SELECT * FROM apcs_document_revisions WHERE document_id=$1', [id])).rowCount).toBe(0);
});
