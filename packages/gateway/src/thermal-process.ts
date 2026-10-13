import { connectAsync, type MqttClient } from 'mqtt';
import type { SignalStore } from '../../domain/src/signals.js';
import { ThermalModel } from '../../domain/src/thermal-model.js';
import { deviceTopic } from '../../led-protocol/src/index.js';
import type { LedConnection } from './mqtt-led.js';
export interface ThermalConnection extends LedConnection { temperatureSignalId: string; }
export const thermalTopic = (options: ThermalConnection): string => `${deviceTopic(options.siteId, options.protocolDeviceId ?? options.deviceId, 'out')}/temperature`;
/** Private simulation namespace only. This is not an authenticated physical sensor driver. */
export class MqttThermalProcess {
  private publisher: MqttClient | null = null;
  private receiver: MqttClient | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private work: Promise<void> = Promise.resolve();
  private readonly model = new ThermalModel();
  private sequence = 0;
  private rejected = 0;
  private started = false;
  private stopped = false;
  private initial: (() => void) | null = null;
  constructor(private readonly options: ThermalConnection, private readonly boot: string, private readonly heater: () => boolean,
    private readonly signals: SignalStore, private readonly fault: (reason: string) => void, private readonly now: () => number = () => performance.now()) { thermalTopic(options); }
  async start(): Promise<void> {
    if (this.started || this.stopped) throw new Error('Virtual process already started or stopped'); this.started = true;
    const options = { protocolVersion: 5 as const, clean: true, reconnectPeriod: 0, queueQoSZero: false, connectTimeout: 2000, properties: { maximumPacketSize: 2048 } };
    try {
      this.receiver = await connectAsync(this.options.url, options);
      this.receiver.on('close', () => this.fail('Virtual process transport disconnected'));
      this.receiver.on('error', () => this.fail('Virtual process transport failed'));
      this.receiver.on('message', (topic, payload, packet) => {
        if (this.stopped || topic !== thermalTopic(this.options)) return;
        try {
          if (packet.retain || packet.qos !== 1 || payload.length > 1024) throw new Error('Invalid frame');
          const value: unknown = JSON.parse(payload.toString('utf8'));
          if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid frame');
          const frame = value as Record<string, unknown>;
          if (Object.keys(frame).length !== 4 || frame.v !== 1 || frame.bootId !== this.boot || !Number.isSafeInteger(frame.sequence) || (frame.sequence as number) < 0 || typeof frame.value !== 'number' || !Number.isFinite(frame.value) || frame.value < 20 || frame.value > 40) throw new Error('Invalid frame');
          const result = this.signals.ingest({ signalId: this.options.temperatureSignalId, bootId: this.boot, sequence: frame.sequence as number, value: frame.value, quality: 'Good', sourceTime: null });
          if (result === 'accepted') { this.initial?.(); this.initial = null; }
          else this.rejected++;
        } catch { this.rejected++; }
      });
      await this.receiver.subscribeAsync(thermalTopic(this.options), { qos: 1, rap: true });
      this.publisher = await connectAsync(this.options.url, options);
      this.publisher.on('close', () => this.fail('Virtual process transport disconnected'));
      this.publisher.on('error', () => this.fail('Virtual process transport failed'));
      if (this.stopped) throw new Error('Virtual process stopped during startup');
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const first = new Promise<void>((resolve, reject) => { this.initial = resolve; timeout = setTimeout(() => reject(new Error('Virtual process initial sample unavailable')), 1500); });
      try { await Promise.all([first, this.send()]); } finally { clearTimeout(timeout); this.initial = null; }
      if (this.stopped) throw new Error('Virtual process stopped during startup');
      this.schedule();
    } catch (error) { await this.stop(); throw error; }
  }
  async stop(): Promise<void> {
    this.stopped = true; clearTimeout(this.timer); this.signals.disconnect(this.options.deviceId);
    await Promise.allSettled([this.publisher?.endAsync(true), this.receiver?.endAsync(true)]);
    await this.work;
  }
  get rejectedFrames(): number { return this.rejected; }
  private fail(reason: string): void {
    if (this.stopped) return;
    this.stopped = true; clearTimeout(this.timer); this.signals.disconnect(this.options.deviceId);
    void this.publisher?.endAsync(true).catch(() => {}); void this.receiver?.endAsync(true).catch(() => {});
    this.fault(reason);
  }
  private schedule() { if (!this.stopped) this.timer = setTimeout(() => { this.work = this.tick(); }, 1000); }
  private async tick() {
    try { await this.send(); this.schedule(); }
    catch { this.fail('Virtual process sampling failed'); }
  }
  private async send(): Promise<void> {
    if (this.stopped || !this.publisher?.connected) throw new Error('Virtual process transport unavailable');
    const value = this.model.step(this.now(), this.heater());
    if (!Number.isSafeInteger(this.sequence)) throw new Error('Virtual process sequence exhausted');
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.publisher.publishAsync(thermalTopic(this.options), JSON.stringify({ v: 1, bootId: this.boot, sequence: this.sequence++, value }), { qos: 1, retain: false, properties: { messageExpiryInterval: 1 } }),
        new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error('Virtual process publication timeout')), 1000); }),
      ]);
    } finally { clearTimeout(timeout); }
  }
}
