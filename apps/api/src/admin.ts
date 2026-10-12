import { Pool } from 'pg';
import { bootstrapAdmin, migrateApplication } from './store.js';

const username = process.argv[2];
if (!username || !process.env.APCS_POSTGRES_URL) throw new Error('Username argument and APCS_POSTGRES_URL are required');
let input = '';
for await (const chunk of process.stdin) {
  input += String(chunk);
  if (Buffer.byteLength(input) > 1024) throw new Error('Password input is too large');
}
const password = input.replace(/\r?\n$/, '');
const pool = new Pool({ connectionString: process.env.APCS_POSTGRES_URL, connectionTimeoutMillis: 2000, query_timeout: 6000 });
try {
  await migrateApplication(pool);
  await bootstrapAdmin(pool, username, password);
  console.log('Administrator created.');
} catch {
  console.error('Administrator creation failed. Check username, password policy, database access, and whether an administrator already exists.');
  process.exitCode = 1;
} finally { await pool.end(); }
