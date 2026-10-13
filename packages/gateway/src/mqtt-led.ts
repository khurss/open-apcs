import {LatencyHistogram, type LatencySummary} from './latency.js';
import { randomUUID } from 'node:crypto';
import { connectAsync, type IClientOptions, type MqttClient } from 'mqtt';
import type { Clock, SignalStore } from '../../domain/src/signals.js';
import type { CommandContext, CommandRequest } from '../../domain/src/commands.js';
import type { PgCommandJournal } from '../../storage/src/command-journal.js';
import { decodeFrame, deviceTopic, GatewaySession, type LedPeer, type Frame } from '../../led-protocol/src/index.js';

export interface LedConnection {
  url: string; siteId: string; deviceId: string; signalId: string; protocolDeviceId?: string;
  credentials?: Pick<IClientOptions, 'username' | 'password' | 'ca' | 'cert' | 'key'>;
}
const clientOptions = (options: LedConnection): IClientOptions => ({
  ...options.credentials, protocolVersion: 5, clean: true, reconnectPeriod: 0,
  queueQoSZero: false, connectTimeout: 3000, properties: { maximumPacketSize: 8192 },
});

async function publish(client: MqttClient | null, topic: string, frame: Frame): Promise<void> {
  if (!client?.connected) throw new Error('MQTT connection unavailable');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      client.publishAsync(topic, JSON.stringify(frame), { qos: 1, retain: false, properties: { messageExpiryInterval: 1 } }),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('MQTT publication timeout')), 1000); }),
    ]);
  } finally { clearTimeout(timer); }
}

/** Protocol simulator only. Authentication and ACLs belong to the deployment. */
export class MqttLedSimulator {
  private client: MqttClient | null = null;
  private queue: Promise<void> = Promise.resolve();
  private queued = 0;
  private rejected = 0;

  constructor(private readonly options: LedConnection, readonly peer: LedPeer, private readonly dropAcks = false) {}

  async start(): Promise<void> {
    if (this.client) throw new Error('Simulator already started');
    const client = await connectAsync(this.options.url, clientOptions(this.options));
    this.client = client;
    client.on('message', (topic, payload, packet) => {
      if (topic !== deviceTopic(this.options.siteId, this.options.protocolDeviceId ?? this.options.deviceId, 'in')) return;
      if (this.queued >= 128) { this.rejected++; void client.endAsync(true); return; }
      this.queued++;
      this.queue = this.queue.then(async () => {
        const frame = decodeFrame(payload, packet.retain);
        const response = this.peer.receive(frame);
        if (response && !(this.dropAcks && response.kind === 'ack')) await this.send(response);
        if (frame.kind === 'write') await this.telemetry();
      }).catch(() => { this.rejected++; }).finally(() => { this.queued--; });
    });
    await client.subscribeAsync(deviceTopic(this.options.siteId, this.options.protocolDeviceId ?? this.options.deviceId, 'in'), { qos: 1, rap: true });
  }

  async stop(): Promise<void> {
    const client = this.client; this.client = null;
    await client?.endAsync(true); await this.queue;
  }
  async telemetry(): Promise<void> { await this.send(this.peer.telemetry()); }
  get rejectedFrames(): number { return this.rejected; }
  private send(frame: Frame): Promise<void> {
    return publish(this.client, deviceTopic(this.options.siteId, this.options.protocolDeviceId ?? this.options.deviceId, 'out'), frame);
  }
}

interface Waiter {
  nonce: string; kind: 'snapshot' | 'ready'; resolve(frame: Frame): void; reject(error: Error): void;
}

/** One configured LED output; no discovery-based trust or automatic reconnect/replay. */
export class MqttLedGateway {
  private client: MqttClient | null = null;
  private session: GatewaySession;
  private waiter: Waiter | null = null;
  private queue: Promise<void> = Promise.resolve();
  private loss: Promise<void> = Promise.resolve();
  private queued = 0;
  private rejectedFrames = 0;
  private lastError: string | null = null;
  private readonly telemetryTiming = new LatencyHistogram();
  private dispatching = false;
  private synchronizing = false;
  private establishedBoot: string | null = null;

  constructor(private readonly options: LedConnection, private readonly signals: SignalStore,
    private readonly journal: PgCommandJournal, private readonly clock: Clock,
    private readonly policy: () => Pick<CommandContext, 'projectRevision' | 'interlockReason' | 'ownerId' | 'maxTtlMs'>) {
    this.session = new GatewaySession(() => clock.monotonicNow(), randomUUID());
    deviceTopic(options.siteId, options.protocolDeviceId ?? options.deviceId, 'in');
  }

