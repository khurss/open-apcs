import type { ScriptRequest } from './contract.js';
export interface ScriptResponse { value?: boolean; valid?: true; }
export class ScriptError extends Error { constructor(readonly status: number, message: string) { super(message); } }
interface Job { request: ScriptRequest; controller: AbortController; resolve(value: ScriptResponse): void; reject(error: Error): void; cleanup(): void; settled: boolean; }
/** One active calculation and a bounded outstanding queue. Cancellation never overlaps jobs. */
export class ScriptQueue {
  private readonly waiting: Job[] = []; private active: Job | null = null; private closed = false;
  constructor(private readonly execute: (request: ScriptRequest, signal: AbortSignal) => Promise<ScriptResponse>, private readonly capacity = 4, private readonly timeoutMs = 1500) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 16 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 5000) throw new Error('Invalid script queue limits');
  }
  run(request: ScriptRequest, signal?: AbortSignal): Promise<ScriptResponse> {
    if (this.closed) return Promise.reject(new ScriptError(503, 'Script queue closed'));
    if (signal?.aborted) return Promise.reject(new ScriptError(499, 'Script request cancelled'));
    if (this.waiting.length + Number(!!this.active) >= this.capacity) return Promise.reject(new ScriptError(429, 'Script queue full'));
    return new Promise((resolve, reject) => {
      const job: Job = { request: structuredClone(request), controller: new AbortController(), resolve, reject, cleanup: () => {}, settled: false };
      const cancel = () => this.cancel(job, new ScriptError(499, 'Script request cancelled'));
      const timer = setTimeout(() => this.cancel(job, new ScriptError(408, 'Script request deadline exceeded')), this.timeoutMs);
      signal?.addEventListener('abort', cancel, { once: true }); job.cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); };
      this.waiting.push(job); this.pump();
    });
  }
  close(): void { this.closed = true; for (const job of [...this.waiting, ...(this.active ? [this.active] : [])]) this.cancel(job, new ScriptError(503, 'Script queue closed')); }
  private cancel(job: Job, error: ScriptError) {
    if (job.settled) return; job.settled = true; job.cleanup(); job.controller.abort(); job.reject(error);
    const index = this.waiting.indexOf(job); if (index >= 0) this.waiting.splice(index, 1);
  }
  private pump() {
    if (this.closed || this.active || !this.waiting.length) return;
    const job = this.waiting.shift()!; this.active = job;
    void this.execute(job.request, job.controller.signal).then((result) => { if (!job.settled) { job.settled = true; job.resolve(result); } }, (error: unknown) => { if (!job.settled) { job.settled = true; job.reject(error instanceof Error ? error : new ScriptError(503, 'Script execution failed')); } }).finally(() => { job.cleanup(); this.active = null; this.pump(); });
  }
}
