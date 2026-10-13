import { expect, it } from 'vitest';
import { assessResources, memoryBytes } from './resources.js';
it('parses Docker memory without treating missing samples as zero', () => {
  expect(memoryBytes('1.5GiB / 16GiB')).toBe(1.5*1024**3);
  expect(memoryBytes('896KiB / 512MiB')).toBe(896*1024);
  for (const value of ['', 'N/A', '-1MiB', '1XB']) expect(()=>memoryBytes(value)).toThrow();
});
it('checks one hour of samples, memory headroom and final-half growth', () => {
  const rows = Array.from({length:123},(_,i)=>({at:i*30,containers:[{Name:'api',MemUsage:'1GiB / 16GiB',CPUPerc:'50.00%'}]}));
  expect(assessResources(rows)).toMatchObject({passed:true,peakBytes:1024**3,growthPercent:0});
  expect(assessResources(rows.map((r,i)=>({...r,containers:[{...r.containers[0]!,MemUsage:i>110?'1.1GiB / 16GiB':'1GiB / 16GiB'}]}))).passed).toBe(false);
  expect(assessResources(rows.map(r=>({...r,containers:[{...r.containers[0]!,MemUsage:'13GiB / 16GiB'}]}))).passed).toBe(false);
  expect(()=>assessResources(rows.slice(0,20))).toThrow();
  expect(()=>assessResources(rows.filter((_,i)=>i<40||i>45))).toThrow();
  expect(()=>assessResources(rows.map((r,i)=>({...r,containers:i===60?[]:r.containers})))).toThrow();
});
