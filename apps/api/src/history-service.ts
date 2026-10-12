import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { SignalStore } from '../../../packages/domain/src/signals.js';
import { HistoryBuffer } from '../../../packages/gateway/src/history-buffer.js';
import { PgSignalArchive } from '../../../packages/storage/src/signal-archive.js';
export interface HistoryStatus { active: boolean; queued: number; dropped: number; failures: number; written: number; error: string | null; pruned: number; maintenanceError: string | null; observerFailures: number; }
/** Archive I/O has its own bounded queue and never participates in command acceptance. */
export class HistoryService {
  private readonly buffer = new HistoryBuffer(randomUUID(), () => performance.now());
  private readonly archive: PgSignalArchive;
  private readonly unsubscribe: () => void;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private work: Promise<void> = Promise.resolve();
  private active = false;
  private closed = false;
  private lastPrune = performance.now();
  private pruned = 0;
  private maintenanceError: string | null = null;
  constructor(pool: Pool, private readonly signals: SignalStore, private readonly ids: () => Iterable<string>) {
    this.archive = new PgSignalArchive(pool);
    this.unsubscribe = signals.subscribe((event) => this.buffer.offer(event));
  }
  start(): void { if (this.active || this.closed) return; this.active = true; this.schedule(); }
  get status(): HistoryStatus { return { active: this.active, ...this.buffer.status, pruned: this.pruned, maintenanceError: this.maintenanceError, observerFailures: this.signals.observerFailures }; }
  private schedule() { if (this.active) this.timer = setTimeout(() => { this.work = this.cycle(); }, 250); }
  private async flush() {
    await this.buffer.flush(async (rows) => { try { await this.archive.append(rows); } catch { throw new Error('History storage unavailable'); } });
  }
  private async cycle() {
    try {
      for (const signalId of this.ids()) this.buffer.offer({ signalId, snapshot: this.signals.get(signalId), observedAt: new Date().toISOString() });
      await this.flush();
      if (this.active && performance.now() - this.lastPrune >= 60000) {
        this.lastPrune = performance.now();
        try {
          const cutoff = new Date(Date.now() - 7 * 86400000);
          for (let batch = 0; batch < 10 && this.active; batch++) { const count = await this.archive.prune(cutoff); this.pruned += count; if (count < 1000) break; }
          this.maintenanceError = null;
        } catch { this.maintenanceError = 'History retention maintenance failed'; }
      }
    } catch { this.maintenanceError = 'History observation failed'; }
    finally { this.schedule(); }
  }
  async close(): Promise<void> {
    if (this.closed) return; this.closed = true; this.active = false; clearTimeout(this.timer);
    this.unsubscribe(); await this.work;
    const deadline = performance.now() + 2000;
    while (this.buffer.status.queued && performance.now() < deadline) { await this.flush(); if (this.buffer.status.error) break; }
  }
}
