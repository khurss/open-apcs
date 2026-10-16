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




it('runs a frozen two-device program through MQTT and verifies both final outputs',async()=>{
 await setup();const projectId=(await project()).json().id;
 const post=(url:string,payload:Record<string,unknown>)=>app!.inject({method:'POST',url:'/api/v1'+url,headers:headers(),payload});
 const {recipePresets}=await import('../../packages/domain/src/recipe-presets.js');
 const ports:Record<string,string>={};const devices:string[]=[];
 for(const key of ['primary','secondary']){const device=(await post('/devices',{projectId,name:key,siteId:'universal',deviceId:key,kind:'virtual-led'})).json();ports[key]=device.signalId;devices.push(device.id);expect((await post(`/devices/${device.id}/runtime`,{action:'start',reason:'Universal test'})).statusCode).toBe(200);}
 const recipe=(await post(`/projects/${projectId}/recipes`,{name:'Sequential',parameters:recipePresets.find(p=>p.id==='sequential-start')!.program})).json();
 const started=await post(`/projects/${projectId}/recipe-runs`,{recipeId:recipe.id,revision:1,bindings:ports});expect(started.statusCode,started.body).toBe(201);const run=started.json();
 expect(run.binding.kind).toBe('universal');
 const changed=structuredClone(recipe.parameters);changed.steps[changed.steps.length-1].durationSeconds=30;
 expect((await post(`/projects/${projectId}/recipes`,{name:'Sequential edited',recipeId:recipe.id,expectedRevision:1,parameters:changed})).statusCode).toBe(201);
 expect(run.binding.ports.primary.signalId).toBe(ports.primary);

 const load=async()=>(await pool.query('SELECT * FROM apcs_recipe_runs WHERE id=$1',[run.id])).rows[0];
 await expect.poll(async()=>(await load()).snapshot.status,{timeout:12000}).toBe('Completed');
 expect((await load()).snapshot.parameters).toEqual(recipe.parameters);
 expect((await load()).revision).toBe(1);
 expect((await load()).control).toMatchObject({phase:'Verified OFF',outputs:{primary:{state:'Verified',value:false},secondary:{state:'Verified',value:false}}});
 const commands=(await pool.query('SELECT snapshot FROM apcs_commands WHERE actor_id=$1 ORDER BY created_at',[`recipe:${run.id}`])).rows.map(r=>r.snapshot);
 expect(commands).toHaveLength(4);expect(commands.every(c=>c.state==='Verified')).toBe(true);expect(commands.map(c=>c.value)).toEqual([true,true,false,false]);
 for(const id of devices)expect((await runtime.status(id)).state).toBe('stopped');
},20000);

it('installs an idempotent universal demo with two unarmed devices, frozen roles and a published screen',async()=>{
 await setup();const id=(await project('Universal demo')).json().id;
 const install=()=>app!.inject({method:'POST',url:`/api/v1/projects/${id}/universal-recipe-demo`,headers:headers(),payload:{}});
 const first=await install();expect(first.statusCode).toBe(201);const demo=first.json();
 const again=await install();expect(again.statusCode).toBe(200);expect(again.json()).toEqual(demo);
 expect(Object.keys(demo.bindings).sort()).toEqual(['primary','secondary']);
 expect((await pool.query('SELECT parameters FROM apcs_recipes WHERE id=$1',[demo.recipeId])).rows[0].parameters.schemaVersion).toBe(3);
 for(const deviceId of demo.deviceIds)expect((await runtime.status(deviceId)).state).toBe('stopped');
 expect((await pool.query('SELECT count(*) FROM apcs_recipe_runs')).rows[0].count).toBe('0');
 expect((await pool.query('SELECT count(*) FROM apcs_devices WHERE project_id=$1',[id])).rows[0].count).toBe('2');
});

