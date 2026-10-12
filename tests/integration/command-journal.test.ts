import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import type { CommandContext, CommandRequest } from '../../packages/domain/src/commands.js';
import { PgCommandJournal } from '../../packages/storage/src/command-journal.js';

const context: CommandContext = {
  bootId: 'boot-1', projectRevision: 1, quality: 'Good', interlockReason: null,
  ownerId: 'operator', maxTtlMs: 30_000,
};
function request(overrides: Partial<CommandRequest> = {}): CommandRequest {
  return { id: randomUUID(), idempotencyKey: randomUUID(), actorId: 'operator',
    targetSignalId: 'led', value: true, ttlMs: 30_000, expectedProjectRevision: 1,
    reason: 'LED commissioning', ...overrides };
}

let admin: Pool;
let pool: Pool;
let schema: string;
let journal: PgCommandJournal;

beforeEach(async () => {
  const connectionString = process.env.APCS_TEST_POSTGRES_URL;
  if (!connectionString) throw new Error('An isolated Docker PostgreSQL fixture is required');
  schema = `test_${randomUUID().replaceAll('-', '')}`;
  admin = new Pool({ connectionString, max: 1 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  pool = new Pool({ connectionString, max: 8, options: `-c search_path=${schema}` });
  journal = new PgCommandJournal(pool);
});

afterEach(async () => {
  await pool?.end();
  if (admin) {
    try { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); }
    finally { await admin.end(); }
  }
});

async function counts() {
  const result = await pool.query<{ commands: number; events: number; outbox: number }>(`
    SELECT (SELECT count(*)::int FROM apcs_commands) AS commands,
           (SELECT count(*)::int FROM apcs_command_events) AS events,
           (SELECT count(*)::int FROM apcs_command_outbox) AS outbox`);
  return result.rows[0];
}

describe('M0: durable commands and transactional outbox', () => {
  it('does not issue a command whose deadline elapses while resolving live context', async () => {
    await journal.migrate();
    const input = request({ ttlMs: 100 });
    await journal.request(input, context);
    expect(await journal.claimNext(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      return context;
    })).toBeNull();
    expect((await journal.get(input.id)).state).toBe('Expired');
  });

  it('never returns a delivery intent when COMMIT fails', async () => {
    await journal.migrate();
    const input = request();
    await journal.request(input, context);
    await pool.query(`
      CREATE FUNCTION fail_dispatch_commit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.snapshot->>'state' = 'Dispatched' THEN RAISE EXCEPTION 'Injected commit failure'; END IF;
        RETURN NEW;
      END $$;
      CREATE CONSTRAINT TRIGGER injected_commit_failure AFTER UPDATE ON apcs_commands
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fail_dispatch_commit()`);
    await expect(journal.claimNext(async () => context)).rejects.toThrow('Injected commit failure');
    expect((await journal.get(input.id)).state).toBe('Accepted');
    expect((await counts())?.events).toBe(2);
    await pool.query('DROP TRIGGER injected_commit_failure ON apcs_commands');
    expect((await journal.claimNext(async () => context))?.command.id).toBe(input.id);
  });

  it('rejects migration drift and a newer database instead of silently changing it', async () => {
    await journal.migrate();
    await pool.query("UPDATE apcs_schema_migrations SET checksum = 'changed'");
    await expect(journal.migrate()).rejects.toThrow(/checksum/i);
    await pool.query('UPDATE apcs_schema_migrations SET version = 2');
    await expect(journal.migrate()).rejects.toThrow(/version/i);
  });

  it('does not keep a transaction open indefinitely if live context stalls', async () => {
    await journal.migrate();
    const input = request();
    await journal.request(input, context);
    const bounded = new PgCommandJournal(pool, { contextTimeoutMs: 25 });
    await expect(bounded.claimNext(() => new Promise<CommandContext>(() => {}))).rejects.toThrow(/timeout/i);
    expect((await journal.get(input.id)).state).toBe('Accepted');
    expect((await journal.claimNext(async () => context))?.command.id).toBe(input.id);
  });

  it('rolls back ACK state and events together if audit insertion fails', async () => {
    await journal.migrate();
    const input = request();
    await journal.request(input, context);
    await journal.claimNext(async () => context);
    await pool.query("ALTER TABLE apcs_command_events ADD CONSTRAINT injected_failure CHECK (state <> 'Verified')");
    await expect(journal.acknowledge({ id: input.id, targetSignalId: 'led', bootId: 'boot-1', status: 'applied', value: true })).rejects.toThrow();
    const snapshot = await journal.get(input.id);
    expect(snapshot.state).toBe('Dispatched');
    expect(snapshot.evidence).toBeNull();
    expect((await counts())?.events).toBe(3);
    expect(await journal.claimNext(async () => context)).toBeNull();
  });

  it('late ACK cannot erase Unknown or unblock the output', async () => {
    await journal.migrate();
    const input = request();
    await journal.request(input, context);
    await journal.claimNext(async () => context);
    await journal.connectionLost('led');
    expect(await journal.acknowledge({ id: input.id, targetSignalId: 'led', bootId: 'boot-1', status: 'applied', value: true })).toBe(false);
    expect((await journal.get(input.id)).state).toBe('Unknown');
    expect((await journal.request(request(), context)).state).toBe('Rejected');
  });

  it('detected backwards database time cancels pending work and marks sent results Unknown', async () => {
    await journal.migrate();
    const sent = request({ targetSignalId: 'sent' });
    const pending = request({ targetSignalId: 'pending' });
    await journal.request(sent, context);
    await journal.claimNext(async () => context);
    await journal.request(pending, context);
    await pool.query("UPDATE apcs_commands SET last_observed_at = clock_timestamp() + interval '1 minute'");
    expect(await journal.recoverExpired()).toBe(2);
    expect((await journal.get(sent.id)).state).toBe('Unknown');
    expect((await journal.get(pending.id)).state).toBe('Cancelled');
    expect(await journal.claimNext(async () => context)).toBeNull();
  });

  it('recovery batches are bounded and repeatable', async () => {
    await journal.migrate();
    for (let index = 0; index < 3; index++) {
      await journal.request(request({ targetSignalId: `led-${index}` }), context);
    }
    await pool.query("UPDATE apcs_commands SET expires_at = clock_timestamp() - interval '1 second'");
    expect(await journal.recoverExpired(2)).toBe(2);
    expect(await journal.recoverExpired(2)).toBe(1);
    expect(await journal.recoverExpired(2)).toBe(0);
    await expect(journal.recoverExpired(0)).rejects.toThrow(/limit/i);
  });

  it('applies migrations idempotently, including concurrent startup', async () => {
    await Promise.all([journal.migrate(), new PgCommandJournal(pool).migrate()]);
    await journal.migrate();
    const result = await pool.query('SELECT version FROM apcs_schema_migrations');
    expect(result.rows).toEqual([{ version: 1 }]);
    expect(await counts()).toEqual({ commands: 0, events: 0, outbox: 0 });
  });

  it('persists request, history and pending delivery across a new connection pool', async () => {
    await journal.migrate();
    const input = request();
    const accepted = await journal.request(input, context);
    expect(accepted.state).toBe('Accepted');
    expect(await counts()).toEqual({ commands: 1, events: 2, outbox: 1 });
    await pool.end();
    pool = new Pool({ connectionString: process.env.APCS_TEST_POSTGRES_URL!, max: 8, options: `-c search_path=${schema}` });
    expect(await new PgCommandJournal(pool).get(input.id)).toEqual(accepted);
  });

  it('rolls back command and history when the outbox INSERT fails', async () => {
    await journal.migrate();
    await pool.query(`ALTER TABLE apcs_command_outbox ADD CONSTRAINT injected_failure CHECK (false)`);
    await expect(journal.request(request(), context)).rejects.toThrow();
    expect(await counts()).toEqual({ commands: 0, events: 0, outbox: 0 });
  });

  it('records rejected requests without scheduling a delivery', async () => {
    await journal.migrate();
    const result = await journal.request(request(), { ...context, interlockReason: 'Tank empty' });
    expect(result).toMatchObject({ state: 'Rejected', reason: 'Tank empty' });
    expect(await counts()).toEqual({ commands: 1, events: 2, outbox: 0 });
    expect(await journal.claimNext(async () => context)).toBeNull();
  });

  it('concurrent idempotent requests yield one command and conflicting payloads cannot overwrite it', async () => {
    await journal.migrate();
    const input = request();
    const results = await Promise.all(Array.from({ length: 8 }, () =>
      new PgCommandJournal(pool).request({ ...input, id: randomUUID() }, context)));
    expect(new Set(results.map((value) => value.id)).size).toBe(1);
    expect(await counts()).toEqual({ commands: 1, events: 2, outbox: 1 });
    await expect(journal.request({ ...input, value: false }, context)).rejects.toThrow(/conflict/i);
  });

  it('allows only one unfinished command per output, even for concurrent different keys', async () => {
    await journal.migrate();
    const results = await Promise.all(Array.from({ length: 4 }, () => journal.request(request(), context)));
    expect(results.filter((value) => value.state === 'Accepted')).toHaveLength(1);
    expect(results.filter((value) => value.state === 'Rejected')).toHaveLength(3);
    expect((await counts())?.outbox).toBe(1);
  });

  it('concurrent workers claim each delivery at most once', async () => {
    await journal.migrate();
    for (let index = 0; index < 4; index++) {
      await journal.request(request({ targetSignalId: `led-${index}` }), context);
    }
    const results = await Promise.all(Array.from({ length: 8 }, () =>
      new PgCommandJournal(pool).claimNext(async () => context)));
    const claimed = results.filter((value) => value !== null);
    expect(claimed).toHaveLength(4);
    expect(new Set(claimed.map((value) => value.command.id)).size).toBe(4);
    expect(new Set(claimed.map((value) => value.attemptId)).size).toBe(4);
    expect(claimed.every((value) => value.command.state === 'Dispatched')).toBe(true);
  });

  it('rechecks context before delivery and consumes rejected work', async () => {
    await journal.migrate();
    const input = request();
    await journal.request(input, context);
    expect(await journal.claimNext(async () => ({ ...context, bootId: 'boot-2' }))).toBeNull();
    expect((await journal.get(input.id)).state).toBe('Rejected');
    expect(await journal.claimNext(async () => context)).toBeNull();
  });

  it('a resolver failure rolls back the claim and permits a fresh check', async () => {
    await journal.migrate();
    const input = request();
    await journal.request(input, context);
    await expect(journal.claimNext(async () => { throw new Error('State unavailable'); })).rejects.toThrow('State unavailable');
    expect((await journal.get(input.id)).state).toBe('Accepted');
    expect((await journal.claimNext(async () => context))?.command.id).toBe(input.id);
  });

  it('a crash after claim never reissues work; recovery marks the result Unknown', async () => {
    await journal.migrate();
    const input = request();
    await journal.request(input, context);
    await journal.claimNext(async () => context);
    const restarted = new PgCommandJournal(pool);
    expect(await restarted.claimNext(async () => context)).toBeNull();
    await pool.query(`UPDATE apcs_commands SET expires_at = clock_timestamp() - interval '1 second' WHERE id = $1`, [input.id]);
    expect(await restarted.recoverExpired()).toBe(1);
    expect((await restarted.get(input.id)).state).toBe('Unknown');
    expect(await restarted.recoverExpired()).toBe(0);
    expect(await restarted.claimNext(async () => context)).toBeNull();
    expect((await restarted.request(request(), context)).state).toBe('Rejected');
  });

  it('expires undelivered work instead of starting a fresh TTL after restart', async () => {
    await journal.migrate();
    const input = request();
    await journal.request(input, context);
    await pool.query(`UPDATE apcs_commands SET expires_at = clock_timestamp() - interval '1 second' WHERE id = $1`, [input.id]);
    expect(await journal.claimNext(async () => context)).toBeNull();
    expect((await journal.get(input.id)).state).toBe('Expired');
  });

  it('persists an application ACK once and frees the output only after a terminal result', async () => {
    await journal.migrate();
    const input = request();
    await journal.request(input, context);
    await journal.claimNext(async () => context);
    const ack = { id: input.id, targetSignalId: 'led', bootId: 'boot-1', status: 'applied' as const, value: true };
    expect(await journal.acknowledge({ ...ack, bootId: 'other' })).toBe(false);
    const results = await Promise.all([journal.acknowledge(ack), journal.acknowledge(ack)]);
    expect(results.sort()).toEqual([false, true]);
    const verified = await new PgCommandJournal(pool).get(input.id);
    expect(verified).toMatchObject({ state: 'Verified', evidence: 'firmware-reported-output' });
    expect(verified.history.map((event) => event.state)).toEqual(['Requested', 'Accepted', 'Dispatched', 'DeviceAccepted', 'Verified']);
    expect((await counts())?.events).toBe(5);
    expect((await journal.request(request(), context)).state).toBe('Accepted');
  });

  it('disconnect atomically cancels pending work and preserves an uncertain sent result', async () => {
    await journal.migrate();
    const pending = request({ targetSignalId: 'pending' });
    const sent = request({ targetSignalId: 'sent' });
    await journal.request(sent, context);
    await journal.claimNext(async () => context);
    await journal.request(pending, context);
    await journal.connectionLost('sent');
    await journal.connectionLost('pending');
    expect((await journal.get(sent.id)).state).toBe('Unknown');
    expect((await journal.get(pending.id)).state).toBe('Cancelled');
    expect(await journal.claimNext(async () => context)).toBeNull();
  });

  it('rejects malformed requests before creating journal or outbox rows', async () => {
    await journal.migrate();
    await expect(journal.request(request({ ttlMs: NaN }), context)).rejects.toThrow(/ttl/i);
    expect(await counts()).toEqual({ commands: 0, events: 0, outbox: 0 });
  });
});
