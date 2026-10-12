import type { Pool } from 'pg';
import type { HistoryRow, HistoryPage, HistoryQuery } from '../../domain/src/history.js';
import type { SignalSnapshot } from '../../domain/src/signals.js';
export class PgSignalArchive {
  constructor(private readonly pool: Pool) {}
  async append(rows: HistoryRow[]): Promise<void> {
    if (!rows.length) return;
    if (rows.length > 1000 || new Set(rows.map((row) => row.eventId)).size !== rows.length) throw new Error('Invalid history batch');
    const client = await this.pool.connect(); let broken = false;
    try {
      await client.query('BEGIN'); await client.query("SET LOCAL statement_timeout='2s'"); await client.query("SET LOCAL lock_timeout='1s'");
      const result = await client.query(`INSERT INTO apcs_signal_history(event_id,signal_id,observed_at,snapshot)
        SELECT "eventId","signalId"::uuid,"observedAt"::timestamptz,snapshot FROM jsonb_to_recordset($1::jsonb) AS point("eventId" text,"signalId" text,"observedAt" text,snapshot jsonb)
        ON CONFLICT(event_id) DO UPDATE SET event_id=EXCLUDED.event_id
        WHERE apcs_signal_history.signal_id=EXCLUDED.signal_id AND apcs_signal_history.observed_at=EXCLUDED.observed_at AND apcs_signal_history.snapshot=EXCLUDED.snapshot RETURNING ordinal`, [JSON.stringify(rows)]);
      if (result.rowCount !== rows.length) throw new Error('History event identity conflict');
      await client.query('COMMIT');
    } catch (error) { try { await client.query('ROLLBACK'); } catch { broken = true; } throw error; }
    finally { client.release(broken); }
  }
  async read(signalId: string, query: HistoryQuery): Promise<HistoryPage> {
    const from = Date.parse(query.from); const to = Date.parse(query.to); const limit = query.limit ?? 100;
    if (!Number.isFinite(from) || !Number.isFinite(to) || from > to || to - from > 7 * 86400000) throw new Error('History range must be ordered and at most seven days');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('History limit must be from 1 to 1000');
    if (query.before && (!/^[1-9][0-9]{0,17}$/.test(query.before) || !(await this.pool.query('SELECT 1 FROM apcs_signal_history WHERE ordinal=$1 AND signal_id=$2', [query.before, signalId])).rowCount)) throw new Error('Invalid history cursor');
    const result = await this.pool.query<{ id: string; observedAt: Date; snapshot: SignalSnapshot }>(`SELECT ordinal::text AS id,observed_at AS "observedAt",snapshot FROM apcs_signal_history WHERE signal_id=$1 AND observed_at >= $2 AND observed_at <= $3
      AND ($4::bigint IS NULL OR (observed_at,ordinal) < (SELECT observed_at,ordinal FROM apcs_signal_history WHERE ordinal=$4)) ORDER BY observed_at DESC,ordinal DESC LIMIT $5`, [signalId, query.from, query.to, query.before ?? null, limit + 1]);
    return { items: result.rows.slice(0, limit).map((row) => ({ ...row, observedAt: row.observedAt.toISOString() })), nextBefore: result.rows.length > limit ? result.rows[limit - 1]!.id : null };
  }
  async prune(before: Date, limit = 1000): Promise<number> {
    if (!Number.isFinite(before.getTime()) || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('Invalid history retention batch');
    const result = await this.pool.query('DELETE FROM apcs_signal_history WHERE ordinal IN (SELECT ordinal FROM apcs_signal_history WHERE observed_at < $1 ORDER BY observed_at,ordinal LIMIT $2 FOR UPDATE SKIP LOCKED)', [before, limit]);
    return result.rowCount ?? 0;
  }
}
