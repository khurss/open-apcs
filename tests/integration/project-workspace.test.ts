import { randomUUID } from 'node:crypto';
import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import { Pool } from 'pg';
import { createApi } from '../../apps/api/src/app.js';
import { bootstrapAdmin, migrateApplication } from '../../apps/api/src/store.js';
import { validateGraph } from '../../packages/domain/src/logic.js';
import { validateScreen } from '../../packages/domain/src/screen.js';
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


describe('project workspace and demo', () => {
  it('installs one stopped virtual demo per owner, prepares bound documents and preserves edits on reopen', async () => {
    await setup();
    const install = () => app!.inject({method:'POST',url:'/api/v1/demo',headers:headers(),payload:{}});
    const responses = await Promise.all([install(), install()]);
    expect(responses.map(r=>r.statusCode).sort()).toEqual([200,201]);
    const demo = responses[0]!.json(); expect(responses[1]!.json()).toEqual(demo);
    const devices = (await pool.query('SELECT * FROM apcs_devices WHERE project_id=$1',[demo.projectId])).rows;
    expect(devices.map(d=>d.kind).sort()).toEqual(['virtual-led','virtual-thermal']);
    const docs = (await pool.query('SELECT * FROM apcs_documents WHERE project_id=$1',[demo.projectId])).rows;
    expect(docs).toHaveLength(4);
    for(const doc of docs) {
      if(doc.kind==='graph') validateGraph(doc.document,true); else validateScreen(doc.document);
      const prepared = (await pool.query('SELECT document,checksum FROM apcs_document_revisions WHERE document_id=$1',[doc.id])).rows;
      expect(prepared).toHaveLength(1); expect(prepared[0].document).toEqual(doc.document); expect(prepared[0].checksum).toHaveLength(64);
    }
    expect((await pool.query('SELECT count(*)::int AS n FROM apcs_commands')).rows[0].n).toBe(0);
    await pool.query("UPDATE apcs_projects SET name='My customized demo' WHERE id=$1",[demo.projectId]);
    expect((await install()).json()).toEqual(demo);
    expect((await pool.query('SELECT name FROM apcs_projects WHERE id=$1',[demo.projectId])).rows[0].name).toBe('My customized demo');
    expect((await pool.query("SELECT count(*)::int AS n FROM apcs_audit WHERE action='demo.installed'")).rows[0].n).toBe(1);
    const other = randomUUID(); await pool.query("INSERT INTO apcs_users(id,username,password_hash) VALUES($1,'other-owner','fixture')",[other]);
    await pool.query('UPDATE apcs_sessions SET user_id=$1',[other]);
    const another = await install(); expect(another.statusCode).toBe(201); expect(another.json().projectId).not.toBe(demo.projectId);
  });
  it('filters catalog before pagination and edits metadata with optimistic concurrency and owner isolation', async () => {
    await setup(); const first = (await project('First')).json(); const second = (await project('Second')).json();
    const add = (projectId:string,name:string) => app!.inject({method:'POST',url:'/api/v1/devices',headers:headers(),payload:{projectId,name,siteId:'catalog',deviceId:randomUUID(),kind:'virtual-led'}});
    const a = (await add(first.id,'First lamp')).json(); const b = (await add(second.id,'Second lamp')).json();
    for(const kind of ['devices','signals']) {
      const response = await app!.inject({url:`/api/v1/${kind}?projectId=${second.id}&q=Second&limit=1`,headers:headers()});
      expect(response.statusCode).toBe(200); expect(response.json().items).toHaveLength(1);
      expect(response.json().items[0].id).toBe(kind==='devices'?b.id:b.signalId); expect(response.json().nextCursor).toBeNull();
    }
    for(const [kind,id] of [['devices',a.id],['signals',a.signalId]]) {
      const edit = (revision:number,name:string) => app!.inject({method:'PATCH',url:`/api/v1/${kind}/${id}`,headers:{...headers(),'if-match':`"${revision}"`},payload:{name}});
      const result = await edit(1,'Renamed'); expect(result.statusCode).toBe(200); expect(result.json()).toMatchObject({name:'Renamed',revision:2});
      expect((await edit(1,'Lost update')).statusCode).toBe(412);
      expect((await app!.inject({method:'PATCH',url:`/api/v1/${kind}/${id}`,headers:headers(),payload:{name:'No precondition'}})).statusCode).toBe(428);
    }
    const other = randomUUID(); await pool.query("INSERT INTO apcs_users(id,username,password_hash) VALUES($1,'other-owner','fixture')",[other]); await pool.query('UPDATE apcs_sessions SET user_id=$1',[other]);
    expect((await app!.inject({url:`/api/v1/devices?projectId=${first.id}`,headers:headers()})).json().items).toEqual([]);
    expect((await app!.inject({method:'PATCH',url:`/api/v1/devices/${a.id}`,headers:{...headers(),'if-match':'"2"'},payload:{name:'Hijacked'}})).statusCode).toBe(404);
  });
});

