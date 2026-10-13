import { ReportProcess } from './report-process.js';
import { AggregateProcess } from './aggregate-process.js';
import { NotificationProcess } from './notification-process.js';
import { syncNotificationRoutes } from './notification-store.js';
import { ScriptClient } from '../../../packages/script-runtime/src/client.js';
import { Pool } from 'pg';
import { createApi } from './app.js';
import { RuntimeProcess } from './runtime-process.js';

const connectionString = process.env.APCS_POSTGRES_URL;
if (!connectionString) throw new Error('APCS_POSTGRES_URL is required');
const pool = new Pool({ connectionString, max: 10, connectionTimeoutMillis: 2000, query_timeout: 6000 });
const origin = process.env.APCS_ORIGIN ?? 'http://localhost:5173';
const scripts = process.env.APCS_SCRIPT_URL ? new ScriptClient(process.env.APCS_SCRIPT_URL) : undefined;
const runtime = process.env.APCS_MQTT_URL ? new RuntimeProcess({ connectionString, ...(process.env.APCS_SCRIPT_URL ? { scriptUrl: process.env.APCS_SCRIPT_URL } : {}), mqttUrl: process.env.APCS_MQTT_URL, ...(process.env.APCS_PHYSICAL_CONFIG ? { physicalConfigPath: process.env.APCS_PHYSICAL_CONFIG } : {}) }) : undefined;
const app = await createApi({ pool, reportsEnabled: Boolean(process.env.APCS_REPORT_URL), origin, ...(scripts ? { scripts } : {}), secureCookies: origin.startsWith('https://'), ...(runtime ? { runtime } : {}) });
runtime?.enableMonitoring();
const notifications = process.env.APCS_NOTIFICATIONS_CONFIG ? new NotificationProcess({ connectionString, configPath: process.env.APCS_NOTIFICATIONS_CONFIG }) : undefined;
if (!notifications) await syncNotificationRoutes(pool, []);
const reports = process.env.APCS_REPORT_URL ? new ReportProcess({ connectionString, rendererUrl: process.env.APCS_REPORT_URL }) : undefined;
const aggregates = new AggregateProcess({ connectionString });
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await reports?.close(); await aggregates.close(); await notifications?.close(); await app.close(); await pool.end();
};
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => { void stop(); });
try {
  await app.listen({ host: '0.0.0.0', port: Number(process.env.API_PORT ?? 3000) });
  console.log(JSON.stringify({ level: 'info', event: 'api.listening', port: Number(process.env.API_PORT ?? 3000) }));
} catch {
  console.error(JSON.stringify({ level: 'error', event: 'api.startup_failed' }));
  await stop(); process.exitCode = 1;
}
