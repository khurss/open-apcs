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
      await client.query('SELECT pg_advisory_xact_lock(9021009)');
      const expired = (await client.query(`SELECT EXISTS(SELECT 1 FROM jsonb_to_recordset($1::jsonb) AS sample("observedAt" timestamptz),apcs_history_retention_boundary b WHERE sample."observedAt"<b.closed_before) AS expired`, [JSON.stringify(rows)])).rows[0].expired;
      if (expired) throw new Error('History sample precedes the closed retention boundary; explicit import is required');
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
    // Preserve whole buckets affected by any admissible late sample, plus their predecessor anchor.
    const rawCutoff = new Date(Math.floor((before.getTime() - 120000) / 3600000) * 3600000 - 120000);
    const client = await this.pool.connect(); let broken = false;
    try {
      await client.query('BEGIN'); await client.query("SET LOCAL statement_timeout='2s'"); await client.query("SET LOCAL lock_timeout='1s'");
      await client.query('SELECT pg_advisory_xact_lock(9021009)');
      await client.query('UPDATE apcs_history_retention_boundary SET closed_before=GREATEST(closed_before,$1)', [before]);
      const result = await client.query(`DELETE FROM apcs_signal_history WHERE ordinal IN (SELECT h.ordinal FROM apcs_signal_history h WHERE h.observed_at<$1
        AND NOT EXISTS(SELECT 1 FROM apcs_history_aggregate_backfill WHERE NOT done)
        AND (h.observed_at<clock_timestamp()-interval '366 days' OR (
          NOT EXISTS(SELECT 1 FROM apcs_history_aggregate_jobs j WHERE j.signal_id=h.signal_id AND j.bucket_start<=h.observed_at+interval '120 seconds' AND j.bucket_start+make_interval(secs=>j.resolution)>=h.observed_at-interval '120 seconds')
          AND (SELECT count(*) FROM apcs_history_aggregates a WHERE a.signal_id=h.signal_id AND a.bucket_start=date_bin(make_interval(secs=>a.resolution),h.observed_at,timestamptz '1970-01-01 00:00:00+00'))=2))
        ORDER BY h.observed_at,h.ordinal LIMIT $2 FOR UPDATE OF h SKIP LOCKED)`, [rawCutoff, limit]);
      await client.query('COMMIT'); return result.rowCount ?? 0;
    } catch (error) { try { await client.query('ROLLBACK'); } catch { broken = true; } throw error; }
    finally { client.release(broken); }
  }
}
