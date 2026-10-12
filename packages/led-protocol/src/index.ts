import { VirtualLed } from '../../domain/src/virtual-led.js';

export type Frame =
  | { v: 1; kind: 'probe'; nonce: string }
  | { v: 1; kind: 'snapshot'; nonce: string; bootId: string; deviceTimeMs: number; sequence: number; value: boolean }
  | { v: 1; kind: 'lease'; nonce: string; bootId: string; sessionId: string; expiresAtMs: number }
  | { v: 1; kind: 'ready'; nonce: string; bootId: string; sessionId: string; expiresAtMs: number; deviceTimeMs: number; sequence: number; value: boolean }
  | { v: 1; kind: 'write'; id: string; bootId: string; sessionId: string; expiresAtMs: number; value: boolean }
  | { v: 1; kind: 'ack'; id: string; bootId: string; sessionId: string; status: 'applied'; value: boolean }
  | { v: 1; kind: 'ack'; id: string; bootId: string; sessionId: string; status: 'failed'; reason: string }
  | { v: 1; kind: 'telemetry'; bootId: string; sessionId: string | null; deviceTimeMs: number; sequence: number; value: boolean };

const identifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const time = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
const sequence = (value: unknown) => time(value) && Number.isSafeInteger(value);
const boolean = (value: unknown) => typeof value === 'boolean';
const text = (value: unknown) => typeof value === 'string' && value.trim().length > 0 && value.length <= 256;
const validators: Record<string, (value: unknown) => boolean> = {
  nonce: identifier, bootId: identifier, sessionId: identifier, id: identifier,
  expiresAtMs: time, deviceTimeMs: time, sequence, value: boolean, reason: text,
};

/** Versioned, bounded UTF-8 JSON. Unknown fields fail rather than being ignored. */
export function decodeFrame(payload: Uint8Array, retained = false): Frame {
  if (retained) throw new Error('Retained LED frames are prohibited');
  if (payload.byteLength > 4096) throw new Error('Frame exceeds 4096 bytes');
  let input: unknown;
  try { input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload)); }
  catch { throw new Error('Invalid JSON frame'); }
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid frame');
  const frame = input as Record<string, unknown>;
  if (frame.v !== 1) throw new Error('Unsupported frame version');
  let fields: string[];
  switch (frame.kind) {
    case 'probe': fields = ['nonce']; break;
    case 'snapshot': fields = ['nonce', 'bootId', 'deviceTimeMs', 'sequence', 'value']; break;
    case 'lease': fields = ['nonce', 'bootId', 'sessionId', 'expiresAtMs']; break;
    case 'ready': fields = ['nonce', 'bootId', 'sessionId', 'expiresAtMs', 'deviceTimeMs', 'sequence', 'value']; break;
    case 'write': fields = ['id', 'bootId', 'sessionId', 'expiresAtMs', 'value']; break;
    case 'ack':
      if (frame.status !== 'applied' && frame.status !== 'failed') throw new Error('Invalid ACK frame');
      fields = ['id', 'bootId', 'sessionId', 'status', frame.status === 'applied' ? 'value' : 'reason']; break;
    case 'telemetry': fields = ['bootId', 'sessionId', 'deviceTimeMs', 'sequence', 'value']; break;
    default: throw new Error('Unknown frame kind');
  }
  const allowed = new Set(['v', 'kind', ...fields]);
  if (Object.keys(frame).length !== allowed.size || Object.keys(frame).some((key) => !allowed.has(key))) throw new Error('Invalid frame fields');
  for (const key of fields) {
    if (key === 'status' || (key === 'sessionId' && frame.kind === 'telemetry' && frame[key] === null)) continue;
    if (!validators[key]?.(frame[key])) throw new Error(`Invalid frame field: ${key}`);
  }
  return frame as Frame;
}

export function deviceTopic(siteId: string, deviceId: string, channel: 'in' | 'out'): string {
  if (!identifier(siteId) || !identifier(deviceId) || !['in', 'out'].includes(channel)) throw new Error('Invalid device topic');
  return `openapcs/led/v1/${siteId}/${deviceId}/${channel}`;
}

/** Simulator peer. Its clock origin is independent from the gateway's clock. */
export class LedPeer {
  private readonly led: VirtualLed;
  private pending: { nonce: string; at: number } | null = null;
  private lease: { sessionId: string; expiresAtMs: number } | null = null;
  private lastLeaseDeadline = -1;
  private sequence = 0;

  constructor(private readonly now: () => number, private readonly bootId: string) {
    if (!identifier(bootId)) throw new Error('Invalid boot ID');
    this.led = new VirtualLed(now, bootId);
  }

