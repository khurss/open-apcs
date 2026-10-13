export interface Sample { seconds: number; volts: number; }
export interface Preamble { points: number; xIncrement: number; xOrigin: number; xReference: number; yIncrement: number; yOrigin: number; yReference: number; }
export function parsePreamble(text: string): Preamble {
  const fields = text.trim().split(',');
  const n = fields.map(Number);
  if (fields.length !== 10 || fields.some(v => !v.trim()) || n.some(v => !Number.isFinite(v))) throw new Error('Invalid waveform preamble');
  const [format, type, points, count, xIncrement, xOrigin, xReference, yIncrement, yOrigin, yReference] = n as [number, number, number, number, number, number, number, number, number, number];
  if (format !== 0 || type !== 0 || count !== 1 || !Number.isInteger(points) || points < 2 || points > 1200 || xIncrement <= 0 || yIncrement <= 0) throw new Error('Expected bounded BYTE/NORMAL waveform');
  return { points, xIncrement, xOrigin, xReference, yIncrement, yOrigin, yReference };
}
export function decodeWaveform(preamble: string, block: Buffer): Sample[] {
  const p = parsePreamble(preamble);
  const digits = block[1]! - 48;
  if (block[0] !== 35 || !Number.isInteger(digits) || digits < 1 || digits > 9 || block.length < 2 + digits) throw new Error('Invalid SCPI block header');
  const lengthText = block.subarray(2, 2 + digits).toString('ascii');
  if (!/^\d+$/.test(lengthText)) throw new Error('Invalid SCPI length');
  const size = Number(lengthText), offset = 2 + digits;
  if (size !== p.points || block.length !== offset + size + 1 || block.at(-1) !== 10) throw new Error('Incomplete or mismatched SCPI block');
  return Array.from(block.subarray(offset, offset + size), (raw, i) => {
    if (raw === 0 || raw === 255) throw new Error('Waveform clipped; review probe and scale');
    return { seconds: (i - p.xReference) * p.xIncrement + p.xOrigin, volts: (raw - p.yOrigin - p.yReference) * p.yIncrement };
  });
}
/** Deliberately narrow fixture: one 3.3 V pulse, 0.7–2.5 s, with 0.1 s of low on both sides. */
export function assessPulse(samples: Sample[]) {
  if (samples.length < 3) throw new Error('Insufficient waveform evidence');
  for (let i = 0; i < samples.length; i++) {
    const p = samples[i]!;
    if (!Number.isFinite(p.seconds) || !Number.isFinite(p.volts) || (i > 0 && p.seconds <= samples[i - 1]!.seconds) || p.volts < -0.3 || p.volts > 3.6) throw new Error('Invalid time or voltage range');
  }
  const rising: number[] = [], falling: number[] = [];
  for (let i = 1; i < samples.length; i++) {
    if (samples[i - 1]!.volts < 1.65 && samples[i]!.volts >= 1.65) rising.push(i);
    if (samples[i - 1]!.volts >= 1.65 && samples[i]!.volts < 1.65) falling.push(i);
  }
  if (rising.length !== 1 || falling.length !== 1 || rising[0]! >= falling[0]!) throw new Error('Expected exactly one complete pulse');
  const r = rising[0]!, f = falling[0]!;
  const start = samples[r]!.seconds, end = samples[f]!.seconds, width = end - start;
  if (width < 0.7 || width > 2.5 || start - samples[0]!.seconds < 0.1 || samples.at(-1)!.seconds - end < 0.1) throw new Error('Pulse duration or evidence window outside bounds');
  // Exclude one sample at each transition; do not count a short spike as a valid plateau.
  const high = samples.slice(r + 1, f - 1);
  const low = [...samples.slice(0, r - 1), ...samples.slice(f + 1)];
  if (!high.length || !low.length || high.some(p => p.volts < 2.8 || p.volts > 3.6) || low.some(p => p.volts < -0.3 || p.volts > 0.4)) throw new Error('Invalid high or low plateau');
  const mean = (s: Sample[]) => s.reduce((sum, p) => sum + p.volts, 0) / s.length;
  return { risingSeconds: start, fallingSeconds: end, widthSeconds: width, highVolts: mean(high), lowVolts: mean(low), sampleIntervalSeconds: samples[1]!.seconds - samples[0]!.seconds, points: samples.length };
}
