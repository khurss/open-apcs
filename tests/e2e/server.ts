import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createApi } from '../../apps/api/src/app.js';
import { bootstrapAdmin, migrateApplication } from '../../apps/api/src/store.js';

if (process.env.NODE_ENV !== 'test' || !process.env.APCS_TEST_POSTGRES_URL) throw new Error('Isolated E2E fixtures required');
const schema = `e2e_${randomUUID().replaceAll('-', '')}`;
const admin = new Pool({ connectionString: process.env.APCS_TEST_POSTGRES_URL, max: 1 });
await admin.query(`CREATE SCHEMA ${schema}`);
const pool = new Pool({ connectionString: process.env.APCS_TEST_POSTGRES_URL, options: `-c search_path=${schema}`, connectionTimeoutMillis: 2000 });
await migrateApplication(pool);
await bootstrapAdmin(pool, 'operator', 'E2E fixture password only!');
const app = await createApi({ pool, origin: 'http://localhost:5173', secureCookies: false });
await app.listen({ host: '0.0.0.0', port: 3000 });
let stopped = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
  if (stopped) return;
  stopped = true;
  void (async () => {
    await app.close(); await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
  })();
});