  receive(frame: Frame): Frame | null {
    if (frame.kind === 'probe') {
      if (this.pending?.nonce === frame.nonce) return null;
      this.pending = { nonce: frame.nonce, at: this.now() };
      return { v: 1, kind: 'snapshot', nonce: frame.nonce, bootId: this.bootId,
        deviceTimeMs: this.pending.at, sequence: this.sequence++, value: this.read() };
    }
    if (frame.kind === 'lease') {
      const pending = this.pending;
      if (!pending || pending.nonce !== frame.nonce || frame.bootId !== this.bootId ||
          frame.expiresAtMs <= this.now() || frame.expiresAtMs > pending.at + 3000 ||
          frame.expiresAtMs <= this.lastLeaseDeadline) return null;
      this.pending = null;
      this.led.grantLease(frame.sessionId, frame.expiresAtMs);
      this.lease = { sessionId: frame.sessionId, expiresAtMs: frame.expiresAtMs };
      this.lastLeaseDeadline = frame.expiresAtMs;
      return { v: 1, kind: 'ready', nonce: frame.nonce, bootId: this.bootId, ...this.lease,
        deviceTimeMs: this.now(), sequence: this.sequence++, value: this.read() };
    }
    if (frame.kind === 'write') {
      const ack = this.led.apply({ id: frame.id, value: frame.value, bootId: frame.bootId,
        controlSessionId: frame.sessionId, expiresAt: frame.expiresAtMs });
      return { v: 1, kind: 'ack', bootId: this.bootId, sessionId: frame.sessionId, ...ack };
    }
    return null;
  }

  telemetry(): Extract<Frame, { kind: 'telemetry' }> {
    return { v: 1, kind: 'telemetry', bootId: this.bootId, sequence: this.sequence++,
      sessionId: this.lease && this.now() < this.lease.expiresAtMs ? this.lease.sessionId : null,
      deviceTimeMs: this.now(), value: this.read() };
  }

  read(): boolean { return this.led.read(); }
}

interface Anchor {
  nonce: string;
  bootId: string;
  deviceTimeMs: number;
  receivedAt: number;
  validUntil: number;
  deviceDeadline: number;
}

/** Conservative clock mapping; assumes relative monotonic rate error <= 1000 ppm. */
export class GatewaySession {
  private pending: { nonce: string; sentAt: number; anchor?: Anchor } | null = null;
  private anchor: Anchor | null = null;

  constructor(private readonly now: () => number, readonly sessionId: string) {
    if (!identifier(sessionId)) throw new Error('Invalid session ID');
  }

  probe(nonce: string): Frame {
    if (!identifier(nonce)) throw new Error('Invalid probe nonce');
    this.pending = { nonce, sentAt: this.now() };
    return { v: 1, kind: 'probe', nonce };
  }

  snapshot(frame: Frame): Frame {
    const pending = this.pending;
    if (frame.kind !== 'snapshot' || !pending || pending.nonce !== frame.nonce) throw new Error('Uncorrelated snapshot');
    if (this.now() - pending.sentAt > 250) throw new Error('Snapshot is not fresh');
    if (this.anchor && this.anchor.bootId !== frame.bootId) this.anchor = null;
    pending.anchor = { nonce: pending.nonce, bootId: frame.bootId, deviceTimeMs: frame.deviceTimeMs,
      receivedAt: this.now(), validUntil: pending.sentAt + 2980, deviceDeadline: frame.deviceTimeMs + 3000 };
    return { v: 1, kind: 'lease', nonce: pending.nonce, bootId: frame.bootId,
      sessionId: this.sessionId, expiresAtMs: pending.anchor.deviceDeadline };
  }

  ready(frame: Frame): void {
    const anchor = this.pending?.anchor;
    if (!anchor || frame.kind !== 'ready' || frame.nonce !== anchor.nonce || frame.bootId !== anchor.bootId ||
        frame.sessionId !== this.sessionId || frame.expiresAtMs !== anchor.deviceDeadline ||
        frame.deviceTimeMs < anchor.deviceTimeMs || this.now() - this.pending!.sentAt > 500) {
      throw new Error('Invalid or expired session confirmation');
    }
    this.anchor = anchor;
    this.pending = null;
  }

  command(id: string, value: boolean, deadline: number): Frame {
    if (!this.active() || !this.anchor) throw new Error('No active device session');
    if (!identifier(id) || typeof value !== 'boolean' || !Number.isFinite(deadline) || deadline <= this.now()) throw new Error('Invalid command deadline or value');
    const anchor = this.anchor;
    if (this.now() - anchor.receivedAt > 1500) throw new Error('Clock sample requires refresh');
    // A sample predates gateway receipt, so this mapping expires early, never late
    // under the declared rate bound. The 10 ms margin also covers rounding.
    const expiresAtMs = Math.min(anchor.deviceDeadline - 10,
      anchor.deviceTimeMs + (deadline - anchor.receivedAt) * 0.999 - 10);
    return { v: 1, kind: 'write', id, value, bootId: anchor.bootId, sessionId: this.sessionId, expiresAtMs };
  }

  active(): boolean { return this.anchor !== null && this.now() < this.anchor.validUntil; }
  disconnect(): void { this.anchor = null; this.pending = null; }
  get bootId(): string | null { return this.active() ? this.anchor!.bootId : null; }
}
