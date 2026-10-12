import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import Fastify from 'fastify';
import cookiePlugin from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import type { Pool } from 'pg';
import { PgCommandJournal } from '../../../packages/storage/src/command-journal.js';
import type { CommandContext, CommandRequest } from '../../../packages/domain/src/commands.js';
import type { SignalSnapshot } from '../../../packages/domain/src/signals.js';
import { audit, migrateApplication, transaction } from './store.js';
import { verifyPassword } from './security.js';

export interface ApiOptions {
  pool: Pool; origin: string; secureCookies: boolean;
  resolveContext?: (request: CommandRequest) => CommandContext;
  readSignal?: (id: string) => SignalSnapshot;
}
interface Session { id: string; username: string; csrf_token: string; }
declare module 'fastify' { interface FastifyRequest { sessionUser: Session | null; } }
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const uuid = { type: 'string', format: 'uuid' };
const name = { type: 'string', minLength: 1, maxLength: 128, pattern: '\\S' };
const slug = { type: 'string', pattern: '^[A-Za-z0-9_-]{1,128}$' };
const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: 'object', additionalProperties: false, properties, required });
const pageSchema = object({ limit: { type: 'string', pattern: '^(100|[1-9][0-9]?)$' }, cursor: uuid }, []);
const idParams = object({ id: uuid });
class HttpError extends Error { constructor(readonly statusCode: number, readonly code: string, message: string) { super(message); } }
const forbidden = () => new HttpError(403, 'FORBIDDEN', 'Request origin or CSRF token rejected');
const sameToken = (left: unknown, right: string) => typeof left === 'string' && /^[a-f0-9]{64}$/.test(left) && /^[a-f0-9]{64}$/.test(right) && timingSafeEqual(Buffer.from(left), Buffer.from(right));

