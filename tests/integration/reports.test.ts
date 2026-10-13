import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createApi } from '../../apps/api/src/app.js';
import { bootstrapAdmin, migrateApplication } from '../../apps/api/src/store.js';
import { ReportService } from '../../apps/api/src/report-service.js';
import { PgSignalArchive } from '../../packages/storage/src/signal-archive.js';
import { PgHistoryAggregates } from '../../packages/storage/src/history-aggregates.js';
let admin: Pool; let pool: Pool; let schema: string; let app: Awaited<ReturnType<typeof createApi>>; let headers: Record<string, string>; let signalId: string; let owner: string;
beforeEach(async () => {
  const connectionString = process.env.APCS_TEST_POSTGRES_URL; if (!connectionString) throw new Error('Docker database required');
  schema = `reports_${randomUUID().replaceAll('-', '')}`; admin = new Pool({ connectionString }); await admin.query(`CREATE SCHEMA ${schema}`);
  pool = new Pool({ connectionString, options: `-c search_path=${schema}` }); await migrateApplication(pool); await bootstrapAdmin(pool, 'operator', 'Report fixture password!');
  app = await createApi({ pool, origin: 'http://localhost:5173', secureCookies: false, reportsEnabled: true });
  const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { origin: 'http://localhost:5173' }, payload: { username: 'operator', password: 'Report fixture password!' } });
  headers = { origin: 'http://localhost:5173', cookie: `apcs_session=${login.cookies[0]!.value}`, 'x-csrf-token': login.json().csrfToken };
  owner = login.json().id;
  const projectId = (await app.inject({ method: 'POST', url: '/api/v1/projects', headers, payload: { name: 'Report project' } })).json().id;
  signalId = (await app.inject({ method: 'POST', url: '/api/v1/devices', headers, payload: { projectId, name: 'Reported LED', kind: 'virtual-led', siteId: 'report', deviceId: 'led' } })).json().signalId;
});
afterEach(async () => { await app?.close(); await pool?.end(); if (admin) { try { await admin.query(`DROP SCHEMA ${schema} CASCADE`); } finally { await admin.end(); } } });
const request = (requestKey = randomUUID(), date = '2026-10-12') => app.inject({ method: 'POST', url: `/api/v1/signals/${signalId}/reports`, headers, payload: { period: 'day', date, requestKey } });
const get = (id: string) => app.inject({ url: `/api/v1/reports/${id}`, headers });
const pdf = Buffer.from('%PDF-1.7\nfixture-renderer\n%%EOF');
it('queues idempotently, bounds outstanding work and audits only the accepted request', async () => {
  const key = randomUUID(); const first = await request(key); expect(first.statusCode).toBe(202); expect(first.json().state).toBe('Queued');
  const retry = await request(key); expect(retry.statusCode).toBe(200); expect(retry.json().id).toBe(first.json().id);
  expect((await request(key, '2026-10-11')).statusCode).toBe(409);
  for (let i = 1; i < 8; i++) expect((await request()).statusCode).toBe(202);
  expect((await request()).statusCode).toBe(429);
  expect((await pool.query("SELECT count(*) FROM apcs_audit WHERE action='report.requested'")).rows[0].count).toBe('8');
  expect((await app.inject({ url: `/api/v1/signals/${signalId}/reports`, headers })).json().items).toHaveLength(8);
});
it('requires owner and CSRF, rejects invalid calendar requests and hides unfinished artifacts', async () => {
  expect((await request(randomUUID(), '2026-02-30')).statusCode).toBe(422);
  const noCsrf = await app.inject({ method: 'POST', url: `/api/v1/signals/${signalId}/reports`, headers: { cookie: headers.cookie!, origin: headers.origin! }, payload: { period: 'day', date: '2026-10-12', requestKey: randomUUID() } }); expect(noCsrf.statusCode).toBe(403);
  const id = (await request()).json().id;
  expect((await app.inject({ url: `/api/v1/reports/${id}/pdf`, headers })).statusCode).toBe(409);
  expect((await app.inject({ url: `/api/v1/reports/${id}` })).statusCode).toBe(401);
  const foreign = randomUUID(); await pool.query("INSERT INTO apcs_users(id,username,password_hash) VALUES($1,'foreign','fixture')", [foreign]); await pool.query('UPDATE apcs_projects SET owner_id=$1', [foreign]);
  expect((await get(id)).statusCode).toBe(404); expect((await request()).statusCode).toBe(404);
});
it('generates an immutable data snapshot and bounded CSV/PDF from real archived aggregates', async () => {
  const base = Date.parse('2026-10-12T00:00:00Z');
  await new PgSignalArchive(pool).append([0, 30, 60, 120].map((second, index) => ({ eventId: randomUUID(), signalId, observedAt: new Date(base + second * 1000).toISOString(), snapshot: { value: index === 1, quality: 'Good' as const, bootId: 'report', sequence: index, receivedTime: new Date(base + second * 1000).toISOString(), sourceTime: null } })));
  const aggregates = new PgHistoryAggregates(pool); for (let i = 0; i < 20 && await aggregates.processNext(new Date(base + 7200000)) !== 'idle'; i++) { /* Drain the bounded fixture. */ }
  const id = (await request()).json().id; const service = new ReportService(pool, async (data) => { expect(data.summary.trueMs).toBe(30000); return pdf; });
  expect(await service.processNext()).toBe(true);
  const ready = (await get(id)).json(); expect(ready.state).toBe('Ready'); expect(ready.report.summary).toMatchObject({ trueMs: 30000, usedHours: 1, qualityMs: { Good: 120000 } });
  const download = await app.inject({ url: `/api/v1/reports/${id}/pdf`, headers }); expect(download.statusCode).toBe(200); expect(download.rawPayload).toEqual(pdf); expect(download.headers['content-type']).toContain('application/pdf');
  const csv = await app.inject({ url: `/api/v1/reports/${id}/csv`, headers }); expect(csv.body).toContain('unknown_seconds'); expect(csv.body).toContain('Reported LED.led');
  await pool.query('DELETE FROM apcs_history_aggregates'); expect((await get(id)).json().report).toEqual(ready.report);
  expect((await pool.query('SELECT count(*) FROM apcs_commands')).rows[0].count).toBe('0');
});
it('records render failure and fences a late result after its lease expires', async () => {
  const failed = (await request()).json().id; await new ReportService(pool, async () => { throw new Error('Renderer unavailable'); }).processNext();
  expect((await get(failed)).json()).toMatchObject({ state: 'Failed', error: 'Report generation failed' });
  const id = (await request()).json().id; let finish!: (data: Buffer) => void;
  const task = new ReportService(pool, () => new Promise((resolve) => { finish = resolve; })).processNext();
  await expect.poll(() => typeof finish).toBe('function');
  await pool.query("UPDATE apcs_report_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [id]);
  finish(pdf); await task;
  await new ReportService(pool, async () => pdf).processNext();
  expect((await get(id)).json()).toMatchObject({ state: 'Failed', error: 'Report generation interrupted' });
  expect((await app.inject({ url: `/api/v1/reports/${id}/pdf`, headers })).statusCode).toBe(409);
});
it('rejects invalid renderer output, preserves pending coverage and prunes expired completed artifacts', async () => {
  const id = (await request()).json().id; await new ReportService(pool, async () => Buffer.from('not a PDF')).processNext(); expect((await get(id)).json().state).toBe('Failed');
  await pool.query("UPDATE apcs_report_jobs SET created_at=clock_timestamp()-interval '8 days' WHERE id=$1", [id]);
  await new ReportService(pool, async () => pdf).prune(); expect((await get(id)).statusCode).toBe(404);
  await pool.query("INSERT INTO apcs_history_aggregate_jobs(signal_id,resolution,bucket_start) VALUES($1,3600,'2026-10-12T00:00:00Z')", [signalId]);
  const pending = (await request()).json().id; await new ReportService(pool, async () => pdf).processNext();
  expect((await get(pending)).json().report.summary).toMatchObject({ pendingHours: 1, missingHours: 23, usedHours: 0 });
});
