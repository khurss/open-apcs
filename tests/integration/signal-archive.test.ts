import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { migrateApplication } from '../../apps/api/src/store.js';
import { PgHistoryAggregates } from '../../packages/storage/src/history-aggregates.js';
import { PgSignalArchive } from '../../packages/storage/src/signal-archive.js';
import type { HistoryRow } from '../../packages/domain/src/history.js';
let admin: Pool; let pool: Pool; let schema: string; let archive: PgSignalArchive; let signalId: string;
const from = '2026-10-12T00:00:00.000Z'; const to = '2026-10-13T00:00:00.000Z';
beforeEach(async () => {
  const connectionString = process.env.APCS_TEST_POSTGRES_URL; if (!connectionString) throw new Error('Docker fixture required');
  schema = `archive_${randomUUID().replaceAll('-', '')}`; admin = new Pool({ connectionString }); await admin.query(`CREATE SCHEMA ${schema}`);
  pool = new Pool({ connectionString, options: `-c search_path=${schema}` }); await migrateApplication(pool); archive = new PgSignalArchive(pool);
  const actor = randomUUID(); const project = randomUUID(); const device = randomUUID(); signalId = randomUUID();
  await pool.query("INSERT INTO apcs_users (id,username,password_hash) VALUES ($1,'fixture','fixture')", [actor]);
  await pool.query("INSERT INTO apcs_projects (id,name,owner_id) VALUES ($1,'Archive fixture',$2)", [project, actor]);
  await pool.query("INSERT INTO apcs_devices (id,project_id,name,kind,site_id,protocol_device_id) VALUES ($1,$2,'LED','virtual-led','test','led')", [device, project]);
  await pool.query("INSERT INTO apcs_signals (id,device_id,name,data_type,direction) VALUES ($1,$2,'LED','boolean','output')", [signalId, device]);
});
afterEach(async () => { await pool?.end(); if (admin) { try { await admin.query(`DROP SCHEMA ${schema} CASCADE`); } finally { await admin.end(); } } });
const row = (value: boolean, observedAt = from): HistoryRow => ({ eventId: randomUUID(), signalId, observedAt, snapshot: { value, quality: 'Good', bootId: 'boot', sequence: 1, receivedTime: observedAt, sourceTime: null } });
describe('durable signal archive', () => {
  it('persists value and quality transitions with stable ordering when timestamps match', async () => {
    const first = row(false); const second = row(true); const lost = row(true); lost.snapshot.quality = 'Disconnected';
    await archive.append([first, second, lost]); const page = await archive.read(signalId, { from, to });
    expect(page.items.map((entry) => [entry.snapshot.value, entry.snapshot.quality])).toEqual([[true, 'Disconnected'], [true, 'Good'], [false, 'Good']]);
    expect(page.nextBefore).toBeNull();
  });
  it('deduplicates a retried committed batch and preserves exact JSON string values', async () => {
    const point = row(false); point.snapshot.value = '18446744073709551615';
    await archive.append([point]); await archive.append([point]);
    const page = await archive.read(signalId, { from, to }); expect(page.items).toHaveLength(1); expect(page.items[0]!.snapshot.value).toBe(point.snapshot.value);
  });
  it('rolls back the entire batch on an event identity conflict', async () => {
    const point = row(false); await archive.append([point]);
    await expect(archive.append([row(true), { ...point, snapshot: { ...point.snapshot, value: true } }])).rejects.toThrow(/conflict/i);
    expect((await archive.read(signalId, { from, to })).items).toHaveLength(1);
  });
  it('does not partially write a batch with a missing signal', async () => {
    await expect(archive.append([row(false), { ...row(true), signalId: randomUUID() }])).rejects.toThrow();
    expect((await archive.read(signalId, { from, to })).items).toHaveLength(0);
  });
  it('pages tied timestamps without skipping transitions or accepting a foreign cursor', async () => {
    await archive.append([row(false), row(true), row(false)]);
    const first = await archive.read(signalId, { from, to, limit: 2 }); expect(first.items).toHaveLength(2); expect(first.nextBefore).not.toBeNull();
    const second = await archive.read(signalId, { from, to, limit: 2, before: first.nextBefore! }); expect(second.items).toHaveLength(1); expect(second.items[0]!.snapshot.value).toBe(false);
    await expect(archive.read(randomUUID(), { from, to, before: first.nextBefore! })).rejects.toThrow(/cursor/i);
    await expect(archive.read(signalId, { from: to, to: from })).rejects.toThrow(/range/i);
    await expect(archive.read(signalId, { from, to, limit: 1001 })).rejects.toThrow(/limit/i);
  });
  it('prunes in bounded batches while retaining the exact cutoff sample', async () => {
    await archive.append([row(false, '2026-10-04T00:00:00Z'), row(true, '2026-10-04T01:00:00Z'), row(false, '2026-10-05T00:00:00Z')]);
    const aggregates = new PgHistoryAggregates(pool); while (await aggregates.backfill()) {}
    for (let i = 0; i < 40; i++) if (await aggregates.processNext(new Date('2026-10-06T00:00:00Z')) === 'idle') break;
    expect(await archive.prune(new Date('2026-10-05T00:00:00Z'), 1)).toBe(1);
    expect(await archive.prune(new Date('2026-10-05T00:00:00Z'), 1)).toBe(1);
    expect(await archive.prune(new Date('2026-10-05T00:00:00Z'), 1)).toBe(0);
    const page = await archive.read(signalId, { from: '2026-10-04T00:00:00Z', to: '2026-10-06T00:00:00Z' }); expect(page.items).toHaveLength(1);
  });
});