export async function createApi(options: ApiOptions) {
  const url = new URL(options.origin);
  if (url.origin !== options.origin || !['http:', 'https:'].includes(url.protocol)) throw new Error('A canonical HTTP origin is required');
  if (!options.secureCookies && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Insecure cookies require a loopback origin');
  const pool = options.pool;
  await migrateApplication(pool);
  const journal = new PgCommandJournal(pool); await journal.migrate();
  const app = Fastify({ bodyLimit: 65536, genReqId: () => randomUUID(), ajv: { customOptions: { coerceTypes: false, removeAdditional: false } } });
  await app.register(cookiePlugin);
  await app.register(rateLimit, { global: false });
  app.decorateRequest('sessionUser', null);
  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && request.headers.origin !== options.origin) throw forbidden();
  });
  app.addHook('preHandler', async (request) => {
    if (request.routeOptions.url === '/api/v1/health/live' || request.routeOptions.url === '/api/v1/auth/login') return;
    const token = request.cookies.apcs_session;
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication required');
    const result = await pool.query<Session>(`SELECT u.id, u.username, s.csrf_token FROM apcs_sessions s
      JOIN apcs_users u ON u.id = s.user_id WHERE s.token_hash = $1 AND s.expires_at > clock_timestamp()`, [digest(token)]);
    request.sessionUser = result.rows[0] ?? null;
    if (!request.sessionUser) throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication required');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && !sameToken(request.headers['x-csrf-token'], request.sessionUser.csrf_token)) throw forbidden();
  });
  app.setErrorHandler((error, request, reply) => {
    const typed = error as { statusCode?: number; code?: string; validation?: unknown; message?: string };
    const status = typed.statusCode ?? (typed.code === '23505' ? 409 : typed.code === '23503' ? 404 : 500);
    const code = typed.validation ? 'INVALID_REQUEST' : status === 500 ? 'INTERNAL_ERROR' : typed.code ?? 'REQUEST_FAILED';
    const message = status >= 500 ? 'Internal server error' : status === 409 ? 'Resource conflict'
      : status === 404 ? 'Resource not found' : typed.validation ? 'Request validation failed' : typed.message ?? 'Request failed';
    reply.code(status).send({ code, message, correlationId: request.id });
  });
  app.get('/api/v1/health/live', async () => ({ status: 'ok' }));
  app.get('/api/v1/health/ready', async () => { await pool.query('SELECT 1'); return { status: 'ready' }; });

  const cookieSettings = { path: '/', httpOnly: true, sameSite: 'strict' as const, secure: options.secureCookies, maxAge: 28800 };
  app.post<{ Body: { username: string; password: string } }>('/api/v1/auth/login', {
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    schema: { body: object({ username: { type: 'string', minLength: 1, maxLength: 64 }, password: { type: 'string', minLength: 1, maxLength: 256 } }) },
  }, async (request, reply) => {
    const result = await pool.query<{ id: string; username: string; password_hash: string }>('SELECT id, username, password_hash FROM apcs_users WHERE username = $1', [request.body.username]);
    const user = result.rows[0];
    if (!await verifyPassword(request.body.password, user?.password_hash ?? null) || !user) {
      await transaction(pool, (client) => audit(client, null, 'auth.failed', null));
      throw new HttpError(401, 'INVALID_CREDENTIALS', 'Invalid credentials');
    }
    const token = randomBytes(32).toString('base64url'); const csrfToken = randomBytes(32).toString('hex');
    await transaction(pool, async (client) => {
      await client.query('DELETE FROM apcs_sessions WHERE expires_at <= clock_timestamp()');
      await client.query("INSERT INTO apcs_sessions (token_hash, user_id, csrf_token, expires_at) VALUES ($1,$2,$3,clock_timestamp() + interval '8 hours')", [digest(token), user.id, csrfToken]);
      await audit(client, user.id, 'auth.login', user.id);
    });
    reply.setCookie('apcs_session', token, cookieSettings);
    return { id: user.id, username: user.username, csrfToken };
  });
  app.get('/api/v1/auth/me', async (request) => ({ id: request.sessionUser!.id, username: request.sessionUser!.username, csrfToken: request.sessionUser!.csrf_token }));
  app.post('/api/v1/auth/logout', async (request, reply) => {
    await transaction(pool, async (client) => {
      await client.query('DELETE FROM apcs_sessions WHERE token_hash = $1', [digest(request.cookies.apcs_session!)]);
      await audit(client, request.sessionUser!.id, 'auth.logout', request.sessionUser!.id);
    });
    reply.clearCookie('apcs_session', { path: '/' }).code(204).send();
  });

  app.post<{ Body: { name: string } }>('/api/v1/projects', { schema: { body: object({ name }) } }, async (request, reply) => {
    const project = await transaction(pool, async (client) => {
      const id = randomUUID();
      const result = await client.query('INSERT INTO apcs_projects (id, name, owner_id) VALUES ($1,$2,$3) RETURNING id, name, revision', [id, request.body.name, request.sessionUser!.id]);
      await audit(client, request.sessionUser!.id, 'project.created', id, { name: request.body.name });
      return result.rows[0];
    });
    return reply.code(201).header('ETag', '"1"').send(project);
  });
  app.get<{ Querystring: { limit?: string; cursor?: string } }>('/api/v1/projects', { schema: { querystring: pageSchema } }, async (request) => {
    const limit = Number(request.query.limit ?? 100);
    const result = await pool.query('SELECT id, name, revision FROM apcs_projects WHERE ($1::uuid IS NULL OR id > $1) ORDER BY id LIMIT $2', [request.query.cursor ?? null, limit + 1]);
    return page(result.rows, limit);
  });
  app.get<{ Params: { id: string } }>('/api/v1/projects/:id', { schema: { params: idParams } }, async (request, reply) => {
    const result = await pool.query('SELECT id, name, revision FROM apcs_projects WHERE id = $1', [request.params.id]);
    if (!result.rows[0]) throw new HttpError(404, 'NOT_FOUND', 'Project not found');
    return reply.header('ETag', `"${result.rows[0].revision}"`).send(result.rows[0]);
  });
  app.patch<{ Params: { id: string }; Body: { name: string } }>('/api/v1/projects/:id', { schema: { params: idParams, body: object({ name }) } }, async (request, reply) => {
    const match = request.headers['if-match'];
    if (typeof match !== 'string' || !/^"[1-9][0-9]{0,8}"$/.test(match)) throw new HttpError(428, 'REVISION_REQUIRED', 'An If-Match revision is required');
    const updated = await transaction(pool, async (client) => {
      const result = await client.query(`UPDATE apcs_projects SET name = $1, revision = revision + 1 WHERE id = $2 AND revision = $3 RETURNING id, name, revision`, [request.body.name, request.params.id, Number(match.slice(1, -1))]);
      if (!result.rows[0]) throw new HttpError(412, 'REVISION_CONFLICT', 'Project revision changed or project is missing');
      await audit(client, request.sessionUser!.id, 'project.updated', request.params.id, { name: request.body.name, revision: result.rows[0].revision });
      return result.rows[0];
    });
    return reply.header('ETag', `"${updated.revision}"`).send(updated);
  });

  app.post<{ Body: { projectId: string; name: string; siteId: string; deviceId: string; kind: string } }>('/api/v1/devices', {
    schema: { body: object({ projectId: uuid, name, siteId: slug, deviceId: slug, kind: { enum: ['virtual-led', 'esp32-led'], type: 'string' } }) },
  }, async (request, reply) => {
    const input = request.body;
    const device = await transaction(pool, async (client) => {
      const id = randomUUID(); const signalId = randomUUID();
      await client.query('INSERT INTO apcs_devices (id, project_id, name, kind, site_id, protocol_device_id) VALUES ($1,$2,$3,$4,$5,$6)', [id, input.projectId, input.name, input.kind, input.siteId, input.deviceId]);
      await client.query("INSERT INTO apcs_signals (id, device_id, name, data_type, direction) VALUES ($1,$2,$3,'boolean','output')", [signalId, id, `${input.name}.led`]);
      await audit(client, request.sessionUser!.id, 'device.created', id, { projectId: input.projectId, signalId });
      return { id, ...input, signalId };
    });
    return reply.code(201).send(device);
  });
  for (const kind of ['devices', 'signals'] as const) {
    app.get<{ Querystring: { limit?: string; cursor?: string } }>(`/api/v1/${kind}`, { schema: { querystring: pageSchema } }, async (request) => {
      const limit = Number(request.query.limit ?? 100);
      const fields = kind === 'devices' ? 'id, project_id AS "projectId", name, kind, site_id AS "siteId", protocol_device_id AS "deviceId"'
        : 'id, device_id AS "deviceId", name, data_type AS "dataType", direction, freshness_ms AS "freshnessMs"';
      const result = await pool.query(`SELECT ${fields} FROM apcs_${kind} WHERE ($1::uuid IS NULL OR id > $1) ORDER BY id LIMIT $2`, [request.query.cursor ?? null, limit + 1]);
      return page(result.rows, limit);
    });
  }
  app.get<{ Params: { id: string } }>('/api/v1/signals/:id/value', { schema: { params: idParams } }, async (request) => {
    if (!(await pool.query('SELECT id FROM apcs_signals WHERE id = $1', [request.params.id])).rowCount) throw new HttpError(404, 'NOT_FOUND', 'Signal not found');
    return options.readSignal?.(request.params.id) ?? { value: null, quality: 'Disconnected', sourceTime: null, receivedTime: null, bootId: null, sequence: null };
  });
  app.get<{ Querystring: { limit?: string; cursor?: string } }>('/api/v1/audit', {
    schema: { querystring: object({ limit: { type: 'string', pattern: '^(100|[1-9][0-9]?)$' }, cursor: { type: 'string', pattern: '^[0-9]{1,18}$' } }, []) },
  }, async (request) => {
    const limit = Number(request.query.limit ?? 100);
    const result = await pool.query('SELECT id::text, actor_id AS "actorId", action, resource_id AS "resourceId", data, at FROM apcs_audit WHERE ($1::bigint IS NULL OR id < $1) ORDER BY id DESC LIMIT $2', [request.query.cursor ?? null, limit + 1]);
    return page(result.rows, limit);
  });

  app.post<{ Body: { targetSignalId: string; value: boolean; ttlMs: number; expectedProjectRevision: number; reason: string } }>('/api/v1/commands', {
    schema: { body: object({ targetSignalId: uuid, value: { type: 'boolean' }, ttlMs: { type: 'integer', minimum: 1, maximum: 3000 },
      expectedProjectRevision: { type: 'integer', minimum: 1 }, reason: { type: 'string', minLength: 1, maxLength: 256, pattern: '\\S' } }) },
  }, async (request, reply) => {
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(key)) throw new HttpError(400, 'IDEMPOTENCY_REQUIRED', 'A valid Idempotency-Key is required');
    const input: CommandRequest = { ...request.body, id: randomUUID(), idempotencyKey: key, actorId: request.sessionUser!.id };
    const target = await pool.query<{ revision: number }>(`SELECT p.revision FROM apcs_signals s JOIN apcs_devices d ON d.id = s.device_id JOIN apcs_projects p ON p.id = d.project_id WHERE s.id = $1`, [input.targetSignalId]);
    if (!target.rows[0]) throw new HttpError(404, 'NOT_FOUND', 'Signal not found');
    const context = options.resolveContext?.(input) ?? { bootId: null, projectRevision: target.rows[0].revision, quality: 'Disconnected', interlockReason: 'Output has not been commissioned', ownerId: null, maxTtlMs: 3000 };
    try { return reply.code(202).send(await journal.request(input, context)); }
    catch (error) {
      if (error instanceof Error && /conflict/i.test(error.message)) throw new HttpError(409, 'COMMAND_CONFLICT', 'Command idempotency conflict');
      throw error;
    }
  });
  app.get<{ Params: { id: string } }>('/api/v1/commands/:id', { schema: { params: idParams } }, async (request) => {
    try { return await journal.get(request.params.id); }
    catch (error) { if (error instanceof Error && error.message.startsWith('Unknown command:')) throw new HttpError(404, 'NOT_FOUND', 'Command not found'); throw error; }
  });
  await app.ready(); return app;
}

function page(rows: Array<{ id: string; [key: string]: unknown }>, limit: number) {
  return { items: rows.slice(0, limit), nextCursor: rows.length > limit ? rows[limit - 1]!.id : null };
}
