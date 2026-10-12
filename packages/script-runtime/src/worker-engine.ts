import { Worker } from 'node:worker_threads';
import type { ScriptRequest } from './contract.js';
import { ScriptError, type ScriptResponse } from './queue.js';
interface Pending { id: number; resolve(value: ScriptResponse): void; reject(error: Error): void; cleanup(): void; }
/** Hard wall deadline outside the interpreter, with no replay after worker loss. */
export class WorkerEngine {
  private worker: Worker | null = null; private pending: Pending | null = null;
  private closed = false; private available = false; private sequence = 0;
  constructor() { this.start(); }
  get ready() { return this.available && !this.closed; }
  private start() {
    if (this.closed || this.worker) return;
    const worker = new Worker(new URL('./worker.ts', import.meta.url), { execArgv: ['--import', import.meta.resolve('tsx')], resourceLimits: { maxOldGenerationSizeMb: 128, stackSizeMb: 4 } });
    this.worker = worker; this.available = false;
    const boot = setTimeout(() => this.reset(worker, new ScriptError(503, 'Script worker startup failed')), 5000);
    worker.on('message', (message: { ready?: boolean; id?: number; result?: ScriptResponse; error?: string }) => {
      if (this.worker !== worker) return;
      if (message.ready) { clearTimeout(boot); this.available = true; return; }
      const pending = this.pending; if (!pending || message.id !== pending.id) return;
      this.pending = null; pending.cleanup();
      if (message.error || !message.result || (message.result.valid !== true && typeof message.result.value !== 'boolean')) pending.reject(new ScriptError(422, 'Script execution rejected'));
      else pending.resolve(message.result);
    });
    const failed = () => { clearTimeout(boot); this.reset(worker, new ScriptError(503, 'Script worker unavailable')); };
    worker.once('error', failed); worker.once('exit', failed);
  }
  execute(request: ScriptRequest, signal: AbortSignal): Promise<ScriptResponse> {
    const worker = this.worker;
    if (!worker || !this.ready) return Promise.reject(new ScriptError(503, 'Script worker warming up'));
    if (this.pending) return Promise.reject(new ScriptError(429, 'Script worker busy'));
    if (signal.aborted) return Promise.reject(new ScriptError(499, 'Script request cancelled'));
    return new Promise((resolve, reject) => {
      const abort = () => this.reset(worker, new ScriptError(408, 'Script execution deadline exceeded'));
      const timer = setTimeout(abort, 500); signal.addEventListener('abort', abort, { once: true });
      const id = ++this.sequence;
      this.pending = { id, resolve, reject, cleanup: () => { clearTimeout(timer); signal.removeEventListener('abort', abort); } };
      worker.postMessage({ id, request });
    });
  }
  private reset(worker: Worker, error: ScriptError) {
    if (this.worker !== worker) return;
    this.worker = null; this.available = false;
    const pending = this.pending; this.pending = null; pending?.cleanup(); pending?.reject(error);
    void worker.terminate().finally(() => { if (!this.closed) this.start(); });
  }
  async close() { this.closed = true; const worker = this.worker; if (worker) { this.reset(worker, new ScriptError(503, 'Script worker closed')); await worker.terminate(); } }
}
