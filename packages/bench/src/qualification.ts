import {percentiles} from './load-evidence.js';
import type {LatencySummary} from '../../gateway/src/latency.js';
import type {GraphTiming} from '../../gateway/src/graph-task.js';

/** Compare ordered value changes, not heartbeat refreshes or command acknowledgements. */
export function qualifyUi(samples: {value: boolean; receivedTime: string}[], events: {value: string; quality: string; at: number}[]) {
  if (!samples.length || samples.length !== events.length) throw new Error('UI transition count differs from accepted telemetry');
  const delays = samples.map((sample,index) => {
    const event = events[index]!;
    if (event.quality !== 'Good' || event.value !== (sample.value ? 'ON' : 'OFF')) throw new Error('UI transition differs from telemetry');
    const delay = event.at - Date.parse(sample.receivedTime);
    if (!Number.isFinite(delay) || delay < 0) throw new Error('Invalid UI clock evidence');
    return delay;
  });
  const result = percentiles(delays);
  if (result.p95 > 500 || result.p99 > 1000) throw new Error('UI latency exceeds L0 criteria');
  return result;
}

/** No ACK is sent during this workload; reactivation retains the original occurrence. */
export function qualifyAlarms(events: {kind:string;occurrence:number}[], expected: number) {
  if (!Number.isSafeInteger(expected) || expected < 2 || expected % 2 || events.length !== expected) throw new Error('Alarm transition count differs from workload');
  const occurrence = events[0]!.occurrence;
  if (!Number.isSafeInteger(occurrence) || occurrence < 1) throw new Error('Invalid alarm occurrence');
  for (const [index,event] of events.entries()) {
    if (event.occurrence !== occurrence || (index % 2 ? event.kind !== 'Returned' : !['Activated','Reactivated'].includes(event.kind))) throw new Error('Alarm transition sequence differs from workload');
  }
  return events.length;
}

/** Bounded histograms preserve rank evidence; skipped slots count as over-budget scheduled starts. */
export function qualifyTiming(gateways: LatencySummary[], graph: GraphTiming, seconds: number) {
  if (!gateways.length || gateways.some(g => !Number.isSafeInteger(g.count) || g.count < seconds || !Number.isFinite(g.p95) || !Number.isFinite(g.p99) || g.p95 < 0 || g.p99 < g.p95 || g.p95 > 100 || g.p99 > 250)) throw new Error('Gateway timing evidence missing or outside L0 bounds');
  const slots=graph.starts+graph.skipped;
  if (graph.periodMs !== 100 || !Number.isSafeInteger(graph.starts) || !Number.isSafeInteger(graph.skipped) || graph.skipped < 0 || !Number.isSafeInteger(graph.lateStarts) || graph.lateStarts < 0 || graph.lateStarts > graph.starts || slots < seconds*10 || graph.starts < seconds*9.9 || !graph.startDelay || graph.startDelay.count !== graph.starts || !Number.isFinite(graph.startDelay.p99) || graph.startDelay.p99 < 0 || graph.startDelay.p99 > 50 || graph.lateStarts+graph.skipped > Math.floor(slots*.01)) throw new Error('Graph timing evidence missing or outside L0 bounds');
  return {gatewaySamples:gateways.reduce((n,g) => n+g.count,0), maxArrivalToStateMs:Math.max(...gateways.map(g=>g.max)), graphStarts:graph.starts, ...graph};
}
