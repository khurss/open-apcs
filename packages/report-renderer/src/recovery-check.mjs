import { readdir, readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const children = async () => {
  const processes = await readdir('/proc'); const found = [];
  for (const pid of processes.filter((v) => /^\d+$/.test(v))) {
    try { const args = (await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0'); if (args[0]?.includes('node') && args.some((a) => a === 'src/server.ts' || a.endsWith('/report-renderer/src/server.ts')) && !args.includes('watch')) found.push(Number(pid)); } catch {}
  }
  return found;
};
const prior = await children(); assert.equal(prior.length, 1, 'Expected one renderer process');
process.kill(prior[0], 'SIGKILL');
const deadline = Date.now() + 10000; let recovered = false;
while (Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 200));
  const current = await children();
  if (current.length === 1 && current[0] !== prior[0]) { try { recovered = (await fetch('http://127.0.0.1:4100/live', { signal: AbortSignal.timeout(1000) })).ok; } catch {} }
  if (recovered) break;
}
assert.equal(recovered, true, 'Renderer must recover without a source edit after process death');
console.log('Renderer process-death recovery passed.');
