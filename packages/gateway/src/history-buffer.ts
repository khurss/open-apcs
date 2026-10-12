import type { SignalObservation } from '../../domain/src/signals.js';
import type { HistoryRow } from '../../domain/src/history.js';
export type { HistoryRow } from '../../domain/src/history.js';
export class HistoryBuffer {
  private readonly queue: HistoryRow[] = [];
  private readonly last = new Map<string, { signature: string; at: number }>();
  private serial = 0;
  private dropped = 0;
  private failures = 0;
  private written = 0;
  private error: string | null = null;
  private flushing: Promise<void> | null = null;
  constructor(private readonly runId: string, private readonly now: () => number, private readonly capacity = 4096, private readonly checkpointMs = 60000) {
    if (!/^[a-zA-Z0-9-]{1,128}$/.test(runId) || !Number.isSafeInteger(capacity) || capacity < 1 || capacity > 100000 || !Number.isSafeInteger(checkpointMs) || checkpointMs < 1 || checkpointMs > 86400000) throw new Error('Invalid history buffer policy');
  }
  offer(event: SignalObservation): void {
    const at = this.now(); const { value, quality, bootId } = event.snapshot;
    const signature = JSON.stringify([value, quality, bootId]); const prior = this.last.get(event.signalId);
    if (prior?.signature === signature && at >= prior.at && at - prior.at < this.checkpointMs) return;
    if (this.queue.length >= this.capacity) { this.dropped++; return; }
    this.queue.push({ ...structuredClone(event), eventId: `${this.runId}:${++this.serial}` });
    this.last.set(event.signalId, { signature, at });
  }
  flush(write: (rows: HistoryRow[]) => Promise<void>): Promise<void> {
    if (this.flushing) return this.flushing;
    if (!this.queue.length) return Promise.resolve();
    const batch = structuredClone(this.queue.slice(0, 100));
    // Defer the writer so even a synchronous throw cannot break acquisition.
    this.flushing = Promise.resolve().then(() => write(batch)).then(() => {
      this.queue.splice(0, batch.length); this.written += batch.length; this.error = null;
    }).catch((cause: unknown) => { this.failures++; this.error = cause instanceof Error ? cause.message : 'History write failed'; }).finally(() => { this.flushing = null; });
    return this.flushing;
  }
  get status() { return { queued: this.queue.length, dropped: this.dropped, failures: this.failures, written: this.written, error: this.error }; }
}
