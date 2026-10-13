import { createServer, connect, type Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { connectAsync, type MqttClient } from 'mqtt';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SignalStore } from '../../packages/domain/src/signals.js';
import { MqttThermalProcess, thermalTopic } from '../../packages/gateway/src/thermal-process.js';
const closers: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); });
function fixture(now = () => performance.now()) {
  const url = process.env.APCS_TEST_MQTT_URL; if (!url) throw new Error('Docker broker required');
  const deviceId = randomUUID(); const boot = randomUUID(); const signalId = randomUUID();
  const options = { url, siteId: randomUUID(), deviceId, signalId, temperatureSignalId: signalId };
  const signals = new SignalStore({ monotonicNow: now, wallNow: () => new Date() }); signals.register({ id: signalId, deviceId, dataType: 'float64', freshnessMs: 3000 }); signals.beginSession(deviceId, boot);
  let heating = false; const fault = vi.fn();
  const thermal = new MqttThermalProcess(options, boot, () => heating, signals, fault, now); closers.push(() => thermal.stop());
  return { options, boot, signalId, signals, process: thermal, fault, heat: (value = true) => { heating = value; } };
}
describe('virtual thermal telemetry through actual MQTT', () => {
  it('receives ordered finite temperature samples and marks them disconnected on stop', async () => {
    const f = fixture(); await f.process.start(); expect(f.signals.get(f.signalId)).toMatchObject({ value: 20, quality: 'Good', bootId: f.boot });
    f.heat(); await expect.poll(() => f.signals.get(f.signalId).value as number, { timeout: 4000 }).toBeGreaterThan(20.1);
    expect(f.signals.get(f.signalId).sequence).toBeGreaterThan(0); expect(f.fault).not.toHaveBeenCalled();
    await f.process.stop(); expect(f.signals.get(f.signalId).quality).toBe('Disconnected'); await expect(f.process.start()).rejects.toThrow(/stopped|started/);
  });
  it('rejects retained, foreign-session, malformed and invalid numeric frames', async () => {
    const f = fixture(); await f.process.start(); const client: MqttClient = await connectAsync(f.options.url, { protocolVersion: 5, reconnectPeriod: 0 }); closers.push(() => client.endAsync(true));
    const topic = thermalTopic(f.options); const frame = { v: 1, bootId: f.boot, sequence: 999, value: 39 };
    await client.publishAsync(topic, JSON.stringify(frame), { qos: 1, retain: true });
    for (const value of [{ ...frame, bootId: 'foreign' }, { ...frame, value: '39' }, { ...frame, extra: true }, { ...frame, value: 100 }, { ...frame, sequence: -1 }]) await client.publishAsync(topic, JSON.stringify(value), { qos: 1 });
    await client.publishAsync(topic, '{broken', { qos: 1 });
    await expect.poll(() => f.process.rejectedFrames).toBeGreaterThanOrEqual(7);
    expect(f.signals.get(f.signalId)).toMatchObject({ value: 20, quality: 'Good' }); expect(f.fault).not.toHaveBeenCalled();
    await client.publishAsync(topic, '', { qos: 1, retain: true });
  });
  it('faults overdue sampling once and leaves no usable sensor quality', async () => {
    let now = 0; const f = fixture(() => now); await f.process.start(); now = 10000;
    await expect.poll(() => f.fault.mock.calls.length, { timeout: 3000 }).toBe(1);
    expect(f.signals.get(f.signalId).quality).toBe('Disconnected'); expect(f.fault).toHaveBeenCalledWith('Virtual process sampling failed');
  });
});

it('disconnects sensor quality when the real broker transport is interrupted', async () => {
  const f = fixture(); const broker = new URL(f.options.url); const sockets = new Set<Socket>();
  const proxy = createServer((client) => {
    const upstream = connect(Number(broker.port || 1883), broker.hostname); sockets.add(client); sockets.add(upstream);
    client.on('error', () => upstream.destroy()); upstream.on('error', () => client.destroy());
    client.on('close', () => { sockets.delete(client); upstream.destroy(); }); upstream.on('close', () => { sockets.delete(upstream); client.destroy(); });
    client.pipe(upstream); upstream.pipe(client);
  });
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  closers.unshift(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>((resolve) => proxy.close(() => resolve())); });
  const address = proxy.address(); if (!address || typeof address === 'string') throw new Error('Proxy fixture unavailable');
  f.options.url = `mqtt://127.0.0.1:${address.port}`;
  await f.process.start(); expect(f.signals.get(f.signalId).quality).toBe('Good');
  for (const socket of sockets) socket.destroy();
  await expect.poll(() => f.fault.mock.calls.length).toBe(1);
  expect(f.signals.get(f.signalId).quality).toBe('Disconnected');
});


it('integrates a heater pulse between one-second telemetry samples', async () => {
  const f = fixture(); await f.process.start();
  f.heat(); await new Promise((resolve) => setTimeout(resolve, 300)); f.heat(false);
  await expect.poll(() => Number(f.signals.get(f.signalId).value), { timeout: 2500 }).toBeGreaterThan(20.1);
  expect(f.signals.get(f.signalId).sequence).toBeLessThanOrEqual(3);
  expect(f.fault).not.toHaveBeenCalled();
});
