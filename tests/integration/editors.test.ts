import { pidGraph } from '../fixtures/pid-graph.js';
import { statefulGraph } from '../fixtures/stateful-graph.js';
import { PgCommandJournal } from '../../packages/storage/src/command-journal.js';
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
      expect((await old.query('SELECT version FROM apcs_app_migrations ORDER BY version')).rows).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }, { version: 5 }, { version: 6 }, { version: 7 }, { version: 8 }, { version: 9 }, { version: 10 }, { version: 11 }, { version: 12 }, { version: 13 }, { version: 14 }, { version: 15 }, { version: 16 }, { version: 17 }, { version: 18 }]);
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

it('binds float64 inputs, simulates numeric values without coercion and rejects incompatible signal types', async () => {
  const sensor = randomUUID(); const device = (await pool.query('SELECT device_id FROM apcs_signals WHERE id=$1', [signalId])).rows[0].device_id;
  await pool.query("INSERT INTO apcs_signals(id,device_id,name,data_type,direction) VALUES($1,$2,'Sensor','float64','input')", [sensor, device]);
  const id = (await create()).json().id;
  const document = { schemaVersion: 1, nodes: [
    { id: 'sensor', kind: 'analog', label: 'Sensor', signalId: sensor, x: 0, y: 0 },
    { id: 'band', kind: 'hysteresis', label: 'Band', low: 5, high: 10, x: 200, y: 0 },
    { id: 'led', kind: 'output', label: 'LED', signalId, x: 400, y: 0 },
  ], edges: [{ id: 'a', source: 'sensor', target: 'band', port: 'in' }, { id: 'b', source: 'band', target: 'led', port: 'in' }] };
  const saved = await save(id, document); expect(saved.statusCode, saved.body).toBe(200);
  expect((await app.inject({ method: 'POST', url: `/api/v1/graphs/${id}/revisions`, headers: { ...headers, 'if-match': '"2"' } })).statusCode).toBe(201);
  const simulated = await app.inject({ method: 'POST', url: `/api/v1/graphs/${id}/simulate`, headers, payload: { steps: [12, 7, null, 7, 5, true, 0, 1].map((value, i) => ({ atMs: i * 100, inputs: { [sensor]: value } })) } });
  expect(simulated.statusCode, simulated.body).toBe(200);
  expect(simulated.json().steps.map((step: { outputs: Record<string, { value: unknown }> }) => step.outputs[signalId]!.value)).toEqual([true, true, null, false, false, null, false, false]);
  const wrong = structuredClone(document); wrong.nodes[0]!.signalId = signalId;
  expect((await save(id, wrong, 2)).statusCode).toBe(422);
  await expect(pool.query("UPDATE apcs_signals SET data_type='int64' WHERE id=$1", [sensor])).rejects.toThrow(/check constraint/);
  await expect(pool.query("UPDATE apcs_signals SET direction='output' WHERE id=$1", [sensor])).rejects.toThrow(/check constraint/);
});

