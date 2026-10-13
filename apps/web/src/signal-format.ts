/** Display rounding never changes the value used by control or history. */
export const formatSignalValue = (value: boolean | number | string | null | undefined): string => value == null ? 'No data' : typeof value === 'boolean' ? value ? 'ON' : 'OFF' : typeof value === 'number' ? value.toFixed(2) : value;
