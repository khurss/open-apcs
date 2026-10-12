import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { PgCommandJournal } from '../../packages/storage/src/command-journal.js';
import type { CommandRequest, CommandContext } from '../../packages/domain/src/commands.js';
let admin: Pool; let pool: Pool; let schema: string; let journal: PgCommandJournal;
const context: CommandContext = { bootId: 'old-boot', quality: 'Good', ownerId: 'operator', projectRevision: 1, maxTtlMs: 3000, interlockReason: null };
const safe = () => ({ ...context, bootId: 'new-boot', value: false });
const request = (): CommandRequest => ({ id: randomUUID(), idempotencyKey: randomUUID(), actorId: 'operator', targetSignalId: 'led', value: true, expectedProjectRevision: 1, ttlMs: 3000, reason: 'Fixture command' });
beforeEach(async () => {
  const connectionString = process.env.APCS_TEST_POSTGRES_URL; if (!connectionString) throw new Error('Docker fixture required');
  schema = `reconcile_${randomUUID().replaceAll('-', '')}`; admin = new Pool({ connectionString }); await admin.query(`CREATE SCHEMA ${schema}`);
  pool = new Pool({ connectionString, options: `-c search_path=${schema}` }); journal = new PgCommandJournal(pool); await journal.migrate();
});
afterEach(async () => { await pool?.end(); if (admin) { try { await admin.query(`DROP SCHEMA ${schema} CASCADE`); } finally { await admin.end(); } } });
async function unknown() { const input = request(); await journal.request(input, context); await journal.claimNext(async () => context); await journal.connectionLost('led'); expect((await journal.get(input.id)).state).toBe('Unknown'); return input; }
describe('explicit Unknown reconciliation', () => {
  it('records operator reconciliation without rewriting the original Unknown outcome or replaying a command', async () => {
    const input = await unknown();
    const result = await journal.reconcile(input.id, 'operator', 'Restarted the virtual device and inspected its safe output', async () => safe());
    expect(result).toMatchObject({ state: 'Unknown', evidence: null, reconciliation: { actorId: 'operator', bootId: 'new-boot', observedValue: false } });
    expect(await journal.claimNext(async () => safe())).toBeNull();
    expect((await new PgCommandJournal(pool).get(input.id)).reconciliation).toEqual(result.reconciliation);
    expect((await journal.request(request(), safe())).state).toBe('Accepted');
    expect(await journal.acknowledge({ id: input.id, targetSignalId: 'led', bootId: 'old-boot', status: 'applied', value: true })).toBe(false);
    expect((await journal.get(input.id)).state).toBe('Unknown');
  });
  it.each([
    { bootId: 'old-boot' }, { bootId: null }, { quality: 'Stale' as const }, { quality: 'Disconnected' as const },
    { value: true }, { value: null }, { ownerId: 'another-owner' }, { interlockReason: 'Protection active' },
  ])('keeps the output blocked when trusted state is unsuitable: %j', async (override) => {
    const input = await unknown();
    await expect(journal.reconcile(input.id, 'operator', 'Attempted recovery', async () => ({ ...safe(), ...override }))).rejects.toThrow(/safe|owner|session|quality|interlock/i);
    expect((await journal.get(input.id)).reconciliation).toBeUndefined();
    expect((await journal.request(request(), safe())).state).toBe('Rejected');
  });
  it('refuses reconciliation of a pending command and an empty explanation', async () => {
    const input = request(); await journal.request(input, context);
    await expect(journal.reconcile(input.id, 'operator', 'Pending request', async () => safe())).rejects.toThrow(/Unknown/);
    await journal.connectionLost('led'); const lost = await unknown();
    await expect(journal.reconcile(lost.id, 'operator', ' ', async () => safe())).rejects.toThrow(/reason/i);
  });
  it('makes concurrent identical reconciliation idempotent and retains the first actor and reason', async () => {
    const input = await unknown(); let audits = 0;
    const outcomes = await Promise.all(Array.from({ length: 3 }, () => journal.reconcile(input.id, 'operator', 'Inspected restart', async () => safe(), async () => { audits++; })));
    expect(outcomes[1]).toEqual(outcomes[0]); expect(audits).toBe(1);
    await expect(journal.reconcile(input.id, 'operator', 'Changed explanation', async () => safe())).rejects.toThrow(/conflict/i);
  });
  it('rolls back reconciliation when its audit hook fails', async () => {
    const input = await unknown();
    await expect(journal.reconcile(input.id, 'operator', 'Audit failure fixture', async () => safe(), async () => { throw new Error('Audit unavailable'); })).rejects.toThrow('Audit unavailable');
    expect((await journal.get(input.id)).reconciliation).toBeUndefined();
    expect((await journal.request(request(), safe())).state).toBe('Rejected');
  });
  it('bounds a stalled trusted resolver and releases its database locks', async () => {
    const input = await unknown(); const bounded = new PgCommandJournal(pool, { contextTimeoutMs: 25 });
    await expect(bounded.reconcile(input.id, 'operator', 'Timeout fixture', async () => new Promise(() => {}))).rejects.toThrow(/timeout/i);
    expect((await journal.reconcile(input.id, 'operator', 'Recovered resolver', async () => safe())).reconciliation).toBeDefined();
  });
  it('upgrades the original journal schema while preserving unknown outcomes and migration checksums', async () => {
    await pool.query(`DROP SCHEMA ${schema} CASCADE; CREATE SCHEMA ${schema}`);
    const sql = await readFile(new URL('../../packages/storage/migrations/001-command-journal.sql', import.meta.url), 'utf8');
    await pool.query(sql); await pool.query('CREATE TABLE apcs_schema_migrations (version integer PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz DEFAULT clock_timestamp())');
    await pool.query('INSERT INTO apcs_schema_migrations (version,checksum) VALUES (1,$1)', [createHash('sha256').update(sql).digest('hex')]);
    const input = request(); const snapshot = { id: input.id, targetSignalId: 'led', value: true, bootId: 'old-boot', state: 'Unknown', reason: 'Legacy loss', evidence: null, history: [{ state: 'Unknown', at: new Date().toISOString(), reason: 'Legacy loss' }] };
    await pool.query("INSERT INTO apcs_commands (id,actor_id,idempotency_key,target_signal_id,fingerprint,request,snapshot,created_at,expires_at,last_observed_at) VALUES ($1,'operator',$2,'led','fixture',$3,$4,clock_timestamp(),clock_timestamp(),clock_timestamp())", [input.id, input.idempotencyKey, input, snapshot]);
    await journal.migrate(); await journal.migrate();
    expect((await journal.get(input.id)).state).toBe('Unknown');
    expect((await journal.reconcile(input.id, 'operator', 'Upgrade recovery', async () => safe())).reconciliation).toBeDefined();
  });
});
