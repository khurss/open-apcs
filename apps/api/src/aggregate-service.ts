import type { Pool, PoolClient } from 'pg';
import { PgHistoryAggregates } from '../../../packages/storage/src/history-aggregates.js';
import { PgSignalArchive } from '../../../packages/storage/src/signal-archive.js';
export class AggregateService {
  private owner: PoolClient | undefined;
  private readonly aggregates: PgHistoryAggregates;
  private readonly archive: PgSignalArchive;
  private closed = false; private failed = false; private started = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private work: Promise<void> = Promise.resolve();
  private maintenanceAt = -Infinity;
  constructor(private readonly pool: Pool, private readonly now: () => Date = () => new Date(), private readonly onFault?: () => void) { this.aggregates = new PgHistoryAggregates(pool); this.archive = new PgSignalArchive(pool); }
  async start(): Promise<void> {
    if (this.started || this.closed) throw new Error('Aggregate service cannot be restarted');
    const owner = await this.pool.connect(); let acquired = false;
    try {
      acquired = (await owner.query('SELECT pg_try_advisory_lock(hashtext(current_schema()),9021010) AS acquired')).rows[0].acquired;
      if (!acquired) throw new Error('Aggregate owner already exists');
      this.owner = owner; owner.on('error', this.fault); await this.heartbeat('running'); this.started = true; this.schedule(0);
    } catch (error) {
      owner.removeListener('error', this.fault); this.owner = undefined;
      if (acquired) { try { await owner.query('SELECT pg_advisory_unlock(hashtext(current_schema()),9021010)'); } catch {} }
      owner.release(true); throw error;
    }
  }
  private readonly fault = () => { this.failed = true; clearTimeout(this.timer); this.onFault?.(); };
  private async heartbeat(state: 'running' | 'stopped') {
    await this.owner!.query(`INSERT INTO apcs_history_aggregate_service(singleton,heartbeat_at,state,last_error) VALUES(true,clock_timestamp(),$1,NULL)
      ON CONFLICT(singleton) DO UPDATE SET heartbeat_at=clock_timestamp(),state=$1,last_error=NULL`, [state]);
  }
  private schedule(delay = 250) { if (!this.closed && !this.failed) this.timer = setTimeout(() => { this.work = this.cycle(); }, delay); }
  private async cycle() {
    try {
      await this.heartbeat('running'); await this.aggregates.backfill();
      for (let i = 0; i < 4 && !this.closed && !this.failed; i++) if (await this.aggregates.processNext(this.now()) === 'idle') break;
      if (!this.closed && !this.failed && performance.now() - this.maintenanceAt >= 60000) {
        this.maintenanceAt = performance.now(); await this.aggregates.prune(this.now());
        const cutoff = new Date(this.now().getTime() - 7 * 86400000); const deadline = performance.now() + 1000;
        for (let i = 0; i < 10 && !this.closed && !this.failed && performance.now() < deadline; i++) if (await this.archive.prune(cutoff) < 1000) break;
      }
      if (!this.closed && !this.failed) await this.heartbeat('running');
    } catch { this.fault(); }
    finally { this.schedule(); }
  }
  async close(): Promise<void> {
    if (this.closed) return; this.closed = true; clearTimeout(this.timer); await this.work;
    if (this.owner) {
      const owner = this.owner;
      try { await this.heartbeat('stopped'); await owner.query('SELECT pg_advisory_unlock(hashtext(current_schema()),9021010)'); }
      catch {} finally { owner.removeListener('error', this.fault); owner.release(true); this.owner = undefined; }
    }
  }
}
