import { fork, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
let child: ChildProcess | undefined; let closing = false; let restart: ReturnType<typeof setTimeout> | undefined;
function start() {
  if (closing) return;
  child = fork(new URL('./server.ts', import.meta.url), [], { execArgv: ['--import', createRequire(import.meta.url).resolve('tsx')], stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  child.once('error', () => { /* Exit handling starts a fresh renderer. */ });
  child.once('exit', () => { child = undefined; if (!closing) restart = setTimeout(start, 1000); });
}
start();
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => {
  if (closing) return; closing = true; clearTimeout(restart);
  if (!child) { process.exit(0); return; }
  const stopped = child; const deadline = setTimeout(() => { stopped.kill('SIGKILL'); process.exit(0); }, 2000);
  stopped.once('exit', () => { clearTimeout(deadline); process.exit(0); }); stopped.kill('SIGTERM');
});
