import { describe, expect, it } from 'vitest';
import { PidController, TimeProportioner, validatePidSettings, type PidInput, type PidSettings } from './pid.js';
import { ThermalModel } from './thermal-model.js';
const settings = (extra: Partial<PidSettings> = {}): PidSettings => ({ kp: 0.2, ki: 0.1, kd: 0, derivativeMs: 100, maxIntervalMs: 2500, ...extra });
const input = (extra: Partial<PidInput> = {}): PidInput => ({ pv: 0, setpoint: 1, manual: 0, auto: true, enable: true, reset: false, ...extra });
describe('normalized PID engineering controller', () => {
  it('starts with proportional action and constrains the output to zero through one', () => {
    const pid = new PidController(settings({ ki: 0 }));
    expect(pid.step(0, input({ setpoint: 2 }))).toBeCloseTo(0.4);
    expect(pid.step(1000, input({ setpoint: 10 }))).toBe(1);
    expect(pid.step(2000, input({ setpoint: -10 }))).toBe(0);
  });
  it('integrates using elapsed seconds without integrating duplicate timestamps', () => {
    const pid = new PidController(settings({ kp: 0 }));
    expect(pid.step(0, input())).toBe(0);
    expect(pid.step(500, input())).toBeCloseTo(0.05);
    expect(pid.step(1500, input())).toBeCloseTo(0.15);
    expect(pid.step(1500, input())).toBeCloseTo(0.15);
  });
  it('limits an integral step at saturation and immediately unwinds for reversed error', () => {
    const pid = new PidController(settings({ kp: 0, ki: 10 })); pid.step(0, input());
    for (let i = 1; i <= 20; i++) expect(pid.step(i * 1000, input())).toBe(1);
    expect(pid.step(21000, input({ setpoint: -1 }))).toBe(0);
  });
  it('does not wind up while proportional action is already saturated', () => {
    const pid = new PidController(settings({ kp: 1, ki: 1 }));
    for (let i = 0; i <= 20; i++) expect(pid.step(i * 1000, input({ setpoint: 10 }))).toBe(1);
    expect(pid.step(21000, input({ setpoint: 0.25 }))).toBeCloseTo(0.5);
  });
  it('filters the derivative of measurement and avoids a setpoint derivative kick', () => {
    const pid = new PidController(settings({ kp: 0, ki: 0, kd: 0.1 }));
    expect(pid.step(0, input())).toBe(0);
    expect(pid.step(1000, input({ setpoint: 10 }))).toBe(0);
    expect(pid.step(2000, input({ pv: -1, setpoint: 10 }))).toBeCloseTo(0.1 * (1 - Math.exp(-10)), 12);
  });
  it('tracks manual output and transfers to auto without a step even when setpoint changes', () => {
    const pid = new PidController(settings());
    expect(pid.step(0, input({ auto: false, manual: 0.3 }))).toBe(0.3);
    expect(pid.step(1000, input({ auto: false, manual: 0.4 }))).toBe(0.4);
    expect(pid.step(2000, input({ setpoint: 2 }))).toBe(0.4);
    expect(pid.step(3000, input({ setpoint: 2 }))).toBeCloseTo(0.6);
    expect(pid.step(4000, input({ auto: false, manual: 0.1 }))).toBe(0.1);
  });
  it('gives disable and reset priority, clears accumulated state and starts fresh', () => {
    const pid = new PidController(settings()); pid.step(0, input()); pid.step(1000, input());
    expect(pid.step(2000, input({ enable: false, auto: false, manual: 1 }))).toBe(0);
    expect(pid.step(3000, input())).toBeCloseTo(0.2);
    expect(pid.step(4000, input({ reset: true }))).toBe(0);
    expect(pid.step(5000, input())).toBeCloseTo(0.2);
  });
  it('rejects invalid data, arithmetic overflow, reversed time and an excessive control gap', () => {
    for (const extra of [{ pv: NaN }, { setpoint: Infinity }, { manual: -0.1 }, { manual: 1.1 }, { auto: 'true' }]) expect(() => new PidController(settings()).step(0, input(extra as Partial<PidInput>))).toThrow();
    expect(() => new PidController(settings({ kp: Number.MAX_VALUE })).step(0, input({ setpoint: 2 }))).toThrow(/finite/i);
    const pid = new PidController(settings()); pid.step(1000, input());
    expect(() => pid.step(999, input())).toThrow(/time/i);
    const late = new PidController(settings()); late.step(0, input()); expect(() => late.step(2501, input())).toThrow(/interval/i);
  });
  it('validates immutable settings and rejects unknown, nonfinite or invalid parameters', () => {
    const original = settings(); const pid = new PidController(original); original.kp = 1;
    expect(pid.step(0, input())).toBeCloseTo(0.2);
    expect(validatePidSettings(settings())).toEqual(settings());
    for (const extra of [{ kp: -1 }, { ki: Infinity }, { kd: NaN }, { kp: '0.2' }, { derivativeMs: 0 }, { derivativeMs: 60001 }, { maxIntervalMs: 99 }, { maxIntervalMs: 60001 }, { output: 1 }]) expect(() => validatePidSettings({ ...settings(), ...extra })).toThrow();
  });
});
describe('windowed time proportioning', () => {
  it('holds the sampled duty for a window and switches at the expected boundary', () => {
    const pwm = new TimeProportioner(1000);
    expect(pwm.step(0, 0.5)).toBe(true); expect(pwm.step(400, 0.9)).toBe(true);
    expect(pwm.step(500, 0.9)).toBe(false); expect(pwm.step(999, 0.9)).toBe(false);
    expect(pwm.step(1000, 0.9)).toBe(true); expect(pwm.step(1899, 0.1)).toBe(true); expect(pwm.step(1900, 0.1)).toBe(false);
  });
  it('turns off immediately at zero and waits for the next window before resuming', () => {
    const pwm = new TimeProportioner(1000); expect(pwm.step(0, 1)).toBe(true);
    expect(pwm.step(100, 0)).toBe(false); expect(pwm.step(200, 1)).toBe(false); expect(pwm.step(1000, 1)).toBe(true);
  });
  it('skips elapsed windows without replaying pulses and rejects invalid duty or time', () => {
    const pwm = new TimeProportioner(1000); pwm.step(0, 0.5); expect(pwm.step(10750, 0.5)).toBe(false);
    expect(() => pwm.step(10749, 0.5)).toThrow(/time/i);
    for (const duty of [-0.1, 1.1, NaN, Infinity]) expect(() => new TimeProportioner(1000).step(0, duty)).toThrow();
    for (const window of [999, 60001, 1000.5, NaN]) expect(() => new TimeProportioner(window)).toThrow();
  });
});
it('regulates the virtual thermal model near its setpoint with bounded binary heater commands', () => {
  const pid = new PidController(settings({ kp: 0.15, ki: 0.02 })); const pwm = new TimeProportioner(2000); const plant = new ThermalModel();
  let heater = false; const settled: number[] = []; let minimumDuty = Infinity; let maximumDuty = -Infinity;
  for (let now = 0; now <= 300000; now += 100) {
    const temperature = plant.step(now, heater);
    const duty = pid.step(now, input({ pv: temperature, setpoint: 24 }));
    minimumDuty = Math.min(minimumDuty, duty); maximumDuty = Math.max(maximumDuty, duty);
    heater = pwm.step(now, duty); if (now >= 240000) settled.push(temperature);
  }
  expect(minimumDuty).toBeGreaterThanOrEqual(0); expect(maximumDuty).toBeLessThanOrEqual(1);
  expect(Math.abs(settled.reduce((a, b) => a + b, 0) / settled.length - 24)).toBeLessThan(0.6);
  expect(Math.min(...settled)).toBeGreaterThan(22.5); expect(Math.max(...settled)).toBeLessThan(25.5);
});
