import {expect,it} from 'vitest';
import {formatSignalValue} from './signal-format.js';
it('formats numeric presentation without converting values or inventing missing measurements',()=>{
  expect(formatSignalValue(21.456,{unit:'°C',displayDecimals:1})).toBe('21.5 °C');
  expect(formatSignalValue(21.456)).toBe('21.46');
  expect(formatSignalValue(null,{unit:'bar',displayDecimals:0})).toBe('No data');
  expect(formatSignalValue(false,{unit:'bar',displayDecimals:0})).toBe('OFF');
  expect(formatSignalValue(0,{unit:'%',displayDecimals:0})).toBe('0 %');
});
