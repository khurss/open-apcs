import { enqueueNotifications, syncNotificationRoutes, claimNotification, finishNotification } from '../../apps/api/src/notification-store.js';
import { transaction } from '../../apps/api/src/store.js';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { PgHistoryAggregates } from '../../packages/storage/src/history-aggregates.js';
import { PgSignalArchive } from '../../packages/storage/src/signal-archive.js';
import { SignalStore } from '../../packages/domain/src/signals.js';
import { PgCommandJournal } from '../../packages/storage/src/command-journal.js';
import { LedPeer } from '../../packages/led-protocol/src/index.js';
import { MqttLedGateway, MqttLedSimulator } from '../../packages/gateway/src/mqtt-led.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { RuntimeProcess } from '../../apps/api/src/runtime-process.js';
import { createApi } from '../../apps/api/src/app.js';
import { bootstrapAdmin, migrateApplication } from '../../apps/api/src/store.js';

let admin: Pool; let pool: Pool; let schema: string; let app: Awaited<ReturnType<typeof createApi>> | undefined;
const origin = 'http://localhost:5173';
const password = 'A test-only password 42!';
let cookie: string; let csrf: string;
beforeEach(async () => {
  const connectionString = process.env.APCS_TEST_POSTGRES_URL;
  if (!connectionString) throw new Error('Docker PostgreSQL fixture required');
  schema = `api_${randomUUID().replaceAll('-', '')}`;
  admin = new Pool({ connectionString, max: 1 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  pool = new Pool({ connectionString, options: `-c search_path=${schema}`, connectionTimeoutMillis: 2000 });
  app = undefined; cookie = ''; csrf = '';
});
afterEach(async () => {
  await app?.close(); await pool?.end();
  if (admin) { try { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); } finally { await admin.end(); } }
});
async function setup(login = true) {
  await migrateApplication(pool);
  await bootstrapAdmin(pool, 'operator', password);
  app = await createApi({ pool, origin, secureCookies: false });
  if (login) {
    const response = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { origin }, payload: { username: 'operator', password } });
    expect(response.statusCode).toBe(200);
    cookie = response.cookies[0]!.name + '=' + response.cookies[0]!.value;
    csrf = response.json().csrfToken;
  }
}
const headers = () => ({ origin, cookie, 'x-csrf-token': csrf });
async function project(name = 'LED Demo') {
  return app!.inject({ method: 'POST', url: '/api/v1/projects', headers: headers(), payload: { name } });
}

