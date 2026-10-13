export interface SequenceSettings { maxIntervalMs: number; steps: { label: string; value: boolean; durationMs: number }[]; }
export interface SequenceState { state: 'Idle' | 'Running' | 'Completed' | 'Aborted'; step: number | null; label: string | null; value: boolean; }
const exact = (value: unknown, keys: string[]): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
export function validateSequenceSettings(input: unknown): SequenceSettings {
  if (!exact(input, ['maxIntervalMs', 'steps']) || !Number.isInteger(input.maxIntervalMs) || Number(input.maxIntervalMs) < 100 || Number(input.maxIntervalMs) > 10000 || !Array.isArray(input.steps) || input.steps.length < 1 || input.steps.length > 16) throw new Error('Invalid sequence settings');
  for (const step of input.steps) if (!exact(step, ['label', 'value', 'durationMs']) || typeof step.label !== 'string' || !step.label.trim() || step.label.length > 64 || typeof step.value !== 'boolean' || !Number.isInteger(step.durationMs) || Number(step.durationMs) < 100 || Number(step.durationMs) > 86400000) throw new Error('Invalid sequence step');
  return structuredClone(input) as unknown as SequenceSettings;
}
/** Non-retentive, single-output sequence. Durations refer to requested values, not actuator acknowledgement. */
export class TimedSequence {
  private readonly settings: SequenceSettings;
  private state: SequenceState['state'] = 'Idle'; private index = 0; private since = 0;
  private last: number | null = null; private armed = false; private faulted = false;
  constructor(settings: SequenceSettings) { this.settings = validateSequenceSettings(settings); }
  invalidate(): void { this.faulted = true; }
  step(now: number, input: { start: boolean; cancel: boolean; permit: boolean }): SequenceState {
    if (this.faulted) throw new Error('Sequence fault latched; create a new execution');
    const fail = (reason: string): never => { this.faulted = true; throw new Error(reason); };
    if (!Number.isFinite(now) || now < 0 || (this.last !== null && now < this.last)) fail('Invalid sequence clock');
    if (this.state === 'Running' && this.last !== null && now - this.last > this.settings.maxIntervalMs) fail('Sequence maximum interval exceeded');
    if (typeof input.start !== 'boolean' || typeof input.cancel !== 'boolean' || typeof input.permit !== 'boolean') fail('Invalid sequence input');
    this.last = now;
    if (input.cancel || !input.permit) {
      if (this.state === 'Running') this.state = 'Aborted';
      this.armed = false;
    } else if (this.state === 'Running') {
      this.armed = false;
      if (now - this.since >= this.settings.steps[this.index]!.durationMs) {
        this.index++; this.since = now;
        if (this.index === this.settings.steps.length) this.state = 'Completed';
      }
    } else if (!input.start) this.armed = true;
    else if (this.armed) { this.armed = false; this.state = 'Running'; this.index = 0; this.since = now; }
    const running = this.state === 'Running'; const current = running ? this.settings.steps[this.index]! : null;
    return { state: this.state, step: running ? this.index : null, label: current?.label ?? null, value: current?.value ?? false };
  }
}