it('runs numeric logic through MQTT and rejects unsupported analog drivers before disturbing the active revision', async () => {
  await app.close();
  const runtime = new RuntimeProcess({ connectionString: process.env.APCS_TEST_POSTGRES_URL!, mqttUrl: process.env.APCS_TEST_MQTT_URL!, databaseOptions: `-c search_path=${schema}` });
  app = await createApi({ pool, origin: 'http://localhost:5173', secureCookies: false, runtime });
  const id = (await create()).json().id;
  const document = { schemaVersion: 1, nodes: [
    { id: 'n', kind: 'number', label: 'Setpoint', value: 12, x: 0, y: 0 },
    { id: 'h', kind: 'hysteresis', label: 'Band', low: 5, high: 10, x: 200, y: 0 },
    { id: 'o', kind: 'output', label: 'LED', signalId, x: 400, y: 0 },
  ], edges: [{ id: 'n-h', source: 'n', target: 'h', port: 'in' }, { id: 'h-o', source: 'h', target: 'o', port: 'in' }] };
  expect((await save(id, document)).statusCode).toBe(200);
  expect((await app.inject({ method: 'POST', url: `/api/v1/graphs/${id}/revisions`, headers: { ...headers, 'if-match': '"2"' } })).statusCode).toBe(201);
  const device = (await pool.query('SELECT device_id FROM apcs_signals WHERE id=$1', [signalId])).rows[0].device_id;
  expect((await app.inject({ method: 'POST', url: `/api/v1/devices/${device}/runtime`, headers, payload: { action: 'start', reason: 'Numeric fixture' } })).statusCode).toBe(200);
  const url = `/api/v1/graphs/${id}/runtime`;
  expect((await app.inject({ method: 'POST', url, headers, payload: { action: 'activate', revision: 2, reason: 'Reviewed numeric behavior' } })).statusCode).toBe(200);
  await expect.poll(async () => (await runtime.readSignal(signalId)).value, { timeout: 4000 }).toBe(true);
  await expect.poll(async () => (await pool.query("SELECT snapshot->>'state' AS state FROM apcs_commands WHERE target_signal_id=$1 ORDER BY created_at DESC LIMIT 1", [signalId])).rows[0]?.state, { timeout: 4000 }).toBe('Verified');
  const sensor = randomUUID();
  await pool.query("INSERT INTO apcs_signals(id,device_id,name,data_type,direction) VALUES($1,$2,'Sensor','float64','input')", [sensor, device]);
  const analog = { ...document, nodes: [{ id: 'n', kind: 'analog', label: 'Sensor', signalId: sensor, x: 0, y: 0 }, ...document.nodes.slice(1)] };
  expect((await save(id, analog, 2)).statusCode).toBe(200);
  expect((await app.inject({ method: 'POST', url: `/api/v1/graphs/${id}/revisions`, headers: { ...headers, 'if-match': '"3"' } })).statusCode).toBe(201);
  const rejected = await app.inject({ method: 'POST', url, headers, payload: { action: 'activate', revision: 3, reason: 'Unsupported driver fixture' } });
  expect(rejected.statusCode).toBe(422); expect(rejected.body).toContain('Numeric input drivers are not available');
  expect(await runtime.graphStatus(id)).toMatchObject({ state: 'running', revision: 2 });
  expect((await runtime.readSignal(signalId)).value).toBe(true);
});

