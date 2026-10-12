import type { Clock, SignalQuality } from './signals.js';

export type CommandState = 'Requested' | 'Rejected' | 'Accepted' | 'Dispatched' |
  'DeviceAccepted' | 'Verified' | 'Failed' | 'Expired' | 'Cancelled' | 'Unknown';

export interface CommandRequest {
  id: string;
  idempotencyKey: string;
  actorId: string;
  targetSignalId: string;
  value: boolean;
  ttlMs: number;
  expectedProjectRevision: number;
  reason: string;
}

/** Trusted, fresh context resolved by the application, never supplied by the browser. */
export interface CommandContext {
  bootId: string | null;
  projectRevision: number;
  quality: SignalQuality;
  interlockReason: string | null;
  ownerId: string | null;
  maxTtlMs: number;
}

export interface CommandEvent {
  state: CommandState;
  at: string;
  reason: string | null;
}

export interface CommandSnapshot {
  id: string;
  targetSignalId: string;
  value: boolean;
  bootId: string | null;
  state: CommandState;
  reason: string | null;
  evidence: 'firmware-reported-output' | null;
  history: CommandEvent[];
}

export type CommandAck = {
  id: string;
  targetSignalId: string;
  bootId: string;
} & ({ status: 'accepted' } | { status: 'applied'; value: boolean } | { status: 'failed'; reason: string });

interface Entry {
  request: CommandRequest;
  snapshot: CommandSnapshot;
  deadline: number;
  fingerprint: string;
}

function rejection(request: CommandRequest, context: CommandContext): string | null {
  if (context.interlockReason !== null) return context.interlockReason || 'Interlock active';
  if (!context.bootId) return 'Device session unavailable';
  if (context.quality !== 'Good') return `Output quality is ${context.quality}`;
  if (context.ownerId !== request.actorId) return 'Output belongs to another owner';
  if (context.projectRevision !== request.expectedProjectRevision) return 'Project revision changed';
  if (!Number.isSafeInteger(context.maxTtlMs) || context.maxTtlMs <= 0 || request.ttlMs > context.maxTtlMs) {
    return 'TTL exceeds output policy';
  }
  return null;
}

export function validateCommandRequest(request: CommandRequest): void {
  if (!Number.isSafeInteger(request.ttlMs) || request.ttlMs <= 0) throw new Error('Invalid TTL');
  for (const key of ['id', 'idempotencyKey', 'actorId', 'targetSignalId', 'reason'] as const) {
    if (typeof request[key] !== 'string' || !request[key].trim()) throw new Error(`Invalid ${key}`);
  }
  if (typeof request.value !== 'boolean') throw new Error('Expected boolean command value');
  if (!Number.isSafeInteger(request.expectedProjectRevision) || request.expectedProjectRevision < 0) {
    throw new Error('Invalid project revision');
  }
}

export function commandFingerprint(request: CommandRequest): string {
  return JSON.stringify([request.targetSignalId, request.value, request.ttlMs,
    request.expectedProjectRevision, request.reason]);
}

/**
 * Process-local state machine for the LED milestone, with no I/O or durable claims.
 * The application must persist command + outbox atomically before dispatching.
 * Never use this class alone as a production command journal or retry queue.
 */
export class CommandBook {
  private readonly entries = new Map<string, Entry>();
  private readonly keys = new Map<string, string>();

  constructor(private readonly clock: Clock) {}

  /** Trusted persistence boundary only; remainingMs comes from the original deadline. */
  static restore(clock: Clock, request: CommandRequest, snapshot: CommandSnapshot, remainingMs: number): CommandBook {
    validateCommandRequest(request);
    if (!Number.isFinite(remainingMs)) throw new Error('Invalid remaining deadline');
    if (snapshot.id !== request.id || snapshot.targetSignalId !== request.targetSignalId ||
        snapshot.value !== request.value || snapshot.history.at(-1)?.state !== snapshot.state) {
      throw new Error('Inconsistent command snapshot');
    }
    const book = new CommandBook(clock);
    book.entries.set(request.id, { request: { ...request }, snapshot: structuredClone(snapshot),
      deadline: clock.monotonicNow() + Math.min(remainingMs, request.ttlMs), fingerprint: commandFingerprint(request) });
    book.keys.set(JSON.stringify([request.actorId, request.idempotencyKey]), request.id);
    return book;
  }

