export interface RuntimeGateway {
  start(): Promise<void>;
  synchronize(): Promise<void>;
  dispatchNext(): Promise<boolean>;
  stop(): Promise<void>;
}

/** Serial soft real-time worker. Restart after a fault is an explicit operation. */
export class LedRuntime {
  private state: 'stopped' | 'running' | 'faulted' = 'stopped';
  private error: string | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight: Promise<void> = Promise.resolve();
  private lastSync = 0;
  private starting = false;
  private stopping = false;

  constructor(private readonly gateway: RuntimeGateway, private readonly now: () => number) {}

  async start(): Promise<void> {
    if (this.state === 'running' || this.starting || this.stopping) throw new Error('Runtime already started or stopping');
    this.starting = true;
    const previous = this.inFlight;
    this.state = 'running'; this.error = null;
    this.inFlight = previous.catch(() => {}).then(async () => {
      if (this.state === 'running') await this.boot();
    });
    try { await this.inFlight; } finally { this.starting = false; }
  }

  async stop(): Promise<void> {
    this.stopping = true; this.state = 'stopped';
    clearTimeout(this.timer);
    try {
      await this.inFlight.catch(() => {});
      await this.gateway.stop();
    } finally { this.stopping = false; }
  }

  get status(): { state: 'stopped' | 'running' | 'faulted'; error: string | null } {
    return { state: this.state, error: this.error };
  }

  private async boot(): Promise<void> {
    try {
      await this.gateway.start();
      if (this.state !== 'running') return;
      await this.gateway.synchronize();
      this.lastSync = this.now(); this.schedule();
    } catch (error) {
      if (this.state !== 'stopped') this.state = 'faulted';
      this.error = 'Runtime startup failed';
      await this.gateway.stop(); throw error;
    }
  }

  private schedule(): void {
    if (this.state !== 'running') return;
    this.timer = setTimeout(() => { this.inFlight = this.cycle(); }, 50);
  }

  private async cycle(): Promise<void> {
    try {
      if (this.now() - this.lastSync >= 1000) {
        await this.gateway.synchronize(); this.lastSync = this.now();
      }
      if (this.state !== 'running') return;
      await this.gateway.dispatchNext();
      this.schedule();
    } catch {
      if (this.state !== 'stopped') this.state = 'faulted';
      this.error = 'Runtime cycle failed; explicit restart required';
      try { await this.gateway.stop(); } catch { this.error = 'Runtime cleanup failed; control lease must expire'; }
    }
  }
}
