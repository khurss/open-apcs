import { createHash, randomUUID } from 'node:crypto';
import { canonicalJson } from '../../packages/domain/src/screen.js';
import { Pool } from 'pg';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { RuntimeProcess } from '../../apps/api/src/runtime-process.js';
import { SimulationRuntime, type RuntimeControl } from '../../apps/api/src/runtime-service.js';
import { migrateApplication } from '../../apps/api/src/store.js';
import { PgCommandJournal } from '../../packages/storage/src/command-journal.js';
import type { CommandRequest } from '../../packages/domain/src/commands.js';
let admin: Pool; let pool: Pool; let schema: string; let runtime: SimulationRuntime; let other: RuntimeControl | undefined;
let deviceId: string; let signalId: string; let actorId: string; let projectId: string; let journal: PgCommandJournal;
beforeEach(async () => {
  const connectionString = process.env.APCS_TEST_POSTGRES_URL; if (!connectionString || !process.env.APCS_TEST_MQTT_URL) throw new Error('Docker fixtures required');
  schema = `runtime_${randomUUID().replaceAll('-', '')}`; admin = new Pool({ connectionString }); await admin.query(`CREATE SCHEMA ${schema}`);
  pool = new Pool({ connectionString, options: `-c search_path=${schema}`, connectionTimeoutMillis: 1000, query_timeout: 2000 }); await migrateApplication(pool); journal = new PgCommandJournal(pool); await journal.migrate();
  actorId = randomUUID(); projectId = randomUUID(); deviceId = randomUUID(); signalId = randomUUID();
  await pool.query('INSERT INTO apcs_users (id,username,password_hash) VALUES ($1,$2,$3)', [actorId, 'fixture', 'fixture-only']);
  await pool.query('INSERT INTO apcs_projects (id,name,owner_id) VALUES ($1,$2,$3)', [projectId, 'Runtime bench', actorId]);
  await pool.query('INSERT INTO apcs_devices (id,project_id,name,kind,site_id,protocol_device_id) VALUES ($1,$2,$3,$4,$5,$6)', [deviceId, projectId, 'Virtual LED', 'virtual-led', 'bench', 'wire-led']);
  await pool.query('INSERT INTO apcs_signals (id,device_id,name,data_type,direction) VALUES ($1,$2,$3,$4,$5)', [signalId, deviceId, 'LED', 'boolean', 'output']);
  runtime = new SimulationRuntime(pool, process.env.APCS_TEST_MQTT_URL); other = undefined;
});
afterEach(async () => { await runtime?.close(); await other?.close(); await pool?.end(); if (admin) { try { await admin.query(`DROP SCHEMA ${schema} CASCADE`); } finally { await admin.end(); } } });
const request = (): CommandRequest => ({ id: randomUUID(), idempotencyKey: randomUUID(), actorId, targetSignalId: signalId, value: true, expectedProjectRevision: 1, ttlMs: 2000, reason: 'Runtime test' });
async function waitFor(check: () => Promise<boolean>) { const end = performance.now() + 3000; while (performance.now() < end) { if (await check()) return; await new Promise((r) => setTimeout(r, 15)); } throw new Error('Runtime condition timed out'); }
async function prepared(value: boolean, id = randomUUID(), revision = 1) {
  const document = { schemaVersion: 1, nodes: [{ id: 'constant', kind: 'constant', value, label: 'Power', x: 0, y: 0 }, { id: 'output', kind: 'output', signalId, label: 'LED', x: 100, y: 0 }], edges: [{ id: 'wire', source: 'constant', target: 'output', port: 'in' }] };
  const name = 'Runtime graph'; const checksum = createHash('sha256').update(canonicalJson({ name, document })).digest('hex');
  await pool.query("INSERT INTO apcs_documents (id,project_id,kind,name,document,revision) VALUES ($1,$2,'graph',$3,$4,$5) ON CONFLICT (id) DO UPDATE SET document=$4, revision=$5", [id, projectId, name, document, revision]);
  await pool.query('INSERT INTO apcs_document_revisions (document_id,revision,name,document,checksum,actor_id) VALUES ($1,$2,$3,$4,$5,$6)', [id, revision, name, document, checksum, actorId]);
  return id;
}
describe('catalog-driven simulation runtime', () => {
  it('archives signal edges and disconnection without browser reads', async () => {
    await runtime.start(deviceId, actorId);
    const input = request(); await journal.request(input, await runtime.context(input));
    await waitFor(async () => (await journal.get(input.id)).state === 'Verified');
    await waitFor(async () => !!(await pool.query("SELECT 1 FROM apcs_signal_history WHERE signal_id=$1 AND snapshot->>'value'='true'", [signalId])).rowCount);
    await runtime.stop(deviceId);
    await waitFor(async () => !!(await pool.query("SELECT 1 FROM apcs_signal_history WHERE signal_id=$1 AND snapshot->>'quality'='Disconnected' AND snapshot->>'value'='true'", [signalId])).rowCount);
    expect((await runtime.historyStatus()).written).toBeGreaterThan(0);
  });
  it('keeps control running when history storage fails and retries its bounded buffer after recovery', async () => {
    await pool.query("CREATE FUNCTION deny_history() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Fixture archive offline'; END $$");
    await pool.query('CREATE TRIGGER deny_history BEFORE INSERT ON apcs_signal_history FOR EACH ROW EXECUTE FUNCTION deny_history()');
    await runtime.start(deviceId, actorId); const input = request(); await journal.request(input, await runtime.context(input));
    await waitFor(async () => (await journal.get(input.id)).state === 'Verified');
    await waitFor(async () => (await runtime.historyStatus()).failures > 0);
    expect((await runtime.status(deviceId)).state).toBe('running');
    await pool.query('DROP TRIGGER deny_history ON apcs_signal_history');
    await waitFor(async () => { const status = await runtime.historyStatus(); return status.written > 0 && status.queued === 0; });
  });

  it('executes a prepared graph headlessly and prevents manual control from bypassing graph ownership', async () => {
    const id = await prepared(true); await runtime.start(deviceId, actorId);
    expect(await runtime.activateGraph(id, 1, actorId)).toMatchObject({ state: 'running', revision: 1 });
    await waitFor(async () => (await runtime.readSignal(signalId)).value === true);
    const manual = request(); expect((await journal.request(manual, await runtime.context(manual))).state).toBe('Rejected');
    await runtime.stopGraph(id); expect((await runtime.graphStatus(id)).state).toBe('stopped');
    expect((await runtime.readSignal(signalId)).quality).toBe('Disconnected');
  });
  it('switches graph revisions after draining commands while retaining the device session', async () => {
    const id = await prepared(true); await runtime.start(deviceId, actorId); const boot = (await runtime.readSignal(signalId)).bootId;
    await runtime.activateGraph(id, 1, actorId); await waitFor(async () => (await runtime.readSignal(signalId)).value === true);
    await prepared(false, id, 2); expect((await runtime.activateGraph(id, 2, actorId)).revision).toBe(2);
    await waitFor(async () => (await runtime.readSignal(signalId)).value === false);
    expect((await runtime.readSignal(signalId)).bootId).toBe(boot); expect((await runtime.status(deviceId)).state).toBe('running');
  });
  it('keeps the previous graph running when a requested revision does not exist', async () => {
    const id = await prepared(true); await runtime.start(deviceId, actorId); await runtime.activateGraph(id, 1, actorId);
    await expect(runtime.activateGraph(id, 99, actorId)).rejects.toThrow(/revision/i);
    expect(await runtime.graphStatus(id)).toMatchObject({ revision: 1, state: 'running' });
  });
  it('rejects competing output owners, unstarted devices, and a forged activation actor', async () => {
    const id = await prepared(true); await expect(runtime.activateGraph(id, 1, actorId)).rejects.toThrow(/running/i);
    await runtime.start(deviceId, actorId); await expect(runtime.activateGraph(id, 1, randomUUID())).rejects.toThrow(/owner/i);
    await runtime.activateGraph(id, 1, actorId); const competing = await prepared(false);
    await expect(runtime.activateGraph(competing, 1, actorId)).rejects.toThrow(/owner/i);
    expect((await runtime.graphStatus(id)).state).toBe('running');
  });

  it('does not let delayed compensation stop a newer activation', async () => {
    const id = await prepared(true); await runtime.start(deviceId, actorId);
    const first = await runtime.activateGraph(id, 1, actorId);
    const second = await runtime.activateGraph(id, 1, actorId);
    await runtime.stopGraph(id, first.activationId!);
    expect(await runtime.graphStatus(id)).toMatchObject({ state: 'running', activationId: second.activationId });
    await runtime.stopGraph(id, second.activationId!);
    expect((await runtime.graphStatus(id)).state).toBe('stopped');
  });
  it('rejects a corrupted prepared checksum before disturbing the active revision', async () => {
    const id = await prepared(true); await runtime.start(deviceId, actorId); await runtime.activateGraph(id, 1, actorId);
    const document = { schemaVersion: 1, nodes: [], edges: [] };
    await pool.query('INSERT INTO apcs_document_revisions (document_id,revision,name,document,checksum,actor_id) VALUES ($1,2,$2,$3,$4,$5)', [id, 'Corrupted import', document, '0'.repeat(64), actorId]);
    await expect(runtime.activateGraph(id, 2, actorId)).rejects.toThrow(/checksum/i);
    expect(await runtime.graphStatus(id)).toMatchObject({ revision: 1, state: 'running' });
  });

  it('executes in a separate process and does not rearm after its process is killed', async () => {
    const client = new RuntimeProcess({ connectionString: process.env.APCS_TEST_POSTGRES_URL!, mqttUrl: process.env.APCS_TEST_MQTT_URL!, databaseOptions: `-c search_path=${schema}` }); other = client;
    expect((await client.start(deviceId, actorId)).state).toBe('running'); expect(client.pid).toBeTypeOf('number'); expect(client.pid).not.toBe(process.pid);
    const input = request(); await journal.request(input, await client.context(input));
    await waitFor(async () => (await journal.get(input.id)).state === 'Verified');
    process.kill(client.pid!, 'SIGKILL');
    await waitFor(async () => { try { return (await client.readSignal(signalId)).quality === 'Disconnected'; } catch { return false; } });
    expect((await client.context(request())).quality).toBe('Disconnected');
    expect((await client.status(deviceId)).state).toBe('stopped');
  });

  it('starts only on demand and verifies a durable command without browser polling', async () => {
    expect((await runtime.readSignal(signalId)).quality).toBe('Disconnected');
    expect(await runtime.start(deviceId, actorId)).toMatchObject({ state: 'running', environment: 'Simulation' });
    expect(await runtime.readSignal(signalId)).toMatchObject({ quality: 'Good', value: false });
    const input = request(); expect((await journal.request(input, await runtime.context(input))).state).toBe('Accepted');
    await waitFor(async () => (await journal.get(input.id)).state === 'Verified');
    expect(await runtime.readSignal(signalId)).toMatchObject({ value: true, quality: 'Good' });
  });
  it('rejects physical profiles and an actor who does not own the project', async () => {
    await expect(runtime.start(deviceId, randomUUID())).rejects.toThrow(/owner/i);
    await pool.query("UPDATE apcs_devices SET kind='esp32-led' WHERE id=$1", [deviceId]);
    await expect(runtime.start(deviceId, actorId)).rejects.toThrow(/virtual/i);
    expect((await runtime.readSignal(signalId)).quality).toBe('Disconnected');
  });
  it('allows only one runtime owner for the workspace and releases ownership on close', async () => {
    await runtime.start(deviceId, actorId); other = new SimulationRuntime(pool, process.env.APCS_TEST_MQTT_URL!);
    await expect(other.start(deviceId, actorId)).rejects.toThrow(/owner/i);
    await runtime.close(); expect((await other.start(deviceId, actorId)).state).toBe('running');
  });
  it('stops explicitly, disconnects quality, and cancels pending intents instead of replaying them', async () => {
    await runtime.start(deviceId, actorId);
    const firstBoot = (await runtime.readSignal(signalId)).bootId;
    const pending = request(); await journal.request(pending, await runtime.context(pending));
    await runtime.stop(deviceId);
    expect(['Accepted', 'Dispatched', 'DeviceAccepted']).not.toContain((await journal.get(pending.id)).state);
    expect(await runtime.status(deviceId)).toMatchObject({ state: 'stopped' });
    expect((await runtime.readSignal(signalId)).quality).toBe('Disconnected');
    expect((await journal.request(request(), await runtime.context(request()))).state).toBe('Rejected');
    await runtime.start(deviceId, actorId); expect((await runtime.readSignal(signalId)).bootId).not.toBe(firstBoot);
    expect((await runtime.readSignal(signalId)).value).toBe(false);
  });
  it('reports a fault and disconnects signals when its database ownership session is terminated', async () => {
    await runtime.start(deviceId, actorId);
    const lock = await pool.query<{ pid: number }>(`WITH key AS (SELECT hashtextextended(current_schema() || ':open-apcs-simulation-runtime', 0) AS value) SELECT pid FROM pg_locks, key WHERE locktype='advisory' AND granted AND classid::bigint=((key.value >> 32) & 4294967295) AND objid::bigint=(key.value & 4294967295)`);
    expect(lock.rows).toHaveLength(1);
    await admin.query('SELECT pg_terminate_backend($1)', [lock.rows[0]!.pid]);
    await waitFor(async () => (await runtime.readSignal(signalId)).quality === 'Disconnected');
    expect((await runtime.status(deviceId)).state).toBe('faulted');
    await expect(runtime.start(deviceId, actorId)).rejects.toThrow(/ownership/i);
  });
  it('reads current project revisions and refuses commands from a stale browser', async () => {
    await runtime.start(deviceId, actorId); await pool.query('UPDATE apcs_projects SET revision=2 WHERE id=$1', [projectId]);
    const input = request(); expect((await runtime.context(input)).projectRevision).toBe(2);
    expect((await journal.request(input, await runtime.context(input))).state).toBe('Rejected');
  });
});

