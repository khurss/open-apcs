import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { SignalStore } from '../../../packages/domain/src/signals.js';
import { PgCommandJournal } from '../../../packages/storage/src/command-journal.js';
import { LedPeer } from '../../../packages/led-protocol/src/index.js';
import { MqttLedGateway, MqttLedSimulator } from '../../../packages/gateway/src/mqtt-led.js';
import { GraphTask } from '../../../packages/gateway/src/graph-task.js';
import { validateGraph } from '../../../packages/domain/src/logic.js';
import { canonicalJson } from '../../../packages/domain/src/screen.js';
import { LedRuntime } from '../../../packages/gateway/src/runtime.js';
import type { CommandContext, CommandRequest } from '../../../packages/domain/src/commands.js';
import type { SignalSnapshot } from '../../../packages/domain/src/signals.js';
export interface RuntimeStatus { deviceId: string; environment: 'Simulation'; state: 'stopped' | 'running' | 'faulted'; error: string | null; }
export interface GraphRuntimeStatus { graphId: string; revision: number | null; activationId: string | null; state: 'stopped' | 'running' | 'paused' | 'faulted'; error: string | null; cycles: number; }
export interface RuntimeControl {
  activateGraph(graphId: string, revision: number, actorId: string, activationId?: string): Promise<GraphRuntimeStatus>;
  stopGraph(graphId: string, activationId?: string): Promise<GraphRuntimeStatus>;
  graphStatus(graphId: string): Promise<GraphRuntimeStatus>;
  start(deviceId: string, actorId: string): Promise<RuntimeStatus>;
  stop(deviceId: string): Promise<RuntimeStatus>;
  status(deviceId: string): Promise<RuntimeStatus>;
  readSignal(signalId: string): Promise<SignalSnapshot>;
  context(request: CommandRequest): Promise<CommandContext>;
  close(): Promise<void>;
}
interface Catalog { deviceId: string; signalId: string; projectId: string; kind: string; revision: number; ownerId: string; protocolDeviceId: string; }
interface Entry { catalog: Catalog; runtime: LedRuntime; gateway: MqttLedGateway; simulator: MqttLedSimulator; stopping: boolean; stopPromise: Promise<void> | null; policy: Pick<CommandContext, 'ownerId' | 'projectRevision' | 'maxTtlMs' | 'interlockReason'>; }
interface GraphEntry { revision: number; activationId: string; ownerId: string; task: GraphTask; }
const disconnected = (): SignalSnapshot => ({ value: null, quality: 'Disconnected', bootId: null, sourceTime: null, receivedTime: null, sequence: null });
const lockKey = "hashtextextended(current_schema() || ':open-apcs-simulation-runtime', 0)";
/** Virtual devices only. Control authority is volatile and must be explicitly rearmed after restart. */
export class SimulationRuntime implements RuntimeControl {
  private readonly clock = { monotonicNow: () => performance.now(), wallNow: () => new Date() };
  private readonly signals = new SignalStore(this.clock);
  private readonly registered = new Set<string>();
  private readonly entries = new Map<string, Entry>();
  private readonly graphs = new Map<string, GraphEntry>();
  private readonly journal: PgCommandJournal;
  private lock: PoolClient | null = null;
  private closed = false;
  private lockLost = false;
  private operations: Promise<void> = Promise.resolve();
  constructor(private readonly pool: Pool, private readonly mqttUrl: string) { this.journal = new PgCommandJournal(pool); }
  private serial<T>(work: () => Promise<T>): Promise<T> { const result = this.operations.then(work); this.operations = result.then(() => {}, () => {}); return result; }
  start(deviceId: string, actorId: string): Promise<RuntimeStatus> { return this.serial(async () => {
    if (this.closed || this.lockLost) throw new Error('Runtime is closed or lost ownership');
    const found = await this.pool.query<Catalog>(`SELECT d.id AS "deviceId", s.id AS "signalId", d.project_id AS "projectId", d.kind, d.protocol_device_id AS "protocolDeviceId", p.revision, p.owner_id AS "ownerId" FROM apcs_devices d JOIN apcs_signals s ON s.device_id=d.id JOIN apcs_projects p ON p.id=d.project_id WHERE d.id=$1 AND s.direction='output'`, [deviceId]);
    const catalog = found.rows[0]; if (!catalog) throw new Error('Device not found');
    if (catalog.ownerId !== actorId) throw new Error('Project owner required');
    if (catalog.kind !== 'virtual-led') throw new Error('Only virtual LED profiles are supported by the simulation runtime');
    const prior = this.entries.get(deviceId);
    if (prior?.runtime.status.state === 'running' && !prior.stopping) return this.status(deviceId);
    if ([...this.entries.values()].filter((entry) => entry.runtime.status.state === 'running').length >= 16) throw new Error('Initial runtime limit is 16 active virtual devices');
    await this.acquire();
    if (prior) await this.stopEntry(prior);
    if (!this.registered.has(catalog.signalId)) { this.signals.register({ id: catalog.signalId, deviceId, dataType: 'boolean', freshnessMs: 3000 }); this.registered.add(catalog.signalId); }
    // A random simulation namespace cannot target a catalog's physical MQTT address.
    const connection = { url: this.mqttUrl, siteId: randomUUID(), deviceId, protocolDeviceId: catalog.protocolDeviceId, signalId: catalog.signalId };
    const startAt = performance.now(); const simulator = new MqttLedSimulator(connection, new LedPeer(() => performance.now() - startAt, randomUUID()));
    const policy: Entry['policy'] = { ownerId: actorId, projectRevision: catalog.revision, maxTtlMs: 3000, interlockReason: null };
    const gateway = new MqttLedGateway(connection, this.signals, this.journal, this.clock, () => ({ ...policy, interlockReason: this.lockLost || this.closed ? 'Runtime ownership unavailable' : policy.interlockReason }));
    const entry = { catalog, simulator, gateway, policy, stopping: false, stopPromise: null } as Entry;
    entry.runtime = new LedRuntime({ start: () => gateway.start(), stop: () => gateway.stop(),
      synchronize: async () => { await this.refresh(entry); await gateway.synchronize(); },
      dispatchNext: async () => { await this.refresh(entry); return gateway.dispatchNext(); },
    }, () => performance.now());
    this.entries.set(deviceId, entry);
    try { await simulator.start(); await entry.runtime.start(); }
    catch (error) { await this.stopEntry(entry); throw error; }
    return this.status(deviceId);
  }); }
  stop(deviceId: string): Promise<RuntimeStatus> { return this.serial(async () => { const entry = this.entries.get(deviceId); if (entry) await this.stopEntry(entry); return this.status(deviceId); }); }
  async status(deviceId: string): Promise<RuntimeStatus> {
    const entry = this.entries.get(deviceId); const state = entry?.runtime.status ?? { state: 'stopped' as const, error: null };
    return { deviceId, environment: 'Simulation', ...state, ...(this.lockLost ? { state: 'faulted' as const, error: 'Runtime ownership lost; restart the service before rearming' } : {}) };
  }
  async readSignal(signalId: string): Promise<SignalSnapshot> {
    if (!this.registered.has(signalId)) return disconnected();
    const sample = this.signals.get(signalId); if (this.closed || this.lockLost) sample.quality = 'Disconnected'; return sample;
  }
  async context(request: CommandRequest): Promise<CommandContext> {
    const entry = [...this.entries.values()].find((item) => item.catalog.signalId === request.targetSignalId);
    if (entry && !entry.stopping && entry.runtime.status.state === 'running' && !this.closed && !this.lockLost) { await this.refresh(entry); return entry.gateway.context(request); }
    const found = await this.pool.query<{ revision: number }>('SELECT p.revision FROM apcs_signals s JOIN apcs_devices d ON d.id=s.device_id JOIN apcs_projects p ON p.id=d.project_id WHERE s.id=$1', [request.targetSignalId]);
    return { bootId: null, quality: 'Disconnected', ownerId: null, projectRevision: found.rows[0]?.revision ?? 1, maxTtlMs: 3000, interlockReason: 'Virtual device is not running' };
  }
  close(): Promise<void> { return this.serial(async () => {
    if (this.closed) return; this.closed = true;
    await Promise.allSettled([...this.graphs.values()].map((entry) => entry.task.stop()));
    await Promise.allSettled([...this.entries.values()].map((entry) => this.stopEntry(entry)));
    const lock = this.lock; this.lock = null;
    if (lock) { try { await lock.query(`SELECT pg_advisory_unlock(${lockKey})`); } catch {} finally { lock.release(true); } }
  }); }
  activateGraph(id: string, revision: number, actorId: string, activationId: string = randomUUID()): Promise<GraphRuntimeStatus> { return this.serial(async () => {
    if (this.closed || this.lockLost) throw new Error('Runtime is closed or lost ownership');
    const found = await this.pool.query<{ name: string; document: unknown; checksum: string; projectId: string; ownerId: string; projectRevision: number }>(`SELECT r.name,r.document,r.checksum,d.project_id AS "projectId",p.owner_id AS "ownerId",p.revision AS "projectRevision" FROM apcs_document_revisions r JOIN apcs_documents d ON d.id=r.document_id JOIN apcs_projects p ON p.id=d.project_id WHERE d.id=$1 AND r.revision=$2 AND d.kind='graph'`, [id, revision]);
    const saved = found.rows[0]; if (!saved) throw new Error('Prepared graph revision not found');
    if (saved.ownerId !== actorId) throw new Error('Project owner required');
    if (createHash('sha256').update(canonicalJson({ name: saved.name, document: saved.document })).digest('hex') !== saved.checksum) throw new Error('Prepared graph revision checksum mismatch');
    const graph = validateGraph(saved.document);
    if (!graph.nodes.length) throw new Error('Prepared graph revision is empty');
    const prior = this.graphs.get(id); const outputs: Entry[] = [];
    for (const node of graph.nodes) {
      if (!node.signalId) continue;
      const entry = [...this.entries.values()].find((item) => item.catalog.signalId === node.signalId);
      if (!entry || entry.catalog.projectId !== saved.projectId || entry.stopping || entry.runtime.status.state !== 'running' || (await this.readSignal(node.signalId)).quality !== 'Good') throw new Error('All graph devices must be running in this project');
      if (node.kind === 'output') {
        if (entry.policy.ownerId !== actorId && entry.policy.ownerId !== prior?.ownerId) throw new Error('Output belongs to another owner');
        outputs.push(entry);
      }
    }
    const ownerId = `graph:${id}:${activationId}`;
    const task = new GraphTask(graph, {
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
    this.graphs.set(id, { revision, activationId, ownerId, task });
    await task.start();
    return this.graphStatus(id);
  }); }
  stopGraph(id: string, activationId?: string): Promise<GraphRuntimeStatus> { return this.serial(async () => { const graph = this.graphs.get(id); if (graph && (!activationId || activationId === graph.activationId)) await graph.task.stop(); return this.graphStatus(id); }); }
  async graphStatus(id: string): Promise<GraphRuntimeStatus> {
    const graph = this.graphs.get(id); const status = graph?.task.status;
    return { graphId: id, revision: graph?.revision ?? null, activationId: graph?.activationId ?? null, state: status?.state ?? 'stopped', error: status?.error ?? null, cycles: status?.cycles ?? 0 };
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
    entry.stopPromise = (async () => { try { await entry.runtime.stop(); } finally { await entry.simulator.stop(); } })();
    return entry.stopPromise;
  }
}
