export interface PidSettings { kp: number; ki: number; kd: number; derivativeMs: number; maxIntervalMs: number; }
export interface PidInput { pv: number; setpoint: number; manual: number; auto: boolean; enable: boolean; reset: boolean; }
const finite = (value: number): number => { if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('PID calculation must remain finite'); return value; };
const clamp = (value: number): number => Math.max(0, Math.min(1, finite(value)));
export function validatePidSettings(value: unknown): PidSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !['kp', 'ki', 'kd', 'derivativeMs', 'maxIntervalMs'].includes(key))) throw new Error('Invalid PID settings fields');
  const settings = value as PidSettings;
  for (const gain of [settings.kp, settings.ki, settings.kd]) if (finite(gain) < 0) throw new Error('PID gains must be nonnegative');
  if (!Number.isSafeInteger(settings.derivativeMs) || settings.derivativeMs < 1 || settings.derivativeMs > 60000) throw new Error('Invalid PID derivative filter');
  if (!Number.isSafeInteger(settings.maxIntervalMs) || settings.maxIntervalMs < 100 || settings.maxIntervalMs > 60000) throw new Error('Invalid PID maximum interval');
  return structuredClone(settings);
}
interface State { at: number; pv: number; auto: boolean; integral: number; derivative: number; output: number; }
/** Parallel PID with a normalized output, measured derivative and conditional integral clamping. */
export class PidController {
  private readonly settings: PidSettings;
  private state: State | null = null;
  constructor(settings: PidSettings) { this.settings = validatePidSettings(settings); }
  step(now: number, input: PidInput): number {
    try {
      const previous = this.state;
      if (!Number.isFinite(now) || now < 0 || (previous && now < previous.at)) throw new Error('Invalid PID time');
      finite(input.pv); finite(input.setpoint); finite(input.manual);
      if (input.manual < 0 || input.manual > 1 || [input.auto, input.enable, input.reset].some((value) => typeof value !== 'boolean')) throw new Error('Invalid PID input');
      if (!input.enable || input.reset) { this.state = null; return 0; }
      const elapsed = previous ? now - previous.at : 0;
      if (elapsed > this.settings.maxIntervalMs) throw new Error('PID control interval exceeded');
      const seconds = elapsed / 1000; const error = finite(input.setpoint - input.pv);
      const proportional = finite(this.settings.kp * error);
      let derivative = previous?.derivative ?? 0;
      if (previous && elapsed > 0) {
        const rate = finite(finite(input.pv - previous.pv) / seconds);
        const alpha = -Math.expm1(-elapsed / this.settings.derivativeMs);
        derivative = finite((1 - alpha) * derivative + alpha * rate);
      }
      const d = finite(-this.settings.kd * derivative);
      let integral = previous?.integral ?? 0; let output: number;
      if (!input.auto) { integral = finite(input.manual - proportional - d); output = input.manual; }
      else if (previous && !previous.auto) {
        // Track the preceding manual output at the transition, including a changed setpoint.
        integral = finite(previous.output - proportional - d); output = previous.output;
      } else {
        const current = finite(proportional + integral + d);
        const delta = finite(finite(this.settings.ki * error) * seconds);
        // Stop integration deeper into saturation; limit a crossing step to the boundary.
        const accepted = delta > 0 ? Math.min(delta, Math.max(0, 1 - current)) : Math.max(delta, Math.min(0, -current));
        integral = finite(integral + accepted); output = clamp(proportional + integral + d);
      }
      this.state = { at: now, pv: input.pv, auto: input.auto, integral, derivative, output };
      return output;
    } catch (error) { this.state = null; throw error; }
  }
}
/** A sampled duty is held per window; a zero request immediately cancels the remaining ON time. */
export class TimeProportioner {
  private origin: number | null = null;
  private last = -Infinity;
  private cycle = -1;
  private duty = 0;
  constructor(private readonly windowMs: number) {
    if (!Number.isSafeInteger(windowMs) || windowMs < 1000 || windowMs > 60000) throw new Error('Invalid time-proportioning window');
  }
  step(now: number, duty: number): boolean {
    try {
      if (!Number.isFinite(now) || now < 0 || now < this.last) throw new Error('Invalid time-proportioning time');
      if (!Number.isFinite(duty) || duty < 0 || duty > 1) throw new Error('Duty must be a finite number from zero through one');
      this.origin ??= now; this.last = now;
      const elapsed = now - this.origin; const cycle = Math.floor(elapsed / this.windowMs);
      if (cycle !== this.cycle) { this.cycle = cycle; this.duty = duty; }
      if (duty === 0) this.duty = 0;
      return elapsed % this.windowMs < this.duty * this.windowMs;
    } catch (error) { this.origin = null; this.last = -Infinity; this.cycle = -1; this.duty = 0; throw error; }
  }
}
