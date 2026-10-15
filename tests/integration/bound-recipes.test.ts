import { randomUUID } from 'node:crypto';
import { beforeEach, afterEach, it, expect } from 'vitest';
import { Pool } from 'pg';
import { createApi } from '../../apps/api/src/app.js';
import { bootstrapAdmin, migrateApplication } from '../../apps/api/src/store.js';
let admin: Pool; let pool: Pool; let schema: string; let app: Awaited<ReturnType<typeof createApi>> | undefined;
const origin = 'http://localhost:5173';
const password = 'A test-only password 42!';
let runtime:import('../../apps/api/src/runtime-service.js').SimulationRuntime;
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
async function setup(login = true,mqttUrl=process.env.APCS_TEST_MQTT_URL!) {
  await migrateApplication(pool);
  await bootstrapAdmin(pool, 'operator', password);
  const {SimulationRuntime}=await import('../../apps/api/src/runtime-service.js');
  runtime=new SimulationRuntime(pool,mqttUrl);
  app = await createApi({ pool, origin, secureCookies: false,runtime });
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



it('binds a catalog thermal device, excludes manual control and completes only with verified OFF',async()=>{
 await setup();const projectId=(await project()).json().id;
 const post=(url:string,payload:Record<string,unknown>)=>app!.inject({method:'POST',url:'/api/v1'+url,headers:headers(),payload});
 const device=(await post('/devices',{projectId,name:'Chamber',siteId:'test',deviceId:'chamber',kind:'virtual-thermal'})).json();
 expect((await post(`/devices/${device.id}/runtime`,{action:'start',reason:'Recipe test'})).statusCode).toBe(200);
 const recipe=(await post(`/projects/${projectId}/recipes`,{name:'Measured',parameters:{targetC:21,holdSeconds:1,maxHeatSeconds:30}})).json();
 const started=await post(`/projects/${projectId}/recipe-runs`,{recipeId:recipe.id,revision:1,deviceId:device.id});
 expect(started.statusCode,started.body).toBe(201);const run=started.json();
 expect(run.binding).toMatchObject({deviceId:device.id,outputSignalId:device.signalId,temperatureSignalId:device.temperatureSignalId});
 const actor=(await pool.query('SELECT owner_id FROM apcs_projects WHERE id=$1',[projectId])).rows[0].owner_id;
 const {PgCommandJournal}=await import('../../packages/storage/src/command-journal.js');const journal=new PgCommandJournal(pool);
 const manual={id:randomUUID(),idempotencyKey:randomUUID(),actorId:actor,targetSignalId:device.signalId,value:true,ttlMs:2000,expectedProjectRevision:1,reason:'Ownership test'};
 expect(await journal.request(manual,await runtime.context(manual))).toMatchObject({state:'Rejected',reason:'Output belongs to another owner'});
 const load=async()=>(await pool.query('SELECT * FROM apcs_recipe_runs WHERE id=$1',[run.id])).rows[0];
 await expect.poll(async()=>(await load()).snapshot.status,{timeout:8000}).toBe('Completed');
 expect((await load()).control).toMatchObject({phase:'Verified OFF',commandState:'Verified'});
 const commands=(await pool.query("SELECT snapshot FROM apcs_commands WHERE actor_id=$1 ORDER BY created_at",[`recipe:${run.id}`])).rows;
 expect(commands[0].snapshot).toMatchObject({value:true,state:'Verified'});expect(commands.at(-1).snapshot).toMatchObject({value:false,state:'Verified'});
 expect((await runtime.status(device.id)).state).toBe('stopped');
},15000);

async function demo(){
 const projectId=(await project()).json().id;
 const post=(url:string,payload:Record<string,unknown>={})=>app!.inject({method:'POST',url:'/api/v1'+url,headers:headers(),payload});
 const response=await post(`/projects/${projectId}/recipe-demo`);expect(response.statusCode,response.body).toBe(201);
 const manifest=response.json();expect((await post(`/projects/${projectId}/recipe-demo`)).json()).toEqual(manifest);
 expect((await runtime.status(manifest.deviceId)).state).toBe('stopped');
 const actor=(await pool.query('SELECT owner_id FROM apcs_projects WHERE id=$1',[projectId])).rows[0].owner_id;
 const start=()=>post(`/projects/${projectId}/recipe-runs`,{recipeId:manifest.recipeId,revision:1,deviceId:manifest.deviceId});
 return {projectId,post,manifest,actor,start};
}
it('latches a real MQTT transport loss, never resumes and skips isolated model integration',async()=>{
 const {mqttProxy}=await import('../helpers/mqtt-proxy.js');const proxy=await mqttProxy(process.env.APCS_TEST_MQTT_URL!);
 try{
  await setup(true,proxy.url);const f=await demo();await runtime.start(f.manifest.deviceId,f.actor);
  const response=await f.start();expect(response.statusCode,response.body).toBe(201);const run=response.json();
  const load=async()=>(await pool.query('SELECT * FROM apcs_recipe_runs WHERE id=$1',[run.id])).rows[0];
  const {tickRecipes}=await import('../../apps/api/src/recipe-service.js');await tickRecipes(pool,run.snapshot.lastAt+500);
  expect((await load()).snapshot.temperatureC).toBe(20);
  await expect.poll(async()=>Number((await pool.query("SELECT count(*) AS n FROM apcs_commands WHERE actor_id=$1 AND snapshot->>'state'='Verified'",[`recipe:${run.id}`])).rows[0].n)).toBeGreaterThan(0);
  proxy.disconnect();await expect.poll(async()=>(await load()).snapshot.status).toBe('Aborted');
  expect((await load()).control.phase).toBe('Revoked');await new Promise(r=>setTimeout(r,500));
  expect((await load()).snapshot.status).toBe('Aborted');expect((await runtime.status(f.manifest.deviceId)).state).not.toBe('running');
 }finally{await proxy.close();}
},15000);
it('rejects physical and cross-project bindings and keeps graph ownership intact',async()=>{
 await setup();const f=await demo();const {createDemoDocument}=await import('../../apps/api/src/demo-api.js');
 const signal=(await pool.query("SELECT id FROM apcs_signals WHERE device_id=$1 AND direction='output'",[f.manifest.deviceId])).rows[0].id;
 const client=await pool.connect();let graph:string;
 try{graph=await createDemoDocument(client,f.projectId,f.actor,'graph','Competing graph',{schemaVersion:1,nodes:[{id:'power',kind:'constant',label:'Power',value:false,x:0,y:0},{id:'out',kind:'output',label:'Heater',signalId:signal,x:100,y:0}],edges:[{id:'wire',source:'power',target:'out',port:'in'}]});}finally{client.release();}
 await runtime.start(f.manifest.deviceId,f.actor);await runtime.activateGraph(graph,1,f.actor);
 const rejected=await f.start();expect(rejected.statusCode).toBe(409);expect(rejected.json().message).toContain('another owner');expect((await runtime.graphStatus(graph)).state).toBe('running');
 await runtime.stopGraph(graph);await runtime.start(f.manifest.deviceId,f.actor);
 const running=await f.start();expect(running.statusCode,running.body).toBe(201);
 await expect(runtime.activateGraph(graph,1,f.actor)).rejects.toThrow('another owner');
 expect((await f.post(`/projects/${f.projectId}/recipe-runs/${running.json().id}/cancel`)).json().snapshot.status).toBe('Aborted');
 expect((await runtime.status(f.manifest.deviceId)).state).toBe('stopped');
 const other=(await project('Other')).json().id;
 const foreign=(await f.post('/devices',{projectId:other,name:'Foreign',siteId:'test',deviceId:'foreign',kind:'virtual-thermal'})).json();
 const physical=(await f.post('/devices',{projectId:f.projectId,name:'Physical',siteId:'test',deviceId:'physical',kind:'esp32-led'})).json();
 for(const [id,status] of [[foreign.id,404],[physical.id,422]] as const){expect((await f.post(`/projects/${f.projectId}/recipe-runs`,{recipeId:f.manifest.recipeId,revision:1,deviceId:id})).statusCode).toBe(status);}
},15000);
it('marks a killed private worker run aborted without rearming its device',async()=>{
 await setup();const f=await demo();await runtime.close();
 const {RuntimeProcess}=await import('../../apps/api/src/runtime-process.js');
 const worker=new RuntimeProcess({connectionString:process.env.APCS_TEST_POSTGRES_URL!,mqttUrl:process.env.APCS_TEST_MQTT_URL!,databaseOptions:`-c search_path=${schema}`});
 try{
  await worker.start(f.manifest.deviceId,f.actor);
  // Create an isolated row, then resolve the same binding used by the API. The worker owns execution.
  const response=await f.post(`/projects/${f.projectId}/recipe-runs`,{recipeId:f.manifest.recipeId,revision:1});const run=response.json();expect(response.statusCode).toBe(201);
  const signals=(await pool.query('SELECT id,direction FROM apcs_signals WHERE device_id=$1',[f.manifest.deviceId])).rows;
  await pool.query('UPDATE apcs_recipe_runs SET binding=$2 WHERE id=$1',[run.id,{deviceId:f.manifest.deviceId,temperatureSignalId:signals.find(s=>s.direction==='input').id,outputSignalId:signals.find(s=>s.direction==='output').id,projectRevision:1}]);
  await worker.activateRecipe(run.id,f.actor);
  await expect.poll(async()=>Number((await pool.query("SELECT count(*) AS n FROM apcs_commands WHERE actor_id=$1 AND snapshot->>'state'='Verified'",[`recipe:${run.id}`])).rows[0].n)).toBeGreaterThan(0);
  process.kill(worker.pid!,'SIGKILL');
  await expect.poll(async()=>{try{return (await worker.status(f.manifest.deviceId)).state;}catch{return 'exiting';}}).toBe('stopped');
  const {tickRecipes}=await import('../../apps/api/src/recipe-service.js');
  const state=(await pool.query('SELECT snapshot FROM apcs_recipe_runs WHERE id=$1',[run.id])).rows[0].snapshot;
  await tickRecipes(pool,state.lastAt+5001);
  const saved=(await pool.query('SELECT * FROM apcs_recipe_runs WHERE id=$1',[run.id])).rows[0];
  expect(saved.snapshot.status).toBe('Aborted');expect(saved.control.phase).toBe('Revoked');expect((await worker.status(f.manifest.deviceId)).state).toBe('stopped');
 }finally{await worker.close();}
},15000);
