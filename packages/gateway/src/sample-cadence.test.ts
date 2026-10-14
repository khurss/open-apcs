import {expect,it} from 'vitest';
import {nextSampleDeadline} from './sample-cadence.js';
it('never reuses a reserved sample slot when a timer fires just before its deadline',()=>{
  const first=nextSampleDeadline(100,100,105);
  expect(first).toBe(1100);
  expect(nextSampleDeadline(100,first,1099.7)).toBe(2100);
});
it('skips elapsed slots after a slow publication instead of issuing a catch-up burst',()=>{
  expect(nextSampleDeadline(100,1100,3250)).toBe(4100);
  expect(nextSampleDeadline(100,1100,1101)).toBe(2100);
});
