import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { createApi } from '../../apps/api/src/app.js';
import { bootstrapAdmin, migrateApplication } from '../../apps/api/src/store.js';
let admin: Pool; let pool: Pool; let schema: string; let app: Awaited<ReturnType<typeof createApi>>; let headers: Record<string, string>; let projectId: string; let signalId: string;
beforeEach(async () => {
  const connectionString = process.env.APCS_TEST_POSTGRES_URL; if (!connectionString) throw new Error('Docker fixture required');
  schema = `editors_${randomUUID().replaceAll('-', '')}`; admin = new Pool({ connectionString }); await admin.query(`CREATE SCHEMA ${schema}`);
  pool = new Pool({ connectionString, options: `-c search_path=${schema}` }); await migrateApplication(pool); await bootstrapAdmin(pool, 'operator', 'Editor fixture password!');
  app = await createApi({ pool, origin: 'http://localhost:5173', secureCookies: false });
  const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { origin: 'http://localhost:5173' }, payload: { username: 'operator', password: 'Editor fixture password!' } });
  headers = { origin: 'http://localhost:5173', cookie: `apcs_session=${login.cookies[0]!.value}`, 'x-csrf-token': login.json().csrfToken };
  projectId = (await app.inject({ method: 'POST', url: '/api/v1/projects', headers, payload: { name: 'Editor project' } })).json().id;
  signalId = (await app.inject({ method: 'POST', url: '/api/v1/devices', headers, payload: { projectId, name: 'LED', kind: 'virtual-led', siteId: 'test', deviceId: 'led' } })).json().signalId;
});
afterEach(async () => { await app?.close(); await pool?.end(); if (admin) { try { await admin.query(`DROP SCHEMA ${schema} CASCADE`); } finally { await admin.end(); } } });
async function create(kind = 'graphs') { return app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/${kind}`, headers, payload: { name: 'LED logic' } }); }
async function save(id: string, document: unknown, revision = 1, kind = 'graphs') { return app.inject({ method: 'PUT', url: `/api/v1/${kind}/${id}`, headers: { ...headers, 'if-match': `"${revision}"` }, payload: { name: 'LED logic', document } }); }

it('persists and prepares numeric and boolean trends but rejects foreign bindings',async()=>{
  const thermal=(await app.inject({method:'POST',url:'/api/v1/devices',headers,payload:{projectId,name:'Thermal',kind:'virtual-thermal',siteId:'trend',deviceId:'chamber'}})).json();
  const id=(await create('screens')).json().id;
  const scene={schemaVersion:1,width:1000,height:800,items:[{id:'trend',kind:'trend',label:'Temperature',signalId:thermal.temperatureSignalId,x:20,y:20,width:800,height:280,windowSeconds:300}]};
  expect((await save(id,scene,1,'screens')).statusCode).toBe(200);
  expect((await save(id,{...scene,items:[{...scene.items[0],signalId:randomUUID()}]},2,'screens')).statusCode).toBe(422);
  const digital={...scene,items:[{...scene.items[0],signalId}]};
  expect((await save(id,digital,2,'screens')).statusCode).toBe(200);
  expect((await app.inject({method:'POST',url:`/api/v1/screens/${id}/revisions`,headers:{...headers,'if-match':'"3"'}})).statusCode).toBe(201);
  expect((await app.inject({url:`/api/v1/screens/${id}/revisions`,headers})).json().items[0].document).toEqual(digital);
});
