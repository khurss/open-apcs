import type { Pool, PoolClient } from 'pg';
import { parseNotificationConfig, routeFingerprint, type NotificationRoute } from '../../../packages/notifications/src/config.js';
import { deliverNotification, DeliveryError } from '../../../packages/notifications/src/transport.js';
import { claimNotification, finishNotification, pruneNotifications, syncNotificationRoutes } from './notification-store.js';
/** One private process owns configuration; database leases retain attempts across crashes. */
export class NotificationService {
  private owner: PoolClient | undefined;
  private routes: NotificationRoute[];
  private controller = new AbortController();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private work: Promise<void> = Promise.resolve();
  private closed = false;
  private started = false;
  private pruneAt = -Infinity;
  constructor(private readonly pool: Pool, routes: NotificationRoute[], private readonly onFault?: () => void) { this.routes = parseNotificationConfig({ version: 1, routes }).routes; }
  async start(): Promise<void> {
    if (this.closed || this.started) throw new Error('Notification service cannot be restarted');
    const owner = await this.pool.connect(); let acquired = false;
    try {
      acquired = (await owner.query('SELECT pg_try_advisory_lock(hashtext(current_schema()),9021008) AS acquired')).rows[0].acquired;
      if (!acquired) throw new Error('Notification owner already exists');
      this.owner = owner; owner.on('error', this.fault);
      await syncNotificationRoutes(this.pool, this.routes);
      await this.heartbeat('running'); this.started = true; this.schedule(0);
    } catch (error) {
      owner.removeListener('error', this.fault); this.owner = undefined;
      if (acquired) { try { await owner.query('SELECT pg_advisory_unlock(hashtext(current_schema()),9021008)'); } catch {} }
      owner.release(true); throw error;
    }
  }
  private readonly fault = () => { this.controller.abort(); clearTimeout(this.timer); this.onFault?.(); };
  private async heartbeat(state: 'running' | 'stopped' | 'faulted') {
    await this.owner!.query(`INSERT INTO apcs_notification_service(singleton,heartbeat_at,state) VALUES(true,clock_timestamp(),$1)
      ON CONFLICT(singleton) DO UPDATE SET heartbeat_at=clock_timestamp(),state=$1`, [state]);
  }
  private schedule(delay = 1000) { if (!this.closed && !this.controller.signal.aborted) this.timer = setTimeout(() => { this.work = this.cycle(); }, delay); }
  private async cycle() {
    try {
      await this.heartbeat('running');
      if (performance.now() - this.pruneAt >= 60000) { await pruneNotifications(this.pool); this.pruneAt = performance.now(); }
      if (this.controller.signal.aborted) return;
      const job = await claimNotification(this.pool);
      if (job) {
        const route = this.routes.find((route) => route.id === job.routeId && routeFingerprint(route) === job.fingerprint);
        let failure: { retryable: boolean; message: string } | undefined;
        try {
          if (!route) throw new DeliveryError('Destination configuration unavailable', false);
          await deliverNotification(route, job, { signal: this.controller.signal });
        } catch (error) { failure = { retryable: error instanceof DeliveryError && error.retryable, message: 'Delivery failed' }; }
        // Database completion failures leave an unknown attempt for lease recovery.
        if (!this.controller.signal.aborted) await finishNotification(this.pool, job, failure);
      }
      if (!this.controller.signal.aborted) await this.heartbeat('running');
    } catch { this.fault(); }
    finally { this.schedule(); }
  }
  async close(): Promise<void> {
    if (this.closed) return; this.closed = true; this.controller.abort(); clearTimeout(this.timer); await this.work;
    if (this.owner) {
      const owner = this.owner;
      try { await this.heartbeat('stopped'); await owner.query('SELECT pg_advisory_unlock(hashtext(current_schema()),9021008)'); }
      catch {} finally { owner.removeListener('error', this.fault); owner.release(true); this.owner = undefined; }
    }
  }
}
