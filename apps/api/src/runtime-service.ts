import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { SignalStore } from '../../../packages/domain/src/signals.js';
import { PgCommandJournal } from '../../../packages/storage/src/command-journal.js';
import { LedPeer } from '../../../packages/led-protocol/src/index.js';
import { MqttLedGateway, MqttLedSimulator } from '../../../packages/gateway/src/mqtt-led.js';
import { LedRuntime } from '../../../packages/gateway/src/runtime.js';
import type { CommandContext, CommandRequest } from '../../../packages/domain/src/commands.js';
import type { SignalSnapshot } from '../../../packages/domain/src/signals.js';
export interface RuntimeStatus { deviceId: string; environment: 'Simulation'; state: 'stopped' | 'running' | 'faulted'; error: string | null; }
export interface RuntimeControl {
  start(deviceId: string, actorId: string): Promise<RuntimeStatus>;
  stop(deviceId: string): Promise<RuntimeStatus>;
  status(deviceId: string): Promise<RuntimeStatus>;
  readSignal(signalId: string): Promise<SignalSnapshot>;
  context(request: CommandRequest): Promise<CommandContext>;
  close(): Promise<void>;
}
interface Catalog { deviceId: string; signalId: string; projectId: string; kind: string; revision: number; ownerId: string; protocolDeviceId: string; }
interface Entry { catalog: Catalog; runtime: LedRuntime; gateway: MqttLedGateway; simulator: MqttLedSimulator; stopping: boolean; policy: Pick<CommandContext, 'ownerId' | 'projectRevision' | 'maxTtlMs' | 'interlockReason'>; }
const disconnected = (): SignalSnapshot => ({ value: null, quality: 'Disconnected', bootId: null, sourceTime: null, receivedTime: null, sequence: null });
const lockKey = "hashtextextended(current_schema() || ':open-apcs-simulation-runtime', 0)";
/** Virtual devices only. Control authority is volatile and must be explicitly rearmed after restart. */
export class SimulationRuntime implements RuntimeControl {
  private readonly clock = { monotonicNow: () => performance.now(), wallNow: () => new Date() };
  private readonly signals = new SignalStore(this.clock);
  private readonly registered = new Set<string>();
  private readonly entries = new Map<string, Entry>();
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
    const entry = { catalog, simulator, gateway, policy, stopping: false } as Entry;
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
    await Promise.allSettled([...this.entries.values()].map((entry) => this.stopEntry(entry)));
    const lock = this.lock; this.lock = null;
    if (lock) { try { await lock.query(`SELECT pg_advisory_unlock(${lockKey})`); } catch {} finally { lock.release(true); } }
  }); }
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
  private async stopEntry(entry: Entry) {
    entry.stopping = true;
    try { await entry.runtime.stop(); } finally { await entry.simulator.stop(); }
  }
}
