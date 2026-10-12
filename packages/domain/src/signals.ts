/** FR-03 / FR-04: current signal values, quality and device-session ordering. */
export type SignalValue = boolean | number | string;
export type SignalQuality = 'Good' | 'Bad' | 'Stale' | 'Disconnected';

export interface Clock {
  wallNow(): Date;
  monotonicNow(): number;
}

export interface SignalDefinition {
  id: string;
  deviceId: string;
  dataType: 'boolean' | 'float64' | 'int64' | 'uint64';
  freshnessMs: number;
}

export interface SignalSample {
  signalId: string;
  value: SignalValue;
  bootId: string;
  sequence: number;
  sourceTime: string | null;
  quality: 'Good' | 'Bad';
}

export interface SignalSnapshot {
  value: SignalValue | null;
  quality: SignalQuality;
  sourceTime: string | null;
  receivedTime: string | null;
  bootId: string | null;
  sequence: number | null;
}

export type IngestResult = 'accepted' | 'duplicate' | 'out-of-order' | 'stale-session';

interface SignalState {
  definition: SignalDefinition;
  snapshot: SignalSnapshot;
  receivedAt: number | null;
}

function validateValue(type: SignalDefinition['dataType'], value: SignalValue): void {
  if (type === 'boolean') {
    if (typeof value !== 'boolean') throw new Error('Expected boolean value');
  } else if (type === 'float64') {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('Expected finite float64 value');
  } else {
    if (typeof value !== 'string' || !/^(0|-?[1-9]\d*)$/.test(value) || value.length > 20) {
      throw new Error(`Expected exact decimal ${type} value`);
    }
    const integer = BigInt(value);
    const min = type === 'int64' ? -(2n ** 63n) : 0n;
    const max = type === 'int64' ? 2n ** 63n - 1n : 2n ** 64n - 1n;
    if (integer < min || integer > max) throw new Error(`${type} value outside range`);
  }
}

/** In-memory domain state. Transport authentication and persistence are separate. */
export class SignalStore {
  private readonly signals = new Map<string, SignalState>();
  private readonly sessions = new Map<string, string>();
  private readonly devices = new Map<string, Set<string>>();

  constructor(private readonly clock: Clock) {}

  register(definition: SignalDefinition): void {
    if (typeof definition.id !== 'string' || !definition.id.trim() ||
        typeof definition.deviceId !== 'string' || !definition.deviceId.trim()) {
      throw new Error('Invalid signal definition ID');
    }
    if (!['boolean', 'float64', 'int64', 'uint64'].includes(definition.dataType)) {
      throw new Error('Unsupported signal data type');
    }
    if (this.signals.has(definition.id)) throw new Error('Signal already registered');
    if (!Number.isFinite(definition.freshnessMs) || definition.freshnessMs <= 0) {
      throw new Error('freshnessMs must be positive and finite');
    }
    this.signals.set(definition.id, {
      definition: { ...definition }, receivedAt: null,
      snapshot: { value: null, quality: 'Disconnected', sourceTime: null,
        receivedTime: null, bootId: null, sequence: null },
    });
    const ids = this.devices.get(definition.deviceId) ?? new Set<string>();
    ids.add(definition.id);
    this.devices.set(definition.deviceId, ids);
  }

  beginSession(deviceId: string, bootId: string): void {
    if (!this.devices.has(deviceId)) throw new Error('Unknown device');
    if (typeof bootId !== 'string' || !bootId.trim()) throw new Error('Invalid boot session');
    if (this.sessions.get(deviceId) === bootId) return;
    this.sessions.set(deviceId, bootId);
    for (const id of this.devices.get(deviceId) ?? []) {
      this.state(id).snapshot.quality = 'Disconnected';
    }
  }

  disconnect(deviceId: string): void {
    this.sessions.delete(deviceId);
    for (const id of this.devices.get(deviceId) ?? []) {
      this.state(id).snapshot.quality = 'Disconnected';
    }
  }

  ingest(sample: SignalSample): IngestResult {
    const state = this.state(sample.signalId);
    if (!Number.isSafeInteger(sample.sequence) || sample.sequence < 0) throw new Error('Invalid sequence');
    if (sample.quality !== 'Good' && sample.quality !== 'Bad') throw new Error('Invalid quality');
    if (sample.sourceTime !== null && (typeof sample.sourceTime !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(sample.sourceTime) ||
        !Number.isFinite(Date.parse(sample.sourceTime)))) throw new Error('Invalid source time');
    if (this.sessions.get(state.definition.deviceId) !== sample.bootId) return 'stale-session';
    if (state.snapshot.bootId === sample.bootId && state.snapshot.sequence !== null) {
      if (sample.sequence === state.snapshot.sequence) return 'duplicate';
      if (sample.sequence < state.snapshot.sequence) return 'out-of-order';
    }
    validateValue(state.definition.dataType, sample.value);
    const receivedTime = this.clock.wallNow().toISOString();
    state.snapshot = { value: sample.value, quality: sample.quality, sourceTime: sample.sourceTime,
      receivedTime, bootId: sample.bootId, sequence: sample.sequence };
    state.receivedAt = this.clock.monotonicNow();
    return 'accepted';
  }

  get(signalId: string): SignalSnapshot {
    const state = this.state(signalId);
    const snapshot = { ...state.snapshot };
    if (snapshot.quality !== 'Disconnected' && state.receivedAt !== null &&
        this.clock.monotonicNow() - state.receivedAt >= state.definition.freshnessMs) {
      snapshot.quality = 'Stale';
    }
    return snapshot;
  }

  private state(signalId: string): SignalState {
    const state = this.signals.get(signalId);
    if (!state) throw new Error(`Unknown signal: ${signalId}`);
    return state;
  }
}
