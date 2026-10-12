import type { Clock, SignalQuality, SignalSnapshot } from './signals.js';
import { record } from './logic.js';
export interface AlarmDefinition { condition: { kind: 'boolean'; value: boolean } | { kind: 'quality'; values: SignalQuality[] }; activationDelayMs: number; returnDelayMs: number; }
export interface AlarmSnapshot { occurrence: number; active: boolean; acknowledged: boolean; available: boolean; suppressedUntil: string | null; version: number; }
export interface AlarmEvent { version: number; kind: 'Available' | 'Unavailable' | 'Activated' | 'Reactivated' | 'Returned' | 'Acknowledged' | 'Suppressed' | 'Unsuppressed'; occurrence: number; at: string; actorId: string | null; reason: string | null; }
export function validateAlarmDefinition(input: unknown): AlarmDefinition {
  const value = record(input, ['condition', 'activationDelayMs', 'returnDelayMs'], 'alarm definition');
  for (const delay of [value.activationDelayMs, value.returnDelayMs]) if (!Number.isSafeInteger(delay) || (delay as number) < 0 || (delay as number) > 86400000) throw new Error('Invalid alarm delay');
  const condition = record(value.condition, ['kind', 'value', 'values'], 'alarm condition');
  if (condition.kind === 'boolean') { if (typeof condition.value !== 'boolean' || 'values' in condition) throw new Error('Invalid boolean alarm condition'); }
  else if (condition.kind === 'quality') {
    if ('value' in condition || !Array.isArray(condition.values) || !condition.values.length || condition.values.length > 4 || new Set(condition.values).size !== condition.values.length || condition.values.some((entry) => !['Good', 'Bad', 'Stale', 'Disconnected'].includes(entry as string))) throw new Error('Invalid quality alarm condition');
  } else throw new Error('Invalid alarm condition kind');
  return structuredClone(input) as AlarmDefinition;
}
export function alarmPhase(snapshot: AlarmSnapshot): string { return snapshot.active ? snapshot.acknowledged ? 'ActiveAcknowledged' : 'ActiveUnacknowledged' : snapshot.acknowledged ? 'Normal' : 'ReturnedUnacknowledged'; }
export class AlarmEngine {
  private readonly definition: AlarmDefinition;
  private readonly state: AlarmSnapshot;
  private events: AlarmEvent[] = [];
  private lastTime = -Infinity;
  private pending: { value: boolean; since: number } | null = null;
  private suppressionDeadline: number | null = null;
  constructor(definition: AlarmDefinition, private readonly clock: Clock, restored?: AlarmSnapshot) {
    this.definition = validateAlarmDefinition(definition);
    this.state = restored ? structuredClone(restored) : { occurrence: 0, active: false, acknowledged: true, available: false, suppressedUntil: null, version: 0 };
    if (!Number.isSafeInteger(this.state.occurrence) || this.state.occurrence < 0 || !Number.isSafeInteger(this.state.version) || this.state.version < 0 || ['active', 'acknowledged', 'available'].some((key) => typeof this.state[key as 'active'] !== 'boolean') || (this.state.occurrence === 0 && (this.state.active || !this.state.acknowledged)) || (this.state.suppressedUntil !== null && !Number.isFinite(Date.parse(this.state.suppressedUntil)))) throw new Error('Invalid restored alarm state');
    if (restored?.available) { this.state.available = false; this.emit('Unavailable', null, 'Runtime restarted'); }
    if (restored?.suppressedUntil) { this.state.suppressedUntil = null; this.emit('Unsuppressed', null, 'Restart cleared suppression'); }
  }
  update(sample: SignalSnapshot): void {
    const now = this.time(); this.expire(now);
    const condition = this.definition.condition;
    const available = condition.kind === 'quality' || (sample.quality === 'Good' && typeof sample.value === 'boolean');
    if (available !== this.state.available) { this.state.available = available; this.emit(available ? 'Available' : 'Unavailable', null, available ? null : `Input quality is ${sample.quality}`); }
    if (!available) { this.pending = null; return; }
    const value = condition.kind === 'quality' ? condition.values.includes(sample.quality) : sample.value === condition.value;
    if (value === this.state.active) { this.pending = null; return; }
    if (this.pending?.value !== value) this.pending = { value, since: now };
    const delay = value ? this.definition.activationDelayMs : this.definition.returnDelayMs;
    if (now - this.pending.since < delay) return;
    this.pending = null; this.state.active = value;
    if (value) {
      // A returned, unacknowledged incident remains open across repeated activations.
      const repeated = !this.state.acknowledged;
      if (!repeated) this.state.occurrence++;
      this.state.acknowledged = false; this.emit(repeated ? 'Reactivated' : 'Activated');
    } else this.emit('Returned');
  }
  acknowledge(occurrence: number, actor: string, reason: string): void {
    this.actor(actor, reason); this.time();
    if (!Number.isSafeInteger(occurrence) || occurrence < 1 || occurrence !== this.state.occurrence) throw new Error('Alarm occurrence changed or is unavailable');
    if (this.state.acknowledged) return;
    this.state.acknowledged = true; this.emit('Acknowledged', actor, reason);
  }
  suppress(durationMs: number, actor: string, reason: string): void {
    this.actor(actor, reason);
    if (!Number.isSafeInteger(durationMs) || durationMs < 1000 || durationMs > 86400000) throw new Error('Suppression duration must be from one second to one day');
    this.suppressionDeadline = this.time() + durationMs;
    this.state.suppressedUntil = new Date(this.clock.wallNow().getTime() + durationMs).toISOString(); this.emit('Suppressed', actor, reason);
  }
  unsuppress(actor: string, reason: string): void {
    this.actor(actor, reason); this.time(); if (!this.state.suppressedUntil) return;
    this.suppressionDeadline = null; this.state.suppressedUntil = null; this.emit('Unsuppressed', actor, reason);
  }
  drainEvents(): AlarmEvent[] { const events = structuredClone(this.events); this.events = []; return events; }
  get snapshot(): AlarmSnapshot { return { ...this.state }; }
  get phase(): string { return alarmPhase(this.state); }
  get notificationDue(): boolean { return this.state.active && !this.state.acknowledged && this.state.suppressedUntil === null; }
  private actor(actor: string, reason: string) { if (!actor.trim() || actor.length > 128 || !reason.trim() || reason.length > 256) throw new Error('An alarm actor and reason are required'); }
  private time(): number { const now = this.clock.monotonicNow(); if (!Number.isFinite(now) || now < this.lastTime) throw new Error('Alarm time must be finite and monotonic'); this.lastTime = now; return now; }
  private expire(now: number) { if (this.suppressionDeadline !== null && now >= this.suppressionDeadline) { this.suppressionDeadline = null; this.state.suppressedUntil = null; this.emit('Unsuppressed', null, 'Suppression expired'); } }
  private emit(kind: AlarmEvent['kind'], actorId: string | null = null, reason: string | null = null) {
    if (this.events.length >= 1024) throw new Error('Alarm event buffer is full');
    this.events.push({ version: ++this.state.version, kind, occurrence: this.state.occurrence, at: this.clock.wallNow().toISOString(), actorId, reason });
  }
}
