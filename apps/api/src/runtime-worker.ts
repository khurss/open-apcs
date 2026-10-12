import { Pool } from 'pg';
import { SimulationRuntime } from './runtime-service.js';
import type { CommandRequest } from '../../../packages/domain/src/commands.js';
if (!process.send || !process.env.APCS_POSTGRES_URL || !process.env.APCS_MQTT_URL) throw new Error('Private runtime worker configuration required');
const pool = new Pool({ connectionString: process.env.APCS_POSTGRES_URL, options: process.env.APCS_DB_OPTIONS ?? '', max: 10, connectionTimeoutMillis: 2000, query_timeout: 2000 });
const runtime = new SimulationRuntime(pool, process.env.APCS_MQTT_URL);
let stopping = false;
let queue: Promise<void> = Promise.resolve(); let queued = 0;
const stop = async () => { if (stopping) return; stopping = true; await runtime.close(); await pool.end(); };
process.on('disconnect', () => { void stop(); });
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => { void stop().finally(() => { if (process.connected) process.disconnect(); }); });
process.on('message', (message: unknown) => {
  if (stopping || !message || typeof message !== 'object') return;
  const request = message as { id?: unknown; method?: unknown; args?: unknown };
  if (typeof request.id !== 'string' || request.id.length > 64 || typeof request.method !== 'string' || !Array.isArray(request.args)) return;
  const id = request.id; const method = request.method; const args = request.args;
  if (++queued > 256) { void stop(); return; }
  queue = queue.then(async () => {
    try {
      let result: unknown;
      if (method === 'start' && args.length === 2 && args.every((v) => typeof v === 'string')) result = await runtime.start(args[0] as string, args[1] as string);
      else if (method === 'stop' && typeof args[0] === 'string') result = await runtime.stop(args[0]);
      else if (method === 'status' && typeof args[0] === 'string') result = await runtime.status(args[0]);
      else if (method === 'readSignal' && typeof args[0] === 'string') result = await runtime.readSignal(args[0]);
      else if (method === 'context' && args[0] && typeof args[0] === 'object') result = await runtime.context(args[0] as CommandRequest);
      else if (method === 'close') { await stop(); result = null; }
      else throw new Error('Invalid runtime operation');
      if (process.connected) process.send!({ id, result });
    } catch (error) {
      const message = error instanceof Error && /^(Device not found|Project owner required|Only virtual|Another runtime|Initial runtime limit|Runtime is closed)/.test(error.message) ? error.message : 'Runtime operation failed';
      if (process.connected) process.send!({ id, error: message });
    } finally { queued--; }
  });
});
