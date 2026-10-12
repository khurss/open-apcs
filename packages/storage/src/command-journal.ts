import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import type { Pool, PoolClient } from 'pg';
import {
  CommandBook, commandFingerprint, validateCommandRequest,
  type CommandAck, type CommandContext, type CommandRequest, type CommandSnapshot,
} from '@open-apcs/domain/commands';
import type { Clock } from '@open-apcs/domain/signals';

export interface DispatchIntent {
  command: CommandSnapshot;
  request: CommandRequest;
  attemptId: string;
  expiresAt: string;
}

interface Row {
  id: string;
  request: CommandRequest;
  snapshot: CommandSnapshot;
  fingerprint: string;
  expires_at: Date;
  last_observed_at: Date;
}

async function transaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let broken = false;
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '2s'");
    await client.query("SET LOCAL statement_timeout = '5s'");
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { broken = true; }
    throw error;
  } finally {
    client.release(broken);
  }
}

/** One DB timestamp anchors monotonic elapsed time during this transaction. */
async function databaseClock(client: PoolClient): Promise<Clock> {
  const result = await client.query<{ now: Date }>('SELECT clock_timestamp() AS now');
  const instant = result.rows[0]!.now.getTime();
  const start = performance.now();
  return { wallNow: () => new Date(instant + performance.now() - start), monotonicNow: () => performance.now() };
}

/** No network writes occur here. A consumed outbox row is never automatically retried. */
export class PgCommandJournal {
  private readonly contextTimeoutMs: number;

  constructor(private readonly pool: Pool, options: { contextTimeoutMs?: number } = {}) {
    this.contextTimeoutMs = options.contextTimeoutMs ?? 1_000;
    if (!Number.isSafeInteger(this.contextTimeoutMs) || this.contextTimeoutMs < 1 || this.contextTimeoutMs > 5_000) {
      throw new Error('Context timeout must be between 1 and 5000 ms');
    }
  }

  async migrate(): Promise<void> {
    const sql = await readFile(new URL('../migrations/001-command-journal.sql', import.meta.url), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    await transaction(this.pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(9021001)');
      await client.query(`CREATE TABLE IF NOT EXISTS apcs_schema_migrations (
        version integer PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT clock_timestamp())`);
      const applied = await client.query<{ version: number; checksum: string }>('SELECT version, checksum FROM apcs_schema_migrations ORDER BY version');
      if (applied.rows.some((row) => row.version !== 1)) throw new Error('Unsupported database schema version');
      if (applied.rows.length) {
        if (applied.rows[0]!.checksum !== checksum) throw new Error('Migration checksum mismatch');
        return;
      }
      await client.query(sql);
      await client.query('INSERT INTO apcs_schema_migrations (version, checksum) VALUES (1, $1)', [checksum]);
    });
  }

  async request(request: CommandRequest, context: CommandContext): Promise<CommandSnapshot> {
    validateCommandRequest(request);
    request = { ...request };
    context = { ...context };
    return transaction(this.pool, async (client) => {
      await this.lock(client, ['idempotency', request.actorId, request.idempotencyKey]);
      const existing = await client.query<Row>(`SELECT * FROM apcs_commands
        WHERE actor_id = $1 AND idempotency_key = $2 FOR UPDATE`, [request.actorId, request.idempotencyKey]);
      if (existing.rows[0]) {
        const row = existing.rows[0];
        if (row.fingerprint !== commandFingerprint(request)) throw new Error('Idempotency conflict');
        return this.refresh(client, row);
      }
      await this.lock(client, ['output', request.targetSignalId]);
      const busy = await client.query(`SELECT id FROM apcs_commands WHERE target_signal_id = $1
        AND snapshot->>'state' IN ('Accepted', 'Dispatched', 'DeviceAccepted', 'Unknown') LIMIT 1`, [request.targetSignalId]);
      if (busy.rowCount) context = { ...context, interlockReason: context.interlockReason ?? 'Output has an unfinished command; reconcile Unknown before retrying' };
      const clock = await databaseClock(client);
      const snapshot = new CommandBook(clock).request(request, context);
      const created = new Date(snapshot.history[0]!.at);
      try {
        await client.query(`INSERT INTO apcs_commands
          (id, actor_id, idempotency_key, target_signal_id, fingerprint, request, snapshot, created_at, expires_at, last_observed_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$8)`, [request.id, request.actorId, request.idempotencyKey,
          request.targetSignalId, commandFingerprint(request), request, snapshot, created, new Date(created.getTime() + request.ttlMs)]);
      } catch (error) {
        if ((error as { code?: string }).code === '23505') throw new Error('Command ID or output conflict', { cause: error });
        throw error;
      }
      await this.events(client, snapshot, 0);
      if (snapshot.state === 'Accepted') {
        await client.query("INSERT INTO apcs_command_outbox (command_id, state) VALUES ($1, 'pending')", [request.id]);
      }
      return snapshot;
    });
  }

  async get(id: string): Promise<CommandSnapshot> {
    return transaction(this.pool, async (client) => this.refresh(client, await this.load(client, id)));
  }