it('registers and runs a virtual thermal loop, archives numeric samples and faults when its device stops', async () => {
  await app.close();
  const runtime = new RuntimeProcess({ connectionString: process.env.APCS_TEST_POSTGRES_URL!, mqttUrl: process.env.APCS_TEST_MQTT_URL!, databaseOptions: `-c search_path=${schema}` });
  app = await createApi({ pool, origin: 'http://localhost:5173', secureCookies: false, runtime });
  const created = await app.inject({ method: 'POST', url: '/api/v1/devices', headers, payload: { projectId, name: 'Thermal bench', kind: 'virtual-thermal', siteId: 'thermal', deviceId: 'tank' } });
  expect(created.statusCode, created.body).toBe(201); const device = created.json();
  const catalog = await pool.query('SELECT id,data_type,direction FROM apcs_signals WHERE device_id=$1', [device.id]);
  expect(catalog.rows).toEqual(expect.arrayContaining([{ id: device.signalId, data_type: 'boolean', direction: 'output' }, { id: device.temperatureSignalId, data_type: 'float64', direction: 'input' }]));
  const document = { schemaVersion: 1, nodes: [
    { id: 't', kind: 'analog', label: 'Temperature', signalId: device.temperatureSignalId, x: 0, y: 0 },
    { id: 'h', kind: 'hysteresis', label: 'Warm', low: 20.5, high: 21, x: 200, y: 0 },
    { id: 'n', kind: 'not', label: 'Heat', x: 400, y: 0 },
    { id: 'o', kind: 'output', label: 'Heater', signalId: device.signalId, x: 600, y: 0 },
  ], edges: [{ id: 't-h', source: 't', target: 'h', port: 'in' }, { id: 'h-n', source: 'h', target: 'n', port: 'in' }, { id: 'n-o', source: 'n', target: 'o', port: 'in' }] };
  const id = (await create()).json().id; expect((await save(id, document)).statusCode).toBe(200);
  expect((await app.inject({ method: 'POST', url: `/api/v1/graphs/${id}/revisions`, headers: { ...headers, 'if-match': '"2"' } })).statusCode).toBe(201);
  expect((await app.inject({ method: 'POST', url: `/api/v1/devices/${device.id}/runtime`, headers, payload: { action: 'start', reason: 'Virtual thermal fixture' } })).statusCode).toBe(200);
  expect(await runtime.readSignal(device.temperatureSignalId)).toMatchObject({ value: 20, quality: 'Good' });
  expect((await app.inject({ method: 'POST', url: `/api/v1/graphs/${id}/runtime`, headers, payload: { action: 'activate', revision: 2, reason: 'Closed loop fixture' } })).statusCode).toBe(200);
  await expect.poll(async () => (await runtime.readSignal(device.signalId)).value).toBe(true);
  await expect.poll(async () => (await pool.query("SELECT count(*)::int AS n FROM apcs_commands WHERE target_signal_id=$1 AND snapshot->>'state'='Verified'", [device.signalId])).rows[0].n, { timeout: 6000 }).toBeGreaterThanOrEqual(2);
  expect((await runtime.readSignal(device.temperatureSignalId)).value as number).toBeGreaterThan(21);
  await expect.poll(async () => (await pool.query("SELECT count(*)::int AS n FROM apcs_signal_history WHERE signal_id=$1 AND snapshot->>'quality'='Good' AND jsonb_typeof(snapshot->'value')='number'", [device.temperatureSignalId])).rows[0].n).toBeGreaterThanOrEqual(2);
  await runtime.stop(device.id);
  await expect.poll(async () => (await runtime.graphStatus(id)).state).toBe('faulted');
  expect((await runtime.readSignal(device.temperatureSignalId)).quality).toBe('Disconnected');
  expect((await runtime.readSignal(device.signalId)).quality).toBe('Disconnected');
});

it('rejects commands to catalog inputs before creating a journal record', async () => {
  const sensor = randomUUID(); const device = (await pool.query('SELECT device_id FROM apcs_signals WHERE id=$1', [signalId])).rows[0].device_id;
  await pool.query("INSERT INTO apcs_signals(id,device_id,name,data_type,direction) VALUES($1,$2,'Sensor','float64','input')", [sensor, device]);
  const response = await app.inject({ method: 'POST', url: '/api/v1/commands', headers: { ...headers, 'idempotency-key': randomUUID() }, payload: { targetSignalId: sensor, value: true, ttlMs: 1000, expectedProjectRevision: 1, reason: 'Invalid actuator fixture' } });
  expect(response.statusCode).toBe(422); expect(response.json().code).toBe('NOT_AN_OUTPUT');
  expect((await pool.query('SELECT id FROM apcs_commands WHERE target_signal_id=$1', [sensor])).rowCount).toBe(0);
});

it('binds numeric HMI values without allowing them to become boolean controls', async () => {
  const sensor = randomUUID(); const device = (await pool.query('SELECT device_id FROM apcs_signals WHERE id=$1', [signalId])).rows[0].device_id;
  await pool.query("INSERT INTO apcs_signals(id,device_id,name,data_type,direction) VALUES($1,$2,'Sensor','float64','input')", [sensor, device]);
  const id = (await create('screens')).json().id;
  const value = { id: 'temperature', kind: 'value', label: 'Temperature (C)', signalId: sensor, x: 0, y: 0, width: 180, height: 80 };
  const document = { schemaVersion: 1, width: 1200, height: 800, items: [value] };
  expect((await save(id, document, 1, 'screens')).statusCode).toBe(200);
  expect((await app.inject({ method: 'POST', url: `/api/v1/screens/${id}/revisions`, headers: { ...headers, 'if-match': '"2"' } })).statusCode).toBe(201);
  expect((await save(id, { ...document, items: [{ ...value, kind: 'button' }] }, 2, 'screens')).statusCode).toBe(422);
  expect((await save(id, { ...document, items: [{ ...value, signalId }] }, 2, 'screens')).statusCode).toBe(422);
});

