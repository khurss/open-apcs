import { randomUUID } from 'node:crypto';
import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import { Pool } from 'pg';
import { createApi } from '../../apps/api/src/app.js';
import { bootstrapAdmin, migrateApplication } from '../../apps/api/src/store.js';
import { vi } from 'vitest';
import type { AiProvider } from '../../apps/api/src/ai-provider.js';
import { validateGraph } from '../../packages/domain/src/logic.js';
let admin: Pool; let pool: Pool; let schema: string; let app: Awaited<ReturnType<typeof createApi>> | undefined;
const origin = 'http://localhost:5173';
const password = 'A test-only password 42!';
let cookie: string; let csrf: string;
beforeEach(async () => {
  const connectionString = process.env.APCS_TEST_POSTGRES_URL;
  if (!connectionString) throw new Error('Docker PostgreSQL fixture required');
  schema = `api_${randomUUID().replaceAll('-', '')}`;
  admin = new Pool({ connectionString, max: 1 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  pool = new Pool({ connectionString, options: `-c search_path=${schema}`, connectionTimeoutMillis: 2000 });
  app = undefined; cookie = ''; csrf = '';
});
afterEach(async () => {
  await app?.close(); await pool?.end();
  if (admin) { try { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); } finally { await admin.end(); } }
});
async function setup(provider?: AiProvider) {
  await migrateApplication(pool);
  await bootstrapAdmin(pool, 'operator', password);
  app = await createApi({ pool, origin, secureCookies: false, ...(provider ? {ai:provider} : {}) });
  {
    const response = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { origin }, payload: { username: 'operator', password } });
    expect(response.statusCode).toBe(200);
    cookie = response.cookies[0]!.name + '=' + response.cookies[0]!.value;
    csrf = response.json().csrfToken;
  }
}
const headers = () => ({ origin, cookie, 'x-csrf-token': csrf });
async function project(name = 'LED Demo') {
  return app!.inject({ method: 'POST', url: '/api/v1/projects', headers: headers(), payload: { name } });
}



describe('optional AI draft authoring',()=>{
  it('requires external-context consent, validates a proposal and never persists or activates it',async()=>{
    let signalId='';
    const generate=vi.fn(async()=>({name:'Suggested LED',summary:'Review before activation',document:JSON.stringify({schemaVersion:1,nodes:[{id:'power',kind:'constant',label:'Power',x:0,y:0,value:true},{id:'led',kind:'output',label:'LED',x:300,y:0,signalId}],edges:[{id:'wire',source:'power',target:'led',port:'in'}]})}));
    await setup({model:'fixture-model',generate});const projectId=(await project()).json().id;
    const device=(await app!.inject({method:'POST',url:'/api/v1/devices',headers:headers(),payload:{projectId,name:'AI LED',siteId:'ai',deviceId:'led',kind:'virtual-led'}})).json();signalId=device.signalId;
    const body={kind:'graph',prompt:'Create a constant LED output',signalIds:[signalId],allowExternal:true};
    const status=await app!.inject({url:'/api/v1/ai/status',headers:headers()});expect(status.statusCode).toBe(200);expect(status.json()).toEqual({configured:true,provider:'OpenAI',model:'fixture-model'});
    const send=(payload:unknown)=>app!.inject({method:'POST',url:`/api/v1/projects/${projectId}/ai/proposals`,headers:headers(),payload:payload as object});
    expect((await send({...body,allowExternal:false})).statusCode).toBe(400);expect(generate).not.toHaveBeenCalled();
    const response=await send(body);expect(response.statusCode).toBe(200);validateGraph(response.json().document,true);expect(response.json().checksum).toHaveLength(64);
    expect(generate).toHaveBeenCalledWith({kind:'graph',prompt:body.prompt,signals:[{id:signalId,name:'AI LED.led',dataType:'boolean',direction:'output'}]});
    expect((await pool.query('SELECT count(*)::int AS n FROM apcs_documents')).rows[0].n).toBe(0);expect((await pool.query('SELECT count(*)::int AS n FROM apcs_commands')).rows[0].n).toBe(0);
    expect((await pool.query("SELECT data FROM apcs_audit WHERE action='ai.generation.completed'")).rows[0].data).not.toHaveProperty('prompt');
  });
  it('rejects malformed documents and bindings outside disclosed context without storing drafts',async()=>{
    let document='not json';const generate=vi.fn(async()=>({name:'Proposal',summary:'Review',document}));
    await setup({model:'fixture-model',generate});const projectId=(await project()).json().id;
    const send=()=>app!.inject({method:'POST',url:`/api/v1/projects/${projectId}/ai/proposals`,headers:headers(),payload:{kind:'screen',prompt:'Show a signal',signalIds:[],allowExternal:true}});
    expect((await send()).statusCode).toBe(422);
    document=JSON.stringify({schemaVersion:1,width:1000,height:600,items:[{id:'lamp',kind:'indicator',label:'Lamp',signalId:randomUUID(),x:0,y:0,width:200,height:100}]});
    expect((await send()).statusCode).toBe(422);expect((await pool.query('SELECT count(*)::int AS n FROM apcs_documents')).rows[0].n).toBe(0);
    const foreign=randomUUID();await pool.query("INSERT INTO apcs_users(id,username,password_hash) VALUES($1,'foreign','fixture')",[foreign]);await pool.query('UPDATE apcs_sessions SET user_id=$1',[foreign]);
    expect((await send()).statusCode).toBe(404);expect(generate).toHaveBeenCalledTimes(2);
  });
  it('reports missing private configuration while ordinary project functions remain available',async()=>{
    await setup();const projectId=(await project()).json().id;
    expect((await app!.inject({url:'/api/v1/ai/status',headers:headers()})).json()).toMatchObject({configured:false,model:null});
    const response=await app!.inject({method:'POST',url:`/api/v1/projects/${projectId}/ai/proposals`,headers:headers(),payload:{kind:'graph',prompt:'Draft',signalIds:[],allowExternal:true}});
    expect(response.statusCode).toBe(503);expect(response.json().code).toBe('AI_NOT_CONFIGURED');
    expect((await app!.inject({url:`/api/v1/projects/${projectId}`,headers:headers()})).statusCode).toBe(200);
  });
});
