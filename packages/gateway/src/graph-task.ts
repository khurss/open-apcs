import { LogicEngine, validateGraph, type LogicGraph, type LogicResult } from '../../domain/src/logic.js';
import type { SignalSnapshot } from '../../domain/src/signals.js';
import type { CommandSnapshot } from '../../domain/src/commands.js';
export interface GraphIo {
  read(ids: string[]): Promise<Record<string, SignalSnapshot>>;
  request(signalId: string, value: boolean): Promise<CommandSnapshot>;
  command(id: string): Promise<CommandSnapshot>;
  revoke(reason: string): Promise<void>;
}
export interface GraphTaskStatus { state: 'stopped' | 'running' | 'paused' | 'faulted'; cycles: number; error: string | null; pending: string[]; last: LogicResult | null; }
export class GraphTask {
  private readonly engine: LogicEngine;
  private readonly ids: string[];
  private readonly boots = new Map<string, string>();
  private readonly pending = new Map<string, string>();
  private readonly targets = new Map<string, boolean>();
  private state: GraphTaskStatus['state'] = 'stopped';
  private cycles = 0;
  private error: string | null = null;
  private last: LogicResult | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight: Promise<void> = Promise.resolve();
  private finished = false;
  private revoked = false;
  private starting = false;
  private pausing = false;
  constructor(graph: LogicGraph, private readonly io: GraphIo, private readonly now: () => number, private readonly periodMs = 100) {
    if (!Number.isSafeInteger(periodMs) || periodMs < 100 || periodMs > 60000) throw new Error('Graph period must be an integer from 100 to 60000 ms');
    const safe = validateGraph(graph); this.engine = new LogicEngine(safe);
    this.ids = [...new Set(safe.nodes.flatMap((node) => node.signalId ? [node.signalId] : []))].sort();
  }
  async start(): Promise<void> {
    if (this.finished || this.state === 'faulted') throw new Error('Create a new task after a stop or fault');
    if (this.state === 'running' || this.starting || this.pausing) throw new Error('Graph task is already running or changing state');
    this.starting = true; this.state = 'running';
    const previous = this.inFlight;
    this.inFlight = previous.then(async () => { if (this.active()) await this.cycle(); });
    try { await this.inFlight; } finally { this.starting = false; }
  }
  async pause(): Promise<void> {
    if (this.pausing) throw new Error('Graph task is already pausing');
    this.pausing = true;
    if (this.state === 'running') this.state = 'paused';
    clearTimeout(this.timer);
    try { await this.inFlight; } finally { this.pausing = false; }
  }
  async stop(): Promise<void> {
    this.finished = true;
    if (this.state !== 'faulted') this.state = 'stopped';
    clearTimeout(this.timer); await this.inFlight;
    await this.revoke('Graph stopped');
  }
  get status(): GraphTaskStatus { return { state: this.state, cycles: this.cycles, error: this.error, pending: [...this.pending.values()], last: structuredClone(this.last) }; }
  private active() { return this.state === 'running' && !this.finished; }
  private async revoke(reason: string) {
    if (this.revoked) return; this.revoked = true;
    try { await this.io.revoke(reason); }
    catch { this.error = `${this.error ?? reason}; revocation failed`; }
  }
  private async cycle(): Promise<void> {
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.calculate(),
        new Promise<never>((_resolve, reject) => { deadline = setTimeout(() => reject(new Error('Graph cycle exceeded its 2000 ms budget')), 2000); }),
      ]);
      if (this.active()) this.timer = setTimeout(() => { this.inFlight = this.cycle(); }, this.periodMs);
    } catch (error) {
      this.state = 'faulted'; this.finished = true;
      this.error = error instanceof Error ? error.message : 'Graph cycle failed'; clearTimeout(this.timer);
      await this.revoke(this.error);
    } finally { clearTimeout(deadline); }
  }
  private async calculate(): Promise<void> {
      const snapshots = await this.io.read(this.ids);
      if (!this.active()) return;
      for (const id of this.ids) {
        const sample = snapshots[id];
        if (!sample || sample.quality !== 'Good' || typeof sample.value !== 'boolean' || !sample.bootId) throw new Error(`Signal ${id} is unavailable`);
        const previous = this.boots.get(id); if (previous && previous !== sample.bootId) throw new Error(`Signal ${id} changed boot session`);
        this.boots.set(id, sample.bootId);
      }
      for (const [id, commandId] of this.pending) {
        const command = await this.io.command(commandId);
        if (!this.active()) return;
        if (command.state === 'Verified') this.pending.delete(id);
        else if (!['Accepted', 'Dispatched', 'DeviceAccepted'].includes(command.state)) throw new Error(`Command ${commandId} ended as ${command.state}`);
      }
      this.last = this.engine.tick(this.now(), Object.fromEntries(this.ids.map((id) => [id, { value: snapshots[id]!.value as boolean, quality: 'Good' as const, reason: null }]))); this.cycles++;
      for (const [id, value] of Object.entries(this.last.outputs)) {
        if (!this.active()) return;
        if (value.quality !== 'Good' || value.value === null) throw new Error(value.reason ?? `Output ${id} is inhibited`);
        if (this.pending.has(id)) continue;
        if (!this.targets.has(id) && snapshots[id]!.value === value.value) this.targets.set(id, value.value);
        if (this.targets.get(id) === value.value) continue;
        const result = await this.io.request(id, value.value);
        // A command may have been accepted while pause/stop was waiting for this cycle.
        if (!['Accepted', 'Dispatched', 'DeviceAccepted', 'Verified'].includes(result.state)) throw new Error(`Command ${result.id} ended as ${result.state}`);
        this.targets.set(id, value.value);
        if (result.state !== 'Verified') this.pending.set(id, result.id);
      }
  }
}
