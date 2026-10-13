import { describe, expect, it } from 'vitest';
import { TimedSequence, validateSequenceSettings, type SequenceSettings } from './sequence.js';
const settings: SequenceSettings = { maxIntervalMs: 500, steps: [{ label: 'Light', value: true, durationMs: 200 }, { label: 'Rest', value: false, durationMs: 300 }, { label: 'Light again', value: true, durationMs: 100 }] };
const run = (sequence: TimedSequence, now: number, start = false, cancel = false, permit = true) => sequence.step(now, { start, cancel, permit });
describe('bounded single-output timed sequences', () => {
  it('requires an observed low then rising start, executes each duration and does not repeat a held start', () => {
    const sequence = new TimedSequence(settings);
    expect(run(sequence, 0, true)).toMatchObject({ state: 'Idle', value: false, step: null });
    run(sequence, 100); expect(run(sequence, 200, true)).toMatchObject({ state: 'Running', step: 0, label: 'Light', value: true });
    expect(run(sequence, 399, true).step).toBe(0); expect(run(sequence, 400, true)).toMatchObject({ step: 1, value: false });
    expect(run(sequence, 700, true)).toMatchObject({ step: 2, value: true });
    expect(run(sequence, 800, true)).toMatchObject({ state: 'Completed', step: null, value: false });
    expect(run(sequence, 1000, true).state).toBe('Completed');
    run(sequence, 1100); expect(run(sequence, 1200, true).state).toBe('Running');
  });
  it('advances at most one step per observation and starts its full duration at that observation', () => {
    const sequence = new TimedSequence(settings); run(sequence, 0); run(sequence, 1, true);
    expect(run(sequence, 501, true).step).toBe(1);
    expect(run(sequence, 800, true).step).toBe(1); expect(run(sequence, 801, true).step).toBe(2);
  });
  it('gives cancellation and loss of permit precedence and requires a fresh eligible start edge', () => {
    for (const cancellation of [true, false]) {
      const sequence = new TimedSequence(settings); run(sequence, 0); run(sequence, 1, true);
      expect(run(sequence, 2, true, cancellation, cancellation)).toMatchObject({ state: 'Aborted', value: false });
      expect(run(sequence, 3, true).state).toBe('Aborted');
      run(sequence, 4, false, true); expect(run(sequence, 5, true).state).toBe('Aborted');
      run(sequence, 6); expect(run(sequence, 7, true).state).toBe('Running');
    }
  });
  it('does not queue start edges received during execution or a disabled interval', () => {
    const sequence = new TimedSequence(settings); run(sequence, 0, false, false, false);
    expect(run(sequence, 1, true).state).toBe('Idle'); run(sequence, 2); run(sequence, 3, true);
    run(sequence, 100); run(sequence, 203, true); run(sequence, 503, true);
    expect(run(sequence, 603, true).state).toBe('Completed'); expect(run(sequence, 604, true).state).toBe('Completed');
  });
  it('latches an overdue running task even if cancellation is requested at the late observation', () => {
    const sequence = new TimedSequence(settings); run(sequence, 0); run(sequence, 1, true);
    expect(() => run(sequence, 502, false, true)).toThrow(/interval/i);
    expect(() => run(sequence, 503)).toThrow(/fault/i);
  });
  it('allows idle downtime but never catches up or resumes a new instance', () => {
    const sequence = new TimedSequence(settings); run(sequence, 0);
    expect(run(sequence, 10000, true).step).toBe(0);
    expect(run(new TimedSequence(settings), 20000, true)).toMatchObject({ state: 'Idle', value: false });
  });
  it('latches invalid or reversed monotonic clocks and owns a copy of its settings', () => {
    const input = structuredClone(settings); const sequence = new TimedSequence(input); input.steps[0]!.value = false;
    run(sequence, 10); expect(run(sequence, 11, true).value).toBe(true);
    expect(() => run(sequence, 10)).toThrow(/clock/i); expect(() => run(sequence, 12)).toThrow(/fault/i);
    expect(() => run(new TimedSequence(settings), NaN)).toThrow(/clock/i);
  });
  it('validates bounded steps, durations, labels, booleans and exact fields', () => {
    expect(validateSequenceSettings(settings)).toEqual(settings);
    for (const invalid of [null, { ...settings, extra: 1 }, { ...settings, steps: [] }, { ...settings, steps: Array(17).fill(settings.steps[0]) }, { ...settings, maxIntervalMs: 99 }, { ...settings, maxIntervalMs: 10001 }, ...[{ durationMs: 99 }, { durationMs: Infinity }, { durationMs: 86400001 }, { label: ' ' }, { value: 1 }, { extra: true }].map((change) => ({ ...settings, steps: [{ ...settings.steps[0], ...change }] }))]) expect(() => validateSequenceSettings(invalid)).toThrow(/sequence/i);
  });
});
