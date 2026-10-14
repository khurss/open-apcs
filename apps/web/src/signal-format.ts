/** Presentation never converts or changes the value used by control or history. */
export const formatSignalValue = (value: boolean | number | string | null | undefined, presentation: {unit?:string;displayDecimals?:number} = {}): string => {
  if(value == null) return 'No data';
  if(typeof value === 'boolean') return value ? 'ON' : 'OFF';
  if(typeof value !== 'number') return value;
  const decimals=presentation.displayDecimals ?? 2;
  return value.toFixed(decimals) + (presentation.unit ? ` ${presentation.unit}` : '');
};