it('creates a bounded virtual input bank atomically with owned numeric inputs', async () => {
  await setup(); const projectId = (await project()).json().id;
  const input = {projectId,name:'Sensor bank',kind:'virtual-input-bank',siteId:'bank',deviceId:'bank',inputCount:15};
  const result = await app!.inject({method:'POST',url:'/api/v1/devices',headers:headers(),payload:input});
  expect(result.statusCode).toBe(201);
  const device = result.json(); expect(device.inputSignalIds).toHaveLength(15);
  const rows = (await pool.query('SELECT * FROM apcs_signals WHERE device_id=$1',[device.id])).rows;
  expect(rows).toHaveLength(16);
  expect(rows.filter(s=>s.direction==='input').every(s=>s.data_type==='float64')).toBe(true);
  expect(new Set(device.inputSignalIds).size).toBe(15);
  for (const inputCount of [0,16,1.5]) {
    expect((await app!.inject({method:'POST',url:'/api/v1/devices',headers:headers(),payload:{...input,deviceId:randomUUID(),inputCount}})).statusCode).toBe(400);
  }
  expect((await app!.inject({method:'POST',url:'/api/v1/devices',headers:headers(),payload:{...input,kind:'virtual-led',deviceId:'wrong'}})).statusCode).toBe(400);
  expect((await pool.query('SELECT count(*)::int AS n FROM apcs_devices')).rows[0].n).toBe(1);
});

it('uses bounded bank defaults, enforces ownership and rolls back channels when audit fails',async()=>{
  await setup();const projectId=(await project()).json().id;
  const input={projectId,name:'Bank',kind:'virtual-input-bank',siteId:'bank-default',deviceId:'default'};
  const create=(payload:Record<string,unknown>,custom=headers())=>app!.inject({method:'POST',url:'/api/v1/devices',headers:custom,payload});
  expect((await create(input,{origin,cookie,'x-csrf-token':'wrong'})).statusCode).toBe(403);
  expect((await create({...input,projectId:randomUUID()})).statusCode).toBe(404);
  expect((await create(input)).json().inputSignalIds).toHaveLength(15);
  expect((await create({...input,deviceId:'one',inputCount:1})).json().inputSignalIds).toHaveLength(1);
  await pool.query("CREATE FUNCTION reject_bank_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Audit unavailable'; END $$");
  await pool.query('CREATE TRIGGER reject_bank_audit BEFORE INSERT ON apcs_audit FOR EACH ROW EXECUTE FUNCTION reject_bank_audit()');
  expect((await create({...input,deviceId:'rollback'})).statusCode).toBe(500);
  expect((await pool.query('SELECT count(*)::int AS n FROM apcs_devices')).rows[0].n).toBe(2);
  expect((await pool.query('SELECT count(*)::int AS n FROM apcs_signals')).rows[0].n).toBe(18);
});

it('persists numeric presentation without changing control metadata and rejects invalid or conflicting edits',async()=>{
  await setup();const projectId=(await project()).json().id;
  const device=(await app!.inject({method:'POST',url:'/api/v1/devices',headers:headers(),payload:{projectId,name:'Temperature',siteId:'units',deviceId:'units',kind:'virtual-thermal'}})).json();
  const id=device.temperatureSignalId;
  const edit=(payload:Record<string,unknown>,revision=1,signalId=id)=>app!.inject({method:'PATCH',url:`/api/v1/signals/${signalId}`,headers:{...headers(),'if-match':`"${revision}"`},payload});
  const changed=await edit({name:'Room temperature',unit:'°C',displayDecimals:1});
  expect(changed.statusCode).toBe(200);expect(changed.json()).toMatchObject({unit:'°C',displayDecimals:1,revision:2,dataType:'float64',direction:'input'});
  expect((await edit({name:'Conflicting',unit:'K',displayDecimals:0})).statusCode).toBe(412);
  for(const payload of [{name:'Invalid',unit:'x'.repeat(25)},{name:'Invalid',displayDecimals:7},{name:'Invalid',displayDecimals:-1},{name:'Invalid',unit:'line\nbreak'}]) expect((await edit(payload,2)).statusCode).toBe(400);
  expect((await edit({name:'Boolean',unit:'V',displayDecimals:1},1,device.signalId)).statusCode).toBe(422);
  expect((await edit({name:'Renamed'},2)).json()).toMatchObject({unit:'°C',displayDecimals:1,revision:3});
  const signals=(await app!.inject({url:`/api/v1/signals?projectId=${projectId}`,headers:headers()})).json().items;
  expect(signals.find((s:{id:string})=>s.id===id)).toMatchObject({unit:'°C',displayDecimals:1});
  const other=randomUUID();await pool.query("INSERT INTO apcs_users(id,username,password_hash) VALUES($1,'units-other','fixture')",[other]);await pool.query('UPDATE apcs_sessions SET user_id=$1',[other]);
  expect((await edit({name:'Foreign',unit:'K'},3)).statusCode).toBe(404);
});
