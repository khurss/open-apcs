import { createServer, type Server } from 'node:http';
import { NotificationService } from '../../apps/api/src/notification-service.js';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrateApplication, transaction } from '../../apps/api/src/store.js';
import { syncNotificationRoutes, enqueueNotifications, claimNotification, finishNotification, pruneNotifications } from '../../apps/api/src/notification-store.js';
import type { WebhookRoute } from '../../packages/notifications/src/config.js';
let worker: NotificationService | undefined; let receiver: Server | undefined;
let admin: Pool; let pool: Pool; let schema: string; let alarmId: string; let project: string;
const route: WebhookRoute = { id: 'local', name: 'Local receiver', kind: 'webhook', priorities: ['high'], events: ['Activated', 'Returned', 'Unsuppressed'], projectIds: [], url: 'https://fixture.invalid/alarm', secret: 'fixture-secret-32-characters-long-only' };
const state = { active: true, acknowledged: false, suppressedUntil: null };
const event = (version = 1, kind = 'Activated') => ({ version, kind, occurrence: 1, at: new Date().toISOString() });
const enqueue = (version = 1) => transaction(pool, (client) => enqueueNotifications(client, alarmId, event(version), state));
beforeEach(async () => {
  const connectionString = process.env.APCS_TEST_POSTGRES_URL; if (!connectionString) throw new Error('Docker fixture required');
  schema = `notify_${randomUUID().replaceAll('-', '')}`; admin = new Pool({ connectionString }); await admin.query(`CREATE SCHEMA ${schema}`);
  pool = new Pool({ connectionString, options: `-c search_path=${schema}`, query_timeout: 5000 }); await migrateApplication(pool);
  const actor = randomUUID(); project = randomUUID(); const device = randomUUID(); const signal = randomUUID(); alarmId = randomUUID();
  await pool.query("INSERT INTO apcs_users (id,username,password_hash) VALUES ($1,'fixture','fixture')", [actor]);
  await pool.query("INSERT INTO apcs_projects (id,name,owner_id) VALUES ($1,'Fixture',$2)", [project, actor]);
  await pool.query("INSERT INTO apcs_devices (id,project_id,name,kind,site_id,protocol_device_id) VALUES ($1,$2,'LED','virtual-led','test','led')", [device, project]);
  await pool.query("INSERT INTO apcs_signals (id,device_id,name,data_type,direction) VALUES ($1,$2,'LED','boolean','output')", [signal, device]);
  await pool.query("INSERT INTO apcs_alarms (id,project_id,signal_id,name,priority,definition) VALUES ($1,$2,$3,'LED on','high','{}')", [alarmId, project, signal]);
});
afterEach(async () => { await worker?.close(); worker = undefined; if (receiver) { receiver.closeAllConnections(); await new Promise<void>((resolve) => receiver!.close(() => resolve())); receiver = undefined; } await pool?.end(); if (admin) { try { await admin.query(`DROP SCHEMA ${schema} CASCADE`); } finally { await admin.end(); } } });
describe('transactional notification outbox', () => {
  it('delivers in the background, rejects a competing owner and closes cleanly', async () => {
    const received: string[] = [];
    receiver = createServer((request, response) => { let body = ''; request.on('data', (chunk) => { body += chunk; }); request.on('end', () => { received.push(body); response.writeHead(204).end(); }); });
    await new Promise<void>((resolve) => receiver!.listen(0, '127.0.0.1', resolve));
    const address = receiver.address(); if (!address || typeof address === 'string') throw new Error('Fixture address required');
    worker = new NotificationService(pool, [{ ...route, url: `http://127.0.0.1:${address.port}/events`, allowInsecure: true }]); await worker.start();
    const duplicate = new NotificationService(pool, [route]); await expect(duplicate.start()).rejects.toThrow(/owner/i); await duplicate.close();
    await enqueue();
    const until = performance.now() + 5000;
    while ((await pool.query("SELECT id FROM apcs_notification_deliveries WHERE state='Delivered'")).rowCount !== 1 && performance.now() < until) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(received).toHaveLength(1); expect(JSON.parse(received[0]!)).toMatchObject({ eventId: `${alarmId}:1` });
    expect((await pool.query('SELECT state FROM apcs_notification_deliveries')).rows[0].state).toBe('Delivered');
    await worker.close(); worker = undefined; await enqueue(2); await new Promise((resolve) => setTimeout(resolve, 1100)); expect(received).toHaveLength(1);
  });
  it('stores one immutable secret-free envelope per matching route and event, atomically', async () => {
    await syncNotificationRoutes(pool, [route]); await enqueue(); await enqueue();
    const job = (await claimNotification(pool))!; expect(job).toMatchObject({ attempt: 1, routeId: 'local', eventId: `${alarmId}:1` });
    expect(JSON.parse(job.body)).toMatchObject({ eventId: `${alarmId}:1`, projectId: project, alarmId, name: 'LED on', kind: 'Activated', priority: 'high' });
    const rows = await pool.query('SELECT * FROM apcs_notification_routes'); expect(JSON.stringify(rows.rows)).not.toContain(route.secret); expect(JSON.stringify(rows.rows)).not.toContain(route.url);
    await expect(transaction(pool, async (client) => { await enqueueNotifications(client, alarmId, event(2), state); throw new Error('Rollback fixture'); })).rejects.toThrow('Rollback');
    expect((await pool.query('SELECT id FROM apcs_notification_deliveries')).rowCount).toBe(1);
  });
  it('filters priorities, projects and suppression without altering alarm state', async () => {
    await syncNotificationRoutes(pool, [{ ...route, priorities: ['low'] }]); await enqueue();
    await syncNotificationRoutes(pool, [{ ...route, projectIds: [randomUUID()] }]); await enqueue();
    await syncNotificationRoutes(pool, [route]);
    await transaction(pool, (client) => enqueueNotifications(client, alarmId, event(), { ...state, suppressedUntil: new Date().toISOString() }));
    await transaction(pool, (client) => enqueueNotifications(client, alarmId, event(2, 'Unsuppressed'), { ...state, acknowledged: true }));
    expect(await claimNotification(pool)).toBeNull();
    await transaction(pool, (client) => enqueueNotifications(client, alarmId, event(3, 'Unsuppressed'), state));
    expect(await claimNotification(pool)).toMatchObject({ eventId: `${alarmId}:3` });
    expect((await pool.query('SELECT state FROM apcs_alarms')).rows[0].state).toMatchObject({ active: false, acknowledged: true });
  });
  it('claims once concurrently, fences expired completion and keeps stable identity after crash', async () => {
    await syncNotificationRoutes(pool, [route]); await enqueue();
    const claims = await Promise.all([claimNotification(pool), claimNotification(pool)]); const first = claims.find((job) => job !== null)!; expect(claims.filter(Boolean)).toHaveLength(1);
    await pool.query("UPDATE apcs_notification_deliveries SET lease_until=clock_timestamp()-interval '1 second'");
    expect(await finishNotification(pool, first)).toBe(false);
    const second = (await claimNotification(pool))!; expect(second).toMatchObject({ id: first.id, eventId: first.eventId, attempt: 2 }); expect(second.token).not.toBe(first.token);
    expect(await finishNotification(pool, first)).toBe(false); expect(await finishNotification(pool, second)).toBe(true);
    expect((await pool.query('SELECT state FROM apcs_notification_deliveries')).rows[0].state).toBe('Delivered');
    expect((await pool.query('SELECT outcome FROM apcs_notification_attempts ORDER BY attempt')).rows.map((r) => r.outcome)).toEqual(['Unknown', 'Delivered']);
  });
  it('backs off and stops after eight attempts, recording only sanitized errors', async () => {
    await syncNotificationRoutes(pool, [route]); await enqueue();
    for (let attempt = 1; attempt <= 8; attempt++) {
      const job = (await claimNotification(pool))!; expect(job.attempt).toBe(attempt);
      expect(await finishNotification(pool, job, { retryable: true, message: `Private endpoint ${route.secret}` })).toBe(true);
      expect(await claimNotification(pool)).toBeNull();
      await pool.query("UPDATE apcs_notification_deliveries SET due_at=clock_timestamp()-interval '1 second'");
    }
    const row = (await pool.query('SELECT * FROM apcs_notification_deliveries')).rows[0]; expect(row.state).toBe('Dead'); expect(row.attempts).toBe(8); expect(JSON.stringify(row)).not.toContain(route.secret);
    expect((await pool.query('SELECT * FROM apcs_notification_attempts')).rowCount).toBe(8);
  });
  it('cancels pending and in-flight work after a configuration change; late completion cannot overwrite it', async () => {
    await syncNotificationRoutes(pool, [route]); await enqueue(); const job = (await claimNotification(pool))!;
    await syncNotificationRoutes(pool, [{ ...route, secret: 'replacement-secret-with-32-characters' }]);
    expect(await finishNotification(pool, job)).toBe(false); expect(await claimNotification(pool)).toBeNull();
    expect((await pool.query('SELECT state FROM apcs_notification_deliveries')).rows[0].state).toBe('Cancelled');
    await enqueue(2); await syncNotificationRoutes(pool, []); expect(await claimNotification(pool)).toBeNull();
    expect((await pool.query('SELECT enabled FROM apcs_notification_routes')).rows[0].enabled).toBe(false);
  });
  it('exhausts an eighth lost response without sending a ninth attempt', async () => {
    await syncNotificationRoutes(pool, [route]); await enqueue();
    for (let attempt = 1; attempt <= 8; attempt++) {
      const job = (await claimNotification(pool))!; expect(job?.attempt).toBe(attempt);
      await pool.query("UPDATE apcs_notification_deliveries SET lease_until=clock_timestamp()-interval '1 second'");
    }
    expect(await claimNotification(pool)).toBeNull();
    expect((await pool.query('SELECT state,attempts FROM apcs_notification_deliveries')).rows[0]).toEqual({ state: 'Dead', attempts: 8 });
    expect((await pool.query("SELECT attempt FROM apcs_notification_attempts WHERE outcome='Unknown'")).rowCount).toBe(8);
  });
  it('prunes old terminal results and their attempts while retaining active work', async () => {
    await syncNotificationRoutes(pool, [route]); await enqueue(); await enqueue(2);
    const job = (await claimNotification(pool))!; await finishNotification(pool, job);
    await pool.query("UPDATE apcs_notification_deliveries SET created_at=clock_timestamp()-interval '366 days',completed_at=clock_timestamp()-interval '366 days'");
    await pruneNotifications(pool);
    expect((await pool.query('SELECT state FROM apcs_notification_deliveries')).rows).toEqual([{ state: 'Pending' }]);
    expect((await pool.query('SELECT attempt FROM apcs_notification_attempts')).rowCount).toBe(0);
  });
  it('bounds outstanding work at 1000 per route and counts overflow without faulting alarms', async () => {
    await syncNotificationRoutes(pool, [route]);
    await transaction(pool, async (client) => { for (let i = 1; i <= 1002; i++) await enqueueNotifications(client, alarmId, event(i), state); });
    expect((await pool.query('SELECT id FROM apcs_notification_deliveries')).rowCount).toBe(1000);
    expect((await pool.query('SELECT dropped FROM apcs_notification_routes')).rows[0].dropped).toBe('2');
  });
});
