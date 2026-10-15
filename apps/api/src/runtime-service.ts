import {RecipeTask} from '../../../packages/gateway/src/recipe-task.js';
import {saveRecipeRun,type RecipeRun} from './recipe-service.js';
import {transaction} from './store.js';
import { MqttInputBank } from '../../../packages/gateway/src/input-bank.js';
import type { GraphEvaluation } from '../../../packages/domain/src/graph-evaluation.js';
import { MqttThermalProcess } from '../../../packages/gateway/src/thermal-process.js';
import { ScriptClient } from '../../../packages/script-runtime/src/client.js';
import { AlarmService, type AlarmAction, type AlarmServiceStatus } from './alarm-service.js';
import { HistoryService, type HistoryStatus } from './history-service.js';
import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { SignalStore } from '../../../packages/domain/src/signals.js';
import { PgCommandJournal } from '../../../packages/storage/src/command-journal.js';
import { LedPeer } from '../../../packages/led-protocol/src/index.js';
import { MqttLedGateway, MqttLedSimulator } from '../../../packages/gateway/src/mqtt-led.js';
import { parsePhysicalConfig, physicalConnection, type PhysicalConfig } from '../../../packages/gateway/src/physical-config.js';
import { GraphTask, type GraphTiming } from '../../../packages/gateway/src/graph-task.js';
import { validateGraph } from '../../../packages/domain/src/logic.js';
import { canonicalJson } from '../../../packages/domain/src/screen.js';
import { LedRuntime } from '../../../packages/gateway/src/runtime.js';
import type { CommandContext, CommandRequest } from '../../../packages/domain/src/commands.js';
import type { SignalSnapshot } from '../../../packages/domain/src/signals.js';
export interface RuntimeStatus { commissionedGpio?: number; transport?: import('../../../packages/gateway/src/transport-trace.js').TraceSnapshot | null; telemetry?: import('../../../packages/gateway/src/latency.js').LatencySummary | null; deviceId: string; environment: 'Simulation' | 'Hardware bench'; state: 'stopped' | 'running' | 'faulted'; error: string | null; }
export interface GraphRuntimeStatus { timing: GraphTiming | null; graphId: string; revision: number | null; activationId: string | null; state: 'stopped' | 'running' | 'paused' | 'faulted'; error: string | null; cycles: number; pending: string[]; evaluation: GraphEvaluation | null; }
export interface RuntimeControl {
  activateRecipe?(runId:string,actorId:string):Promise<void>;
  stopRecipe?(runId:string,reason:string):Promise<void>;
  alarmStatus(): Promise<AlarmServiceStatus>;
  alarmAction(id: string, actor: string, action: AlarmAction): Promise<void>;
  historyStatus(): Promise<HistoryStatus>;
  activateGraph(graphId: string, revision: number, actorId: string, activationId?: string): Promise<GraphRuntimeStatus>;
  stopGraph(graphId: string, activationId?: string): Promise<GraphRuntimeStatus>;
  graphStatus(graphId: string): Promise<GraphRuntimeStatus>;
  start(deviceId: string, actorId: string): Promise<RuntimeStatus>;
  startPhysical(deviceId: string, actorId: string, gpio: number): Promise<RuntimeStatus>;
  stop(deviceId: string): Promise<RuntimeStatus>;
  status(deviceId: string, trace?: boolean): Promise<RuntimeStatus>;
  readSignal(signalId: string): Promise<SignalSnapshot>;
  readSignals?(signalIds: string[]): Promise<Record<string, SignalSnapshot>>;
  context(request: CommandRequest): Promise<CommandContext>;
  close(): Promise<void>;
}
interface Catalog { siteId: string; deviceId: string; signalId: string; projectId: string; kind: string; revision: number; ownerId: string; protocolDeviceId: string; }
interface Entry { physicalGpio: number | null; inputSignalIds: string[]; temperatureSignalId: string | null; process: MqttThermalProcess | MqttInputBank | null; processError: string | null; catalog: Catalog; runtime: LedRuntime; gateway: MqttLedGateway; simulator: MqttLedSimulator | null; stopping: boolean; stopPromise: Promise<void> | null; policy: Pick<CommandContext, 'ownerId' | 'projectRevision' | 'maxTtlMs' | 'interlockReason'>; }
interface GraphEntry { blocks: GraphEvaluation['blocks']; revision: number; activationId: string; ownerId: string; task: GraphTask; }
const disconnected = (): SignalSnapshot => ({ value: null, quality: 'Disconnected', bootId: null, sourceTime: null, receivedTime: null, sequence: null });
const lockKey = "hashtextextended(current_schema() || ':open-apcs-simulation-runtime', 0)";
/** Virtual devices and explicitly commissioned LED benches. Control authority is volatile and must be explicitly rearmed after restart. */
export class SimulationRuntime implements RuntimeControl {
  private readonly clock = { monotonicNow: () => performance.now(), wallNow: () => new Date() };
  private readonly signals = new SignalStore(this.clock);
  private readonly registered = new Set<string>();
  private readonly entries = new Map<string, Entry>();
  private readonly recipes = new Map<string,RecipeTask>();
  private readonly graphs = new Map<string, GraphEntry>();
  private readonly journal: PgCommandJournal;
  private readonly alarms: AlarmService;
  private readonly history: HistoryService;
  private lock: PoolClient | null = null;
  private closed = false;
  private lockLost = false;
  private operations: Promise<void> = Promise.resolve();
  private readonly physicalConfig: PhysicalConfig | undefined;
  constructor(private readonly pool: Pool, private readonly mqttUrl: string, physicalConfig?: PhysicalConfig, private readonly scripts?: ScriptClient) { this.physicalConfig = physicalConfig ? parsePhysicalConfig(physicalConfig) : undefined; this.alarms = new AlarmService(pool, (id) => this.registered.has(id) && !this.closed && !this.lockLost ? this.signals.get(id) : disconnected()); this.journal = new PgCommandJournal(pool); this.history = new HistoryService(pool, this.signals, () => this.registered); }
  private serial<T>(work: () => Promise<T>): Promise<T> { const result = this.operations.then(work); this.operations = result.then(() => {}, () => {}); return result; }
  /** Start read-only monitoring under the same exclusive workspace ownership as control. */
  startMonitoring(): Promise<void> { return this.serial(async () => {
    if (this.closed || this.lockLost) throw new Error('Runtime is closed or lost ownership');
    await this.acquire(); this.history.start(); this.alarms.start();
  }); }
  start(deviceId: string, actorId: string): Promise<RuntimeStatus> { return this.startDevice(deviceId, actorId); }
  startPhysical(deviceId: string, actorId: string, gpio: number): Promise<RuntimeStatus> { return this.startDevice(deviceId, actorId, { gpio }); }
  private startDevice(deviceId: string, actorId: string, physical?: { gpio: number }): Promise<RuntimeStatus> { return this.serial(async () => {
    if (this.closed || this.lockLost) throw new Error('Runtime is closed or lost ownership');
    const found = await this.pool.query<Catalog>(`SELECT d.site_id AS "siteId", d.id AS "deviceId", s.id AS "signalId", d.project_id AS "projectId", d.kind, d.protocol_device_id AS "protocolDeviceId", p.revision, p.owner_id AS "ownerId" FROM apcs_devices d JOIN apcs_signals s ON s.device_id=d.id JOIN apcs_projects p ON p.id=d.project_id WHERE d.id=$1 AND s.direction='output'`, [deviceId]);
    const catalog = found.rows[0]; if (!catalog) throw new Error('Device not found');
    if (catalog.ownerId !== actorId) throw new Error('Project owner required');
    if (!physical && !['virtual-led', 'virtual-thermal', 'virtual-input-bank'].includes(catalog.kind)) throw new Error('Only virtual profiles are supported by the simulation runtime');
    if (physical && catalog.kind !== 'esp32-led') throw new Error('Physical commissioning requires an ESP32 LED profile');
    if (physical && !this.physicalConfig) throw new Error('Physical connection is not configured');
    // Validate the reviewed address and pin before even accepting an idempotent start.
    const physicalLink = physical ? physicalConnection(this.physicalConfig!, { siteId: catalog.siteId, deviceId: catalog.protocolDeviceId, signalId: catalog.signalId }, physical.gpio) : null;
    const temperatures = ['virtual-thermal','virtual-input-bank'].includes(catalog.kind) ? await this.pool.query<{ id: string }>("SELECT id FROM apcs_signals WHERE device_id=$1 AND direction='input' AND data_type='float64' ORDER BY id", [deviceId]) : null;
    if (catalog.kind === 'virtual-thermal' && temperatures?.rows.length !== 1) throw new Error('Virtual thermal profile requires exactly one numeric sensor');
    const inputSignalIds = temperatures?.rows.map(row=>row.id) ?? [];
    if (catalog.kind === 'virtual-input-bank' && (inputSignalIds.length < 1 || inputSignalIds.length > 15)) throw new Error('Input bank requires 1–15 numeric inputs');
    const temperatureSignalId = catalog.kind === 'virtual-thermal' ? inputSignalIds[0]! : null;
    const prior = this.entries.get(deviceId);
    if (prior?.runtime.status.state === 'running' && !prior.stopping) return this.status(deviceId);
    if ([...this.entries.values()].filter((entry) => entry.runtime.status.state === 'running').length >= 16) throw new Error('Initial runtime limit is 16 active devices');
    await this.acquire();
    if (prior) await this.stopEntry(prior);
    if (!this.registered.has(catalog.signalId)) { this.signals.register({ id: catalog.signalId, deviceId, dataType: 'boolean', freshnessMs: 3000 }); this.registered.add(catalog.signalId); }
    for (const id of inputSignalIds) if (!this.registered.has(id)) { this.signals.register({ id, deviceId, dataType: 'float64', freshnessMs: 3000 }); this.registered.add(id); }
    // A random simulation namespace cannot target a catalog's physical MQTT address.
    const connection = physicalLink ? { ...physicalLink, deviceId, protocolDeviceId: catalog.protocolDeviceId } : { url: this.mqttUrl, siteId: randomUUID(), deviceId, protocolDeviceId: catalog.protocolDeviceId, signalId: catalog.signalId };
    // A surviving controller boot must never revive an old server intent.
    if (physical) await this.journal.connectionLost(catalog.signalId);
    const startAt = performance.now(); const bootId = randomUUID(); const simulator = physical ? null : new MqttLedSimulator(connection, new LedPeer(() => performance.now() - startAt, bootId));
    const policy: Entry['policy'] = { ownerId: actorId, projectRevision: catalog.revision, maxTtlMs: 3000, interlockReason: null };
    const gateway = new MqttLedGateway(connection, this.signals, this.journal, this.clock, () => ({ ...policy, interlockReason: this.lockLost || this.closed ? 'Runtime ownership unavailable' : policy.interlockReason }));
    const entry = { physicalGpio: physical?.gpio ?? null, catalog, simulator, gateway, policy, inputSignalIds, temperatureSignalId, process: null, processError: null, stopping: false, stopPromise: null } as Entry;
    entry.runtime = new LedRuntime({ start: () => gateway.start(), stop: () => gateway.stop(),
      synchronize: async () => { await this.refresh(entry); await gateway.synchronize(); },
      dispatchNext: async () => { await this.refresh(entry); return gateway.dispatchNext(); },
    }, () => performance.now());
    if (temperatureSignalId && simulator) entry.process = new MqttThermalProcess({ ...connection, temperatureSignalId }, bootId, () => simulator.peer.read(), this.signals, (reason) => { entry.processError = reason; void this.stopEntry(entry).catch(() => {}); });
    if (catalog.kind === 'virtual-input-bank' && simulator) entry.process = new MqttInputBank({...connection,inputSignalIds},bootId,this.signals,(reason)=>{entry.processError=reason;void this.stopEntry(entry).catch(()=>{});});
    this.entries.set(deviceId, entry);
    try {
      await simulator?.start(); await entry.runtime.start(); await entry.process?.start();
      if (physical) { const initial = this.signals.get(catalog.signalId); if (initial.quality !== 'Good' || initial.value !== false) throw new Error('Physical commissioning did not verify an OFF output'); }
      this.history.start(); this.alarms.start();
    }
    catch (error) { await this.stopEntry(entry); throw error; }
    return this.status(deviceId);
  }); }
  stop(deviceId: string): Promise<RuntimeStatus> { return this.serial(async () => { const entry = this.entries.get(deviceId); if (entry) await this.stopEntry(entry); return this.status(deviceId); }); }
  async status(deviceId: string, trace = false): Promise<RuntimeStatus> {
    const entry = this.entries.get(deviceId); const state = entry?.runtime.status ?? { state: 'stopped' as const, error: null };
    const kind = entry?.catalog.kind ?? (await this.pool.query<{ kind: string }>('SELECT kind FROM apcs_devices WHERE id=$1', [deviceId])).rows[0]?.kind;
    return { ...(entry?.physicalGpio !== null && entry?.physicalGpio !== undefined ? { commissionedGpio: entry.physicalGpio } : {}), ...(trace ? {transport: entry?.gateway.transport ?? null} : {}), ...(entry ? {telemetry: entry.gateway.diagnostics.telemetry} : {}), deviceId, environment: kind === 'esp32-led' ? 'Hardware bench' : 'Simulation', ...state, ...(entry?.processError ? { state: 'faulted' as const, error: entry.processError } : {}), ...(this.lockLost ? { state: 'faulted' as const, error: 'Runtime ownership lost; restart the service before rearming' } : {}) };
  }
  async readSignal(signalId: string): Promise<SignalSnapshot> {
    if (!this.registered.has(signalId)) return disconnected();
    const sample = this.signals.get(signalId); if (this.closed || this.lockLost) sample.quality = 'Disconnected'; return sample;
  }
  async readSignals(signalIds: string[]): Promise<Record<string, SignalSnapshot>> {
    if (!signalIds.length || signalIds.length > 100 || new Set(signalIds).size !== signalIds.length) throw new Error('Invalid signal batch');
    return Object.fromEntries(await Promise.all(signalIds.map(async id => [id, await this.readSignal(id)] as const)));
  }
  async context(request: CommandRequest): Promise<CommandContext> {
    const entry = [...this.entries.values()].find((item) => item.catalog.signalId === request.targetSignalId);
    if (entry && !entry.stopping && entry.runtime.status.state === 'running' && !this.closed && !this.lockLost) { await this.refresh(entry); return entry.gateway.context(request); }
    const found = await this.pool.query<{ revision: number }>('SELECT p.revision FROM apcs_signals s JOIN apcs_devices d ON d.id=s.device_id JOIN apcs_projects p ON p.id=d.project_id WHERE s.id=$1', [request.targetSignalId]);
    return { bootId: null, quality: 'Disconnected', ownerId: null, projectRevision: found.rows[0]?.revision ?? 1, maxTtlMs: 3000, interlockReason: 'Device is not running' };
  }
  close(): Promise<void> { return this.serial(async () => {
    if (this.closed) return; this.closed = true;
    await Promise.allSettled([...this.recipes.values()].map(task=>task.stop('Recipe runtime stopped')));
    await Promise.allSettled([...this.graphs.values()].map((entry) => entry.task.stop()));
    await Promise.allSettled([...this.entries.values()].map((entry) => this.stopEntry(entry)));
    await this.alarms.close();
    await this.history.close();
    const lock = this.lock; this.lock = null;
    if (lock) { try { await lock.query(`SELECT pg_advisory_unlock(${lockKey})`); } catch {} finally { lock.release(true); } }
  }); }
  activateRecipe(runId:string,actorId:string):Promise<void>{return this.serial(async()=>{
    if(this.closed||this.lockLost)throw new Error('Recipe runtime unavailable');
    const run=(await this.pool.query<RecipeRun>('SELECT r.* FROM apcs_recipe_runs r JOIN apcs_projects p ON p.id=r.project_id WHERE r.id=$1 AND p.owner_id=$2',[runId,actorId])).rows[0];
    if(!run?.binding||run.snapshot.status!=='Running')throw new Error('Recipe run unavailable');
    const binding=run.binding;const entry=this.entries.get(binding.deviceId);
    if(!entry||entry.catalog.kind!=='virtual-thermal'||entry.catalog.projectId!==run.project_id||entry.catalog.signalId!==binding.outputSignalId||entry.temperatureSignalId!==binding.temperatureSignalId||entry.stopping||entry.runtime.status.state!=='running')throw new Error('Recipe requires a running virtual thermal device');
    if(entry.policy.ownerId!==actorId)throw new Error('Output belongs to another owner');
    await this.refresh(entry);
    if(entry.policy.projectRevision!==binding.projectRevision)throw new Error('Recipe project revision changed');
    const temperature=await this.readSignal(binding.temperatureSignalId),output=await this.readSignal(binding.outputSignalId);
    if(temperature.quality!=='Good'||typeof temperature.value!=='number'||output.quality!=='Good'||output.value!==false)throw new Error('Recipe requires Good telemetry and an OFF output');
    const unfinished=await this.pool.query("SELECT id FROM apcs_commands WHERE target_signal_id=$1 AND (snapshot->>'state' IN ('Accepted','Dispatched','DeviceAccepted') OR (snapshot->>'state'='Unknown' AND reconciliation IS NULL)) LIMIT 1",[binding.outputSignalId]);
    if(unfinished.rowCount)throw new Error('Recipe output has unresolved commands');
    for(const [id,task] of this.recipes)if(task.finished)this.recipes.delete(id);
    const ownerId=`recipe:${runId}`;
    const task=new RecipeTask({...run.snapshot,temperatureC:temperature.value}, {
      read:async()=>{
        if(entry.policy.ownerId!==ownerId||entry.stopping||this.closed||this.lockLost)throw new Error('Recipe output ownership unavailable');
        const input=await this.readSignal(binding.temperatureSignalId),output=await this.readSignal(binding.outputSignalId);
        return {temperature:input.value as number,output:output.value as boolean,quality:input.quality==='Good'?output.quality:input.quality,bootId:input.bootId===output.bootId?input.bootId:null};
      },
      request:async value=>{
        if(entry.policy.ownerId!==ownerId||entry.stopping)throw new Error('Recipe output ownership unavailable');
        const active=await this.pool.query("SELECT id FROM apcs_recipe_runs WHERE id=$1 AND snapshot->>'status'='Running'",[runId]);
        if(!active.rowCount)throw new Error('Recipe run is no longer active');
        const request:CommandRequest={id:randomUUID(),idempotencyKey:randomUUID(),actorId:ownerId,targetSignalId:binding.outputSignalId,value,ttlMs:2000,expectedProjectRevision:binding.projectRevision,reason:`Recipe ${run.recipe_id} v${run.revision} run ${runId}`};
        return this.journal.request(request,await this.context(request));
      },
      command:id=>this.journal.get(id),
      save:(snapshot,control)=>transaction(this.pool,async client=>{
        const current=(await client.query<RecipeRun>('SELECT * FROM apcs_recipe_runs WHERE id=$1 FOR UPDATE',[runId])).rows[0];
        if(!current||current.snapshot.status!=='Running')return false;
        await saveRecipeRun(client,current,snapshot,Date.now());
        await client.query('UPDATE apcs_recipe_runs SET control=$2 WHERE id=$1',[runId,control]);return true;
      }),
      revoke:async()=>{if(entry.policy.ownerId===ownerId){entry.policy.ownerId=null;await this.stopEntry(entry);}},
    });
    entry.policy.ownerId=ownerId;this.recipes.set(runId,task);task.start();
  });}
  stopRecipe(runId:string,reason:string):Promise<void>{return this.serial(async()=>{await this.recipes.get(runId)?.stop(reason);});}
  activateGraph(id: string, revision: number, actorId: string, activationId: string = randomUUID()): Promise<GraphRuntimeStatus> { return this.serial(async () => {
    if (this.closed || this.lockLost) throw new Error('Runtime is closed or lost ownership');
    const found = await this.pool.query<{ name: string; document: unknown; checksum: string; projectId: string; ownerId: string; projectRevision: number }>(`SELECT r.name,r.document,r.checksum,d.project_id AS "projectId",p.owner_id AS "ownerId",p.revision AS "projectRevision" FROM apcs_document_revisions r JOIN apcs_documents d ON d.id=r.document_id JOIN apcs_projects p ON p.id=d.project_id WHERE d.id=$1 AND r.revision=$2 AND d.kind='graph'`, [id, revision]);
    const saved = found.rows[0]; if (!saved) throw new Error('Prepared graph revision not found');
    if (saved.ownerId !== actorId) throw new Error('Project owner required');
    if (createHash('sha256').update(canonicalJson({ name: saved.name, document: saved.document })).digest('hex') !== saved.checksum) throw new Error('Prepared graph revision checksum mismatch');
    const graph = validateGraph(saved.document);
    if (!graph.nodes.length) throw new Error('Prepared graph revision is empty');
    for (const node of graph.nodes.filter((node) => node.kind === 'script')) {
      if (!this.scripts) throw new Error('Script evaluator is unavailable');
      await this.scripts.validate({ source: node.source!, language: node.language! });
    }
    const prior = this.graphs.get(id); const outputs: Entry[] = [];
    for (const node of graph.nodes) {
      if (!node.signalId) continue;
      const entry = [...this.entries.values()].find((item) => item.catalog.signalId === node.signalId || item.inputSignalIds.includes(node.signalId!));
      if (node.kind === 'analog' && (!entry || !entry.inputSignalIds.includes(node.signalId))) throw new Error('Numeric input drivers are not available in the current runtime profile');
      if (!entry || entry.catalog.projectId !== saved.projectId || entry.stopping || entry.runtime.status.state !== 'running' || (await this.readSignal(node.signalId)).quality !== 'Good') throw new Error('All graph devices must be running in this project');
      if (node.kind === 'output') {
        if (entry.policy.ownerId !== actorId && entry.policy.ownerId !== prior?.ownerId) throw new Error('Output belongs to another owner');
        outputs.push(entry);
      }
    }
    const ownerId = `graph:${id}:${activationId}`;
    const task = new GraphTask(graph, {
      ...(this.scripts ? { evaluate: this.scripts.evaluate.bind(this.scripts) } : {}),
      read: async (ids) => Object.fromEntries(await Promise.all(ids.map(async (signalId) => [signalId, await this.readSignal(signalId)]))),
      request: async (targetSignalId, value) => {
        const entry = outputs.find((item) => item.catalog.signalId === targetSignalId);
        if (!entry || entry.policy.ownerId !== ownerId) throw new Error('Graph output ownership unavailable');
        const request: CommandRequest = { id: randomUUID(), idempotencyKey: randomUUID(), actorId: ownerId, targetSignalId, value, expectedProjectRevision: saved.projectRevision, ttlMs: 2000, reason: `Graph ${id} revision ${revision}` };
        return this.journal.request(request, await this.context(request));
      },
      command: (commandId) => this.journal.get(commandId),
      revoke: async () => { await Promise.all(outputs.map(async (entry) => { if (entry.policy.ownerId === ownerId) { entry.policy.ownerId = null; await this.stopEntry(entry); } })); },
    }, () => performance.now());
    if (prior && ['running', 'paused'].includes(prior.task.status.state)) {
      await prior.task.pause();
      try {
        const deadline = performance.now() + 2500;
        for (const commandId of prior.task.status.pending) {
          for (;;) {
            const state = (await this.journal.get(commandId)).state;
            if (state === 'Verified') break;
            if (!['Accepted', 'Dispatched', 'DeviceAccepted'].includes(state) || performance.now() >= deadline) throw new Error('Previous graph commands could not be verified');
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
        }
      } catch (error) { await prior.task.stop(); throw error; }
    }
    // Transfer shared outputs before revoking the old generation. Removed outputs stop.
    for (const entry of outputs) entry.policy.ownerId = ownerId;
    if (prior) await prior.task.stop();
    this.graphs.set(id, { revision, activationId, ownerId, task, blocks: graph.nodes.map(({ id, label, kind }) => ({ id, label, kind })) });
    await task.start();
    return this.graphStatus(id);
  }); }
  stopGraph(id: string, activationId?: string): Promise<GraphRuntimeStatus> { return this.serial(async () => { const graph = this.graphs.get(id); if (graph && (!activationId || activationId === graph.activationId)) await graph.task.stop(); return this.graphStatus(id); }); }
  async alarmStatus(): Promise<AlarmServiceStatus> { return this.alarms.status; }
  async alarmAction(id: string, actor: string, action: AlarmAction): Promise<void> { await this.alarms.action(id, actor, action); }
  async historyStatus(): Promise<HistoryStatus> { return this.history.status; }
  async graphStatus(id: string): Promise<GraphRuntimeStatus> {
    const graph = this.graphs.get(id); const status = graph?.task.status;
    return { timing: status?.timing ?? null, graphId: id, revision: graph?.revision ?? null, activationId: graph?.activationId ?? null, state: status?.state ?? 'stopped', error: status?.error ?? null, cycles: status?.cycles ?? 0, pending: status?.pending ?? [], evaluation: status?.last && status.lastEvaluatedAt && graph ? { at: status.lastEvaluatedAt, cycle: status.cycles, blocks: structuredClone(graph.blocks), result: status.last } : null };
  }
  private async acquire() {
    if (this.lock) return;
    const client = await this.pool.connect();
    try {
      const result = await client.query<{ owned: boolean }>(`SELECT pg_try_advisory_lock(${lockKey}) AS owned`);
      if (!result.rows[0]!.owned) throw new Error('Another runtime has ownership of this workspace');
      this.lock = client; client.on('error', () => { this.lockLost = true; void this.close(); });
    } catch (error) { client.release(true); throw error; }
  }
  private async refresh(entry: Entry) {
    if (!this.lock || this.closed || this.lockLost || entry.stopping) throw new Error('Runtime ownership unavailable');
    try {
      const found = await this.lock.query<{ revision: number; owner_id: string }>('SELECT revision, owner_id FROM apcs_projects WHERE id=$1', [entry.catalog.projectId]);
      const project = found.rows[0];
      if (!project || project.owner_id !== entry.catalog.ownerId) throw new Error('Project ownership changed');
      entry.policy.projectRevision = project.revision;
    } catch (error) { this.lockLost = true; void this.close(); throw error; }
  }
  private stopEntry(entry: Entry): Promise<void> {
    if (entry.stopPromise) return entry.stopPromise;
    entry.stopping = true;
    entry.stopPromise = (async () => { try { await entry.process?.stop(); } finally { try { await entry.runtime.stop(); } finally { await entry.simulator?.stop(); } } })();
    return entry.stopPromise;
  }
}
