import { expect, it } from 'vitest';
import { percentiles, verifyHistory, assessLoad } from './load-evidence.js';
it('uses nearest-rank percentiles and rejects missing or invalid evidence', () => {
  expect(percentiles(Array.from({length: 100}, (_, i) => i + 1))).toEqual({ count: 100, p50: 50, p95: 95, p99: 99, max: 100 });
  for (const bad of [[], [NaN], [-1], [Infinity]]) expect(() => percentiles(bad)).toThrow();
});
it('counts ordered changes, tolerates heartbeat repeats, but detects loss and reboot', () => {
  const rows = [true, true, false, true, false].map((value, i) => ({value, bootId: 'boot', sequence: i + 1, quality: 'Good'}));
  expect(verifyHistory(rows, 'boot', 4)).toBe(4);
  expect(() => verifyHistory(rows.slice(2), 'boot', 4)).toThrow();
  expect(() => verifyHistory(rows.map((r,i) => ({...r, bootId: i === 2 ? 'new' : r.bootId})), 'boot', 4)).toThrow();
  expect(() => verifyHistory(rows.map((r,i) => ({...r, sequence: i === 2 ? 0 : r.sequence})), 'boot', 4)).toThrow();
});
it('never labels a short or incomplete run as a one-hour workload pass', () => {
  const input = { requestedSeconds: 3600, elapsedSeconds: 3600, devices: 16, commands: 57600, verified: 57600, historyChanges: 57600, missedTicks: 0, errors: [] as string[] };
  expect(assessLoad(input)).toBe('hour-workload-passed');
  expect(assessLoad({...input, requestedSeconds: 60, elapsedSeconds: 60, commands: 960, verified: 960, historyChanges: 960})).toBe('smoke-passed');
  for (const bad of [{...input, elapsedSeconds: 3599}, {...input, verified: 57599}, {...input, historyChanges: 57599}, {...input, missedTicks: 1}, {...input, errors: ['runtime fault']}, {...input, devices: 0}]) expect(() => assessLoad(bad)).toThrow();
});
