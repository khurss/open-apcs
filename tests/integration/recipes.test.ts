import { randomUUID } from 'node:crypto';
import { beforeEach, afterEach, it, expect } from 'vitest';
import { Pool } from 'pg';
import { createApi } from '../../apps/api/src/app.js';
import { bootstrapAdmin, migrateApplication } from '../../apps/api/src/store.js';
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
async function setup(login = true) {
  await migrateApplication(pool);
  await bootstrapAdmin(pool, 'operator', password);
  app = await createApi({ pool, origin, secureCookies: false });
  if (login) {
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


it('publishes immutable recipe versions and serializes starts with a durable run journal',async()=>{
 await setup(); const projectId=(await project()).json().id;
 const save=()=>app!.inject({method:'POST',url:`/api/v1/projects/${projectId}/recipes`,headers:headers(),payload:{name:'Thermal demo',parameters:{targetC:22,holdSeconds:2,maxHeatSeconds:60}}});
 const created=await save(); expect(created.statusCode).toBe(201);
 const recipe=created.json();
 const start=()=>app!.inject({method:'POST',url:`/api/v1/projects/${projectId}/recipe-runs`,headers:headers(),payload:{recipeId:recipe.id,revision:1}});
 const results=await Promise.all([start(),start()]); expect(results.map(r=>r.statusCode).sort()).toEqual([201,409]);
 const run=results.find(r=>r.statusCode===201)!.json(); expect(run.snapshot.parameters.targetC).toBe(22);
 const edited=await app!.inject({method:'POST',url:`/api/v1/projects/${projectId}/recipes`,headers:headers(),payload:{name:'Thermal demo',recipeId:recipe.id,expectedRevision:1,parameters:{targetC:30,holdSeconds:3,maxHeatSeconds:60}}});
 expect(edited.statusCode).toBe(201); expect(edited.json().revision).toBe(2);
 const stale=await app!.inject({method:'POST',url:`/api/v1/projects/${projectId}/recipes`,headers:headers(),payload:{name:'Thermal demo',recipeId:recipe.id,expectedRevision:1,parameters:{targetC:30,holdSeconds:3,maxHeatSeconds:60}}}); expect(stale.statusCode).toBe(412);
 const cancel=await app!.inject({method:'POST',url:`/api/v1/projects/${projectId}/recipe-runs/${run.id}/cancel`,headers:headers(),payload:{}}); expect(cancel.statusCode).toBe(200);
 const listing=(await app!.inject({url:`/api/v1/projects/${projectId}/recipe-runs`,headers:headers()})).json();
 expect(listing.items[0].snapshot).toMatchObject({status:'Aborted',heater:false,parameters:{targetC:22}});
 expect(listing.items[0].events.map((e:{message:string})=>e.message)).toEqual(['Run started','Cancelled by operator']);
 expect((await pool.query('SELECT count(*)::int AS n FROM apcs_commands')).rows[0].n).toBe(0);
 const other=randomUUID(); await pool.query("INSERT INTO apcs_users(id,username,password_hash) VALUES($1,'other','fixture')",[other]); await pool.query('UPDATE apcs_sessions SET user_id=$1',[other]);
 expect((await app!.inject({url:`/api/v1/projects/${projectId}/recipe-runs`,headers:headers()})).statusCode).toBe(404);
});

it('executes without browser polling, journals transitions, aborts restart and excludes a second simulator',async()=>{
 await setup(); const projectId=(await project()).json().id;
 const recipe=(await app!.inject({method:'POST',url:`/api/v1/projects/${projectId}/recipes`,headers:headers(),payload:{name:'Chamber',parameters:{targetC:21,holdSeconds:1,maxHeatSeconds:60}}})).json();
 await expect(pool.query("UPDATE apcs_recipes SET name='tampered'")).rejects.toThrow('immutable');
 const start=async()=>{const response=await app!.inject({method:'POST',url:`/api/v1/projects/${projectId}/recipe-runs`,headers:headers(),payload:{recipeId:recipe.id,revision:1}});expect(response.statusCode).toBe(201);return response.json();};
 const {tickRecipes,startRecipeSimulator}=await import('../../apps/api/src/recipe-service.js');
 const first=await start();
 for(let delta=500;delta<=4000;delta+=500) await tickRecipes(pool,first.snapshot.startedAt+delta);
 const completed=(await pool.query('SELECT * FROM apcs_recipe_runs WHERE id=$1',[first.id])).rows[0];
 expect(completed.snapshot).toMatchObject({status:'Completed',heater:false});
 expect(completed.events.map((e:{message:string})=>e.message)).toEqual(['Run started','Step: Holding','Run completed']);
 const second=await start();
 const errors:unknown[]=[];const stop=await startRecipeSimulator(pool,e=>errors.push(e));
 try{
  expect((await pool.query('SELECT snapshot FROM apcs_recipe_runs WHERE id=$1',[second.id])).rows[0].snapshot).toMatchObject({status:'Aborted',heater:false,reason:'Simulator restarted'});
  await expect(startRecipeSimulator(pool,()=>{})).rejects.toThrow('already running');
  const third=await start();
  await new Promise(resolve=>setTimeout(resolve,700));
  expect((await pool.query('SELECT snapshot FROM apcs_recipe_runs WHERE id=$1',[third.id])).rows[0].snapshot.temperatureC).toBeGreaterThan(20);
 }finally{await stop();}
 expect(errors).toEqual([]);
 expect((await pool.query("SELECT count(*)::int AS n FROM apcs_recipe_runs WHERE snapshot->>'status'='Running'")).rows[0].n).toBe(0);
});
it('validates bounds, isolates versions and latches simulated input failures',async()=>{
 await setup();const projectId=(await project()).json().id;const otherProject=(await project('Other')).json().id;
 const publish=(parameters:unknown)=>app!.inject({method:'POST',url:`/api/v1/projects/${projectId}/recipes`,headers:headers(),payload:{name:'Safety',parameters}});
 expect((await publish({targetC:80,holdSeconds:2,maxHeatSeconds:60})).statusCode).toBe(400);
 const recipe=(await publish({targetC:22,holdSeconds:2,maxHeatSeconds:60})).json();
 expect((await app!.inject({method:'POST',url:`/api/v1/projects/${otherProject}/recipe-runs`,headers:headers(),payload:{recipeId:recipe.id,revision:1}})).statusCode).toBe(404);
 for(const cause of ['permit','quality']){
  const run=(await app!.inject({method:'POST',url:`/api/v1/projects/${projectId}/recipe-runs`,headers:headers(),payload:{recipeId:recipe.id,revision:1}})).json();
  const fail=()=>app!.inject({method:'POST',url:`/api/v1/projects/${projectId}/recipe-runs/${run.id}/cancel`,headers:headers(),payload:{cause}});
  const stopped=(await fail()).json();expect(stopped.snapshot).toMatchObject({status:'Aborted',heater:false});expect(stopped.events).toHaveLength(2);
  expect((await fail()).json().events).toHaveLength(2);
 }
});

it('samples time after waiting for a database connection so a newly started run is not falsely aborted',async()=>{
 await setup(); const projectId=(await project()).json().id;
 const recipe=(await app!.inject({method:'POST',url:`/api/v1/projects/${projectId}/recipes`,headers:headers(),payload:{name:'Queued tick',parameters:{targetC:22,holdSeconds:5,maxHeatSeconds:60}}})).json();
 const single=new Pool({connectionString:process.env.APCS_TEST_POSTGRES_URL,options:`-c search_path=${schema}`,max:1});
 const held=await single.connect();
 const {tickRecipes}=await import('../../apps/api/src/recipe-service.js');
 const pending=tickRecipes(single);
 try {
  await new Promise(resolve=>setTimeout(resolve,25));
  const run=(await app!.inject({method:'POST',url:`/api/v1/projects/${projectId}/recipe-runs`,headers:headers(),payload:{recipeId:recipe.id,revision:1}})).json();
  held.release();await pending;
  expect((await pool.query('SELECT snapshot FROM apcs_recipe_runs WHERE id=$1',[run.id])).rows[0].snapshot.status).toBe('Running');
 }finally{await single.end();}
});

it('publishes ordered programs, freezes their steps and journals consecutive same-kind transitions',async()=>{
 await setup();const projectId=(await project()).json().id;
 const parameters={schemaVersion:2,steps:[{kind:'cool',name:'First',targetC:21,timeoutSeconds:10},{kind:'cool',name:'Second',targetC:21,timeoutSeconds:10}]};
 const published=await app!.inject({method:'POST',url:`/api/v1/projects/${projectId}/recipes`,headers:headers(),payload:{name:'Staged recipe',parameters}});
 expect(published.statusCode).toBe(201);const recipe=published.json();
 const started=await app!.inject({method:'POST',url:`/api/v1/projects/${projectId}/recipe-runs`,headers:headers(),payload:{recipeId:recipe.id,revision:1}});expect(started.statusCode).toBe(201);const run=started.json();
 const changed=structuredClone(parameters);changed.steps[0]!.name='Changed';
 expect((await app!.inject({method:'POST',url:`/api/v1/projects/${projectId}/recipes`,headers:headers(),payload:{name:'Staged recipe',recipeId:recipe.id,expectedRevision:1,parameters:changed}})).statusCode).toBe(201);
 const {tickRecipes}=await import('../../apps/api/src/recipe-service.js');
 await tickRecipes(pool,run.snapshot.startedAt+500);await tickRecipes(pool,run.snapshot.startedAt+1000);
 const saved=(await pool.query('SELECT * FROM apcs_recipe_runs WHERE id=$1',[run.id])).rows[0];
 expect(saved.snapshot).toMatchObject({status:'Completed',heater:false,parameters});
 expect(saved.events.map((event:{message:string})=>event.message)).toEqual(['Run started','Step 2: Second (Cooling)','Run completed']);
 expect((await pool.query('SELECT count(*)::int AS n FROM apcs_commands')).rows[0].n).toBe(0);
 for(const steps of [[],Array(17).fill(parameters.steps[0]),[{kind:'cool',name:'Too cold',targetC:20,timeoutSeconds:1}],[{kind:'heat',name:'Unknown field',targetC:22,timeoutSeconds:2,extra:true}]]) {
  expect((await app!.inject({method:'POST',url:`/api/v1/projects/${projectId}/recipes`,headers:headers(),payload:{name:'Invalid',parameters:{schemaVersion:2,steps}}})).statusCode).toBe(400);
 }
});
