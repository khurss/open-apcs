import type { EventEmitter } from 'node:events';
export async function supervise(child: EventEmitter & { kill(signal: 'SIGKILL'): boolean }, cleanup: (armed: boolean, locked: boolean) => Promise<void>, timeoutMs: number) {
  let armed = false, locked = false, timedOut = false;
  const result = await new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.on('message', message => { if (message === 'arming') armed = true; if (message === 'locked') locked = true; });
    child.once('error', () => { clearTimeout(timer); resolve(null); });
    child.once('close', code => { clearTimeout(timer); resolve(code as number | null); });
  });
  await cleanup(armed, locked);
  if (timedOut || result !== 0) throw new Error(timedOut ? 'Hardware worker exceeded its deadline' : 'Hardware worker failed');
}
