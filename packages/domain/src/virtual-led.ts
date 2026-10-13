/** Simulator-only contract: all participants share one monotonic simulation clock. */
export interface SimulatedWrite {
  id: string;
  bootId: string;
  controlSessionId: string;
  value: boolean;
  expiresAt: number;
}

export type SimulatedAck = { id: string } & (
  { status: 'applied'; value: boolean } | { status: 'failed'; reason: string }
);

export class VirtualLed {
  private value = false;
  private lease: { controlSessionId: string; expiresAt: number } | null = null;
  private readonly applied = new Map<string, { fingerprint: string; expiresAt: number; ack: SimulatedAck }>();

  constructor(private readonly now: () => number, private bootId: string) {}

  /** The virtual scheduler observes deadlines on read/apply/grantLease; no real GPIO. */
  read(): boolean {
    this.expire();
    return this.value;
  }

  /** Trusted simulator coordinator API, not an unauthenticated network handler. */
  grantLease(controlSessionId: string, expiresAt: number): void {
    this.expire();
    const remaining = expiresAt - this.now();
    if (!controlSessionId.trim() || !Number.isFinite(remaining) || remaining <= 0 || remaining > 3_000) {
      throw new Error('Invalid LED lease: maximum duration is 3000 ms');
    }
    if (this.lease?.controlSessionId !== controlSessionId) this.value = false;
    if (this.lease?.controlSessionId === controlSessionId && expiresAt <= this.lease.expiresAt) return;
    this.lease = { controlSessionId, expiresAt };
  }

  apply(write: SimulatedWrite): SimulatedAck {
    this.expire();
    const failed = (reason: string): SimulatedAck => ({ id: write.id, status: 'failed', reason });
    if (typeof write.id !== 'string' || !write.id.trim() || typeof write.value !== 'boolean' ||
        !Number.isFinite(write.expiresAt)) return failed('Invalid write');
    if (write.bootId !== this.bootId) return failed('Boot session changed');
    if (!this.lease || this.lease.controlSessionId !== write.controlSessionId) return failed('No active control lease');
    if (write.expiresAt <= this.now()) return failed('Command expired');
    if (write.expiresAt > this.lease.expiresAt) return failed('Command exceeds control lease');
    const fingerprint = JSON.stringify([write.bootId, write.controlSessionId, write.value, write.expiresAt]);
    const previous = this.applied.get(write.id);
    if (previous) {
      if (previous.fingerprint !== fingerprint) return failed('Command ID conflict');
      return { ...previous.ack };
    }
    // Keep every still-valid identity; never evict a live entry to make space.
    if (this.applied.size >= 128) return failed('Simulation command cache full; wait for expiry');
    this.value = write.value;
    const ack: SimulatedAck = { id: write.id, status: 'applied', value: this.value };
    this.applied.set(write.id, { fingerprint, expiresAt: write.expiresAt, ack });
    return { ...ack };
  }

  reboot(bootId: string): void {
    if (!bootId.trim() || bootId === this.bootId) throw new Error('Reboot requires a new boot ID');
    this.bootId = bootId;
    this.value = false;
    this.lease = null;
    this.applied.clear();
  }

  private expire(): void {
    const now = this.now();
    for (const [id, entry] of this.applied) if (entry.expiresAt <= now) this.applied.delete(id);
    if (this.lease && this.now() >= this.lease.expiresAt) {
      this.value = false;
      this.lease = null;
    }
  }
}