it('reconciles an uncertain virtual heater only against a new observed OFF session', async () => {
  await app.close();
  const runtime = new RuntimeProcess({ connectionString: process.env.APCS_TEST_POSTGRES_URL!, mqttUrl: process.env.APCS_TEST_MQTT_URL!, databaseOptions: `-c search_path=${schema}` });
  app = await createApi({ pool, origin: 'http://localhost:5173', secureCookies: false, runtime });
  const created = await app.inject({ method: 'POST', url: '/api/v1/devices', headers, payload: { projectId, name: 'Recovery heater', kind: 'virtual-thermal', siteId: 'recovery', deviceId: 'heater' } });
  expect(created.statusCode).toBe(201); const device = created.json();
  const actor = (await pool.query('SELECT owner_id FROM apcs_projects WHERE id=$1', [projectId])).rows[0].owner_id;
  const context = { bootId: 'old-boot', quality: 'Good' as const, ownerId: actor, projectRevision: 1, maxTtlMs: 3000, interlockReason: null };
  const command = { id: randomUUID(), idempotencyKey: randomUUID(), actorId: actor, targetSignalId: device.signalId, value: true, expectedProjectRevision: 1, ttlMs: 3000, reason: 'Uncertain heater fixture' };
  const journal = new PgCommandJournal(pool); await journal.request(command, context); await journal.claimNext(async () => context); await journal.connectionLost(device.signalId);
  const reconcile = () => app.inject({ method: 'POST', url: `/api/v1/commands/${command.id}/reconcile`, headers, payload: { reason: 'Inspected new virtual heater session', acceptUnknownOutcome: true } });
  expect((await reconcile()).statusCode).toBe(409);
  expect((await app.inject({ method: 'POST', url: `/api/v1/devices/${device.id}/runtime`, headers, payload: { action: 'start', reason: 'Recovery fixture' } })).statusCode).toBe(200);
  const result = await reconcile(); expect(result.statusCode, result.body).toBe(200); expect(result.json()).toMatchObject({ state: 'Unknown', reconciliation: { observedValue: false, actorId: actor } });
  expect(result.json().reconciliation.bootId).not.toBe('old-boot');
  expect((await pool.query('SELECT id FROM apcs_commands WHERE target_signal_id=$1', [device.signalId])).rowCount).toBe(1);
});

it('creates typed numeric alarms and rejects incompatible bindings and unauthenticated mutations', async () => {
  const sensor = randomUUID(); const device = (await pool.query('SELECT device_id FROM apcs_signals WHERE id=$1', [signalId])).rows[0].device_id;
  await pool.query("INSERT INTO apcs_signals(id,device_id,name,data_type,direction) VALUES($1,$2,'Sensor','float64','input')", [sensor, device]);
  const url = `/api/v1/projects/${projectId}/alarms`;
  const payload = { name: 'High temperature', signalId: sensor, priority: 'high', definition: { condition: { kind: 'threshold', direction: 'high', threshold: 24, deadband: 1 }, activationDelayMs: 500, returnDelayMs: 1000 } };
  const created = await app.inject({ method: 'POST', url, headers, payload }); expect(created.statusCode, created.body).toBe(201);
  expect((await app.inject({ method: 'POST', url, headers, payload: { ...payload, signalId } })).statusCode).toBe(422);
  expect((await app.inject({ method: 'POST', url, headers: { cookie: headers.cookie! }, payload })).statusCode).toBe(403);
  expect((await app.inject({ method: 'POST', url, headers, payload: { ...payload, definition: { ...payload.definition, condition: { ...payload.definition.condition, deadband: -1 } } } })).statusCode).toBe(422);
  expect((await pool.query('SELECT definition FROM apcs_alarms WHERE id=$1', [created.json().id])).rows[0].definition).toEqual(payload.definition);
});


