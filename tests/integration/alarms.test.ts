import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { migrateApplication } from '../../apps/api/src/store.js';
import { syncNotificationRoutes } from '../../apps/api/src/notification-store.js';
import { AlarmService } from '../../apps/api/src/alarm-service.js';
import type { SignalSnapshot } from '../../packages/domain/src/signals.js';
let admin: Pool; let pool: Pool; let schema: string; let service: AlarmService; let actor: string; let alarmId: string; let current: SignalSnapshot;
beforeEach(async () => {
  const connectionString = process.env.APCS_TEST_POSTGRES_URL; if (!connectionString) throw new Error('Docker fixture required');
  schema = `alarms_${randomUUID().replaceAll('-', '')}`; admin = new Pool({ connectionString }); await admin.query(`CREATE SCHEMA ${schema}`);
  pool = new Pool({ connectionString, options: `-c search_path=${schema}`, query_timeout: 2000 }); await migrateApplication(pool);
  actor = randomUUID(); alarmId = randomUUID(); const project = randomUUID(); const device = randomUUID(); const signal = randomUUID();
  await pool.query("INSERT INTO apcs_users (id,username,password_hash) VALUES ($1,'fixture','fixture')", [actor]);
  await pool.query("INSERT INTO apcs_projects (id,name,owner_id) VALUES ($1,'Alarm fixture',$2)", [project, actor]);
  await pool.query("INSERT INTO apcs_devices (id,project_id,name,kind,site_id,protocol_device_id) VALUES ($1,$2,'LED','virtual-led','test','led')", [device, project]);
  await pool.query("INSERT INTO apcs_signals (id,device_id,name,data_type,direction) VALUES ($1,$2,'LED','boolean','output')", [signal, device]);
  await pool.query("INSERT INTO apcs_alarms (id,project_id,signal_id,name,priority,definition) VALUES ($1,$2,$3,'LED on','high',$4)", [alarmId, project, signal, { condition: { kind: 'boolean', value: true }, activationDelayMs: 0, returnDelayMs: 0 }]);
  current = { value: true, quality: 'Good', bootId: 'boot', sequence: 1, receivedTime: new Date().toISOString(), sourceTime: null };
  service = new AlarmService(pool, () => ({ ...current }));
});
afterEach(async () => { await service?.close(); await pool?.end(); if (admin) { try { await admin.query(`DROP SCHEMA ${schema} CASCADE`); } finally { await admin.end(); } } });
const state = async () => (await pool.query('SELECT state FROM apcs_alarms WHERE id=$1', [alarmId])).rows[0].state;
async function waitFor(check: () => Promise<boolean>) { const deadline = performance.now() + 3000; while (performance.now() < deadline) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 20)); } throw new Error('Alarm condition timed out'); }
describe('durable alarm monitoring', () => {
  it('enqueues notifications in the alarm transaction and suppresses maintenance events', async () => {
    await syncNotificationRoutes(pool, [{ id: 'fixture', name: 'Fixture', kind: 'webhook', url: 'https://fixture.invalid/events', secret: 'fixture-secret-at-least-32-characters', priorities: ['high'], events: ['Activated', 'Reactivated', 'Returned', 'Unsuppressed'], projectIds: [] }]);
    service.start(); await waitFor(async () => (await state()).active);
    expect((await pool.query('SELECT body FROM apcs_notification_deliveries')).rows.map((r) => JSON.parse(r.body).kind)).toEqual(['Activated']);
    await service.action(alarmId, actor, { kind: 'suppress', durationMs: 60000, reason: 'Maintenance' });
    current.value = false; await waitFor(async () => !(await state()).active);
    current.value = true; await waitFor(async () => (await state()).active);
    expect((await pool.query('SELECT id FROM apcs_notification_deliveries')).rowCount).toBe(1);
    await service.action(alarmId, actor, { kind: 'unsuppress', reason: 'Maintenance finished' });
    expect((await pool.query('SELECT body FROM apcs_notification_deliveries ORDER BY created_at')).rows.map((r) => JSON.parse(r.body).kind)).toEqual(['Activated', 'Unsuppressed']);
    expect((await state()).acknowledged).toBe(false);
  });
  it('rolls back the outbox when the alarm audit cannot commit', async () => {
    await syncNotificationRoutes(pool, [{ id: 'fixture', name: 'Fixture', kind: 'webhook', url: 'https://fixture.invalid/events', secret: 'fixture-secret-at-least-32-characters', priorities: ['high'], events: ['Activated'], projectIds: [] }]);
    await pool.query("CREATE FUNCTION deny_activation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='alarm.activated' THEN RAISE EXCEPTION 'Fixture audit failure'; END IF; RETURN NEW; END $$");
    await pool.query('CREATE TRIGGER deny_activation BEFORE INSERT ON apcs_audit FOR EACH ROW EXECUTE FUNCTION deny_activation()');
    service.start(); await waitFor(async () => service.status.state === 'faulted');
    expect((await pool.query('SELECT id FROM apcs_notification_deliveries')).rowCount).toBe(0);
    expect((await state()).active).toBe(false);
  });
  it('evaluates without a browser and persists state plus ordered lifecycle events', async () => {
    service.start(); await waitFor(async () => (await state()).active);
    current.value = false; await waitFor(async () => !(await state()).active);
    expect(await state()).toMatchObject({ occurrence: 1, acknowledged: false });
    expect((await pool.query('SELECT kind FROM apcs_alarm_events ORDER BY version')).rows.map((row) => row.kind)).toEqual(['Available', 'Activated', 'Returned']);
  });
  it('persists an acknowledgement and audit without clearing the active cause', async () => {
    service.start(); await waitFor(async () => (await state()).active);
    await service.action(alarmId, actor, { kind: 'acknowledge', occurrence: 1, reason: 'Investigated' });
    expect(await state()).toMatchObject({ active: true, acknowledged: true });
    expect((await pool.query("SELECT actor_id,reason FROM apcs_alarm_events WHERE kind='Acknowledged'")).rows[0]).toEqual({ actor_id: actor, reason: 'Investigated' });
    expect((await pool.query("SELECT actor_id FROM apcs_audit WHERE action='alarm.acknowledged'")).rows[0].actor_id).toBe(actor);
  });
  it('rejects a foreign actor and an obsolete occurrence without faulting monitoring', async () => {
    service.start(); await waitFor(async () => (await state()).active);
    await expect(service.action(alarmId, randomUUID(), { kind: 'acknowledge', occurrence: 1, reason: 'Forged' })).rejects.toThrow(/owner/i);
    await service.action(alarmId, actor, { kind: 'acknowledge', occurrence: 1, reason: 'Inspected' });
    current.value = false; await waitFor(async () => !(await state()).active); current.value = true; await waitFor(async () => (await state()).occurrence === 2);
    await expect(service.action(alarmId, actor, { kind: 'acknowledge', occurrence: 1, reason: 'Old page' })).rejects.toThrow(/occurrence/i);
    expect(service.status.state).toBe('running'); expect((await state()).acknowledged).toBe(false);
  });
  it('retains an active occurrence when input quality becomes unavailable', async () => {
    service.start(); await waitFor(async () => (await state()).active); current.quality = 'Disconnected'; current.value = null;
    await waitFor(async () => !(await state()).available); expect((await state()).active).toBe(true);
  });
  it('rolls back an unaudited acknowledgement and exposes a monitor fault', async () => {
    service.start(); await waitFor(async () => (await state()).active);
    await pool.query("CREATE FUNCTION deny_alarm_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='alarm.acknowledged' THEN RAISE EXCEPTION 'Fixture audit failure'; END IF; RETURN NEW; END $$");
    await pool.query('CREATE TRIGGER deny_alarm_audit BEFORE INSERT ON apcs_audit FOR EACH ROW EXECUTE FUNCTION deny_alarm_audit()');
    await expect(service.action(alarmId, actor, { kind: 'acknowledge', occurrence: 1, reason: 'Audit fixture' })).rejects.toThrow();
    expect((await state()).acknowledged).toBe(false); expect(service.status.state).toBe('faulted');
    expect((await pool.query("SELECT 1 FROM apcs_alarm_events WHERE kind='Acknowledged'")).rowCount).toBe(0);
  });
  it('restores acknowledgement after restart and records the default removal of suppression', async () => {
    service.start(); await waitFor(async () => (await state()).active);
    await service.action(alarmId, actor, { kind: 'acknowledge', occurrence: 1, reason: 'Inspected' });
    await service.action(alarmId, actor, { kind: 'suppress', durationMs: 60000, reason: 'Maintenance' }); await service.close();
    service = new AlarmService(pool, () => ({ ...current })); service.start();
    await waitFor(async () => (await state()).suppressedUntil === null);
    expect(await state()).toMatchObject({ active: true, acknowledged: true, occurrence: 1 });
    expect((await pool.query("SELECT reason FROM apcs_alarm_events WHERE kind='Unsuppressed'")).rows[0].reason).toBe('Restart cleared suppression');
  });
});
