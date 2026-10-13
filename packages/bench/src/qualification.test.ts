import {describe, expect, it} from 'vitest';
import {qualifyUi, qualifyAlarms, qualifyTiming} from './qualification.js';

describe('L0 supplemental acceptance evidence', () => {
  const samples = [{value:true, receivedTime:'2026-01-01T00:00:00.000Z'}, {value:false, receivedTime:'2026-01-01T00:00:01.000Z'}];
  const events = [{value:'ON',quality:'Good',at:Date.parse(samples[0]!.receivedTime)+200}, {value:'OFF',quality:'Good',at:Date.parse(samples[1]!.receivedTime)+300}];
  it('correlates every ordered physical transition to its first accepted sample', () => {
    expect(qualifyUi(samples,events)).toMatchObject({count:2,p95:300});
    expect(() => qualifyUi(samples,events.slice(1))).toThrow(/count/);
    expect(() => qualifyUi(samples,[events[1]!,events[0]!])).toThrow(/transition/);
    expect(() => qualifyUi(samples,[{...events[0]!,at:events[0]!.at-500},events[1]!])).toThrow(/clock/);
    expect(() => qualifyUi(samples,[{...events[0]!,at:events[0]!.at+1500},events[1]!])).toThrow(/latency/);
    expect(() => qualifyUi(samples,[{...events[0]!,quality:'Stale'},events[1]!])).toThrow(/transition/);
  });
  it('requires all alternating persisted alarm transitions within the same unacknowledged occurrence', () => {
    const events=[{kind:'Activated',occurrence:1},{kind:'Returned',occurrence:1},{kind:'Reactivated',occurrence:1},{kind:'Returned',occurrence:1}];
    expect(qualifyAlarms(events,4)).toBe(4);
    expect(() => qualifyAlarms(events.slice(1),4)).toThrow();
    expect(() => qualifyAlarms([{kind:'Activated',occurrence:1},{kind:'Returned',occurrence:2}],2)).toThrow();
  });
  it('checks gateway percentiles and counts missed slots against the graph percentile budget', () => {
    const task={periodMs:100,starts:601,skipped:0,maxStartDelayMs:12,maxExecutionMs:9,lateStarts:0,startDelay:{count:601,p50:1,p95:5,p99:12,max:12}};
    expect(qualifyTiming([{count:60,p50:20,p95:20,p99:20,max:20}],task,60)).toMatchObject({graphStarts:601});
    expect(qualifyTiming([{count:60,p50:20,p95:20,p99:20,max:20}],{...task,skipped:1,lateStarts:1,maxStartDelayMs:80,startDelay:{count:601,p50:1,p95:5,p99:12,max:80}},60)).toMatchObject({skipped:1});
    expect(() => qualifyTiming([{count:60,p50:20,p95:20,p99:20,max:20}],{...task,lateStarts:7},60)).toThrow();
    expect(() => qualifyTiming([{count:0,p50:0,p95:0,p99:0,max:0}],task,60)).toThrow();
    expect(() => qualifyTiming([{count:60,p50:20,p95:101,p99:101,max:101}],task,60)).toThrow();
    expect(() => qualifyTiming([{count:60,p50:20,p95:20,p99:20,max:20}],{...task,skipped:7},60)).toThrow();
    expect(() => qualifyTiming([{count:60,p50:20,p95:20,p99:20,max:20}],{...task,starts:5},60)).toThrow();
  });
});