it('persists, simulates and activates a counter/filter graph through the common MQTT output path', async () => {
  await app.close();
  const runtime = new RuntimeProcess({ connectionString: process.env.APCS_TEST_POSTGRES_URL!, mqttUrl: process.env.APCS_TEST_MQTT_URL!, databaseOptions: `-c search_path=${schema}` });
  app = await createApi({ pool, origin: 'http://localhost:5173', secureCookies: false, runtime });
  const id = (await create()).json().id; const document = statefulGraph(signalId);
  const saved = await save(id, document); expect(saved.statusCode, saved.body).toBe(200);
  expect((await app.inject({ method: 'POST', url: `/api/v1/graphs/${id}/revisions`, headers: { ...headers, 'if-match': '"2"' } })).statusCode).toBe(201);
  const simulated = await app.inject({ method: 'POST', url: `/api/v1/graphs/${id}/simulate`, headers, payload: { steps: [0, 500, 1000, 1500, 2000].map((atMs) => ({ atMs, inputs: {} })) } });
  expect(simulated.statusCode, simulated.body).toBe(200);
  expect(simulated.json().steps.map((step: { nodes: Record<string, { value: unknown }> }) => step.nodes.count!.value)).toEqual([0, 0, 1, 1, 1]);
  expect(simulated.json().steps.map((step: { outputs: Record<string, { value: unknown }> }) => step.outputs[signalId]!.value)).toEqual([false, false, false, true, true]);
  expect((await pool.query('SELECT count(*) FROM apcs_commands')).rows[0].count).toBe('0');
  const device = (await pool.query('SELECT device_id FROM apcs_signals WHERE id=$1', [signalId])).rows[0].device_id;
  expect((await app.inject({ method: 'POST', url: `/api/v1/devices/${device}/runtime`, headers, payload: { action: 'start', reason: 'Stateful numeric fixture' } })).statusCode).toBe(200);
  expect((await app.inject({ method: 'POST', url: `/api/v1/graphs/${id}/runtime`, headers, payload: { action: 'activate', revision: 2, reason: 'Reviewed edge counting and smoothing' } })).statusCode).toBe(200);
  await expect.poll(async () => (await runtime.readSignal(signalId)).value, { timeout: 5000 }).toBe(true);
  await expect.poll(async () => (await pool.query("SELECT snapshot->>'state' AS state FROM apcs_commands WHERE target_signal_id=$1 ORDER BY created_at DESC LIMIT 1", [signalId])).rows[0]?.state).toBe('Verified');
});


it('simulates PID faults and controls a virtual thermal process through a prepared revision', async () => {
  await app.close();
  const runtime = new RuntimeProcess({ connectionString: process.env.APCS_TEST_POSTGRES_URL!, mqttUrl: process.env.APCS_TEST_MQTT_URL!, databaseOptions: `-c search_path=${schema}` });
  app = await createApi({ pool, origin: 'http://localhost:5173', secureCookies: false, runtime });
  const created = await app.inject({ method: 'POST', url: '/api/v1/devices', headers, payload: { projectId, name: 'PID bench', kind: 'virtual-thermal', siteId: 'pid', deviceId: 'heater' } });
  expect(created.statusCode).toBe(201); const device = created.json();
  const id = (await create()).json().id; const document = pidGraph(device.temperatureSignalId, device.signalId);
  const saved = await save(id, document); expect(saved.statusCode, saved.body).toBe(200);
  expect((await app.inject({ method: 'POST', url: `/api/v1/graphs/${id}/revisions`, headers: { ...headers, 'if-match': '"2"' } })).statusCode).toBe(201);
  const simulated = await app.inject({ method: 'POST', url: `/api/v1/graphs/${id}/simulate`, headers, payload: { steps: [[0, 24], [1000, 20], [2000, 20], [5001, 20]].map(([atMs, value]) => ({ atMs, inputs: { [device.temperatureSignalId]: value } })) } });
  expect(simulated.statusCode, simulated.body).toBe(200);
  expect(simulated.json().steps.map((step: { outputs: Record<string, { value: unknown }> }) => step.outputs[device.signalId]!.value)).toEqual([false, false, true, null]);
  expect((await pool.query('SELECT count(*) FROM apcs_commands')).rows[0].count).toBe('0');
  expect((await app.inject({ method: 'POST', url: `/api/v1/devices/${device.id}/runtime`, headers, payload: { action: 'start', reason: 'PID virtual fixture' } })).statusCode).toBe(200);
  expect((await app.inject({ method: 'POST', url: `/api/v1/graphs/${id}/runtime`, headers, payload: { action: 'activate', revision: 2, reason: 'Reviewed PID parameters' } })).statusCode).toBe(200);
  await expect.poll(async () => (await pool.query("SELECT count(*)::int AS n FROM apcs_commands WHERE target_signal_id=$1 AND request->>'value'='true' AND snapshot->>'state'='Verified'", [device.signalId])).rows[0].n, { timeout: 5000 }).toBeGreaterThan(0);
  await expect.poll(async () => Number((await runtime.readSignal(device.temperatureSignalId)).value), { timeout: 5000 }).toBeGreaterThan(20);
  await runtime.stop(device.id); await expect.poll(async () => (await runtime.graphStatus(id)).state).toBe('faulted');
});

