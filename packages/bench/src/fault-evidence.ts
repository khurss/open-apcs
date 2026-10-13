import { assessPulse, type Sample } from './rigol.js';
function validate(samples: Sample[]) {
  if (samples.length < 3) throw new Error('Insufficient samples');
  const dt = samples[1]!.seconds - samples[0]!.seconds;
  if (!Number.isFinite(dt) || dt <= 0) throw new Error('Invalid sampling interval');
  for (let i = 0; i < samples.length; i++) {
    const p = samples[i]!;
    if (!Number.isFinite(p.seconds) || !Number.isFinite(p.volts) || (i > 0 && Math.abs(p.seconds - samples[i - 1]!.seconds - dt) > dt * 1e-6)) throw new Error('Invalid sample sequence');
  }
}
export function assessFaultPulse(samples: Sample[]) {
  validate(samples);
  return assessPulse(samples, { minimumSeconds: 0.1, maximumSeconds: 5, lowSeconds: 0.5 });
}
export function assessLow(samples: Sample[], minimumSeconds: number) {
  validate(samples);
  const duration = samples.at(-1)!.seconds - samples[0]!.seconds;
  if (!Number.isFinite(minimumSeconds) || minimumSeconds <= 0 || duration < minimumSeconds || samples.some(p => p.volts < -0.3 || p.volts > 0.4)) throw new Error('Output did not remain low for the observation window');
  return { durationSeconds: duration, minimumVolts: Math.min(...samples.map(p => p.volts)), maximumVolts: Math.max(...samples.map(p => p.volts)) };
}
/** Same-host monotonic brackets, never wall-clock timestamps or an assumed USB latency. */
export function failureDelay(input: { pulseSeconds: number; sampleSeconds: number; on: [number, number]; fault: [number, number]; maximumSeconds: number }) {
  const {pulseSeconds, sampleSeconds, on, fault, maximumSeconds} = input;
  if (![pulseSeconds, sampleSeconds, ...on, ...fault, maximumSeconds].every(Number.isFinite) || pulseSeconds <= 0 || sampleSeconds <= 0 || maximumSeconds <= 0 || on[0] > on[1] || fault[0] > fault[1] || fault[0] < on[1]) throw new Error('Invalid timing brackets');
  // The physical ON edge precedes its verified ACK; each sampled edge has up to one dt uncertainty.
  const minimum = on[0] + pulseSeconds - sampleSeconds - fault[1];
  const maximum = on[1] + pulseSeconds + sampleSeconds - fault[0];
  if (minimum < 0 || maximum > maximumSeconds) throw new Error('Cannot establish a bounded fault-to-low delay');
  return { minimumSeconds: minimum, maximumSeconds: maximum };
}
