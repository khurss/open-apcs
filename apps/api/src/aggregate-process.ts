import { fork, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
export class AggregateProcess {
  private child: ChildProcess | undefined;
  private closed = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(private readonly options: { connectionString: string; databaseOptions?: string }) { this.start(); }
  private start() {
    if (this.closed) return;
    const child = fork(new URL('./aggregate-worker.ts', import.meta.url), [], {
      execArgv: ['--max-old-space-size=128', '--import', createRequire(import.meta.url).resolve('tsx')], stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
      env: { ...process.env, APCS_POSTGRES_URL: this.options.connectionString, APCS_DB_OPTIONS: this.options.databaseOptions ?? '' },
    });
    this.child = child;
    child.once('error', () => { /* Exit handling restarts the private worker. */ });
    child.once('exit', () => { if (this.child === child) this.child = undefined; if (!this.closed) this.timer = setTimeout(() => this.start(), 10000); });
  }
  async close(): Promise<void> {
    if (this.closed) return; this.closed = true; clearTimeout(this.timer);
    const child = this.child; if (!child || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve) => { const deadline = setTimeout(() => child.kill('SIGKILL'), 11000); child.once('exit', () => { clearTimeout(deadline); resolve(); }); child.kill('SIGTERM'); });
  }
}
