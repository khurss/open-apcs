import { createApi } from '../../apps/api/src/app.js';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { RuntimeProcess } from '../../apps/api/src/runtime-process.js';
import { loadPhysicalConfig } from '../../apps/api/src/physical-file.js';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { Pool } from 'pg';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { SimulationRuntime } from '../../apps/api/src/runtime-service.js';
import { migrateApplication } from '../../apps/api/src/store.js';
import { PgCommandJournal } from '../../packages/storage/src/command-journal.js';
import { MqttLedSimulator } from '../../packages/gateway/src/mqtt-led.js';
import { LedPeer } from '../../packages/led-protocol/src/index.js';
import type { PhysicalConfig } from '../../packages/gateway/src/physical-config.js';
let admin: Pool; let pool: Pool; let schema: string; let runtime: SimulationRuntime; let simulator: MqttLedSimulator;
let app: Awaited<ReturnType<typeof createApi>> | undefined;
let processRuntime: RuntimeProcess | undefined; let directory: string | undefined;
let actor: string; let device: string; let signal: string; let config: PhysicalConfig; let journal: PgCommandJournal;
beforeEach(async () => {
  const connectionString = process.env.APCS_TEST_POSTGRES_URL; if (!connectionString) throw new Error('Docker fixtures required');
  schema = `physical_${randomUUID().replaceAll('-', '')}`; admin = new Pool({ connectionString }); await admin.query(`CREATE SCHEMA ${schema}`);
  pool = new Pool({ connectionString, options: `-c search_path=${schema}` }); await migrateApplication(pool); journal = new PgCommandJournal(pool); await journal.migrate();
  actor = randomUUID(); device = randomUUID(); signal = randomUUID(); const project = randomUUID();
  await pool.query("INSERT INTO apcs_users(id,username,password_hash) VALUES($1,'fixture','fixture')", [actor]);
  await pool.query("INSERT INTO apcs_projects(id,name,owner_id) VALUES($1,'TLS bench',$2)", [project, actor]);
  await pool.query("INSERT INTO apcs_devices(id,project_id,name,kind,site_id,protocol_device_id) VALUES($1,$2,'Physical profile','esp32-led','tls','led')", [device, project]);
  await pool.query("INSERT INTO apcs_signals(id,device_id,name,data_type,direction) VALUES($1,$2,'LED','boolean','output')", [signal, device]);
  const ca = await readFile(new URL('../../.cache/mqtt-tls-fixture/ca.crt', import.meta.url), 'utf8');
  config = { url: 'mqtts://mqtt-tls:8883', username: 'gateway', password: 'fixture-gateway-password', ca, devices: [{ siteId: 'tls', deviceId: 'led', gpio: 18 }] };
  simulator = new MqttLedSimulator({ url: config.url, siteId: 'tls', deviceId: 'led', signalId: signal, credentials: { ca, username: 'device', password: 'fixture-device-password' } }, new LedPeer(() => performance.now(), 'physical-fixture'));
  runtime = new SimulationRuntime(pool, process.env.APCS_TEST_MQTT_URL!, config);
});
afterEach(async () => { await app?.close(); app = undefined; await processRuntime?.close(); processRuntime = undefined; if (directory) await rm(directory, { recursive: true, force: true }); directory = undefined; await runtime?.close(); await simulator?.stop(); await pool?.end(); if (admin) { try { await admin.query(`DROP SCHEMA ${schema} CASCADE`); } finally { await admin.end(); } } });
function request() { return { id: randomUUID(), idempotencyKey: randomUUID(), actorId: actor, targetSignalId: signal, value: true, expectedProjectRevision: 1, ttlMs: 3000, reason: 'TLS simulator commissioning' }; }
describe('physical-profile runtime verified with a TLS simulator', () => {
  it.each([18, 5])('requires authenticated owner review on GPIO%i and compensates when arming cannot be audited', async (gpio) => {
    config.devices[0]!.gpio = gpio;
    await runtime.close(); runtime = new SimulationRuntime(pool, process.env.APCS_TEST_MQTT_URL!, config);
    app = await createApi({ pool, origin: 'http://localhost:5173', secureCookies: false, runtime });
    const token = randomBytes(32).toString('base64url'); const csrf = randomBytes(32).toString('hex');
    await pool.query("INSERT INTO apcs_sessions(token_hash,user_id,csrf_token,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')", [createHash('sha256').update(token).digest('hex'), actor, csrf]);
    const headers = { origin: 'http://localhost:5173', cookie: `apcs_session=${token}`, 'x-csrf-token': csrf };
    const url = `/api/v1/devices/${device}/commission`; const payload = { action: 'start', gpio, acknowledgeLedOnly: true, reason: 'Reviewed isolated LED bench' };
    expect((await app.inject({ method: 'POST', url, headers: { origin: headers.origin }, payload })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url, headers: { ...headers, 'x-csrf-token': '' }, payload })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url, headers, payload: { ...payload, acknowledgeLedOnly: false } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url, headers, payload: { ...payload, actorId: actor } })).statusCode).toBe(400);
    await simulator.start();
    expect((await app.inject({ method: 'POST', url, headers, payload: { ...payload, gpio: 19 } })).statusCode).toBe(503);
    const started = await app.inject({ method: 'POST', url, headers, payload }); expect(started.statusCode).toBe(200); expect(started.json().state).toBe('running');
    const foreign = randomUUID(); await pool.query("INSERT INTO apcs_users(id,username,password_hash) VALUES($1,'foreign','fixture')", [foreign]);
    await pool.query('UPDATE apcs_sessions SET user_id=$1', [foreign]);
    expect((await app.inject({ method: 'POST', url, headers, payload: { action: 'stop', reason: 'Foreign stop' } })).statusCode).toBe(404);
    await pool.query('UPDATE apcs_sessions SET user_id=$1', [actor]);
    expect((await app.inject({ method: 'POST', url, headers, payload: { action: 'stop', reason: 'End bench' } })).json().state).toBe('stopped');
    await pool.query("CREATE FUNCTION deny_physical_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='physical.start.completed' THEN RAISE EXCEPTION 'Fixture audit failure'; END IF; RETURN NEW; END $$");
    await pool.query('CREATE TRIGGER deny_physical_audit BEFORE INSERT ON apcs_audit FOR EACH ROW EXECUTE FUNCTION deny_physical_audit()');
    expect((await app.inject({ method: 'POST', url, headers, payload })).statusCode).toBe(503);
    expect((await runtime.status(device)).state).toBe('stopped');
    const audit = (await pool.query("SELECT data FROM apcs_audit WHERE action='physical.start.requested'")).rows;
    expect(audit[0].data).toEqual({ reason: payload.reason, gpio: 19, acknowledgeLedOnly: true });
    expect(JSON.stringify(audit)).not.toContain(config.password);
  });

  it('arms through private IPC using a private validated configuration and stays disarmed after worker loss', async () => {
    directory = await mkdtemp('/tmp/apcs-physical-'); const path = `${directory}/config.json`;
    await writeFile(path, JSON.stringify(config), { mode: 0o600 }); expect(await loadPhysicalConfig(path)).toEqual(config);
    processRuntime = new RuntimeProcess({ connectionString: process.env.APCS_TEST_POSTGRES_URL!, mqttUrl: process.env.APCS_TEST_MQTT_URL!, databaseOptions: `-c search_path=${schema}`, physicalConfigPath: path });
    await simulator.start(); expect((await processRuntime.startPhysical(device, actor, 18)).state).toBe('running');
    process.kill(processRuntime.pid!, 'SIGKILL');
    await expect.poll(async () => { try { return (await processRuntime!.context(request())).quality; } catch { return null; } }, { timeout: 4000 }).toBe('Disconnected');
    expect((await processRuntime.status(device)).state).toBe('stopped');
  });
  it('refuses disabled commissioning, an unreviewed pin and a foreign actor', async () => {
    await expect(runtime.startPhysical(device, actor, 19)).rejects.toThrow(/GPIO/);
    await expect(runtime.startPhysical(device, randomUUID(), 18)).rejects.toThrow(/owner/);
    await runtime.close(); runtime = new SimulationRuntime(pool, process.env.APCS_TEST_MQTT_URL!);
    await expect(runtime.startPhysical(device, actor, 18)).rejects.toThrow(/configured/);
    expect((await runtime.readSignal(signal)).quality).toBe('Disconnected');
  });
  it('cancels undispatched old intents before rearming the same device boot and verifies a new command', async () => {
    const old = request(); await journal.request(old, { bootId: 'physical-fixture', ownerId: actor, quality: 'Good', projectRevision: 1, maxTtlMs: 3000, interlockReason: null });
    await simulator.start(); expect(await runtime.startPhysical(device, actor, 18)).toMatchObject({ state: 'running', environment: 'Hardware bench' });
    expect((await journal.get(old.id)).state).toBe('Cancelled'); expect((await runtime.readSignal(signal)).value).toBe(false);
    const fresh = request(); await journal.request(fresh, await runtime.context(fresh)); await expect.poll(async () => (await journal.get(fresh.id)).state, { timeout: 3000 }).toBe('Verified'); expect(simulator.peer.read()).toBe(true);
    await runtime.stop(device); expect((await runtime.readSignal(signal)).quality).toBe('Disconnected');
    await expect.poll(() => simulator.peer.read(), { timeout: 4000 }).toBe(false);
  });
  it('never restores physical authority when a runtime is replaced', async () => {
    await simulator.start(); await runtime.startPhysical(device, actor, 18); await runtime.close();
    runtime = new SimulationRuntime(pool, process.env.APCS_TEST_MQTT_URL!, config);
    expect((await runtime.context(request())).quality).toBe('Disconnected');
    expect((await runtime.status(device)).state).toBe('stopped');
    await runtime.startPhysical(device, actor, 18); expect((await runtime.readSignal(signal)).value).toBe(false);
  });
});
