import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { connectAsync, type MqttClient } from 'mqtt';
import { Pool } from 'pg';
import { SignalStore, type Clock } from '../../packages/domain/src/signals.js';
import type { CommandRequest } from '../../packages/domain/src/commands.js';
import { PgCommandJournal } from '../../packages/storage/src/command-journal.js';
import { deviceTopic, LedPeer } from '../../packages/led-protocol/src/index.js';
import { MqttLedGateway, MqttLedSimulator, type LedConnection } from '../../packages/gateway/src/mqtt-led.js';

let admin: Pool; let pool: Pool; let schema: string; let journal: PgCommandJournal;
let gateway: MqttLedGateway; let simulator: MqttLedSimulator; let raw: MqttClient;
let signals: SignalStore; let options: LedConnection;
const clock: Clock = { monotonicNow: () => performance.now(), wallNow: () => new Date() };
let interlock: string | null;

beforeEach(async () => {
  if (!process.env.APCS_TEST_POSTGRES_URL || !process.env.APCS_TEST_MQTT_URL) throw new Error('Docker fixtures required');
  const connectionString = process.env.APCS_TEST_POSTGRES_URL;
  schema = `mqtt_${randomUUID().replaceAll('-', '')}`;
  admin = new Pool({ connectionString, max: 1 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  pool = new Pool({ connectionString, options: `-c search_path=${schema}` });
  journal = new PgCommandJournal(pool); await journal.migrate();
  options = { url: process.env.APCS_TEST_MQTT_URL, siteId: randomUUID(), deviceId: 'virtual-esp32', signalId: 'led' };
  signals = new SignalStore(clock);
  signals.register({ id: 'led', deviceId: options.deviceId, dataType: 'boolean', freshnessMs: 3000 });
  interlock = null;
  gateway = new MqttLedGateway(options, signals, journal, clock, () => ({
    projectRevision: 1, interlockReason: interlock, ownerId: 'operator', maxTtlMs: 3000,
  }));
});

afterEach(async () => {
  await gateway?.stop(); await simulator?.stop(); await raw?.endAsync(true);
  await pool?.end();
  if (admin) { try { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); } finally { await admin.end(); } }
});
function request(): CommandRequest {
  return { id: randomUUID(), idempotencyKey: randomUUID(), actorId: 'operator', targetSignalId: 'led',
    value: true, ttlMs: 2000, expectedProjectRevision: 1, reason: 'LED integration test' };
}
async function start(dropAcks = false) {
  const origin = performance.now();
  simulator = new MqttLedSimulator(options, new LedPeer(() => performance.now() - origin, randomUUID()), dropAcks);
  await simulator.start(); await gateway.start(); await gateway.synchronize();
}
async function waitFor(check: () => Promise<boolean> | boolean) {
  const deadline = performance.now() + 2500;
  while (performance.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Condition timed out');
}

describe('LED gateway with real PostgreSQL and Mosquitto', () => {
  it('retains bounded correlated send, broker acknowledgement and receive evidence after a handshake timeout', async () => {
    await start();
    expect(gateway.transport.events.map(e=>e.event)).toEqual(expect.arrayContaining(['send','puback','receive']));
    const sent=gateway.transport.events.find(e=>e.event==='send')!;
    expect(gateway.transport.events).toEqual(expect.arrayContaining([expect.objectContaining({event:'puback',hash:sent.hash,bytes:sent.bytes})]));
    await simulator.stop();
    await expect(gateway.synchronize()).rejects.toThrow('Device handshake timed out');
    expect(gateway.transport.events).toEqual(expect.arrayContaining([expect.objectContaining({event:'timeout'})]));
    expect(signals.get('led').quality).toBe('Disconnected');
    await gateway.stop();
    expect(gateway.transport.events.some(e=>e.event==='timeout')).toBe(true);
  });

  it('records accepted telemetry arrival-to-state delay without counting duplicates', async () => {
    let monotonic = 0;
    gateway = new MqttLedGateway(options, signals, journal, {...clock, monotonicNow: () => monotonic}, () => ({projectRevision: 1, interlockReason: null, ownerId: 'operator', maxTtlMs: 3000}));
    await start();
    const unsubscribe = signals.subscribe(() => { monotonic += 25; });
    raw = await connectAsync(options.url, {protocolVersion: 5, reconnectPeriod: 0});
    const topic = deviceTopic(options.siteId, options.deviceId, 'out');
    const frame = JSON.stringify(simulator.peer.telemetry());
    await raw.publishAsync(topic, frame, {qos: 1});
    await waitFor(() => gateway.diagnostics.telemetry?.count === 1);
    expect(gateway.diagnostics.telemetry).toEqual({count: 1, p50: 25, p95: 25, p99: 25, max: 25});
    const snapshot = gateway.diagnostics;
    snapshot.telemetry!.count = 999;
    expect(gateway.diagnostics.telemetry!.count).toBe(1);
    await raw.publishAsync(topic, frame, {qos: 1});
    // A fresh frame behind the duplicate proves the receive queue drained in order.
    await raw.publishAsync(topic, JSON.stringify(simulator.peer.telemetry()), {qos: 1});
    await waitFor(() => gateway.diagnostics.telemetry!.count === 2);
    expect(gateway.diagnostics.telemetry!.count).toBe(2);
    unsubscribe();
  });

  it('keeps fresh telemetry and handshake replies independent of a stalled acknowledgement journal', async () => {
    await start(); let entered=false; let release!:()=>void;
    const barrier=new Promise<void>(r=>{release=r;});
    const acknowledge=journal.acknowledge.bind(journal);
    vi.spyOn(journal,'acknowledge').mockImplementationOnce(async frame=>{entered=true;await barrier;return acknowledge(frame);});
    const input=request(); await journal.request(input,gateway.context(input)); await gateway.dispatchNext();
    await waitFor(()=>entered);
    try {
      await expect(gateway.synchronize()).resolves.toBeUndefined();
      expect(signals.get('led')).toMatchObject({value:true,quality:'Good'});
      expect((await journal.get(input.id)).state).toBe('Dispatched');
    } finally {release();}
    await waitFor(async ()=>(await journal.get(input.id)).state==='Verified');
  });

  it('keeps the catalog device identity separate from its MQTT address', async () => {
    const addressed = { ...options, protocolDeviceId: 'wire-led' };
    gateway = new MqttLedGateway(addressed, signals, journal, clock, () => ({ projectRevision: 1, interlockReason: null, ownerId: 'operator', maxTtlMs: 3000 }));
    const startAt = performance.now();
    simulator = new MqttLedSimulator({ ...options, deviceId: 'wire-led' }, new LedPeer(() => performance.now() - startAt, randomUUID()));
    await simulator.start(); await gateway.start(); await gateway.synchronize();
    expect(signals.get('led').quality).toBe('Good');
    const input = request(); await journal.request(input, gateway.context(input)); await gateway.dispatchNext();
    await waitFor(async () => (await journal.get(input.id)).state === 'Verified');
    expect(simulator.peer.read()).toBe(true);
  });

  it('requires explicit restart after a device boot change and cancels old commands', async () => {
    await start(); const input = request();
    await journal.request(input, gateway.context(input));
    await simulator.stop();
    const origin = performance.now();
    simulator = new MqttLedSimulator(options, new LedPeer(() => performance.now() - origin, randomUUID()));
    await simulator.start();
    await expect(gateway.synchronize()).rejects.toThrow(/boot.*restart/i);
    await expect(gateway.synchronize()).rejects.toThrow(/boot.*restart/i);
    expect(gateway.context(request()).quality).toBe('Disconnected');
    expect(simulator.peer.telemetry().sessionId).toBeNull();
    await waitFor(async () => (await journal.get(input.id)).state === 'Cancelled');
    expect(simulator.peer.read()).toBe(false);
    await gateway.stop(); await gateway.start(); await gateway.synchronize();
    expect(simulator.peer.read()).toBe(false);
    const fresh = request(); await journal.request(fresh, gateway.context(fresh));
    await gateway.dispatchNext();
    await waitFor(async () => (await journal.get(fresh.id)).state === 'Verified');
  });

  it('requires a fresh session after gateway restart and never replays an old request', async () => {
    await start(); const input = request();
    await journal.request(input, gateway.context(input));
    await gateway.stop(); await gateway.start(); await gateway.synchronize();
    expect(await gateway.dispatchNext()).toBe(false);
    expect((await journal.get(input.id)).state).toBe('Cancelled');
    expect(simulator.peer.read()).toBe(false);
    const next = request(); await journal.request(next, gateway.context(next));
    await gateway.dispatchNext();
    await waitFor(async () => (await journal.get(next.id)).state === 'Verified');
  });

  it('rejects a live retained write at the simulator, not only retained subscription replay', async () => {
    await start();
    raw = await connectAsync(options.url, { protocolVersion: 5, reconnectPeriod: 0 });
    const topic = deviceTopic(options.siteId, options.deviceId, 'in');
    await raw.subscribeAsync(topic, { qos: 1, rap: true });
    let command: Record<string, unknown> | null = null;
    raw.on('message', (_topic, payload) => {
      const frame = JSON.parse(payload.toString()) as Record<string, unknown>;
      if (frame.kind === 'write') command = frame;
    });
    const input = request(); await journal.request(input, gateway.context(input));
    await gateway.dispatchNext();
    await waitFor(async () => (await journal.get(input.id)).state === 'Verified' && command !== null);
    const before = simulator.rejectedFrames;
    await raw.publishAsync(topic, JSON.stringify({ ...command!, id: randomUUID(), value: false }), { qos: 1, retain: true });
    await waitFor(() => simulator.rejectedFrames > before);
    expect(simulator.peer.read()).toBe(true);
    raw.removeAllListeners('message');
    await raw.publishAsync(topic, '', { qos: 1, retain: true });
  });

  it('establishes a session, reads an OFF snapshot, and verifies a persisted command', async () => {
    await start();
    expect(signals.get('led')).toMatchObject({ value: false, quality: 'Good' });
    const input = request();
    expect((await journal.request(input, gateway.context(input))).state).toBe('Accepted');
    expect(await gateway.dispatchNext()).toBe(true);
    await waitFor(async () => (await journal.get(input.id)).state === 'Verified');
    expect(simulator.peer.read()).toBe(true);
    expect(signals.get('led').value).toBe(true);
    expect(await gateway.dispatchNext()).toBe(false);
  });
  it('revalidates interlocks immediately before dispatch', async () => {
    await start(); const input = request();
    await journal.request(input, gateway.context(input));
    interlock = 'Commissioning paused';
    expect(await gateway.dispatchNext()).toBe(false);
    expect((await journal.get(input.id))).toMatchObject({ state: 'Rejected', reason: interlock });
    expect(simulator.peer.read()).toBe(false);
  });
  it('treats telemetry as state, never as an acknowledgement for a lost ACK', async () => {
    await start(true); const input = { ...request(), ttlMs: 500 };
    await journal.request(input, gateway.context(input)); await gateway.dispatchNext();
    await waitFor(() => simulator.peer.read());
    await simulator.telemetry();
    await waitFor(() => signals.get('led').value === true);
    expect((await journal.get(input.id)).state).toBe('Dispatched');
    await pool.query('UPDATE apcs_commands SET expires_at = clock_timestamp() WHERE id = $1', [input.id]);
    await journal.recoverExpired();
    expect((await journal.get(input.id)).state).toBe('Unknown');
    expect(await gateway.dispatchNext()).toBe(false);
  });
  it('cancels unsent commands and marks signals disconnected on gateway shutdown', async () => {
    await start(); const input = request();
    await journal.request(input, gateway.context(input));
    await gateway.stop();
    expect(signals.get('led').quality).toBe('Disconnected');
    expect((await journal.get(input.id)).state).toBe('Cancelled');
    expect(simulator.peer.read()).toBe(false);
  });
  it('ignores retained telemetry and malformed packets without breaking subsequent commands', async () => {
    await start();
    raw = await connectAsync(options.url, { protocolVersion: 5, reconnectPeriod: 0 });
    const topic = deviceTopic(options.siteId, options.deviceId, 'out');
    await raw.publishAsync(topic, JSON.stringify(simulator.peer.telemetry()), { qos: 1, retain: true });
    await raw.publishAsync(topic, '{broken', { qos: 1, retain: false });
    await waitFor(() => gateway.diagnostics.rejectedFrames >= 2);
    const input = request(); await journal.request(input, gateway.context(input));
    await gateway.dispatchNext();
    await waitFor(async () => (await journal.get(input.id)).state === 'Verified');
    await raw.publishAsync(topic, '', { qos: 1, retain: true });
  });
  it('does not enable a device from an unsolicited retained snapshot', async () => {
    raw = await connectAsync(options.url, { protocolVersion: 5, reconnectPeriod: 0 });
    const topic = deviceTopic(options.siteId, options.deviceId, 'out');
    await raw.publishAsync(topic, JSON.stringify({ v: 1, kind: 'snapshot', nonce: 'old', bootId: 'old',
      deviceTimeMs: 0, sequence: 0, value: true }), { qos: 1, retain: true });
    await gateway.start();
    await waitFor(() => gateway.diagnostics.rejectedFrames >= 1);
    expect(gateway.context(request()).bootId).toBeNull();
    expect(signals.get('led').quality).toBe('Disconnected');
    await raw.publishAsync(topic, '', { qos: 1, retain: true });
  });
});
