export function percentiles(samples: number[]) {
  if (!samples.length || samples.some(n => !Number.isFinite(n) || n < 0)) throw new Error('Invalid or absent latency evidence');
  const sorted = [...samples].sort((a,b) => a-b);
  const rank = (p: number) => sorted[Math.ceil(sorted.length * p) - 1]!;
  return { count: sorted.length, p50: rank(0.5), p95: rank(0.95), p99: rank(0.99), max: sorted.at(-1)! };
}
export function verifyHistory(rows: {value: unknown; bootId: string | null; sequence: number | null; quality: string}[], boot: string, expectedChanges: number) {
  let prior = false, sequence = -1, changes = 0;
  for (const row of rows) {
    if (row.quality !== 'Good' || row.bootId !== boot || typeof row.value !== 'boolean' || row.sequence === null || !Number.isSafeInteger(row.sequence) || row.sequence < sequence || (row.value !== prior && row.sequence === sequence)) throw new Error('Invalid history session, quality or sequence');
    if (row.value !== prior) { changes++; prior = row.value; }
    sequence = row.sequence;
  }
  if (changes !== expectedChanges) throw new Error(`History changes ${changes}; expected ${expectedChanges}`);
  return changes;
}
export function assessLoad(input: { requestedSeconds: number; elapsedSeconds: number; devices: number; commands: number; verified: number; historyChanges: number; missedTicks: number; errors: string[] }) {
  const {requestedSeconds, elapsedSeconds, devices, commands, verified, historyChanges, missedTicks, errors} = input;
  if (!Number.isInteger(requestedSeconds) || requestedSeconds < 60 || requestedSeconds > 3600 || !Number.isFinite(elapsedSeconds) || elapsedSeconds < requestedSeconds || !Number.isInteger(devices) || devices < 1 || devices > 16 || commands !== devices * requestedSeconds || verified !== commands || historyChanges !== commands || missedTicks !== 0 || errors.length) throw new Error('Load workload did not complete without loss');
  return requestedSeconds === 3600 ? 'hour-workload-passed' : 'smoke-passed';
}
