import { Pool } from 'pg';
import { ReportService } from './report-service.js';
import { ReportClient } from '../../../packages/report-renderer/src/client.js';
import { migrateApplication } from './store.js';
const pool = new Pool({ connectionString: process.env.APCS_POSTGRES_URL, options: process.env.APCS_DB_OPTIONS ?? '', max: 3, connectionTimeoutMillis: 2000, query_timeout: 6000 });
let service: ReportService | undefined; let closing = false;
async function stop(failed = false) {
  if (closing) return; closing = true;
  const deadline = setTimeout(() => process.exit(1), 18000); deadline.unref();
  await service?.close(); await pool.end(); clearTimeout(deadline);
  if (process.connected) process.disconnect(); process.exitCode = failed ? 1 : 0;
}
pool.on('error', () => { void stop(true); });
process.once('SIGTERM', () => { void stop(); }); process.once('SIGINT', () => { void stop(); }); process.once('disconnect', () => { void stop(); });
try {
  if (!process.env.APCS_POSTGRES_URL || !process.env.APCS_REPORT_URL) throw new Error('Database configuration required');
  await migrateApplication(pool); const renderer = new ReportClient(process.env.APCS_REPORT_URL!); service = new ReportService(pool, (data) => renderer.render(data)); service.start();
} catch { console.error(JSON.stringify({ level: 'error', event: 'reports.startup_failed' })); await stop(true); }
