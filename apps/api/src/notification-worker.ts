import { Pool } from 'pg';
import { loadNotificationConfig } from './notification-file.js';
import { NotificationService } from './notification-service.js';
import { migrateApplication } from './store.js';
const pool = new Pool({ connectionString: process.env.APCS_POSTGRES_URL, options: process.env.APCS_DB_OPTIONS ?? '', max: 3, connectionTimeoutMillis: 2000, query_timeout: 6000 });
let service: NotificationService | undefined; let closing = false;
async function stop(failed = false) {
  if (closing) return; closing = true;
  const deadline = setTimeout(() => process.exit(1), 10000); deadline.unref();
  await service?.close(); await pool.end(); clearTimeout(deadline);
  if (process.connected) process.disconnect(); process.exitCode = failed ? 1 : 0;
}
process.once('SIGTERM', () => { void stop(); }); process.once('SIGINT', () => { void stop(); }); process.once('disconnect', () => { void stop(); });
try {
  if (!process.env.APCS_POSTGRES_URL || !process.env.APCS_NOTIFICATIONS_CONFIG) throw new Error('Configuration required');
  const config = await loadNotificationConfig(process.env.APCS_NOTIFICATIONS_CONFIG); await migrateApplication(pool);
  service = new NotificationService(pool, config.routes, () => { void stop(true); }); await service.start();
} catch { console.error(JSON.stringify({ level: 'error', event: 'notifications.startup_failed' })); await stop(true); }
