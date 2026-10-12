import { fork, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import type { RuntimeControl, RuntimeStatus, GraphRuntimeStatus } from './runtime-service.js';
import type { CommandContext, CommandRequest } from '../../../packages/domain/src/commands.js';
import type { SignalSnapshot } from '../../../packages/domain/src/signals.js';
export interface RuntimeProcessOptions { connectionString: string; mqttUrl: string; databaseOptions?: string; }
interface Pending { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout>; }
/** Bounded private IPC; restarting a worker never restores its control authority. */
export class RuntimeProcess implements RuntimeControl {
  private child: ChildProcess | null = null;
  private readonly pending = new Map<string, Pending>();
  private closed = false;
  constructor(private readonly options: RuntimeProcessOptions) {}
  get pid(): number | undefined { return this.child?.pid; }
  activateGraph(graphId: string, revision: number, actorId: string, activationId?: string): Promise<GraphRuntimeStatus> { return this.call('activateGraph', [graphId, revision, actorId, activationId ?? randomUUID()]); }
  stopGraph(graphId: string, activationId?: string): Promise<GraphRuntimeStatus> { return this.call('stopGraph', [graphId, activationId]); }
  graphStatus(graphId: string): Promise<GraphRuntimeStatus> { return this.call('graphStatus', [graphId]); }
  start(deviceId: string, actorId: string): Promise<RuntimeStatus> { return this.call('start', [deviceId, actorId]); }
  stop(deviceId: string): Promise<RuntimeStatus> { return this.call('stop', [deviceId]); }
  status(deviceId: string): Promise<RuntimeStatus> { return this.call('status', [deviceId]); }
  readSignal(signalId: string): Promise<SignalSnapshot> { return this.call('readSignal', [signalId]); }
  context(request: CommandRequest): Promise<CommandContext> { return this.call('context', [request]); }
  async close(): Promise<void> {
    if (this.closed) return;
    const child = this.child;
    if (child) { try { await this.call('close', []); } catch {} finally { if (child.connected) child.disconnect(); child.kill('SIGTERM'); } }
    this.closed = true;
    this.fail(new Error('Runtime client closed'));
  }
  private ensure(): ChildProcess {
    if (this.closed) throw new Error('Runtime client closed');
    if (this.child && this.child.connected && !this.child.killed) return this.child;
    const child = fork(new URL('./runtime-worker.ts', import.meta.url), [], {
      execArgv: ['--import', createRequire(import.meta.url).resolve('tsx')],
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'], serialization: 'advanced',
      env: { ...process.env, APCS_POSTGRES_URL: this.options.connectionString, APCS_MQTT_URL: this.options.mqttUrl, APCS_DB_OPTIONS: this.options.databaseOptions ?? '' },
    });
    this.child = child;
    child.on('message', (value: unknown) => {
      if (!value || typeof value !== 'object' || !('id' in value) || typeof value.id !== 'string') return;
      const pending = this.pending.get(value.id); if (!pending) return;
      clearTimeout(pending.timer); this.pending.delete(value.id);
      if ('error' in value && typeof value.error === 'string') pending.reject(new Error(value.error));
      else if ('result' in value) pending.resolve(value.result);
      else pending.reject(new Error('Invalid runtime reply'));
    });
    const exited = () => { if (this.child === child) { this.child = null; this.fail(new Error('Runtime process disconnected; control is not armed')); } };
    child.once('error', exited); child.once('exit', exited); child.once('disconnect', exited);
    return child;
  }
  private call<T>(method: keyof RuntimeControl, args: unknown[]): Promise<T> {
    if (this.pending.size >= 256) return Promise.reject(new Error('Runtime request queue is full'));
    const child = this.ensure(); const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); if (this.child === child) { this.child = null; this.fail(new Error('Runtime request timed out; control is not armed')); } }, 5000);
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
      child.send({ id, method, args }, (error) => { if (error && this.child === child) { child.kill('SIGKILL'); this.child = null; this.fail(new Error('Runtime IPC unavailable')); } });
    });
  }
  private fail(error: Error) { for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); } this.pending.clear(); }
}