  async start(): Promise<void> {
    if (this.client) throw new Error('Gateway already started');
    await this.loss;
    this.establishedBoot = null;
    this.session = new GatewaySession(() => this.clock.monotonicNow(), randomUUID());
    const client = await connectAsync(this.options.url, clientOptions(this.options));
    this.client = client;
    client.on('close', () => this.invalidate());
    client.on('error', () => { this.lastError = 'MQTT connection error'; this.invalidate(); });
    client.on('message', (topic, payload, packet) => {
      if (topic !== deviceTopic(this.options.siteId, this.options.protocolDeviceId ?? this.options.deviceId, 'out')) return;
      const arrivedAt = this.clock.monotonicNow();
      const rejected = (error: unknown) => {
        this.rejectedFrames++; this.lastError = error instanceof Error ? error.message : 'Frame processing failed';
      };
      try {
        const frame = decodeFrame(payload, packet.retain);
        // Freshness/lease replies and current state must not wait for durable ACK I/O.
        if ((frame.kind === 'snapshot' || frame.kind === 'ready') && this.waiter?.kind === frame.kind && this.waiter.nonce === frame.nonce) {
          this.waiter.resolve(frame); return;
        }
        if (!this.session.active() || !('bootId' in frame) || frame.bootId !== this.session.bootId) return;
        if (frame.kind === 'telemetry' && frame.sessionId === this.session.sessionId && this.ingest(frame) === 'accepted') {
          this.telemetryTiming.record(this.clock.monotonicNow() - arrivedAt);
        }
        if (frame.kind === 'ack' && frame.sessionId === this.session.sessionId) {
          if (this.queued >= 128) { this.lastError = 'MQTT acknowledgement queue exhausted'; this.invalidate(); void client.endAsync(true); return; }
          this.queued++;
          this.queue = this.queue.then(async () => {
            const common = { id: frame.id, targetSignalId: this.options.signalId, bootId: frame.bootId };
            await this.journal.acknowledge(frame.status === 'applied'
              ? { ...common, status: 'applied', value: frame.value }
              : { ...common, status: 'failed', reason: frame.reason });
          }).catch(rejected).finally(() => { this.queued--; });
        }
      } catch (error) { rejected(error); }
    });
    await client.subscribeAsync(deviceTopic(this.options.siteId, this.options.protocolDeviceId ?? this.options.deviceId, 'out'), { qos: 1, rap: true });
  }

  async synchronize(): Promise<void> {
    if (this.synchronizing) throw new Error('Session synchronization already in progress');
    this.synchronizing = true;
    try {
      // Durable-journal availability is a prerequisite for renewing control authority.
      await this.journal.recoverExpired();
      const nonce = randomUUID();
      const snapshot = await this.exchange(this.session.probe(nonce), 'snapshot', nonce);
      if (snapshot.kind !== 'snapshot') throw new Error('Invalid snapshot');
      if (this.establishedBoot !== null && snapshot.bootId !== this.establishedBoot) {
        throw new Error('Device boot changed; explicit gateway restart required');
      }
      const ready = await this.exchange(this.session.snapshot(snapshot), 'ready', nonce);
      this.session.ready(ready);
      if (ready.kind !== 'ready') throw new Error('Invalid session reply');
      this.establishedBoot = ready.bootId;
      this.signals.beginSession(this.options.deviceId, ready.bootId);
      this.ingest(ready);
    } catch (error) {
      this.invalidate(); throw error;
    } finally { this.synchronizing = false; }
  }

  async stop(): Promise<void> {
    const client = this.client; this.client = null;
    this.invalidate();
    await client?.endAsync(true); await this.queue; await this.loss;
  }

  context(request: CommandRequest): CommandContext {
    const policy = this.policy();
    if (request.targetSignalId !== this.options.signalId) return { ...policy, bootId: null, quality: 'Disconnected' };
    return { ...policy, bootId: this.session.bootId,
      quality: this.session.active() ? this.signals.get(this.options.signalId).quality : 'Disconnected' };
  }

  async dispatchNext(): Promise<boolean> {
    if (this.dispatching) return false;
    this.dispatching = true;
    try {
      await this.journal.recoverExpired();
      const intent = await this.journal.claimNext(async (request) => this.context(request), this.options.signalId);
      if (!intent) return false;
      const context = this.context(intent.request);
      if (context.bootId !== intent.command.bootId || context.quality !== 'Good' ||
          context.interlockReason !== null || context.ownerId !== intent.request.actorId ||
          context.projectRevision !== intent.request.expectedProjectRevision || intent.request.ttlMs > context.maxTtlMs) {
        await this.journal.connectionLost(this.options.signalId); return false;
      }
      const frame = this.session.command(intent.command.id, intent.command.value, intent.deadlineMonotonicMs);
      await publish(this.client, deviceTopic(this.options.siteId, this.options.protocolDeviceId ?? this.options.deviceId, 'in'), frame);
      return true;
    } catch (error) {
      this.invalidate(); throw error;
    } finally { this.dispatching = false; }
  }

  get diagnostics(): { rejectedFrames: number; lastError: string | null; telemetry: LatencySummary | null } {
    return { rejectedFrames: this.rejectedFrames, lastError: this.lastError, telemetry: this.telemetryTiming.summary() };
  }

  private ingest(frame: Extract<Frame, { kind: 'ready' | 'telemetry' }>) {
    return this.signals.ingest({ signalId: this.options.signalId, value: frame.value, bootId: frame.bootId,
      sequence: frame.sequence, sourceTime: null, quality: 'Good' });
  }

  private invalidate(): void {
    this.session.disconnect(); this.signals.disconnect(this.options.deviceId);
    this.waiter?.reject(new Error('Device session disconnected'));
    this.loss = this.loss.then(() => this.journal.connectionLost(this.options.signalId))
      .catch(() => { this.lastError = 'Could not persist connection loss'; });
  }

  private async exchange(frame: Frame, kind: 'snapshot' | 'ready', nonce: string): Promise<Frame> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const reply = new Promise<Frame>((resolve, reject) => {
      this.waiter = { nonce, kind, resolve, reject };
      timer = setTimeout(() => reject(new Error('Device handshake timed out')), 500);
    });
    try {
      const [, response] = await Promise.all([publish(this.client, deviceTopic(this.options.siteId, this.options.protocolDeviceId ?? this.options.deviceId, 'in'), frame), reply]);
      return response;
    } finally { clearTimeout(timer); this.waiter = null; }
  }
}