describe('local API authentication and catalog with real PostgreSQL', () => {
  it('serves owner-only minute aggregates with explicit coverage and bounded ranges', async () => {
    await setup(); const projectId = (await project()).json().id;
    const device = (await app!.inject({ method: 'POST', url: '/api/v1/devices', headers: headers(), payload: { projectId, name: 'Aggregate LED', siteId: 'aggregate', deviceId: 'led', kind: 'virtual-led' } })).json();
    const start = Math.floor(Date.now() / 3600000) * 3600000 - 3600000; const stamp = (seconds: number) => new Date(start + seconds * 1000).toISOString();
    const archive = new PgSignalArchive(pool); const aggregates = new PgHistoryAggregates(pool);
    await archive.append([0, 10, 40, 60].map((second, index) => ({ eventId: randomUUID(), signalId: device.signalId, observedAt: stamp(second), snapshot: { value: index === 1, quality: 'Good' as const, bootId: 'fixture', sequence: index, sourceTime: null, receivedTime: stamp(second) } })));
    for (let i = 0; i < 20; i++) if (await aggregates.processNext(new Date(start + 7500000)) === 'idle') break;
    const path = `/api/v1/signals/${device.signalId}/aggregates`; const url = `${path}?from=${stamp(0)}&to=${stamp(60)}&resolution=60`;
    expect((await app!.inject({ url })).statusCode).toBe(401);
    const result = await app!.inject({ url, headers: headers() }); expect(result.statusCode).toBe(200);
    expect(result.json().items[0]).toMatchObject({ stale: false, aggregate: { trueMs: 30000, falseMs: 30000, qualityMs: { Good: 60000, Unknown: 0 } } });
    expect((await app!.inject({ url: `${path}?from=${stamp(0)}&to=${stamp(366 * 86400)}&resolution=60`, headers: headers() })).statusCode).toBe(422);
    expect((await app!.inject({ url: `${path}?from=${stamp(0)}&to=${stamp(60)}&resolution=1`, headers: headers() })).statusCode).toBe(400);
    expect((await app!.inject({ url: '/api/v1/history/aggregates/status', headers: headers() })).json()).toMatchObject({ state: 'not running', blocked: 0 });
    const foreign = randomUUID(); await pool.query("INSERT INTO apcs_users(id,username,password_hash) VALUES($1,'foreign-aggregate','fixture')", [foreign]); await pool.query('UPDATE apcs_projects SET owner_id=$2 WHERE id=$1', [projectId, foreign]);
    expect((await app!.inject({ url, headers: headers() })).statusCode).toBe(404);
  });
  it('exposes secret-free notification logs and protects audited bounded retries', async () => {
    await setup(); const projectId = (await project()).json().id;
    const device = (await app!.inject({ method: 'POST', url: '/api/v1/devices', headers: headers(), payload: { projectId, name: 'Alarm LED', siteId: 'alarm', deviceId: 'led', kind: 'virtual-led' } })).json();
    const alarmId = (await app!.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/alarms`, headers: headers(), payload: { name: 'LED on', signalId: device.signalId, priority: 'high', definition: { condition: { kind: 'boolean', value: true }, activationDelayMs: 0, returnDelayMs: 0 } } })).json().id;
    const secret = 'fixture-notification-private-secret-32';
    await syncNotificationRoutes(pool, [{ id: 'local', name: 'Local receiver', kind: 'webhook', url: 'https://private.fixture.invalid/secret-path', secret, priorities: ['high'], events: ['Activated'], projectIds: [] }]);
    await transaction(pool, (client) => enqueueNotifications(client, alarmId, { version: 1, kind: 'Activated', occurrence: 1, at: new Date().toISOString() }, { active: true, acknowledged: false, suppressedUntil: null }));
    const job = (await claimNotification(pool))!; await finishNotification(pool, job, { retryable: false, message: secret });
    const url = `/api/v1/projects/${projectId}/notifications`;
    expect((await app!.inject({ url })).statusCode).toBe(401);
    const result = await app!.inject({ url, headers: headers() }); expect(result.statusCode).toBe(200); expect(result.body).not.toContain(secret); expect(result.body).not.toContain('secret-path');
    expect(result.json().items[0]).toMatchObject({ id: job.id, state: 'Dead', attempts: 1 });
    const retry = `/api/v1/notifications/${job.id}/retry`;
    expect((await app!.inject({ method: 'POST', url: retry, headers: { origin, cookie }, payload: { reason: 'Endpoint repaired' } })).statusCode).toBe(403);
    expect((await app!.inject({ method: 'POST', url: retry, headers: headers(), payload: { reason: ' ' } })).statusCode).toBe(400);
    await pool.query("CREATE FUNCTION deny_notification_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='notification.retry' THEN RAISE EXCEPTION 'Fixture audit failure'; END IF; RETURN NEW; END $$");
    await pool.query('CREATE TRIGGER deny_notification_audit BEFORE INSERT ON apcs_audit FOR EACH ROW EXECUTE FUNCTION deny_notification_audit()');
    expect((await app!.inject({ method: 'POST', url: retry, headers: headers(), payload: { reason: 'Endpoint repaired' } })).statusCode).toBe(500);
    expect((await pool.query('SELECT state FROM apcs_notification_deliveries')).rows[0].state).toBe('Dead');
    await pool.query('DROP TRIGGER deny_notification_audit ON apcs_audit');
    expect((await app!.inject({ method: 'POST', url: retry, headers: headers(), payload: { reason: 'Endpoint repaired' } })).statusCode).toBe(204);
    expect((await pool.query("SELECT data FROM apcs_audit WHERE action='notification.retry'")).rows[0].data).toMatchObject({ reason: 'Endpoint repaired', attempts: 1 });
    const second = (await claimNotification(pool))!; expect(second).toMatchObject({ id: job.id, attempt: 2 }); await finishNotification(pool, second);
    expect((await app!.inject({ url: `/api/v1/notifications/${job.id}/attempts`, headers: headers() })).json().items).toHaveLength(2);
    expect((await app!.inject({ method: 'POST', url: retry, headers: headers(), payload: { reason: 'Duplicate' } })).statusCode).toBe(409);
    const foreign = randomUUID(); await pool.query("INSERT INTO apcs_users(id,username,password_hash) VALUES($1,'foreign-notification','fixture')", [foreign]); await pool.query('UPDATE apcs_projects SET owner_id=$2 WHERE id=$1', [projectId, foreign]);
    expect((await app!.inject({ url, headers: headers() })).statusCode).toBe(404);
    expect((await app!.inject({ method: 'POST', url: retry, headers: headers(), payload: { reason: 'Foreign' } })).statusCode).toBe(404);
  });
  it('validates alarm rules, ownership, authentication and bounded lifecycle reads', async () => {
    await setup(); const projectId = (await project()).json().id;
    const device = (await app!.inject({ method: 'POST', url: '/api/v1/devices', headers: headers(), payload: { projectId, name: 'Alarm LED', siteId: 'alarm', deviceId: 'led', kind: 'virtual-led' } })).json();
    const url = `/api/v1/projects/${projectId}/alarms`;
    const payload = { name: 'LED offline', signalId: device.signalId, priority: 'high', definition: { condition: { kind: 'quality', values: ['Disconnected'] }, activationDelayMs: 0, returnDelayMs: 0 } };
    expect((await app!.inject({ url })).statusCode).toBe(401);
    expect((await app!.inject({ method: 'POST', url, headers: { cookie }, payload })).statusCode).toBe(403);
    expect((await app!.inject({ method: 'POST', url, headers: headers(), payload: { ...payload, signalId: randomUUID() } })).statusCode).toBe(422);
    expect((await app!.inject({ method: 'POST', url, headers: headers(), payload: { ...payload, definition: { ...payload.definition, activationDelayMs: -1 } } })).statusCode).toBe(422);
    const created = await app!.inject({ method: 'POST', url, headers: headers(), payload }); expect(created.statusCode).toBe(201);
    const id = created.json().id;
    const listed = (await app!.inject({ url, headers: headers() })).json().items;
    expect(listed).toHaveLength(1); expect(listed[0]).toMatchObject({ id, phase: 'Normal', evaluationStale: true });
    expect((await app!.inject({ url: `/api/v1/alarms/${id}/events`, headers: headers() })).json().items).toEqual([]);
    expect((await app!.inject({ method: 'POST', url: `/api/v1/alarms/${id}/actions`, headers: headers(), payload: { kind: 'acknowledge', occurrence: 1, reason: 'Inspected', actorId: 'forged' } })).statusCode).toBe(400);
    expect((await app!.inject({ method: 'POST', url: `/api/v1/alarms/${id}/actions`, headers: headers(), payload: { kind: 'acknowledge', occurrence: 1, reason: 'Inspected' } })).statusCode).toBe(409);
    const foreign = randomUUID(); await pool.query("INSERT INTO apcs_users(id,username,password_hash) VALUES($1,'foreign','fixture')", [foreign]);
    await pool.query('UPDATE apcs_projects SET owner_id=$2 WHERE id=$1', [projectId, foreign]);
    expect((await app!.inject({ url, headers: headers() })).statusCode).toBe(404);
    expect((await app!.inject({ url: `/api/v1/alarms/${id}/events`, headers: headers() })).statusCode).toBe(404);
  });

  it('serves protected bounded history pages with value and quality intact', async () => {
    await setup(); const projectId = (await project()).json().id;
    const device = (await app!.inject({ method: 'POST', url: '/api/v1/devices', headers: headers(), payload: { projectId, name: 'History LED', siteId: 'history', deviceId: 'led', kind: 'virtual-led' } })).json();
    const archive = new PgSignalArchive(pool); const at = '2026-10-12T12:00:00.000Z';
    await archive.append([false, true].map((value, index) => ({ eventId: randomUUID(), signalId: device.signalId, observedAt: at, snapshot: { value, quality: 'Good' as const, bootId: 'boot', sequence: index, receivedTime: at, sourceTime: null } })));
    const url = `/api/v1/signals/${device.signalId}/history?from=2026-10-12T00:00:00Z&to=2026-10-13T00:00:00Z&limit=1`;
    expect((await app!.inject({ url })).statusCode).toBe(401);
    const result = await app!.inject({ url, headers: headers() }); expect(result.statusCode).toBe(200);
    expect(result.json().items[0].snapshot).toMatchObject({ value: true, quality: 'Good' });
    expect((await app!.inject({ url: `${url}&before=${result.json().nextBefore}`, headers: headers() })).json().items[0].snapshot.value).toBe(false);
    expect((await app!.inject({ url: `/api/v1/signals/${device.signalId}/history?from=2026-10-12T00:00:00Z&to=2026-11-12T00:00:00Z`, headers: headers() })).statusCode).toBe(422);
    expect((await app!.inject({ url: '/api/v1/history/status', headers: headers() })).json().active).toBe(false);
  });

  it('lists blocking commands and atomically audits explicit recovery using the real restarted simulator', async () => {
    await setup(); const projectId = (await project()).json().id;
    const device = (await app!.inject({ method: 'POST', url: '/api/v1/devices', headers: headers(), payload: { projectId, name: 'Recovery LED', siteId: 'recovery', deviceId: 'led', kind: 'virtual-led' } })).json();
    const actor = (await pool.query('SELECT owner_id FROM apcs_projects WHERE id=$1', [projectId])).rows[0].owner_id;
    const journal = new PgCommandJournal(pool); const id = randomUUID();
    const input = { id, idempotencyKey: id, actorId: actor, targetSignalId: device.signalId, value: true, ttlMs: 3000, expectedProjectRevision: 1, reason: 'Lost ACK fixture' };
    const old = { bootId: 'retired-boot', quality: 'Good' as const, ownerId: actor, projectRevision: 1, maxTtlMs: 3000, interlockReason: null };
    await journal.request(input, old); await journal.claimNext(async () => old); await journal.connectionLost(device.signalId);
    await app!.close(); const runtime = new RuntimeProcess({ connectionString: process.env.APCS_TEST_POSTGRES_URL!, mqttUrl: process.env.APCS_TEST_MQTT_URL!, databaseOptions: `-c search_path=${schema}` });
    app = await createApi({ pool, origin, secureCookies: false, runtime });
    for (let index = 0; index < 12; index++) { const next = randomUUID(); await journal.request({ ...input, id: next, idempotencyKey: next }, old); }
    const historyUrl = `/api/v1/signals/${device.signalId}/commands`;
    const history = await app.inject({ url: historyUrl, headers: headers() }); expect(history.statusCode).toBe(200); expect(history.json().blocking).toMatchObject({ id, state: 'Unknown' });
    expect(history.json().items).toHaveLength(10);
    expect((await app.inject({ url: `${historyUrl}?before=${history.json().nextCursor}`, headers: headers() })).json().items.some((entry: { id: string }) => entry.id === id)).toBe(true);
    const url = `/api/v1/commands/${id}/reconcile`; const payload = { reason: 'Inspected restarted virtual LED', acceptUnknownOutcome: true };
    const stalled = vi.spyOn(runtime, 'context').mockImplementationOnce(() => new Promise(() => {}));
    const timedOut = await app.inject({ method: 'POST', url, headers: headers(), payload }); stalled.mockRestore();
    expect(timedOut.statusCode).toBe(409);
    expect((await journal.get(id)).reconciliation).toBeUndefined();
    expect((await app.inject({ method: 'POST', url, headers: headers(), payload })).statusCode).toBe(409);
    await runtime.start(device.id, actor);
    expect((await app.inject({ method: 'POST', url, headers: { cookie }, payload })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url, headers: headers(), payload: { ...payload, actorId: 'forged' } })).statusCode).toBe(400);
    await pool.query("CREATE FUNCTION deny_recovery_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='command.reconciled' THEN RAISE EXCEPTION 'Fixture audit failure'; END IF; RETURN NEW; END $$");
    await pool.query('CREATE TRIGGER deny_recovery_audit BEFORE INSERT ON apcs_audit FOR EACH ROW EXECUTE FUNCTION deny_recovery_audit()');
    expect((await app.inject({ method: 'POST', url, headers: headers(), payload })).statusCode).toBe(500);
    expect((await app.inject({ url: historyUrl, headers: headers() })).json().blocking.id).toBe(id);
    await pool.query('DROP TRIGGER deny_recovery_audit ON apcs_audit');
    const result = await app.inject({ method: 'POST', url, headers: headers(), payload }); expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({ state: 'Unknown', reconciliation: { actorId: actor, observedValue: false } });
    expect((await app.inject({ url: historyUrl, headers: headers() })).json().blocking).toBeNull();
    expect((await pool.query("SELECT data FROM apcs_audit WHERE action='command.reconciled'")).rows[0].data).toMatchObject({ reason: payload.reason, bootId: result.json().reconciliation.bootId });
  });

  it('commissions a virtual LED in the private worker and controls it through the audited API', async () => {
    await setup(); const projectId = (await project()).json().id;
    const device = (await app!.inject({ method: 'POST', url: '/api/v1/devices', headers: headers(), payload: { projectId, name: 'Worker LED', siteId: 'worker', deviceId: 'worker-led', kind: 'virtual-led' } })).json();
    await app!.close();
    app = await createApi({ pool, origin, secureCookies: false, runtime: new RuntimeProcess({ connectionString: process.env.APCS_TEST_POSTGRES_URL!, mqttUrl: process.env.APCS_TEST_MQTT_URL!, databaseOptions: `-c search_path=${schema}` }) });
    const start = await app.inject({ method: 'POST', url: `/api/v1/devices/${device.id}/runtime`, headers: headers(), payload: { action: 'start', reason: 'Commission virtual bench' } });
    expect(start.statusCode).toBe(200); expect(start.json().state).toBe('running');
    const response = await app.inject({ method: 'POST', url: '/api/v1/commands', headers: { ...headers(), 'idempotency-key': randomUUID() }, payload: { targetSignalId: device.signalId, value: true, ttlMs: 2000, expectedProjectRevision: 1, reason: 'Worker control test' } });
    expect(response.statusCode).toBe(202); expect(response.json().state).toBe('Accepted');
    let verified = false; const deadline = performance.now() + 2500;
    while (performance.now() < deadline) {
      const result = await app.inject({ url: `/api/v1/commands/${response.json().id}`, headers: { cookie } });
      if (result.json().state === 'Verified') { verified = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    expect(verified).toBe(true);
    expect((await app.inject({ url: `/api/v1/signals/${device.signalId}/value`, headers: { cookie } })).json()).toMatchObject({ value: true, quality: 'Good' });
    expect((await app.inject({ method: 'POST', url: `/api/v1/devices/${device.id}/runtime`, headers: headers(), payload: { action: 'stop', reason: 'End virtual bench' } })).json().state).toBe('stopped');
    const audit = (await app.inject({ url: '/api/v1/audit', headers: { cookie } })).json().items;
    expect(audit.some((e: { action: string }) => e.action === 'runtime.start.requested')).toBe(true);
    await pool.query("CREATE FUNCTION reject_runtime_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'runtime.start.completed' THEN RAISE EXCEPTION 'fixture'; END IF; RETURN NEW; END $$");
    await pool.query('CREATE TRIGGER reject_runtime_audit BEFORE INSERT ON apcs_audit FOR EACH ROW EXECUTE FUNCTION reject_runtime_audit()');
    const unaudited = await app.inject({ method: 'POST', url: `/api/v1/devices/${device.id}/runtime`, headers: headers(), payload: { action: 'start', reason: 'Audit rollback probe' } });
    expect(unaudited.statusCode).toBe(503);
    expect((await app.inject({ url: `/api/v1/devices/${device.id}/runtime`, headers: { cookie } })).json().state).toBe('stopped');

  });

  it('controls a protocol simulator through the authenticated API and durable MQTT path', async () => {
    await setup(); const projectId = (await project()).json().id;
    const catalog = (await app!.inject({ method: 'POST', url: '/api/v1/devices', headers: headers(), payload: {
      projectId, name: 'API LED', siteId: randomUUID(), deviceId: 'led', kind: 'virtual-led',
    } })).json();
    const user = (await app!.inject({ url: '/api/v1/auth/me', headers: { cookie } })).json();
    const clock = { monotonicNow: () => performance.now(), wallNow: () => new Date() };
    const store = new SignalStore(clock);
    store.register({ id: catalog.signalId, deviceId: catalog.id, dataType: 'boolean', freshnessMs: 3000 });
    const connection = { url: process.env.APCS_TEST_MQTT_URL!, siteId: catalog.siteId, deviceId: catalog.id, signalId: catalog.signalId };
    const start = performance.now();
    const simulator = new MqttLedSimulator(connection, new LedPeer(() => performance.now() - start, randomUUID()));
    const gateway = new MqttLedGateway(connection, store, new PgCommandJournal(pool), clock, () => ({
      ownerId: user.id, interlockReason: null, projectRevision: 1, maxTtlMs: 3000,
    }));
    try {
      await simulator.start(); await gateway.start(); await gateway.synchronize();
      await app!.close();
      app = await createApi({ pool, origin, secureCookies: false, resolveContext: (request) => gateway.context(request), readSignal: (id) => store.get(id) });
      const response = await app.inject({ method: 'POST', url: '/api/v1/commands', headers: { ...headers(), 'idempotency-key': randomUUID() }, payload: {
        targetSignalId: catalog.signalId, value: true, ttlMs: 2000, expectedProjectRevision: 1, reason: 'API commissioning',
      } });
      expect(response.statusCode).toBe(202); expect(response.json().state).toBe('Accepted');
      await gateway.dispatchNext();
      const deadline = performance.now() + 2000;
      let verified = false;
      while (performance.now() < deadline) {
        const current = await app.inject({ url: `/api/v1/commands/${response.json().id}`, headers: { cookie } });
        if (current.json().state === 'Verified') { verified = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(verified).toBe(true); expect(simulator.peer.read()).toBe(true);
    } finally { await gateway.stop(); await simulator.stop(); }
  });

  it('rejects a non-ASCII forged CSRF token with 403 rather than a server error', async () => {
    await setup();
    const response = await app!.inject({ method: 'POST', url: '/api/v1/projects',
      headers: { cookie, origin, 'x-csrf-token': '\u00e9'.repeat(64) }, payload: { name: 'Blocked' } });
    expect(response.statusCode).toBe(403);
  });

  it('verifies application migration checksums and serializes administrator bootstrap', async () => {
    await migrateApplication(pool); await migrateApplication(pool);
    const results = await Promise.allSettled([bootstrapAdmin(pool, 'first', password), bootstrapAdmin(pool, 'second', password)]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    await pool.query("UPDATE apcs_app_migrations SET checksum = 'modified'");
    await expect(migrateApplication(pool)).rejects.toThrow(/checksum/i);
  });

  it('persists uncommissioned commands as rejected and preserves actor-scoped idempotency', async () => {
    await setup(); const projectId = (await project()).json().id;
    const device = (await app!.inject({ method: 'POST', url: '/api/v1/devices', headers: headers(), payload: {
      projectId, name: 'LED', siteId: 'demo', deviceId: 'led', kind: 'virtual-led',
    } })).json();
    const payload = { targetSignalId: device.signalId, value: true, ttlMs: 1000, expectedProjectRevision: 1, reason: 'Commissioning check' };
    const commandHeaders = { ...headers(), 'idempotency-key': randomUUID() };
    const first = await app!.inject({ method: 'POST', url: '/api/v1/commands', headers: commandHeaders, payload });
    expect(first.statusCode).toBe(202); expect(first.json().state).toBe('Rejected');
    const repeated = await app!.inject({ method: 'POST', url: '/api/v1/commands', headers: commandHeaders, payload });
    expect(repeated.json().id).toBe(first.json().id);
    const conflict = await app!.inject({ method: 'POST', url: '/api/v1/commands', headers: commandHeaders, payload: { ...payload, value: false } });
    expect(conflict.statusCode).toBe(409);
    const user = (await app!.inject({ url: '/api/v1/auth/me', headers: { cookie } })).json();
    expect((await pool.query('SELECT actor_id FROM apcs_commands')).rows[0].actor_id).toBe(user.id);
  });

  it('bootstraps exactly one administrator and stores a salted password hash', async () => {
    await setup(false);
    await expect(bootstrapAdmin(pool, 'second', password)).rejects.toThrow(/already/i);
    const rows = await pool.query('SELECT password_hash FROM apcs_users');
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].password_hash).toMatch(/^scrypt\$/);
    expect(rows.rows[0].password_hash).not.toContain(password);
  });
  it('requires authentication while keeping liveness public', async () => {
    await setup(false);
    expect((await app!.inject('/api/v1/health/live')).statusCode).toBe(200);
    for (const url of ['/api/v1/projects', '/api/v1/devices', '/api/v1/signals', '/api/v1/audit', '/api/v1/auth/me']) {
      expect((await app!.inject(url)).statusCode).toBe(401);
    }
  });
  it('creates an HttpOnly session, validates it across API restart, and revokes it on logout', async () => {
    await setup(false);
    const login = await app!.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { origin }, payload: { username: 'operator', password } });
    expect(login.statusCode).toBe(200);
    expect(login.headers['set-cookie']).toContain('HttpOnly');
    expect(login.headers['set-cookie']).toContain('SameSite=Strict');
    cookie = login.cookies[0]!.name + '=' + login.cookies[0]!.value; csrf = login.json().csrfToken;
    const session = await pool.query('SELECT token_hash FROM apcs_sessions');
    expect(session.rows[0].token_hash).not.toContain(login.cookies[0]!.value);
    await app!.close(); app = await createApi({ pool, origin, secureCookies: false });
    expect((await app.inject({ url: '/api/v1/auth/me', headers: { cookie } })).json()).toMatchObject({ username: 'operator', csrfToken: csrf });
    expect((await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: headers() })).statusCode).toBe(204);
    expect((await app.inject({ url: '/api/v1/auth/me', headers: { cookie } })).statusCode).toBe(401);
  });
  it('rejects invalid passwords, forged cookies, and expired sessions', async () => {
    await setup();
    const wrong = await app!.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { origin }, payload: { username: 'operator', password: 'Incorrect password' } });
    expect(wrong.statusCode).toBe(401);
    expect((await app!.inject({ url: '/api/v1/projects', headers: { cookie: 'apcs_session=forged' } })).statusCode).toBe(401);
    await pool.query("UPDATE apcs_sessions SET expires_at = clock_timestamp() - interval '1 second'");
    expect((await app!.inject({ url: '/api/v1/projects', headers: { cookie } })).statusCode).toBe(401);
  });
  it('rejects cross-origin and missing-CSRF mutations without writing data', async () => {
    await setup();
    for (const invalid of [{ cookie, origin }, { cookie, origin: 'https://untrusted.invalid', 'x-csrf-token': csrf }]) {
      expect((await app!.inject({ method: 'POST', url: '/api/v1/projects', headers: invalid, payload: { name: 'Blocked' } })).statusCode).toBe(403);
    }
    expect((await pool.query('SELECT * FROM apcs_projects')).rows).toHaveLength(0);
    expect((await app!.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'operator', password } })).statusCode).toBe(403);
  });
  it('limits login attempts without revealing whether a user exists', async () => {
    await setup(false);
    for (let i = 0; i < 5; i++) {
      const response = await app!.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { origin }, payload: { username: 'missing', password } });
      expect(response.statusCode).toBe(401);
      expect(response.json().message).toBe('Invalid credentials');
    }
    expect((await app!.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { origin }, payload: { username: 'operator', password } })).statusCode).toBe(429);
  });
  it('creates and pages projects without accepting unknown fields or coerced values', async () => {
    await setup(); const created = await project();
    expect(created.statusCode).toBe(201);
    expect(created.headers.etag).toBe('"1"');
    const second = await project('Second site'); expect(second.statusCode).toBe(201);
    const page = (await app!.inject({ url: '/api/v1/projects?limit=1', headers: { cookie } })).json();
    expect(page.items).toHaveLength(1); expect(page.nextCursor).toBeTruthy();
    const next = (await app!.inject({ url: `/api/v1/projects?limit=1&cursor=${page.nextCursor}`, headers: { cookie } })).json();
    expect(next.items).toHaveLength(1); expect(next.items[0].id).not.toBe(page.items[0].id);
    for (const payload of [{ name: 42 }, { name: '' }, { name: 'x', actorId: 'admin' }]) {
      expect((await app!.inject({ method: 'POST', url: '/api/v1/projects', headers: headers(), payload })).statusCode).toBe(400);
    }
  });
  it('uses optimistic revisions and audits changes with the session actor', async () => {
    await setup(); const created = (await project()).json();
    const url = `/api/v1/projects/${created.id}`;
    expect((await app!.inject({ method: 'PATCH', url, headers: headers(), payload: { name: 'Updated' } })).statusCode).toBe(428);
    const updated = await app!.inject({ method: 'PATCH', url, headers: { ...headers(), 'if-match': '"1"' }, payload: { name: 'Updated' } });
    expect(updated.statusCode).toBe(200); expect(updated.headers.etag).toBe('"2"');
    expect((await app!.inject({ method: 'PATCH', url, headers: { ...headers(), 'if-match': '"1"' }, payload: { name: 'Lost edit' } })).statusCode).toBe(412);
    const audit = (await app!.inject({ url: '/api/v1/audit', headers: { cookie } })).json();
    expect(audit.items.some((event: { action: string }) => event.action === 'project.updated')).toBe(true);
    expect(JSON.stringify(audit)).not.toContain(password);
  });
  it('creates a device and signal atomically and rejects duplicate MQTT addresses', async () => {
    await setup(); const projectId = (await project()).json().id;
    const payload = { projectId, name: 'Virtual LED', siteId: 'demo', deviceId: 'led-1', kind: 'virtual-led' };
    const device = await app!.inject({ method: 'POST', url: '/api/v1/devices', headers: headers(), payload });
    expect(device.statusCode).toBe(201);
    expect((await app!.inject({ method: 'POST', url: '/api/v1/devices', headers: headers(), payload })).statusCode).toBe(409);
    const list = (await app!.inject({ url: '/api/v1/signals', headers: { cookie } })).json();
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({ deviceId: device.json().id, dataType: 'boolean', direction: 'output' });
    const value = (await app!.inject({ url: `/api/v1/signals/${list.items[0].id}/value`, headers: { cookie } })).json();
    expect(value).toMatchObject({ value: null, quality: 'Disconnected' });
  });
  it('rolls back a configuration mutation when its audit write fails', async () => {
    await setup();
    await pool.query(`CREATE FUNCTION fail_config_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Injected audit failure'; END $$;
      CREATE TRIGGER injected_audit BEFORE INSERT ON apcs_audit FOR EACH ROW EXECUTE FUNCTION fail_config_audit()`);
    const response = await project(); expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain('Injected audit');
    expect((await pool.query('SELECT * FROM apcs_projects')).rows).toHaveLength(0);
  });
  it('validates request size and rejects a command-supplied actor', async () => {
    await setup();
    expect((await app!.inject({ method: 'POST', url: '/api/v1/projects', headers: headers(), payload: { name: 'x'.repeat(70000) } })).statusCode).toBe(413);
    expect((await app!.inject({ method: 'POST', url: '/api/v1/commands', headers: headers(), payload: {
      actorId: 'someone-else', targetSignalId: randomUUID(), value: true, ttlMs: 1000, expectedProjectRevision: 1, reason: 'test',
    } })).statusCode).toBe(400);
  });
});