async function universalDemo(){
 const projectId=(await project()).json().id;
 const post=(url:string,payload:Record<string,unknown>={})=>app!.inject({method:'POST',url:'/api/v1'+url,headers:headers(),payload});
 const response=await post(`/projects/${projectId}/universal-recipe-demo`);expect(response.statusCode,response.body).toBe(201);const manifest=response.json();
 const actor=(await pool.query('SELECT owner_id FROM apcs_projects WHERE id=$1',[projectId])).rows[0].owner_id;
 const start=(bindings=manifest.bindings)=>post(`/projects/${projectId}/recipe-runs`,{recipeId:manifest.recipeId,revision:1,bindings});
 return {projectId,post,manifest,actor,start};
}
it('validates exact typed same-project virtual bindings before any ownership transfer',async()=>{
 await setup();const f=await universalDemo();
 const foreignProject=(await project('Other')).json().id;
 const foreign=(await f.post('/devices',{projectId:foreignProject,name:'Foreign',siteId:'test',deviceId:'foreign',kind:'virtual-led'})).json();
 const physical=(await f.post('/devices',{projectId:f.projectId,name:'Physical',siteId:'test',deviceId:'physical',kind:'esp32-led'})).json();
 const thermal=(await f.post('/devices',{projectId:f.projectId,name:'Thermal',siteId:'test',deviceId:'thermal',kind:'virtual-thermal'})).json();
 for(const [bindings,status] of [[{},422],[{primary:f.manifest.bindings.primary},422],[{...f.manifest.bindings,extra:randomUUID()},422],[{...f.manifest.bindings,secondary:f.manifest.bindings.primary},422],[{...f.manifest.bindings,secondary:foreign.signalId},404],[{...f.manifest.bindings,secondary:physical.signalId},422],[{...f.manifest.bindings,secondary:thermal.temperatureSignalId},422]] as const){const r=await f.start(bindings);expect(r.statusCode,r.body).toBe(status);}
 expect((await pool.query('SELECT count(*) FROM apcs_recipe_runs')).rows[0].count).toBe('0');
});
it('reserves all outputs or none and prevents manual and graph writes until cancellation',async()=>{
 await setup();const f=await universalDemo();const {createDemoDocument}=await import('../../apps/api/src/demo-api.js');
 const client=await pool.connect();let graph:string;
 try{graph=await createDemoDocument(client,f.projectId,f.actor,'graph','Competing graph',{schemaVersion:1,nodes:[{id:'power',kind:'constant',label:'Power',value:false,x:0,y:0},{id:'out',kind:'output',label:'Secondary',signalId:f.manifest.bindings.secondary,x:100,y:0}],edges:[{id:'wire',source:'power',target:'out',port:'in'}]});}finally{client.release();}
 for(const id of f.manifest.deviceIds)await runtime.start(id,f.actor);await runtime.activateGraph(graph,1,f.actor);
 const rejected=await f.start();expect(rejected.statusCode,rejected.body).toBe(409);expect(rejected.json().message).toContain('another owner');
 expect((await runtime.graphStatus(graph)).state).toBe('running');
 const request={id:randomUUID(),idempotencyKey:randomUUID(),actorId:f.actor,targetSignalId:f.manifest.bindings.primary,value:false,ttlMs:2000,expectedProjectRevision:1,reason:'Check group ownership'};
 expect((await runtime.context(request)).ownerId).toBe(f.actor);
 expect((await pool.query("SELECT count(*) FROM apcs_commands WHERE actor_id LIKE 'recipe:%'")).rows[0].count).toBe('0');
 await runtime.stopGraph(graph);for(const id of f.manifest.deviceIds)await runtime.start(id,f.actor);
 const started=await f.start();expect(started.statusCode,started.body).toBe(201);const id=started.json().id;
 await expect(runtime.activateGraph(graph,1,f.actor)).rejects.toThrow('another owner');
 const {PgCommandJournal}=await import('../../packages/storage/src/command-journal.js');
 expect(await new PgCommandJournal(pool).request(request,await runtime.context(request))).toMatchObject({state:'Rejected',reason:'Output belongs to another owner'});
 expect((await f.post(`/projects/${f.projectId}/recipe-runs/${id}/cancel`)).json().snapshot.status).toBe('Aborted');
 for(const device of f.manifest.deviceIds)expect((await runtime.status(device)).state).toBe('stopped');
},15000);
it('revokes the complete output group after MQTT loss and does not resume',async()=>{
 const {mqttProxy}=await import('../helpers/mqtt-proxy.js');const proxy=await mqttProxy(process.env.APCS_TEST_MQTT_URL!);
 try{
  await setup(true,proxy.url);const f=await universalDemo();for(const id of f.manifest.deviceIds)await runtime.start(id,f.actor);
  const response=await f.start();expect(response.statusCode,response.body).toBe(201);const id=response.json().id;
  const load=async()=>(await pool.query('SELECT * FROM apcs_recipe_runs WHERE id=$1',[id])).rows[0];
  await expect.poll(async()=>Number((await pool.query("SELECT count(*) AS n FROM apcs_commands WHERE actor_id=$1 AND snapshot->>'state'='Verified'",[`recipe:${id}`])).rows[0].n)).toBeGreaterThan(0);
  proxy.disconnect();await expect.poll(async()=>(await load()).snapshot.status).toBe('Aborted');expect((await load()).control.phase).toBe('Revoked');
  for(const device of f.manifest.deviceIds)await expect.poll(async()=>(await runtime.status(device)).state).toBe('stopped');
  const {tickRecipes}=await import('../../apps/api/src/recipe-service.js');await tickRecipes(pool,Date.now()+6000);expect((await load()).snapshot.status).toBe('Aborted');
 }finally{await proxy.close();}
},15000);
it('uses measured numeric conditions and leaves read-only devices running after a timeout',async()=>{
 await setup();const f=await universalDemo();
 const thermal=(await f.post('/devices',{projectId:f.projectId,name:'Measured input',siteId:'test',deviceId:'measured',kind:'virtual-thermal'})).json();
 const parameters={schemaVersion:3,ports:[{key:'output',label:'Output',kind:'boolean-output'},{key:'temperature',label:'Temperature',kind:'number-input'}],steps:[{kind:'set',name:'Enable',port:'output',value:true,timeoutSeconds:2},{kind:'wait',name:'Unreachable target',port:'temperature',operator:'gte',value:100,timeoutSeconds:1}]};
 const recipe=await f.post(`/projects/${f.projectId}/recipes`,{name:'Timeout',parameters});expect(recipe.statusCode).toBe(201);
 await runtime.start(f.manifest.deviceIds[0],f.actor);await runtime.start(thermal.id,f.actor);
 const started=await f.post(`/projects/${f.projectId}/recipe-runs`,{recipeId:recipe.json().id,revision:1,bindings:{output:f.manifest.bindings.primary,temperature:thermal.temperatureSignalId}});expect(started.statusCode,started.body).toBe(201);
 const load=async()=>(await pool.query('SELECT snapshot FROM apcs_recipe_runs WHERE id=$1',[started.json().id])).rows[0].snapshot;
 await expect.poll(async()=>(await load()).status,{timeout:6000}).toBe('Aborted');expect((await load()).reason).toContain('condition timeout');expect((await load()).values.temperature).toBe(20);
 expect((await runtime.status(f.manifest.deviceIds[0])).state).toBe('stopped');expect((await runtime.status(thermal.id)).state).toBe('running');
},12000);