  request(request: CommandRequest, context: CommandContext): CommandSnapshot {
    validateCommandRequest(request);
    const key = JSON.stringify([request.actorId, request.idempotencyKey]);
    const fingerprint = commandFingerprint(request);
    const existing = this.keys.get(key);
    if (existing !== undefined) {
      if (this.entry(existing).fingerprint !== fingerprint) throw new Error('Idempotency conflict');
      return this.get(existing);
    }
    if (this.entries.has(request.id)) throw new Error('Command ID conflict');
    const entry: Entry = {
      request: { ...request }, fingerprint, deadline: this.clock.monotonicNow() + request.ttlMs,
      snapshot: { id: request.id, targetSignalId: request.targetSignalId, value: request.value,
        bootId: context.bootId, state: 'Requested', reason: null, evidence: null,
        history: [{ state: 'Requested', at: this.clock.wallNow().toISOString(), reason: null }] },
    };
    const reason = rejection(request, context);
    this.transition(entry, reason === null ? 'Accepted' : 'Rejected', reason);
    this.entries.set(request.id, entry);
    this.keys.set(key, request.id);
    return this.copy(entry);
  }

  get(id: string): CommandSnapshot {
    const entry = this.entry(id);
    this.expire(entry);
    return this.copy(entry);
  }

  /** Returns an intent once. This method does not publish to any transport. */
  dispatch(id: string, context: CommandContext): CommandSnapshot | null {
    const entry = this.entry(id);
    this.expire(entry);
    if (entry.snapshot.state !== 'Accepted') return null;
    const reason = rejection(entry.request, context) ??
      (entry.snapshot.bootId !== context.bootId ? 'Device session changed' : null);
    if (reason !== null) {
      this.transition(entry, 'Rejected', reason);
      return null;
    }
    this.transition(entry, 'Dispatched');
    return this.copy(entry);
  }

  acknowledge(ack: CommandAck): boolean {
    const entry = this.entries.get(ack.id);
    if (!entry) return false;
    this.expire(entry);
    const snapshot = entry.snapshot;
    if ((snapshot.state !== 'Dispatched' && snapshot.state !== 'DeviceAccepted') ||
        snapshot.bootId !== ack.bootId || snapshot.targetSignalId !== ack.targetSignalId) return false;
    if (ack.status === 'accepted') {
      if (snapshot.state === 'DeviceAccepted') return false;
      this.transition(entry, 'DeviceAccepted');
    } else if (ack.status === 'applied') {
      if (ack.value !== snapshot.value) return false;
      if (snapshot.state === 'Dispatched') this.transition(entry, 'DeviceAccepted');
      snapshot.evidence = 'firmware-reported-output';
      this.transition(entry, 'Verified');
    } else if (ack.status === 'failed' && typeof ack.reason === 'string' && ack.reason.trim()) {
      this.transition(entry, 'Failed', ack.reason);
    } else {
      return false;
    }
    return true;
  }

  connectionLost(targetSignalId: string): void {
    for (const entry of this.entries.values()) {
      if (entry.snapshot.targetSignalId !== targetSignalId) continue;
      this.expire(entry);
      if (entry.snapshot.state === 'Accepted') this.transition(entry, 'Cancelled', 'Connection lost before dispatch');
      if (entry.snapshot.state === 'Dispatched' || entry.snapshot.state === 'DeviceAccepted') {
        this.transition(entry, 'Unknown', 'Connection lost; physical outcome unknown');
      }
    }
  }

  private expire(entry: Entry): void {
    if (this.clock.monotonicNow() < entry.deadline) return;
    if (entry.snapshot.state === 'Accepted') this.transition(entry, 'Expired', 'Deadline elapsed before dispatch');
    if (entry.snapshot.state === 'Dispatched' || entry.snapshot.state === 'DeviceAccepted') {
      this.transition(entry, 'Unknown', 'Deadline elapsed; physical outcome unknown');
    }
  }

  private transition(entry: Entry, state: CommandState, reason: string | null = null): void {
    const at = this.clock.wallNow().toISOString();
    entry.snapshot.state = state;
    entry.snapshot.reason = reason;
    entry.snapshot.history.push({ state, at, reason });
  }

  private entry(id: string): Entry {
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`Unknown command: ${id}`);
    return entry;
  }

  private copy(entry: Entry): CommandSnapshot {
    return { ...entry.snapshot, history: entry.snapshot.history.map((event) => ({ ...event })) };
  }
}
