import type { Pool, PoolClient } from 'pg';
import { aggregateHistory, type HistoryAggregate } from '../../domain/src/history-aggregate.js';
import type { ArchivedSample } from '../../domain/src/history.js';
export interface AggregatePage { items: Array<{ bucketStart: string; calculatedAt: string; aggregate: HistoryAggregate; stale: boolean }>; nextBefore: string | null; }
export class PgHistoryAggregates {
  constructor(private readonly pool: Pool) {}
  private async atomic<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect(); let broken = false;
    try { await client.query('BEGIN'); await client.query("SET LOCAL statement_timeout='5s'"); await client.query("SET LOCAL lock_timeout='1s'"); const result = await work(client); await client.query('COMMIT'); return result; }
    catch (error) { try { await client.query('ROLLBACK'); } catch { broken = true; } throw error; }
    finally { client.release(broken); }
  }
  async processNext(now = new Date()): Promise<'idle' | 'written' | 'blocked'> {
    if (!Number.isFinite(now.getTime())) throw new Error('Invalid aggregate clock');
    return this.atomic(async (client) => {
      const job = (await client.query(`SELECT j.signal_id,j.resolution,j.bucket_start,s.data_type FROM apcs_history_aggregate_jobs j JOIN apcs_signals s ON s.id=j.signal_id
        WHERE j.bucket_start+make_interval(secs=>j.resolution+120)<=$1 AND j.retry_at<=$1
        ORDER BY j.bucket_start,j.signal_id,j.resolution LIMIT 1 FOR UPDATE OF j SKIP LOCKED`, [now])).rows[0];
      if (!job) return 'idle';
      const from = (job.bucket_start as Date).toISOString(); const to = new Date(job.bucket_start.getTime() + job.resolution * 1000).toISOString();
      const rows = (await client.query<{ id: string; observedAt: Date; snapshot: ArchivedSample['snapshot'] }>(`WITH interior AS (
        SELECT ordinal,observed_at,snapshot FROM apcs_signal_history WHERE signal_id=$1 AND observed_at>=$2 AND observed_at<$3 ORDER BY observed_at,ordinal LIMIT 10001),
        preceding AS (SELECT ordinal,observed_at,snapshot FROM apcs_signal_history WHERE signal_id=$1 AND observed_at<$2 ORDER BY observed_at DESC,ordinal DESC LIMIT 1),
        following AS (SELECT ordinal,observed_at,snapshot FROM apcs_signal_history WHERE signal_id=$1 AND observed_at>=$3 ORDER BY observed_at,ordinal LIMIT 1)
        SELECT ordinal::text AS id,observed_at AS "observedAt",snapshot FROM (SELECT * FROM interior UNION ALL SELECT * FROM preceding UNION ALL SELECT * FROM following) samples ORDER BY observed_at,ordinal`, [job.signal_id, from, to])).rows;
      const key = [job.signal_id, job.resolution, from];
      const interior = rows.filter((row) => row.observedAt.getTime() >= Date.parse(from) && row.observedAt.getTime() < Date.parse(to)).length;
      if (interior > 10000) {
        await client.query("UPDATE apcs_history_aggregate_jobs SET retry_at=$4::timestamptz+interval '1 minute',last_error='Aggregate sample limit exceeded' WHERE signal_id=$1 AND resolution=$2 AND bucket_start=$3", [...key, now]);
        return 'blocked';
      }
      let aggregate: HistoryAggregate;
      try { aggregate = aggregateHistory(rows.map((row) => ({ ...row, observedAt: row.observedAt.toISOString() })), { from, to, profile: job.data_type === 'boolean' ? 'digital' : job.data_type === 'float64' ? 'analog' : 'exact' }); }
      catch { await client.query("UPDATE apcs_history_aggregate_jobs SET retry_at=$4::timestamptz+interval '1 minute',last_error='Aggregate source validation failed' WHERE signal_id=$1 AND resolution=$2 AND bucket_start=$3", [...key, now]); return 'blocked'; }
      await client.query(`INSERT INTO apcs_history_aggregates(signal_id,resolution,bucket_start,aggregate) VALUES($1,$2,$3,$4)
        ON CONFLICT(signal_id,resolution,bucket_start) DO UPDATE SET aggregate=$4,calculated_at=clock_timestamp()`, [...key, aggregate]);
      await client.query('DELETE FROM apcs_history_aggregate_jobs WHERE signal_id=$1 AND resolution=$2 AND bucket_start=$3', key);
      return 'written';
    });
  }
  async prune(now = new Date()): Promise<{ aggregates: number; jobs: number }> {
    if (!Number.isFinite(now.getTime())) throw new Error('Invalid aggregate clock');
    return this.atomic(async (client) => {
      const cutoff = new Date(now.getTime() - 365 * 86400000);
      const aggregates = await client.query(`DELETE FROM apcs_history_aggregates WHERE (signal_id,resolution,bucket_start) IN
        (SELECT signal_id,resolution,bucket_start FROM apcs_history_aggregates WHERE bucket_start+make_interval(secs=>resolution)<$1 ORDER BY bucket_start LIMIT 1000 FOR UPDATE SKIP LOCKED)`, [cutoff]);
      const jobs = await client.query(`DELETE FROM apcs_history_aggregate_jobs WHERE (signal_id,resolution,bucket_start) IN
        (SELECT signal_id,resolution,bucket_start FROM apcs_history_aggregate_jobs WHERE bucket_start+make_interval(secs=>resolution)<$1 ORDER BY bucket_start LIMIT 1000 FOR UPDATE SKIP LOCKED)`, [cutoff]);
      return { aggregates: aggregates.rowCount ?? 0, jobs: jobs.rowCount ?? 0 };
    });
  }
  /** Only records present when the insert trigger was installed need this bounded scan. */
  async backfill(): Promise<boolean> {
    return this.atomic(async (client) => {
      const state = (await client.query('SELECT * FROM apcs_history_aggregate_backfill WHERE NOT done FOR UPDATE SKIP LOCKED')).rows[0];
      if (!state) return false;
      const rows = (await client.query('SELECT ordinal,signal_id,observed_at FROM apcs_signal_history WHERE ordinal>$1 AND ordinal<=$2 ORDER BY ordinal LIMIT 1000', [state.cursor_ordinal, state.through_ordinal])).rows;
      if (rows.length) await client.query('SELECT apcs_queue_history_aggregates($1::uuid[],$2::timestamptz[])', [rows.map((row) => row.signal_id), rows.map((row) => row.observed_at)]);
      await client.query('UPDATE apcs_history_aggregate_backfill SET cursor_ordinal=$1,done=$2', [rows.at(-1)?.ordinal ?? state.through_ordinal, rows.length < 1000]);
      return rows.length > 0;
    });
  }
  async read(signalId: string, query: { from: string; to: string; resolution: 60 | 3600; limit?: number; before?: string }): Promise<AggregatePage> {
    const from = Date.parse(query.from); const to = Date.parse(query.to); const limit = query.limit ?? 100;
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from || to - from > 365 * 86400000 || ![60, 3600].includes(query.resolution)) throw new Error('Aggregate range must be ordered and at most 365 days');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000 || (query.before && !Number.isFinite(Date.parse(query.before)))) throw new Error('Invalid aggregate page');
    const rows = (await this.pool.query(`SELECT a.bucket_start AS "bucketStart",a.calculated_at AS "calculatedAt",a.aggregate,
      EXISTS(SELECT 1 FROM apcs_history_aggregate_jobs j WHERE j.signal_id=a.signal_id AND j.resolution=a.resolution AND j.bucket_start=a.bucket_start) AS stale
      FROM apcs_history_aggregates a WHERE a.signal_id=$1 AND a.resolution=$2 AND a.bucket_start>=$3 AND a.bucket_start<$4 AND ($5::timestamptz IS NULL OR a.bucket_start<$5)
      ORDER BY a.bucket_start DESC LIMIT $6`, [signalId, query.resolution, query.from, query.to, query.before ?? null, limit + 1])).rows;
    const items = rows.slice(0, limit).map((row) => ({ ...row, bucketStart: row.bucketStart.toISOString(), calculatedAt: row.calculatedAt.toISOString() })) as AggregatePage['items'];
    return { items, nextBefore: rows.length > limit ? items.at(-1)!.bucketStart : null };
  }
}