it('requires a simulation epoch for weekly schedules and applies explicit UTC windows without commands', async () => {
  const { scheduleGraph } = await import('../fixtures/schedule-graph.js');
  const id = (await create()).json().id; expect((await save(id, scheduleGraph(signalId))).statusCode).toBe(200);
  const simulate = (startAt?: string) => app.inject({ method: 'POST', url: `/api/v1/graphs/${id}/simulate`, headers, payload: { ...(startAt ? { startAt } : {}), steps: [0, 1000, 28801000].map((atMs) => ({ atMs, inputs: {} })) } });
  expect((await simulate()).statusCode).toBe(422);
  const valid = await simulate('2026-10-12T08:59:59.000Z'); expect(valid.statusCode, valid.body).toBe(200);
  expect(valid.json().steps.map((s: { outputs: Record<string, { value: unknown }> }) => s.outputs[signalId]!.value)).toEqual([false, true, false]);
  for (const invalid of ['2026-10-12T09:00:00', '2026-02-30T09:00:00.000Z', '1899-12-31T09:00:00.000Z']) expect((await simulate(invalid)).statusCode).toBe(422);
  expect((await pool.query('SELECT count(*) FROM apcs_commands')).rows[0].count).toBe('0');
});
it('activates a prepared all-day schedule using server wall time and verifies the MQTT command', async () => {
  const { scheduleGraph } = await import('../fixtures/schedule-graph.js');
  await app.close(); const runtime = new RuntimeProcess({ connectionString: process.env.APCS_TEST_POSTGRES_URL!, mqttUrl: process.env.APCS_TEST_MQTT_URL!, databaseOptions: `-c search_path=${schema}` });
  app = await createApi({ pool, origin: 'http://localhost:5173', secureCookies: false, runtime });
  const id = (await create()).json().id; const document = scheduleGraph(signalId);
  document.nodes[0]!.schedule = { zone: 'UTC', days: [1, 2, 3, 4, 5, 6, 7], startMinute: 0, endMinute: 0 };
  expect((await save(id, document)).statusCode).toBe(200);
  expect((await app.inject({ method: 'POST', url: `/api/v1/graphs/${id}/revisions`, headers: { ...headers, 'if-match': '"2"' } })).statusCode).toBe(201);
  const device = (await pool.query('SELECT device_id FROM apcs_signals WHERE id=$1', [signalId])).rows[0].device_id;
  expect((await app.inject({ method: 'POST', url: `/api/v1/devices/${device}/runtime`, headers, payload: { action: 'start', reason: 'Weekly schedule fixture' } })).statusCode).toBe(200);
  expect((await app.inject({ method: 'POST', url: `/api/v1/graphs/${id}/runtime`, headers, payload: { action: 'activate', revision: 2, reason: 'Reviewed weekly schedule' } })).statusCode).toBe(200);
  await expect.poll(async () => (await pool.query("SELECT count(*)::int AS n FROM apcs_commands WHERE target_signal_id=$1 AND request->>'value'='true' AND snapshot->>'state'='Verified'", [signalId])).rows[0].n, { timeout: 5000 }).toBe(1);
});

