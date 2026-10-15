import {mqttProxy} from '../helpers/mqtt-proxy.js';
import type {AiProvider} from '../../apps/api/src/ai-provider.js';
import { ReportProcess } from '../../apps/api/src/report-process.js';
import { AggregateProcess } from '../../apps/api/src/aggregate-process.js';
import { createServer } from 'node:http';
import { NotificationProcess } from '../../apps/api/src/notification-process.js';
import { ScriptClient } from '../../packages/script-runtime/src/client.js';
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
await writeFile(physicalConfigPath, JSON.stringify({ url: 'mqtts://mqtt-tls:8883', username: 'e2e-gateway', password: 'fixture-e2e-gateway-password', ca, devices: ['led', 'recovery'].map(deviceId => ({ siteId: 'tls-e2e', deviceId, gpio: 18 })) }), { mode: 0o600 });
const simulators = ['led', 'recovery'].map(deviceId => new MqttLedSimulator({ url: 'mqtts://mqtt-tls:8883', siteId: 'tls-e2e', deviceId, signalId: 'fixture', credentials: { ca, username: 'e2e-device', password: 'fixture-e2e-device-password' } }, new LedPeer(() => performance.now(), randomUUID())));
for (const simulator of simulators) await simulator.start();
const proxy=await mqttProxy(process.env.APCS_TEST_MQTT_URL!);
const faults=createServer((request,response)=>{if(request.method==='POST'&&request.url==='/mqtt/disconnect'){proxy.disconnect();response.writeHead(204).end();}else response.writeHead(404).end();});
await new Promise<void>(resolve=>faults.listen(3001,'0.0.0.0',resolve));
const runtime = new RuntimeProcess({ connectionString: process.env.APCS_TEST_POSTGRES_URL, mqttUrl: proxy.url, databaseOptions: `-c search_path=${schema}`, physicalConfigPath, scriptUrl: process.env.APCS_SCRIPT_URL! });
// No external model calls or credentials in browser acceptance.
const ai:AiProvider={model:'fixture-model',async generate(context){return {name:'Fixture proposal',summary:'Review this local deterministic fixture before saving.',document:JSON.stringify(context.kind==='graph'?{schemaVersion:1,nodes:[{id:'ai-constant',kind:'constant',label:'AI constant',value:false,x:80,y:80}],edges:[]}:{schemaVersion:1,width:1000,height:600,items:[{id:'ai-title',kind:'label',label:'AI overview',x:40,y:40,width:700,height:100}]})};}};
const app = await createApi({ pool, recipesEnabled: true, ai, reportsEnabled: true, origin: 'http://localhost:5173', secureCookies: false, runtime, scripts: new ScriptClient(process.env.APCS_SCRIPT_URL!) });
runtime.enableMonitoring();
await mkdir(new URL('../../.cache/e2e/', import.meta.url), { recursive: true });
await writeFile(new URL('../../.cache/e2e/schema.json', import.meta.url), JSON.stringify({ schema }), { mode: 0o600 });
// Isolated local recipient: reject the first delivery per project so scenarios stay independent.
const deliveries = new Map<string, number>();
const recipient = createServer((request, response) => {
  request.setEncoding('utf8'); let body = '';
  request.on('data', (chunk: string) => { body += chunk; if (body.length > 16384) request.destroy(); });
  request.on('end', () => {
    try {
      const { projectId } = JSON.parse(body) as { projectId?: unknown };
      if (typeof projectId !== 'string') throw new Error('Fixture project missing');
      const count = (deliveries.get(projectId) ?? 0) + 1; deliveries.set(projectId, count);
      response.writeHead(count === 1 ? 400 : 204).end();
    } catch { response.writeHead(400).end(); }
  });
});
await new Promise<void>((resolve) => recipient.listen(0, '127.0.0.1', resolve));
const recipientAddress = recipient.address(); if (!recipientAddress || typeof recipientAddress === 'string') throw new Error('Fixture listener required');
const notificationConfigPath = '/tmp/apcs-e2e/notifications.json';
await writeFile(notificationConfigPath, JSON.stringify({ version: 1, routes: [{ id: 'fixture', name: 'Local test receiver', kind: 'webhook', url: `http://127.0.0.1:${recipientAddress.port}/events`, secret: 'fixture-only-signing-secret-at-least-32', allowInsecure: true, priorities: ['low', 'medium', 'high'], events: ['Activated', 'Returned'], projectIds: [] }] }), { mode: 0o600 });
const notifications = new NotificationProcess({ connectionString: process.env.APCS_TEST_POSTGRES_URL, databaseOptions: `-c search_path=${schema}`, configPath: notificationConfigPath });
const reports = new ReportProcess({ connectionString: process.env.APCS_TEST_POSTGRES_URL, databaseOptions: `-c search_path=${schema}`, rendererUrl: process.env.APCS_REPORT_URL! });
const aggregates = new AggregateProcess({ connectionString: process.env.APCS_TEST_POSTGRES_URL, databaseOptions: `-c search_path=${schema}` });
await app.listen({ host: '0.0.0.0', port: 3000 });
let stopped = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
  if (stopped) return;
  stopped = true;
  void (async () => {
    await reports.close(); await aggregates.close(); await notifications.close(); recipient.closeAllConnections(); await new Promise<void>((resolve) => recipient.close(() => resolve()));
    await app.close();faults.closeAllConnections();await new Promise<void>(resolve=>faults.close(()=>resolve()));await proxy.close(); await Promise.all(simulators.map(simulator => simulator.stop())); await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
  })();
});
