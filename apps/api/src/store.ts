import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Pool, PoolClient } from 'pg';
import { hashPassword } from './security.js';

export async function transaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect(); let broken = false;
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout = '5s'");
    await client.query("SET LOCAL lock_timeout = '2s'");
    const result = await work(client); await client.query('COMMIT'); return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { broken = true; }
    throw error;
  } finally { client.release(broken); }
}

export async function audit(client: PoolClient, actorId: string | null, action: string, resourceId: string | null, data: unknown = {}): Promise<void> {
  await client.query('INSERT INTO apcs_audit (actor_id, action, resource_id, data) VALUES ($1,$2,$3,$4)', [actorId, action, resourceId, data]);
}

export async function migrateApplication(pool: Pool): Promise<void> {
  const migrations = await Promise.all(['001-application.sql', '002-editors.sql', '003-signal-history.sql', '004-alarms.sql', '005-notifications.sql', '006-notification-service.sql'].map(async (name, index) => {
    const sql = await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8');
    return { version: index + 1, sql, checksum: createHash('sha256').update(sql).digest('hex') };
  }));
  await transaction(pool, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(9021002)');
    await client.query('CREATE TABLE IF NOT EXISTS apcs_app_migrations (version integer PRIMARY KEY, checksum text NOT NULL)');
    const applied = await client.query<{ version: number; checksum: string }>('SELECT version, checksum FROM apcs_app_migrations ORDER BY version');
    for (const [index, row] of applied.rows.entries()) {
      if (row.version !== index + 1 || migrations[index]?.checksum !== row.checksum) throw new Error('Application migration version or checksum mismatch');
    }
    for (const migration of migrations.slice(applied.rows.length)) {
      await client.query(migration.sql);
      await client.query('INSERT INTO apcs_app_migrations VALUES ($1, $2)', [migration.version, migration.checksum]);
    }
  });
}

/** Local administrator bootstrap only; not exposed as an unauthenticated HTTP route. */
export async function bootstrapAdmin(pool: Pool, username: string, password: string): Promise<void> {
  if (!/^[a-z][a-z0-9_.-]{2,63}$/.test(username)) throw new Error('Invalid username');
  const hash = await hashPassword(password);
  await transaction(pool, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(9021003)');
    if ((await client.query('SELECT id FROM apcs_users LIMIT 1')).rowCount) throw new Error('Administrator already exists');
    const id = randomUUID();
    await client.query('INSERT INTO apcs_users (id, username, password_hash) VALUES ($1,$2,$3)', [id, username, hash]);
    await audit(client, id, 'admin.created', id);
  });
}
