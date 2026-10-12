import { createHash, randomUUID } from 'node:crypto';
import { canonicalJson } from '../../packages/domain/src/screen.js';
import { Pool } from 'pg';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { RuntimeProcess } from '../../apps/api/src/runtime-process.js';
import { SimulationRuntime, type RuntimeControl } from '../../apps/api/src/runtime-service.js';
import { migrateApplication } from '../../apps/api/src/store.js';
import { PgCommandJournal } from '../../packages/storage/src/command-journal.js';
import type { CommandRequest } from '../../packages/domain/src/commands.js';
let admin: Pool; let pool: Pool; let schema: string; let runtime: SimulationRuntime; let other: RuntimeControl | undefined;
let deviceId: string; let signalId: string; let actorId: string; let projectId: string; let journal: PgCommandJournal;
beforeEach(async () => {
  const connectionString = process.env.APCS_TEST_POSTGRES_URL; if (!connectionString || !process.env.APCS_TEST_MQTT_URL) throw new Error('Docker fixtures required');
  schema = `runtime_${randomUUID().replaceAll('-', '')}`; admin = new Pool({ connectionString }); await admin.query(`CREATE SCHEMA ${schema}`);
  pool = new Pool({ connectionString, options: `-c search_path=${schema}`, connectionTimeoutMillis: 1000, query_timeout: 2000 }); await migrateApplication(pool); journal = new PgCommandJournal(pool); await journal.migrate();
  actorId = randomUUID(); projectId = randomUUID(); deviceId = randomUUID(); signalId = randomUUID();
  await pool.query('INSERT INTO apcs_users (id,username,password_hash) VALUES ($1,$2,$3)', [actorId, 'fixture', 'fixture-only']);
  await pool.query('INSERT INTO apcs_projects (id,name,owner_id) VALUES ($1,$2,$3)', [projectId, 'Runtime bench', actorId]);
  await pool.query('INSERT INTO apcs_devices (id,project_id,name,kind,site_id,protocol_device_id) VALUES ($1,$2,$3,$4,$5,$6)', [deviceId, projectId, 'Virtual LED', 'virtual-led', 'bench', 'wire-led']);
  await pool.query('INSERT INTO apcs_signals (id,device_id,name,data_type,direction) VALUES ($1,$2,$3,$4,$5)', [signalId, deviceId, 'LED', 'boolean', 'output']);
  runtime = new SimulationRuntime(pool, process.env.APCS_TEST_MQTT_URL); other = undefined;
});
afterEach(async () => { await runtime?.close(); await other?.close(); await pool?.end(); if (admin) { try { await admin.query(`DROP SCHEMA ${schema} CASCADE`); } finally { await admin.end(); } } });
const request = (): CommandRequest => ({ id: randomUUID(), idempotencyKey: randomUUID(), actorId, targetSignalId: signalId, value: true, expectedProjectRevision: 1, ttlMs: 2000, reason: 'Runtime test' });
async function waitFor(check: () => Promise<boolean>) { const end = performance.now() + 3000; while (performance.now() < end) { if (await check()) return; await new Promise((r) => setTimeout(r, 15)); } throw new Error('Runtime condition timed out'); }
async function prepared(value: boolean, id = randomUUID(), revision = 1) {
  const document = { schemaVersion: 1, nodes: [{ id: 'constant', kind: 'constant', value, label: 'Power', x: 0, y: 0 }, { id: 'output', kind: 'output', signalId, label: 'LED', x: 100, y: 0 }], edges: [{ id: 'wire', source: 'constant', target: 'output', port: 'in' }] };
  const name = 'Runtime graph'; const checksum = createHash('sha256').update(canonicalJson({ name, document })).digest('hex');
  await pool.query("INSERT INTO apcs_documents (id,project_id,kind,name,document,revision) VALUES ($1,$2,'graph',$3,$4,$5) ON CONFLICT (id) DO UPDATE SET document=$4, revision=$5", [id, projectId, name, document, revision]);
  await pool.query('INSERT INTO apcs_document_revisions (document_id,revision,name,document,checksum,actor_id) VALUES ($1,$2,$3,$4,$5,$6)', [id, revision, name, document, checksum, actorId]);
  return id;
}
describe('catalog-driven simulation runtime', () => {
  it('executes a prepared graph headlessly and prevents manual control from bypassing graph ownership', async () => {
    const id = await prepared(true); await runtime.start(deviceId, actorId);
    expect(await runtime.activateGraph(id, 1, actorId)).toMatchObject({ state: 'running', revision: 1 });
    await waitFor(async () => (await runtime.readSignal(signalId)).value === true);
    const manual = request(); expect((await journal.request(manual, await runtime.context(manual))).state).toBe('Rejected');
    await runtime.stopGraph(id); expect((await runtime.graphStatus(id)).state).toBe('stopped');
    expect((await runtime.readSignal(signalId)).quality).toBe('Disconnected');
  });
  it('switches graph revisions after draining commands while retaining the device session', async () => {
    const id = await prepared(true); await runtime.start(deviceId, actorId); const boot = (await runtime.readSignal(signalId)).bootId;
    await runtime.activateGraph(id, 1, actorId); await waitFor(async () => (await runtime.readSignal(signalId)).value === true);
    await prepared(false, id, 2); expect((await runtime.activateGraph(id, 2, actorId)).revision).toBe(2);
    await waitFor(async () => (await runtime.readSignal(signalId)).value === false);
    expect((await runtime.readSignal(signalId)).bootId).toBe(boot); expect((await runtime.status(deviceId)).state).toBe('running');
  });
  it('keeps the previous graph running when a requested revision does not exist', async () => {
    const id = await prepared(true); await runtime.start(deviceId, actorId); await runtime.activateGraph(id, 1, actorId);
    await expect(runtime.activateGraph(id, 99, actorId)).rejects.toThrow(/revision/i);
    expect(await runtime.graphStatus(id)).toMatchObject({ revision: 1, state: 'running' });
  });
  it('rejects competing output owners, unstarted devices, and a forged activation actor', async () => {
    const id = await prepared(true); await expect(runtime.activateGraph(id, 1, actorId)).rejects.toThrow(/running/i);
    await runtime.start(deviceId, actorId); await expect(runtime.activateGraph(id, 1, randomUUID())).rejects.toThrow(/owner/i);
    await runtime.activateGraph(id, 1, actorId); const competing = await prepared(false);
    await expect(runtime.activateGraph(competing, 1, actorId)).rejects.toThrow(/owner/i);
    expect((await runtime.graphStatus(id)).state).toBe('running');
  });

  it('does not let delayed compensation stop a newer activation', async () => {
    const id = await prepared(true); await runtime.start(deviceId, actorId);
    const first = await runtime.activateGraph(id, 1, actorId);
    const second = await runtime.activateGraph(id, 1, actorId);
    await runtime.stopGraph(id, first.activationId!);
    expect(await runtime.graphStatus(id)).toMatchObject({ state: 'running', activationId: second.activationId });
    await runtime.stopGraph(id, second.activationId!);
    expect((await runtime.graphStatus(id)).state).toBe('stopped');
  });
  it('rejects a corrupted prepared checksum before disturbing the active revision', async () => {
    const id = await prepared(true); await runtime.start(deviceId, actorId); await runtime.activateGraph(id, 1, actorId);
    const document = { schemaVersion: 1, nodes: [], edges: [] };
    await pool.query('INSERT INTO apcs_document_revisions (document_id,revision,name,document,checksum,actor_id) VALUES ($1,2,$2,$3,$4,$5)', [id, 'Corrupted import', document, '0'.repeat(64), actorId]);
    await expect(runtime.activateGraph(id, 2, actorId)).rejects.toThrow(/checksum/i);
    expect(await runtime.graphStatus(id)).toMatchObject({ revision: 1, state: 'running' });
  });

  it('executes in a separate process and does not rearm after its process is killed', async () => {
    const client = new RuntimeProcess({ connectionString: process.env.APCS_TEST_POSTGRES_URL!, mqttUrl: process.env.APCS_TEST_MQTT_URL!, databaseOptions: `-c search_path=${schema}` }); other = client;
    expect((await client.start(deviceId, actorId)).state).toBe('running'); expect(client.pid).toBeTypeOf('number'); expect(client.pid).not.toBe(process.pid);
    const input = request(); await journal.request(input, await client.context(input));
    await waitFor(async () => (await journal.get(input.id)).state === 'Verified');
    process.kill(client.pid!, 'SIGKILL');
    await waitFor(async () => { try { return (await client.readSignal(signalId)).quality === 'Disconnected'; } catch { return false; } });
    expect((await client.context(request())).quality).toBe('Disconnected');
    expect((await client.status(deviceId)).state).toBe('stopped');
  });

  it('starts only on demand and verifies a durable command without browser polling', async () => {
    expect((await runtime.readSignal(signalId)).quality).toBe('Disconnected');
    expect(await runtime.start(deviceId, actorId)).toMatchObject({ state: 'running', environment: 'Simulation' });
    expect(await runtime.readSignal(signalId)).toMatchObject({ quality: 'Good', value: false });
    const input = request(); expect((await journal.request(input, await runtime.context(input))).state).toBe('Accepted');
    await waitFor(async () => (await journal.get(input.id)).state === 'Verified');
    expect(await runtime.readSignal(signalId)).toMatchObject({ value: true, quality: 'Good' });
  });
  it('rejects physical profiles and an actor who does not own the project', async () => {
    await expect(runtime.start(deviceId, randomUUID())).rejects.toThrow(/owner/i);
    await pool.query("UPDATE apcs_devices SET kind='esp32-led' WHERE id=$1", [deviceId]);
    await expect(runtime.start(deviceId, actorId)).rejects.toThrow(/virtual/i);
    expect((await runtime.readSignal(signalId)).quality).toBe('Disconnected');
  });
  it('allows only one runtime owner for the workspace and releases ownership on close', async () => {
    await runtime.start(deviceId, actorId); other = new SimulationRuntime(pool, process.env.APCS_TEST_MQTT_URL!);
    await expect(other.start(deviceId, actorId)).rejects.toThrow(/owner/i);
    await runtime.close(); expect((await other.start(deviceId, actorId)).state).toBe('running');
  });
  it('stops explicitly, disconnects quality, and cancels pending intents instead of replaying them', async () => {
    await runtime.start(deviceId, actorId);
    const firstBoot = (await runtime.readSignal(signalId)).bootId;
    const pending = request(); await journal.request(pending, await runtime.context(pending));
    await runtime.stop(deviceId);
    expect(['Accepted', 'Dispatched', 'DeviceAccepted']).not.toContain((await journal.get(pending.id)).state);
    expect(await runtime.status(deviceId)).toMatchObject({ state: 'stopped' });
    expect((await runtime.readSignal(signalId)).quality).toBe('Disconnected');
    expect((await journal.request(request(), await runtime.context(request()))).state).toBe('Rejected');
    await runtime.start(deviceId, actorId); expect((await runtime.readSignal(signalId)).bootId).not.toBe(firstBoot);
    expect((await runtime.readSignal(signalId)).value).toBe(false);
  });
  it('reports a fault and disconnects signals when its database ownership session is terminated', async () => {
    await runtime.start(deviceId, actorId);
    const lock = await pool.query<{ pid: number }>(`WITH key AS (SELECT hashtextextended(current_schema() || ':open-apcs-simulation-runtime', 0) AS value) SELECT pid FROM pg_locks, key WHERE locktype='advisory' AND granted AND classid::bigint=((key.value >> 32) & 4294967295) AND objid::bigint=(key.value & 4294967295)`);
    expect(lock.rows).toHaveLength(1);
    await admin.query('SELECT pg_terminate_backend($1)', [lock.rows[0]!.pid]);
    await waitFor(async () => (await runtime.readSignal(signalId)).quality === 'Disconnected');
    expect((await runtime.status(deviceId)).state).toBe('faulted');
    await expect(runtime.start(deviceId, actorId)).rejects.toThrow(/ownership/i);
  });
  it('reads current project revisions and refuses commands from a stale browser', async () => {
    await runtime.start(deviceId, actorId); await pool.query('UPDATE apcs_projects SET revision=2 WHERE id=$1', [projectId]);
    const input = request(); expect((await runtime.context(input)).projectRevision).toBe(2);
    expect((await journal.request(input, await runtime.context(input))).state).toBe('Rejected');
  });
});
