import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { MqttLedSimulator } from '../../packages/gateway/src/mqtt-led.js';
import { LedPeer } from '../../packages/led-protocol/src/index.js';
import { Pool } from 'pg';
import { RuntimeProcess } from '../../apps/api/src/runtime-process.js';
import { createApi } from '../../apps/api/src/app.js';
import { bootstrapAdmin, migrateApplication } from '../../apps/api/src/store.js';

if (process.env.NODE_ENV !== 'test' || !process.env.APCS_TEST_POSTGRES_URL) throw new Error('Isolated E2E fixtures required');
const schema = `e2e_${randomUUID().replaceAll('-', '')}`;
const admin = new Pool({ connectionString: process.env.APCS_TEST_POSTGRES_URL, max: 1 });
await admin.query(`CREATE SCHEMA ${schema}`);
const pool = new Pool({ connectionString: process.env.APCS_TEST_POSTGRES_URL, options: `-c search_path=${schema}`, connectionTimeoutMillis: 2000 });
await migrateApplication(pool);
await bootstrapAdmin(pool, 'operator', 'E2E fixture password only!');
await mkdir('/tmp/apcs-e2e', { recursive: true });
const ca = await readFile(new URL('../../.cache/mqtt-tls-fixture/ca.crt', import.meta.url), 'utf8');
const physicalConfigPath = '/tmp/apcs-e2e/physical.json';
await writeFile(physicalConfigPath, JSON.stringify({ url: 'mqtts://mqtt-tls:8883', username: 'e2e-gateway', password: 'fixture-e2e-gateway-password', ca, devices: [{ siteId: 'tls-e2e', deviceId: 'led', gpio: 18 }] }), { mode: 0o600 });
const simulator = new MqttLedSimulator({ url: 'mqtts://mqtt-tls:8883', siteId: 'tls-e2e', deviceId: 'led', signalId: 'fixture', credentials: { ca, username: 'e2e-device', password: 'fixture-e2e-device-password' } }, new LedPeer(() => performance.now(), randomUUID()));
await simulator.start();
const runtime = new RuntimeProcess({ connectionString: process.env.APCS_TEST_POSTGRES_URL, mqttUrl: process.env.APCS_TEST_MQTT_URL!, databaseOptions: `-c search_path=${schema}`, physicalConfigPath });
const app = await createApi({ pool, origin: 'http://localhost:5173', secureCookies: false, runtime });
await mkdir(new URL('../../.cache/e2e/', import.meta.url), { recursive: true });
await writeFile(new URL('../../.cache/e2e/schema.json', import.meta.url), JSON.stringify({ schema }), { mode: 0o600 });
await app.listen({ host: '0.0.0.0', port: 3000 });
let stopped = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
  if (stopped) return;
  stopped = true;
  void (async () => {
    await app.close(); await simulator.stop(); await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
  })();
});
