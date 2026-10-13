import { expect, it } from 'vitest';
import { assessFaultPulse, assessLow, failureDelay } from './fault-evidence.js';
function wave() { return Array.from({length: 1200}, (_, i) => ({ seconds: (i - 200) * 0.01, volts: i >= 200 && i < 600 ? 3.3 : 0 })); }
it('requires a real high-to-low transition and a sustained low tail', () => {
  expect(assessFaultPulse(wave()).fallingSeconds).toBe(4);
  for (const bad of [wave().map(p => ({...p, volts: 0})), wave().map(p => ({...p, volts: 3.3})), wave().map((p,i) => ({...p, volts: i > 1000 ? 3.3 : p.volts})), wave().slice(0,620)]) expect(() => assessFaultPulse(bad)).toThrow();
});
it('rejects unsettled voltages, nonfinite values and uneven or reversed time', () => {
  for (const bad of [wave().map((p,i) => ({...p, volts: i < 500 ? 1 : p.volts})), wave().map(p => ({...p, seconds: NaN})), wave().reverse(), wave().map((p,i) => ({...p, seconds: p.seconds + (i === 900 ? 0.001 : 0)}))]) expect(() => assessFaultPulse(bad)).toThrow();
});
it('requires a full low observation window without excursions', () => {
  const low = wave().map(p => ({...p, volts: 0.04}));
  expect(assessLow(low, 10).maximumVolts).toBe(0.04);
  expect(() => assessLow(low.slice(0,20), 10)).toThrow();
  expect(() => assessLow(low.map((p,i) => ({...p, volts: i === 1000 ? 0.8 : p.volts})), 10)).toThrow();
});
it('reports a conservative fault-to-fall interval using host ON acknowledgement and fault brackets', () => {
  // The physical rising edge lies between ON request and verified acknowledgement.
  expect(failureDelay({pulseSeconds: 8, sampleSeconds: 0.01, on: [100,100.1], fault: [106,106.2], maximumSeconds: 3.2})).toEqual({minimumSeconds: expect.closeTo(1.79), maximumSeconds: expect.closeTo(2.11)});
  expect(() => failureDelay({pulseSeconds: 8, sampleSeconds: 0.01, on: [100,100.1], fault: [102,102.1], maximumSeconds: 3.2})).toThrow();
  expect(() => failureDelay({pulseSeconds: 1, sampleSeconds: 0.01, on: [100,100.1], fault: [106,106.2], maximumSeconds: 3.2})).toThrow();
  expect(() => failureDelay({pulseSeconds: 8, sampleSeconds: 0.01, on: [100.1,100], fault: [106,106.2], maximumSeconds: 3.2})).toThrow();
});
