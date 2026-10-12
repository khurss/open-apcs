import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AggregateService } from '../../apps/api/src/aggregate-service.js';
import { migrateApplication } from '../../apps/api/src/store.js';
import { PgSignalArchive } from '../../packages/storage/src/signal-archive.js';
import { PgHistoryAggregates } from '../../packages/storage/src/history-aggregates.js';
import type { HistoryRow } from '../../packages/domain/src/history.js';
let service: AggregateService | undefined;
let admin: Pool; let pool: Pool; let schema: string; let signalId: string; let archive: PgSignalArchive; let aggregates: PgHistoryAggregates;
const base = Date.parse('2026-10-12T12:00:00Z'); const at = (seconds: number) => new Date(base + seconds * 1000).toISOString();
const point = (seconds: number, value: boolean): HistoryRow => ({ eventId: randomUUID(), signalId, observedAt: at(seconds), snapshot: { value, quality: 'Good', bootId: 'fixture', sequence: 1, sourceTime: null, receivedTime: at(seconds) } });
const query = { from: at(0), to: at(60), resolution: 60 as const };
beforeEach(async () => {
  const connectionString = process.env.APCS_TEST_POSTGRES_URL; if (!connectionString) throw new Error('Docker fixture required');
  schema = `aggregates_${randomUUID().replaceAll('-', '')}`; admin = new Pool({ connectionString }); await admin.query(`CREATE SCHEMA ${schema}`);
  pool = new Pool({ connectionString, options: `-c search_path=${schema}` }); await migrateApplication(pool); archive = new PgSignalArchive(pool); aggregates = new PgHistoryAggregates(pool);
  const actor = randomUUID(); const project = randomUUID(); const device = randomUUID(); signalId = randomUUID();
  await pool.query("INSERT INTO apcs_users(id,username,password_hash) VALUES($1,'fixture','fixture')", [actor]);
  await pool.query("INSERT INTO apcs_projects(id,name,owner_id) VALUES($1,'Aggregate fixture',$2)", [project, actor]);
  await pool.query("INSERT INTO apcs_devices(id,project_id,name,kind,site_id,protocol_device_id) VALUES($1,$2,'LED','virtual-led','test','led')", [device, project]);
  await pool.query("INSERT INTO apcs_signals(id,device_id,name,data_type,direction) VALUES($1,$2,'LED','boolean','output')", [signalId, device]);
});
afterEach(async () => { await service?.close(); service = undefined; await pool?.end(); if (admin) { try { await admin.query(`DROP SCHEMA ${schema} CASCADE`); } finally { await admin.end(); } } });
async function drain() { while (await aggregates.backfill()) {} for (let count = 0; count < 100; count++) { const result = await aggregates.processNext(new Date(at(7500))); if (result === 'idle') return; expect(result).toBe('written'); } throw new Error('Fixture aggregate queue did not drain'); }
describe('persistent minute/hour aggregates', () => {
  it('runs aggregation without a browser or armed devices and holds one owner per schema', async () => {
    await archive.append([point(0, false), point(10, true), point(40, false), point(60, false)]);
    service = new AggregateService(pool, () => new Date(at(7500))); await service.start();
    const duplicate = new AggregateService(pool); await expect(duplicate.start()).rejects.toThrow(/owner/i); await duplicate.close();
    const deadline = performance.now() + 5000;
    while (!(await aggregates.read(signalId, query)).items.length && performance.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await aggregates.read(signalId, query)).items[0]!.aggregate.trueMs).toBe(30000);
    expect((await pool.query('SELECT state FROM apcs_history_aggregate_service')).rows[0].state).toBe('running');
    await service.close(); service = undefined; expect((await pool.query('SELECT state FROM apcs_history_aggregate_service')).rows[0].state).toBe('stopped');
  });
  it('prunes expired annual aggregates in bounded batches while retaining recent jobs', async () => {
    await archive.append([point(0, false), point(10, true), point(60, false)]); await drain();
    await archive.append([point(365 * 86400, true)]);
    const result = await aggregates.prune(new Date(at(365 * 86400 + 7500)));
    expect(result.aggregates).toBeGreaterThan(0); expect((await aggregates.read(signalId, query)).items).toHaveLength(0);
    expect((await pool.query('SELECT 1 FROM apcs_history_aggregate_jobs')).rowCount).toBeGreaterThan(0);
    await expect(aggregates.read(signalId, { ...query, to: at(366 * 86400) })).rejects.toThrow(/365 days/);
  });
  it('marks affected buckets atomically and waits for the continuity window before calculation', async () => {
    await archive.append([point(0, false), point(10, true), point(40, false), point(60, false)]);
    expect((await pool.query('SELECT resolution FROM apcs_history_aggregate_jobs')).rows.some((row) => row.resolution === 3600)).toBe(true);
    // Older boundary buckets may be ready, but the minute beginning at base is not.
    for (let i = 0; i < 10; i++) await aggregates.processNext(new Date(at(179)));
    expect((await aggregates.read(signalId, query)).items).toHaveLength(0);
    await drain();
    expect((await aggregates.read(signalId, query)).items[0]).toMatchObject({ stale: false, aggregate: { trueMs: 30000, falseMs: 30000, transitions: 2, qualityMs: { Good: 60000 } } });
  });
  it('recalculates a dirty bucket for late data and does not dirty it for an identical batch retry', async () => {
    await archive.append([point(0, false), point(10, true), point(40, false), point(60, false)]); await drain();
    const late = point(30, false); await archive.append([late]);
    expect((await aggregates.read(signalId, query)).items[0]!.stale).toBe(true); await drain();
    expect((await aggregates.read(signalId, query)).items[0]).toMatchObject({ stale: false, aggregate: { trueMs: 20000, falseMs: 40000 } });
    await archive.append([late]); expect((await aggregates.read(signalId, query)).items[0]!.stale).toBe(false);
    await expect(archive.append([{ ...late, snapshot: { ...late.snapshot, value: true } }])).rejects.toThrow(/conflict/i);
    expect((await aggregates.read(signalId, query)).items[0]!.stale).toBe(false);
  });
  it('protects raw observations until dependent aggregates are complete', async () => {
    await archive.append([point(0, false), point(10, true), point(40, false), point(60, false)]);
    expect(await archive.prune(new Date(at(60)))).toBe(0);
    await drain(); expect(await archive.prune(new Date(at(7200)))).toBe(4);
    expect((await aggregates.read(signalId, query)).items[0]!.aggregate.trueMs).toBe(30000);
  });
  it('rejects data older than the closed retention boundary without changing preserved aggregates', async () => {
    await archive.append([point(0, false), point(10, true), point(40, false), point(60, false)]); await drain();
    expect(await archive.prune(new Date(at(7200)))).toBe(4);
    await expect(archive.append([point(30, false), point(7300, true)])).rejects.toThrow(/retention boundary/i);
    expect((await pool.query('SELECT 1 FROM apcs_signal_history')).rowCount).toBe(0);
    expect((await aggregates.read(signalId, query)).items[0]!.aggregate.trueMs).toBe(30000);
    await archive.append([point(7300, true)]); expect((await pool.query('SELECT 1 FROM apcs_signal_history')).rowCount).toBe(1);
  });
  it('retains a complete boundary hour so an admissible late session change cannot erase its earlier coverage', async () => {
    await archive.append(Array.from({ length: 62 }, (_, index) => point(-3600 + index * 60, false))); await drain();
    const hour = { from: at(-3600), to: at(0), resolution: 3600 as const };
    expect((await aggregates.read(signalId, hour)).items[0]!.aggregate.qualityMs.Good).toBe(3600000);
    expect(await archive.prune(new Date(at(-60)))).toBe(0);
    const late = point(-30, false); late.snapshot.bootId = 'late-session'; await archive.append([late]); await drain();
    expect((await aggregates.read(signalId, hour)).items[0]!.aggregate.qualityMs).toMatchObject({ Good: 3540000, Unknown: 60000 });
  });
  it('backfills pre-existing raw records in bounded restartable pages', async () => {
    await pool.query('ALTER TABLE apcs_signal_history DISABLE TRIGGER apcs_history_aggregate_inserted');
    await archive.append(Array.from({ length: 1000 }, (_, index) => point(index % 60, Boolean(index % 2))));
    await archive.append([point(60, false), point(61, true)]);
    await pool.query('ALTER TABLE apcs_signal_history ENABLE TRIGGER apcs_history_aggregate_inserted');
    await pool.query('UPDATE apcs_history_aggregate_backfill SET cursor_ordinal=0,through_ordinal=(SELECT max(ordinal) FROM apcs_signal_history),done=false');
    expect((await pool.query('SELECT 1 FROM apcs_history_aggregate_jobs')).rowCount).toBe(0);
    expect(await aggregates.backfill()).toBe(true);
    expect((await pool.query('SELECT done FROM apcs_history_aggregate_backfill')).rows[0].done).toBe(false);
    aggregates = new PgHistoryAggregates(pool); expect(await aggregates.backfill()).toBe(true); expect(await aggregates.backfill()).toBe(false);
    await drain(); expect((await aggregates.read(signalId, query)).items[0]!.aggregate.sampleCount).toBe(1000);
  });
  it('exposes bounded overload instead of silently aggregating a truncated bucket', async () => {
    for (let i = 0; i < 10; i++) await archive.append(Array.from({ length: 1000 }, (_, n) => point(n % 60, Boolean(n % 2))));
    await archive.append([point(1, false)]);
    for (let i = 0; i < 30; i++) if (await aggregates.processNext(new Date(at(7500))) === 'idle') break;
    const errors = (await pool.query('SELECT last_error FROM apcs_history_aggregate_jobs WHERE last_error IS NOT NULL')).rows;
    expect(errors.length).toBeGreaterThan(0); expect(errors.every((row) => row.last_error === 'Aggregate sample limit exceeded')).toBe(true);
    expect((await aggregates.read(signalId, query)).items).toHaveLength(0);
    expect(await archive.prune(new Date(at(60)))).toBe(0);
  });
});
