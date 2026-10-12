import type { ArchivedSample } from './history.js';
import type { SignalQuality, SignalValue } from './signals.js';
export type AggregateProfile = 'analog' | 'digital' | 'counter64' | 'exact';
export interface AggregateObservation { at: string; value: SignalValue | null; quality: SignalQuality; }
export interface HistoryAggregate {
  from: string; to: string; profile: AggregateProfile;
  sampleCount: number; validSampleCount: number; invalidSamples: number;
  first: AggregateObservation | null; last: AggregateObservation | null;
  min: number | string | null; max: number | string | null; mean: number | null;
  qualityMs: Record<SignalQuality | 'Unknown', number>;
  trueMs: number; falseMs: number; transitions: number; counterDelta: string | null; resets: number;
}
/** Bounded zero-order hold; unsupported continuity is unknown, never a synthetic zero. */
export function aggregateHistory(rows: ArchivedSample[], options: { from: string; to: string; profile: AggregateProfile; maxGapMs?: number }): HistoryAggregate {
  const from = Date.parse(options.from); const to = Date.parse(options.to); const maxGap = options.maxGapMs ?? 120000;
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from || to - from > 3600000) throw new Error('Aggregate interval must be ordered and at most one hour');
  if (!['analog', 'digital', 'counter64', 'exact'].includes(options.profile) || !Number.isSafeInteger(maxGap) || maxGap < 1 || maxGap > 120000) throw new Error('Invalid aggregate profile or continuity limit');
  if (rows.length > 10002) throw new Error('Aggregate supports at most 10002 samples');
  const ids = new Set<string>();
  const samples = rows.map((row) => {
    if (!/^[1-9][0-9]{0,17}$/.test(row.id) || ids.has(row.id)) throw new Error('Invalid or duplicate aggregate sample identity'); ids.add(row.id);
    const at = Date.parse(row.observedAt); if (!Number.isFinite(at)) throw new Error('Invalid aggregate observation time');
    if (!['Good', 'Bad', 'Stale', 'Disconnected'].includes(row.snapshot.quality) || (row.snapshot.bootId !== null && typeof row.snapshot.bootId !== 'string')) throw new Error('Invalid aggregate snapshot');
    return { ...row, at };
  }).sort((a, b) => a.at - b.at || (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
  const profile = options.profile;
  const valid = (value: SignalValue | null): boolean => profile === 'analog' ? typeof value === 'number' && Number.isFinite(value)
    : profile === 'digital' ? typeof value === 'boolean'
      : profile === 'counter64' ? typeof value === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(value) && BigInt(value) <= 18446744073709551615n
        : typeof value === 'string';
  const result: HistoryAggregate = { from: new Date(from).toISOString(), to: new Date(to).toISOString(), profile, sampleCount: 0, validSampleCount: 0, invalidSamples: 0, first: null, last: null, min: null, max: null, mean: null,
    qualityMs: { Good: 0, Bad: 0, Stale: 0, Disconnected: 0, Unknown: to - from }, trueMs: 0, falseMs: 0, transitions: 0, counterDelta: profile === 'counter64' ? '0' : null, resets: 0 };
  let counterDelta = 0n; let mean = 0; let weight = 0;
  const extremes = (value: SignalValue | null) => {
    if (profile === 'analog') { const number = value as number; result.min = result.min === null ? number : Math.min(result.min as number, number); result.max = result.max === null ? number : Math.max(result.max as number, number); }
    if (profile === 'counter64') { const integer = BigInt(value as string); if (result.min === null || integer < BigInt(result.min)) result.min = value as string; if (result.max === null || integer > BigInt(result.max)) result.max = value as string; }
  };
  for (const [index, row] of samples.entries()) {
    const sample = row.snapshot; const inside = row.at >= from && row.at < to; const usable = sample.quality === 'Good' && valid(sample.value);
    if (inside) {
      result.sampleCount++;
      const observation = { at: new Date(row.at).toISOString(), value: sample.value, quality: sample.quality };
      result.first ??= observation; result.last = observation;
      if (usable) { result.validSampleCount++; extremes(sample.value); }
      else if (sample.quality === 'Good') result.invalidSamples++;
      const previous = samples[index - 1];
      if (usable && previous?.snapshot.quality === 'Good' && valid(previous.snapshot.value) && sample.bootId && sample.bootId === previous.snapshot.bootId && row.at - previous.at <= maxGap) {
        if (profile === 'digital' && sample.value !== previous.snapshot.value) result.transitions++;
        if (profile === 'counter64') {
          const value = BigInt(sample.value as string); const old = BigInt(previous.snapshot.value as string);
          if (value < old) { result.resets++; counterDelta += value; } else counterDelta += value - old;
        }
      }
    }
    const next = samples[index + 1];
    if (!next || !sample.bootId || next.snapshot.bootId !== sample.bootId || next.at - row.at > maxGap) continue;
    const duration = Math.max(0, Math.min(to, next.at) - Math.max(from, row.at)); if (!duration) continue;
    if (sample.quality === 'Good' && !usable) continue;
    result.qualityMs[sample.quality] += duration; result.qualityMs.Unknown -= duration;
    if (usable) {
      extremes(sample.value);
      if (profile === 'analog') {
        const fraction = duration / (weight + duration);
        // Convex blending avoids overflow in (value * duration) and (value - mean).
        mean = weight ? mean * (1 - fraction) + (sample.value as number) * fraction : sample.value as number;
        weight += duration;
      }
      if (profile === 'digital') { if (sample.value) result.trueMs += duration; else result.falseMs += duration; }
    }
  }
  if (weight) result.mean = mean;
  if (profile === 'counter64') result.counterDelta = counterDelta.toString();
  return result;
}