it('simulates a one-shot sequence without writes and verifies each requested transition headlessly', async () => {
  const { sequenceGraph } = await import('../fixtures/sequence-graph.js');
  await app.close(); const runtime = new RuntimeProcess({ connectionString: process.env.APCS_TEST_POSTGRES_URL!, mqttUrl: process.env.APCS_TEST_MQTT_URL!, databaseOptions: `-c search_path=${schema}` });
  app = await createApi({ pool, origin: 'http://localhost:5173', secureCookies: false, runtime });
  const id = (await create()).json().id;
  expect((await save(id, sequenceGraph(signalId))).statusCode).toBe(200);
  expect((await app.inject({ method: 'POST', url: `/api/v1/graphs/${id}/revisions`, headers: { ...headers, 'if-match': '"2"' } })).statusCode).toBe(201);
  const simulation = await app.inject({ method: 'POST', url: `/api/v1/graphs/${id}/simulate`, headers, payload: { steps: [0, 1000, 2000, 3000, 4000, 5000].map((atMs) => ({ atMs, inputs: {} })) } });
  expect(simulation.statusCode, simulation.body).toBe(200);
  expect(simulation.json().steps.map((step: { outputs: Record<string, { value: unknown }> }) => step.outputs[signalId]!.value)).toEqual([false, true, false, true, false, false]);
  expect(simulation.json().steps.at(-1).nodes.sequence.sequence.state).toBe('Completed');
  expect((await pool.query('SELECT count(*) FROM apcs_commands')).rows[0].count).toBe('0');
  const device = (await pool.query('SELECT device_id FROM apcs_signals WHERE id=$1', [signalId])).rows[0].device_id;
  expect((await app.inject({ method: 'POST', url: `/api/v1/devices/${device}/runtime`, headers, payload: { action: 'start', reason: 'Sequence fixture' } })).statusCode).toBe(200);
  expect((await app.inject({ method: 'POST', url: `/api/v1/graphs/${id}/runtime`, headers, payload: { action: 'activate', revision: 2, reason: 'Reviewed one-shot steps' } })).statusCode).toBe(200);
  const values = async () => (await pool.query("SELECT request->'value' AS value FROM apcs_commands WHERE target_signal_id=$1 AND snapshot->>'state'='Verified' ORDER BY created_at", [signalId])).rows.map((row) => row.value);
  await expect.poll(values, { timeout: 8000 }).toEqual([true, false, true, false]);
  await expect.poll(async () => (await runtime.graphStatus(id)).pending).toEqual([]);
  const changed = sequenceGraph(signalId); changed.nodes[3]!.label = 'New draft label';
  expect((await save(id, changed, 2)).statusCode).toBe(200);
  const trace = await app.inject({ method: 'GET', url: `/api/v1/graphs/${id}/runtime`, headers });
  expect(trace.statusCode).toBe(200);
  expect(trace.json()).toMatchObject({ revision: 2, state: 'running', pending: [], evaluation: { result: { nodes: { sequence: { sequence: { state: 'Completed' } } } } } });
  expect(Number.isFinite(Date.parse(trace.json().evaluation.at))).toBe(true);
  expect(trace.json().evaluation.cycle).toBeGreaterThan(0);
  expect(trace.json().evaluation.blocks.find((block: { id: string }) => block.id === 'sequence').label).toBe('LED sequence');
  expect((await app.inject({ method: 'GET', url: `/api/v1/graphs/${id}/runtime` })).statusCode).toBe(401);

  expect((await runtime.graphStatus(id)).state).toBe('running');
});
