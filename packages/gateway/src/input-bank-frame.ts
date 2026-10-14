/** Validate the whole bank before publishing any channel to the signal store. */
export function parseInputBankFrame(payload: Uint8Array, bootId: string, count: number): {sequence:number; values:number[]} {
  if (!Number.isInteger(count) || count < 1 || count > 15 || payload.length > 2048) throw new Error('Invalid input bank');
  const value: unknown = JSON.parse(Buffer.from(payload).toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid bank frame');
  const frame = value as Record<string,unknown>;
  if (Object.keys(frame).length !== 4 || frame.v !== 1 || frame.bootId !== bootId || !Number.isSafeInteger(frame.sequence) || (frame.sequence as number) < 0 || !Array.isArray(frame.values) || frame.values.length !== count || frame.values.some((v,index) => typeof v !== 'number' || !Number.isFinite(v) || v < index*100 || v >= (index+1)*100)) throw new Error('Invalid bank frame');
  return {sequence:frame.sequence as number,values:frame.values as number[]};
}
