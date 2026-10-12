import { enqueueNotifications } from './notification-store.js';
import type { Pool } from 'pg';
import type { SignalSnapshot } from '../../../packages/domain/src/signals.js';
import { AlarmEngine, type AlarmSnapshot, type AlarmDefinition } from '../../../packages/domain/src/alarms.js';
import { transaction, audit } from './store.js';
export type AlarmAction = { kind: 'acknowledge'; occurrence: number; reason: string } | { kind: 'suppress'; durationMs: number; reason: string } | { kind: 'unsuppress'; reason: string };
export interface AlarmServiceStatus { state: 'stopped' | 'running' | 'faulted'; error: string | null; rules: number; }
interface Entry { id: string; signalId: string; engine: AlarmEngine; version: number; saved: number; evaluatedAt: string | null; }
export class AlarmService {
  private entries = new Map<string, Entry>();
  private active = false;
  private closed = false;
  private error: string | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private work: Promise<unknown> = Promise.resolve();
  private loaded = -Infinity;
  constructor(private readonly pool: Pool, private readonly read: (id: string) => SignalSnapshot) {}
  start(): void { if (this.active || this.closed || this.error) return; this.active = true; this.schedule(); }
  private serial<T>(job: () => Promise<T>): Promise<T> { const next = this.work.then(job); this.work = next.catch(() => {}); return next; }
  private schedule() { if (this.active) this.timer = setTimeout(() => { void this.serial(async () => { if (!this.active) return; try { await this.cycle(); } catch { this.fault(); } finally { this.schedule(); } }); }, 100); }
  private fault() { this.error = 'Alarm monitoring failed; restart required'; this.active = false; clearTimeout(this.timer); }
  private async load() {
    const result = await this.pool.query<{ id: string; signal_id: string; definition: AlarmDefinition; state: AlarmSnapshot }>('SELECT id,signal_id,definition,state FROM apcs_alarms ORDER BY id LIMIT 101');
    if (result.rows.length > 100) throw new Error('Alarm rule limit exceeded');
    for (const row of result.rows) if (!this.entries.has(row.id)) this.entries.set(row.id, { id: row.id, signalId: row.signal_id, version: row.state.version, engine: new AlarmEngine(row.definition, { monotonicNow: () => performance.now(), wallNow: () => new Date() }, row.state), saved: -Infinity, evaluatedAt: null });
    this.loaded = performance.now();
  }
  private async cycle() {
    if (performance.now() - this.loaded >= 1000) await this.load();
    for (const entry of this.entries.values()) {
      entry.evaluatedAt = new Date().toISOString(); entry.engine.update(this.read(entry.signalId));
      if (entry.engine.snapshot.version !== entry.version || performance.now() - entry.saved >= 1000) await this.persist(entry);
    }
  }
  private async persist(entry: Entry) {
    const events = entry.engine.drainEvents(); const state = entry.engine.snapshot;
    try {
      await transaction(this.pool, async (client) => {
        const row = (await client.query('SELECT state FROM apcs_alarms WHERE id=$1 FOR UPDATE', [entry.id])).rows[0];
        if (!row || row.state.version !== entry.version) throw new Error('Alarm state changed concurrently');
        for (const event of events) {
          await client.query('INSERT INTO apcs_alarm_events (alarm_id,version,kind,occurrence,actor_id,reason,at) VALUES ($1,$2,$3,$4,$5,$6,$7)', [entry.id, event.version, event.kind, event.occurrence, event.actorId, event.reason, event.at]);
          await enqueueNotifications(client, entry.id, event, state);
          await audit(client, event.actorId, `alarm.${event.kind.toLowerCase()}`, entry.id, { occurrence: event.occurrence, reason: event.reason });
        }
        await client.query('UPDATE apcs_alarms SET state=$2,last_evaluated_at=$3 WHERE id=$1', [entry.id, state, entry.evaluatedAt]);
      });
      entry.version = state.version; entry.saved = performance.now();
    } catch (error) { this.fault(); throw error; }
  }
  async action(id: string, actor: string, action: AlarmAction): Promise<void> {
    return this.serial(async () => {
      if (!this.active || this.error) throw new Error('Alarm monitoring is unavailable');
      const owner = (await this.pool.query('SELECT p.owner_id FROM apcs_alarms a JOIN apcs_projects p ON p.id=a.project_id WHERE a.id=$1', [id])).rows[0];
      if (owner?.owner_id !== actor) throw new Error('Alarm owner required');
      if (!this.entries.has(id)) await this.load();
      const entry = this.entries.get(id); if (!entry) throw new Error('Alarm unavailable');
      if (action.kind === 'acknowledge') entry.engine.acknowledge(action.occurrence, actor, action.reason);
      else if (action.kind === 'suppress') entry.engine.suppress(action.durationMs, actor, action.reason);
      else entry.engine.unsuppress(actor, action.reason);
      await this.persist(entry);
    });
  }
  async close(): Promise<void> { this.closed = true; this.active = false; clearTimeout(this.timer); await this.work; }
  get status(): AlarmServiceStatus { return { state: this.error ? 'faulted' : this.active ? 'running' : 'stopped', error: this.error, rules: this.entries.size }; }
}
