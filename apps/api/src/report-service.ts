import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { reportCsv, reportRange, summarizeReport, type ReportBucket, type SignalReport } from '../../../packages/domain/src/history-report.js';
import { transaction } from './store.js';
import { pruneReports } from './report-api.js';
interface Job { id: string; actor_id: string; signal_id: string; period: 'day' | 'month'; date: string; lease_token: string; }
export class ReportService {
  private stopped = false; private timer: ReturnType<typeof setTimeout> | undefined; private work: Promise<unknown> = Promise.resolve();
  constructor(private readonly pool: Pool, private readonly render: (report: SignalReport) => Promise<Buffer>) {}
  start() { if (this.timer || this.stopped) throw new Error('Report service already started or closed'); this.schedule(); }
  private schedule() { if (!this.stopped) this.timer = setTimeout(() => { this.work = this.processNext().catch(() => {}).finally(() => this.schedule()); }, 500); }
  async close() { this.stopped = true; clearTimeout(this.timer); await this.work; }
  async prune() { await pruneReports(this.pool); }
  async processNext(): Promise<boolean> {
    const job = await transaction(this.pool, async (client) => {
      await client.query("UPDATE apcs_report_jobs SET state='Failed',error='Report generation interrupted',completed_at=clock_timestamp(),lease_until=NULL,lease_token=NULL WHERE state='Generating' AND lease_until<clock_timestamp()");
      const row = (await client.query<Job>("SELECT * FROM apcs_report_jobs WHERE state='Queued' ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED")).rows[0];
      if (!row) return undefined;
      const token = randomUUID(); await client.query("UPDATE apcs_report_jobs SET state='Generating',lease_until=clock_timestamp()+interval '30 seconds',lease_token=$2 WHERE id=$1", [row.id, token]);
      return { ...row, lease_token: token };
    });
    if (!job) { await this.prune(); return false; }
    try {
      const data = await this.snapshot(job); const csv = reportCsv(data); const pdf = await this.render(data);
      if (pdf.length < 16 || pdf.length > 2097152 || !pdf.subarray(0, 5).equals(Buffer.from('%PDF-')) || Buffer.byteLength(csv) > 524288 || Buffer.byteLength(JSON.stringify(data)) > 524288) throw new Error('Invalid report artifact');
      await this.pool.query("UPDATE apcs_report_jobs SET state='Ready',report=$3,pdf=$4,csv=$5,completed_at=clock_timestamp(),lease_until=NULL,lease_token=NULL WHERE id=$1 AND state='Generating' AND lease_token=$2 AND lease_until>clock_timestamp()", [job.id, job.lease_token, data, pdf, csv]);
    } catch {
      await this.pool.query("UPDATE apcs_report_jobs SET state='Failed',error='Report generation failed',completed_at=clock_timestamp(),lease_until=NULL,lease_token=NULL WHERE id=$1 AND state='Generating' AND lease_token=$2 AND lease_until>clock_timestamp()", [job.id, job.lease_token]);
    }
    return true;
  }
  private async snapshot(job: Job): Promise<SignalReport> {
    return transaction(this.pool, async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
      const signal = (await client.query<{ id: string; name: string; dataType: string;unit:string;displayDecimals:number;revision:number }>('SELECT s.id,s.name,s.data_type AS "dataType",s.unit,s.display_decimals AS "displayDecimals",s.revision FROM apcs_signals s JOIN apcs_devices d ON d.id=s.device_id JOIN apcs_projects p ON p.id=d.project_id WHERE s.id=$1 AND p.owner_id=$2', [job.signal_id, job.actor_id])).rows[0];
      if (!signal || !['boolean', 'float64'].includes(signal.dataType)) throw new Error('Report signal unavailable');
      const range = reportRange(job.period, job.date);
      const rows = (await client.query(`WITH buckets AS (
        SELECT a.bucket_start,a.calculated_at,a.aggregate,EXISTS(SELECT 1 FROM apcs_history_aggregate_jobs j WHERE j.signal_id=a.signal_id AND j.resolution=a.resolution AND j.bucket_start=a.bucket_start) AS stale
        FROM apcs_history_aggregates a WHERE a.signal_id=$1 AND a.resolution=3600 AND a.bucket_start>=$2 AND a.bucket_start<$3
        UNION ALL SELECT j.bucket_start,NULL,NULL,true FROM apcs_history_aggregate_jobs j WHERE j.signal_id=$1 AND j.resolution=3600 AND j.bucket_start>=$2 AND j.bucket_start<$3
        AND NOT EXISTS(SELECT 1 FROM apcs_history_aggregates a WHERE a.signal_id=j.signal_id AND a.resolution=j.resolution AND a.bucket_start=j.bucket_start))
        SELECT * FROM buckets ORDER BY bucket_start LIMIT 745`, [job.signal_id, range.from, range.to])).rows;
      const buckets: ReportBucket[] = rows.map((row) => ({ bucketStart: row.bucket_start.toISOString(), calculatedAt: row.calculated_at?.toISOString() ?? null, aggregate: row.aggregate, stale: row.stale }));
      return { ...summarizeReport(job.period, job.date, signal.dataType === 'boolean' ? 'digital' : 'analog', buckets), templateVersion:2, id: job.id, generatedAt: new Date().toISOString(), signal };
    });
  }
}
