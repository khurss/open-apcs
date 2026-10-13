import { expect, it } from 'vitest';
import { WeeklySchedule, validateWeeklySettings, type WeeklySettings } from './weekly-schedule.js';
const settings = (extra: Partial<WeeklySettings> = {}): WeeklySettings => ({ zone: 'UTC', days: [1, 2, 3, 4, 5], startMinute: 540, endMinute: 1020, ...extra });
const at = (iso: string, extra: Partial<WeeklySettings> = {}) => new WeeklySchedule(settings(extra)).step(0, Date.parse(iso));
it('includes the start and excludes the end of a selected weekday window', () => {
  expect(at('2026-10-12T08:59:59.999Z')).toBe(false);
  expect(at('2026-10-12T09:00:00Z')).toBe(true);
  expect(at('2026-10-12T17:00:00Z')).toBe(false);
  expect(at('2026-10-11T10:00:00Z')).toBe(false);
});
it('assigns an overnight window to its start weekday and equal boundaries mean a full day', () => {
  const night = { days: [5], startMinute: 1320, endMinute: 360 };
  expect(at('2026-10-16T23:00:00Z', night)).toBe(true);
  expect(at('2026-10-17T05:59:59Z', night)).toBe(true);
  expect(at('2026-10-17T06:00:00Z', night)).toBe(false);
  expect(at('2026-10-17T23:00:00Z', night)).toBe(false);
  expect(at('2026-10-13T08:59:59Z', { days: [1], endMinute: 540 })).toBe(true);
  expect(at('2026-10-13T09:00:00Z', { days: [1], endMinute: 540 })).toBe(false);
});
it('skips a spring window when either local boundary does not exist', () => {
  const spring = { zone: 'America/New_York', days: [7], startMinute: 150, endMinute: 240 };
  expect(at('2026-03-08T07:30:00Z', spring)).toBe(false);
  expect(at('2026-03-08T06:30:00Z', { ...spring, startMinute: 60, endMinute: 150 })).toBe(false);
  expect(at('2026-03-08T07:30:00Z', { ...spring, startMinute: 60 })).toBe(true);
});
it('uses the first occurrence of ambiguous boundaries and does not repeat after a fresh start', () => {
  const fall = { zone: 'America/New_York', days: [7], startMinute: 90, endMinute: 105 };
  expect(at('2026-11-01T05:35:00Z', fall)).toBe(true);
  expect(at('2026-11-01T05:45:00Z', fall)).toBe(false);
  expect(at('2026-11-01T06:35:00Z', fall)).toBe(false);
  const schedule = new WeeklySchedule(settings(fall)); const start = Date.parse('2026-11-01T05:35:00Z');
  expect(schedule.step(0, start)).toBe(true); expect(schedule.step(3600000, start + 3600000)).toBe(false);
});
it('handles a half-hour daylight-saving fold', () => {
  const fall = { zone: 'Australia/Lord_Howe', days: [7], startMinute: 95, endMinute: 105 };
  expect(at('2026-04-04T14:40:00Z', fall)).toBe(true);
  expect(at('2026-04-04T15:10:00Z', fall)).toBe(false);
});
it('keeps a full-day window continuous through a repeated hour', () => {
  const allDay = { zone: 'America/New_York', days: [7], startMinute: 0, endMinute: 0 };
  expect(at('2026-11-01T04:00:00Z', allDay)).toBe(true);
  expect(at('2026-11-01T06:30:00Z', allDay)).toBe(true);
  expect(at('2026-11-02T04:59:59Z', allDay)).toBe(true);
  expect(at('2026-11-02T05:00:00Z', allDay)).toBe(false);
});
it('does not replay an interval missed during downtime', () => {
  const schedule = new WeeklySchedule(settings()); const start = Date.parse('2026-10-12T08:00:00Z');
  expect(schedule.step(0, start)).toBe(false);
  expect(schedule.step(36000000, start + 36000000)).toBe(false);
});
it('latches forward and backward wall-clock divergence and frozen-clock faults', () => {
  const start = Date.parse('2026-10-12T10:00:00Z');
  for (const delta of [-1001, 1001]) {
    const schedule = new WeeklySchedule(settings()); expect(schedule.step(0, start)).toBe(true);
    expect(() => schedule.step(100, start + 100 + delta)).toThrow(/clock/i);
    expect(() => schedule.step(200, start + 200)).toThrow(/clock/i);
  }
  const frozen = new WeeklySchedule(settings()); frozen.step(0, start);
  expect(() => frozen.step(1001, start)).toThrow(/clock/i);
});
it('uses a fixed clock anchor so many small corrections cannot evade the limit', () => {
  const schedule = new WeeklySchedule(settings()); const start = Date.parse('2026-10-12T10:00:00Z');
  schedule.step(0, start); expect(schedule.step(1000, start + 2000)).toBe(true);
  expect(() => schedule.step(2000, start + 3100)).toThrow(/clock/i);
});
it('rejects invalid or reversed time and requires explicit supported wall time', () => {
  const start = Date.parse('2026-10-12T10:00:00Z');
  for (const wall of [NaN, Infinity, undefined, Date.parse('1899-12-31T00:00:00Z'), Date.parse('2101-01-01T00:00:00Z')]) expect(() => new WeeklySchedule(settings()).step(0, wall as number)).toThrow(/clock/i);
  const schedule = new WeeklySchedule(settings()); schedule.step(100, start); expect(() => schedule.step(99, start)).toThrow(/clock/i);
});
it('validates bounded settings, named zones and immutable weekday membership', () => {
  const original = settings(); const schedule = new WeeklySchedule(original); original.days.length = 0;
  expect(schedule.step(0, Date.parse('2026-10-12T10:00:00Z'))).toBe(true);
  expect(validateWeeklySettings(settings())).toEqual(settings());
  for (const extra of [{ zone: 'Mars/Base' }, { zone: '+01:00' }, { zone: '' }, { days: [] }, { days: [0] }, { days: [8] }, { days: [1, 1] }, { days: [1.5] }, { startMinute: -1 }, { endMinute: 1440 }, { startMinute: 1.5 }, { startMinute: NaN }, { replay: true }]) expect(() => validateWeeklySettings({ ...settings(), ...extra })).toThrow();
});