  /** Resolver only reads trusted live state; it must not publish or mutate devices. */
  async claimNext(resolve: (request: CommandRequest, signal: AbortSignal) => Promise<CommandContext>): Promise<DispatchIntent | null> {
    return transaction(this.pool, async (client) => {
      const result = await client.query<Row>(`SELECT c.* FROM apcs_commands c
        JOIN apcs_command_outbox o ON o.command_id = c.id WHERE o.state = 'pending'
        ORDER BY c.created_at, c.id LIMIT 1 FOR UPDATE OF c SKIP LOCKED`);
      const row = result.rows[0];
      if (!row) return null;
      const clock = await databaseClock(client);
      const book = this.restore(row, clock);
      let command: CommandSnapshot | null = null;
      if (book.get(row.id).state === 'Accepted') {
        command = book.dispatch(row.id, await this.resolveContext(resolve, row.request));
      }
      const snapshot = book.get(row.id);
      await this.save(client, row, snapshot, clock);
      if (!command || snapshot.state !== 'Dispatched') return null;
      const attemptId = randomUUID();
      await client.query("UPDATE apcs_command_outbox SET state = 'consumed', attempt_id = $2 WHERE command_id = $1", [row.id, attemptId]);
      // transaction() returns this intent only after COMMIT succeeds.
      return { command: snapshot, request: { ...row.request }, attemptId, expiresAt: row.expires_at.toISOString() };
    });
  }

  async acknowledge(ack: CommandAck): Promise<boolean> {
    ack = { ...ack };
    return transaction(this.pool, async (client) => {
      const result = await client.query<Row>('SELECT * FROM apcs_commands WHERE id = $1 FOR UPDATE', [ack.id]);
      const row = result.rows[0];
      if (!row) return false;
      const clock = await databaseClock(client);
      const book = this.restore(row, clock);
      const accepted = book.acknowledge(ack);
      await this.save(client, row, book.get(row.id), clock);
      return accepted;
    });
  }

  async recoverExpired(limit = 100): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) throw new Error('Invalid recovery limit');
    return transaction(this.pool, async (client) => {
      const rows = await client.query<Row>(`SELECT * FROM apcs_commands
        WHERE snapshot->>'state' IN ('Accepted', 'Dispatched', 'DeviceAccepted')
          AND (expires_at <= clock_timestamp() OR last_observed_at > clock_timestamp())
        ORDER BY expires_at, id LIMIT $1 FOR UPDATE SKIP LOCKED`, [limit]);
      for (const row of rows.rows) await this.refresh(client, row);
      return rows.rowCount ?? 0;
    });
  }

  async connectionLost(targetSignalId: string): Promise<void> {
    await transaction(this.pool, async (client) => {
      await this.lock(client, ['output', targetSignalId]);
      const result = await client.query<Row>(`SELECT * FROM apcs_commands WHERE target_signal_id = $1
        AND snapshot->>'state' IN ('Accepted', 'Dispatched', 'DeviceAccepted') FOR UPDATE`, [targetSignalId]);
      for (const row of result.rows) {
        const clock = await databaseClock(client);
        const book = this.restore(row, clock);
        book.connectionLost(targetSignalId);
        await this.save(client, row, book.get(row.id), clock);
      }
    });
  }

  private restore(row: Row, clock: Clock): CommandBook {
    const now = clock.wallNow().getTime();
    const book = CommandBook.restore(clock, row.request, row.snapshot, row.expires_at.getTime() - now);
    if (now < row.last_observed_at.getTime()) book.connectionLost(row.request.targetSignalId);
    return book;
  }

  private async refresh(client: PoolClient, row: Row): Promise<CommandSnapshot> {
    const clock = await databaseClock(client);
    const snapshot = this.restore(row, clock).get(row.id);
    await this.save(client, row, snapshot, clock);
    return snapshot;
  }

  private async save(client: PoolClient, row: Row, snapshot: CommandSnapshot, clock: Clock): Promise<void> {
    await client.query('UPDATE apcs_commands SET snapshot = $2, last_observed_at = $3 WHERE id = $1',
      [row.id, snapshot, clock.wallNow()]);
    await this.events(client, snapshot, row.snapshot.history.length);
    if (snapshot.state !== 'Accepted') {
      await client.query("UPDATE apcs_command_outbox SET state = 'closed' WHERE command_id = $1 AND state = 'pending'", [row.id]);
    }
  }

  private async events(client: PoolClient, snapshot: CommandSnapshot, from: number): Promise<void> {
    for (let index = from; index < snapshot.history.length; index++) {
      const event = snapshot.history[index]!;
      await client.query(`INSERT INTO apcs_command_events (command_id, ordinal, state, at, reason)
        VALUES ($1,$2,$3,$4,$5)`, [snapshot.id, index, event.state, event.at, event.reason]);
    }
  }

  private async load(client: PoolClient, id: string): Promise<Row> {
    const result = await client.query<Row>('SELECT * FROM apcs_commands WHERE id = $1 FOR UPDATE', [id]);
    if (!result.rows[0]) throw new Error(`Unknown command: ${id}`);
    return result.rows[0];
  }

  private async lock(client: PoolClient, scope: string[]): Promise<void> {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [JSON.stringify(scope)]);
  }

  private async resolveContext(
    resolve: (request: CommandRequest, signal: AbortSignal) => Promise<CommandContext>, request: CommandRequest,
  ): Promise<CommandContext> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        resolve({ ...request }, controller.signal),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(new Error('Live context timeout'));
            controller.abort();
          }, this.contextTimeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}
