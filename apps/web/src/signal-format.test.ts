import {expect,it} from 'vitest';
import {formatSignalValue} from './signal-format.js';
it('formats numeric presentation without converting values or inventing missing measurements',()=>{
  expect(formatSignalValue(21.456,{unit:'°C',displayDecimals:1})).toBe('21.5 °C');
  expect(formatSignalValue(21.456)).toBe('21.46');
  expect(formatSignalValue(null,{unit:'bar',displayDecimals:0})).toBe('No data');
  expect(formatSignalValue(false,{unit:'bar',displayDecimals:0})).toBe('OFF');
  expect(formatSignalValue(0,{unit:'%',displayDecimals:0})).toBe('0 %');
});
it('keeps chart ticks compact while preserving configured precision in ordinary ranges',async()=>{
  const {formatAxisValue}=await import('./signal-format.js');
  expect(formatAxisValue(21.456,{displayDecimals:1})).toBe('21.5');
  expect(formatAxisValue(1e100,{displayDecimals:6}).length).toBeLessThanOrEqual(12);
  expect(formatAxisValue(-0.0000001,{displayDecimals:6})).toBe('-1.00e-7');
});
