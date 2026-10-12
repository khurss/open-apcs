import { Pool } from 'pg';
import { createApi } from './app.js';
import { RuntimeProcess } from './runtime-process.js';

const connectionString = process.env.APCS_POSTGRES_URL;
if (!connectionString) throw new Error('APCS_POSTGRES_URL is required');
const pool = new Pool({ connectionString, max: 10, connectionTimeoutMillis: 2000, query_timeout: 6000 });
const origin = process.env.APCS_ORIGIN ?? 'http://localhost:5173';
const runtime = process.env.APCS_MQTT_URL ? new RuntimeProcess({ connectionString, mqttUrl: process.env.APCS_MQTT_URL }) : undefined;
const app = await createApi({ pool, origin, secureCookies: origin.startsWith('https://'), ...(runtime ? { runtime } : {}) });
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await app.close(); await pool.end();
};
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => { void stop(); });
try {
  await app.listen({ host: '0.0.0.0', port: Number(process.env.API_PORT ?? 3000) });
  console.log(JSON.stringify({ level: 'info', event: 'api.listening', port: Number(process.env.API_PORT ?? 3000) }));
} catch {
  console.error(JSON.stringify({ level: 'error', event: 'api.startup_failed' }));
  await stop(); process.exitCode = 1;
}