async function unavailableAlarm() {
  const id = randomUUID();
  await pool.query('INSERT INTO apcs_alarms(id,project_id,signal_id,name,priority,definition) VALUES($1,$2,$3,$4,$5,$6)', [id, projectId, signalId, 'Device unavailable', 'high', { condition: { kind: 'quality', values: ['Disconnected'] }, activationDelayMs: 0, returnDelayMs: 0 }]);
  return id;
}
it('monitors unavailable catalog signals before any device is armed and requires exclusive ownership', async () => {
  const id = await unavailableAlarm();
  await runtime.startMonitoring(); await runtime.startMonitoring();
  await waitFor(async () => (await pool.query('SELECT state FROM apcs_alarms WHERE id=$1', [id])).rows[0].state.active);
  expect(await runtime.alarmStatus()).toMatchObject({ state: 'running', rules: 1 });
  expect((await runtime.status(deviceId)).state).toBe('stopped');
  expect((await pool.query('SELECT count(*) FROM apcs_commands')).rows[0].count).toBe('0');
  expect(await runtime.readSignal(signalId)).toMatchObject({ quality: 'Disconnected', value: null });
  const competitor = new SimulationRuntime(pool, process.env.APCS_TEST_MQTT_URL!); other = competitor;
  await expect(competitor.startMonitoring()).rejects.toThrow(/owner/i);
  expect((await competitor.alarmStatus()).state).toBe('stopped');
  await runtime.close(); await competitor.startMonitoring();
  expect((await competitor.alarmStatus()).state).toBe('running');
});
it('stops passive monitoring when its ownership database session is terminated', async () => {
  await unavailableAlarm(); await runtime.startMonitoring();
  const lock = await pool.query<{ pid: number }>(`WITH key AS (SELECT hashtextextended(current_schema() || ':open-apcs-simulation-runtime', 0) AS value) SELECT pid FROM pg_locks, key WHERE locktype='advisory' AND granted AND classid::bigint=((key.value >> 32) & 4294967295) AND objid::bigint=(key.value & 4294967295)`);
  expect(lock.rows).toHaveLength(1); await admin.query('SELECT pg_terminate_backend($1)', [lock.rows[0]!.pid]);
  await waitFor(async () => (await runtime.alarmStatus()).state !== 'running');
  await expect(runtime.startMonitoring()).rejects.toThrow(/ownership/i);
});
it('supervises passive monitoring across worker death without browser calls or restoring graph authority', async () => {
  const id = await unavailableAlarm(); const graph = await prepared(true);
  const client = new RuntimeProcess({ connectionString: process.env.APCS_TEST_POSTGRES_URL!, mqttUrl: process.env.APCS_TEST_MQTT_URL!, databaseOptions: `-c search_path=${schema}` }); other = client;
  client.enableMonitoring();
  await waitFor(async () => (await pool.query('SELECT state FROM apcs_alarms WHERE id=$1', [id])).rows[0].state.active);
  await client.alarmAction(id, actorId, { kind: 'acknowledge', occurrence: 1, reason: 'Inspected before arming' });
  await client.start(deviceId, actorId); await client.activateGraph(graph, 1, actorId);
  await waitFor(async () => (await client.readSignal(signalId)).value === true);
  await waitFor(async () => !(await pool.query('SELECT state FROM apcs_alarms WHERE id=$1', [id])).rows[0].state.active);
  const beforePid = client.pid!; process.kill(beforePid, 'SIGKILL');
  const deadline = performance.now() + 18000;
  let recovered = false;
  // Only database observations: no IPC read is allowed to spawn the replacement worker.
  while (performance.now() < deadline) {
    if (client.pid && client.pid !== beforePid && (await pool.query('SELECT state FROM apcs_alarms WHERE id=$1', [id])).rows[0].state.active) { recovered = true; break; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  expect(recovered).toBe(true);
  expect((await client.status(deviceId)).state).toBe('stopped');
  expect((await client.graphStatus(graph)).state).toBe('stopped');
  expect(await client.readSignal(signalId)).toMatchObject({ quality: 'Disconnected', value: null });
  expect((await client.context(request())).ownerId).toBe(null);
  await client.close(); expect(() => client.enableMonitoring()).toThrow(/closed/i);
}, 25000);

it('runs fifteen numeric bank inputs through MQTT and archives every channel before disconnecting them', async () => {
  await pool.query("UPDATE apcs_devices SET kind='virtual-input-bank' WHERE id=$1",[deviceId]);
  const ids = Array.from({length:15},()=>randomUUID()).sort();
  for (const [index,id] of ids.entries()) await pool.query("INSERT INTO apcs_signals(id,device_id,name,data_type,direction) VALUES($1,$2,$3,'float64','input')",[id,deviceId,`Input ${index}`]);
  await runtime.start(deviceId, actorId);
  const first = await runtime.readSignals(ids);
  for (const [index,id] of ids.entries()) expect(first[id]).toMatchObject({value:index*100,quality:'Good',sequence:0,bootId:(await runtime.readSignal(signalId)).bootId});
  await waitFor(async () => (await runtime.readSignal(ids[14]!)).sequence! > 0);
  await waitFor(async () => (await pool.query("SELECT count(DISTINCT signal_id)::int AS n FROM apcs_signal_history WHERE signal_id=ANY($1::uuid[]) AND snapshot->>'quality'='Good'",[ids])).rows[0].n===15);
  const input = request(); await journal.request(input, await runtime.context(input));
  await waitFor(async () => (await journal.get(input.id)).state==='Verified');
  const graphId=randomUUID(),name='Bank input control';
  const document={schemaVersion:1,nodes:[
    {id:'sensor',kind:'analog',signalId:ids[14],label:'Bank sensor',x:0,y:0},
    {id:'limit',kind:'number',value:2000,label:'Limit',x:0,y:100},
    {id:'compare',kind:'greater',label:'Above limit',x:150,y:0},
    {id:'output',kind:'output',signalId,label:'LED',x:300,y:0},
  ],edges:[{id:'a',source:'sensor',target:'compare',port:'a'},{id:'b',source:'limit',target:'compare',port:'b'},{id:'out',source:'compare',target:'output',port:'in'}]};
  const checksum=createHash('sha256').update(canonicalJson({name,document})).digest('hex');
  await pool.query("INSERT INTO apcs_documents(id,project_id,kind,name,document,revision) VALUES($1,$2,'graph',$3,$4,1)",[graphId,projectId,name,document]);
  await pool.query('INSERT INTO apcs_document_revisions(document_id,revision,name,document,checksum,actor_id) VALUES($1,1,$2,$3,$4,$5)',[graphId,name,document,checksum,actorId]);
  expect((await runtime.activateGraph(graphId,1,actorId)).state).toBe('running');
  await waitFor(async()=>(await runtime.readSignal(signalId)).value===false);
  await runtime.stopGraph(graphId);
  await runtime.stop(deviceId);
  for (const id of ids) expect((await runtime.readSignal(id)).quality).toBe('Disconnected');
});

it('keeps 200 virtual signals live and archived within thirteen input-bank devices', async () => {
  const devices:string[]=[];const signals:string[]=[];
  for(let bank=0;bank<13;bank++){
    const id=bank===0?deviceId:randomUUID();const output=bank===0?signalId:randomUUID();
    if(bank===0)await pool.query("UPDATE apcs_devices SET kind='virtual-input-bank' WHERE id=$1",[id]);
    else {
      await pool.query("INSERT INTO apcs_devices(id,project_id,name,kind,site_id,protocol_device_id) VALUES($1,$2,$3,'virtual-input-bank','bank-capacity',$4)",[id,projectId,`Bank ${bank}`,`bank-${bank}`]);
      await pool.query("INSERT INTO apcs_signals(id,device_id,name,data_type,direction) VALUES($1,$2,'Output','boolean','output')",[output,id]);
    }
    const inputs=Array.from({length:bank===12?7:15},()=>randomUUID()).sort();
    await pool.query("INSERT INTO apcs_signals(id,device_id,name,data_type,direction) SELECT id,$2,'Input','float64','input' FROM unnest($1::uuid[]) AS id",[inputs,id]);
    devices.push(id);signals.push(output,...inputs);
    await runtime.start(id,actorId);
  }
  expect(signals).toHaveLength(200);
  for(let offset=0;offset<200;offset+=100){
    const samples=Object.values(await runtime.readSignals(signals.slice(offset,offset+100)));
    expect(samples).toHaveLength(100);expect(samples.every(s=>s.quality==='Good')).toBe(true);
  }
  await waitFor(async()=>(await pool.query("SELECT count(DISTINCT signal_id)::int AS n FROM apcs_signal_history WHERE signal_id=ANY($1::uuid[]) AND snapshot->>'quality'='Good'",[signals])).rows[0].n===200);
  for(const id of devices)await runtime.stop(id);
  for(const id of signals)expect((await runtime.readSignal(id)).quality).toBe('Disconnected');
},30000);
