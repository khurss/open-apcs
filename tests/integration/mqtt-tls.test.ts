import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { connectAsync } from 'mqtt';
import { Pool } from 'pg';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { SignalStore } from '../../packages/domain/src/signals.js';
import { PgCommandJournal } from '../../packages/storage/src/command-journal.js';
import { LedPeer } from '../../packages/led-protocol/src/index.js';
import { MqttLedGateway, MqttLedSimulator } from '../../packages/gateway/src/mqtt-led.js';
let pool: Pool; let admin: Pool; let schema: string; let journal: PgCommandJournal; let ca: string;
let gateway: MqttLedGateway | undefined; let device: MqttLedSimulator | undefined;
const url = 'mqtts://mqtt-tls:8883'; const clock = { monotonicNow: () => performance.now(), wallNow: () => new Date() };
const base = { url, siteId: 'tls', deviceId: 'led', signalId: 'led' };
beforeEach(async () => {
  if (!process.env.APCS_TEST_POSTGRES_URL) throw new Error('Docker fixtures required');
  schema = `tls_${randomUUID().replaceAll('-', '')}`; admin = new Pool({ connectionString: process.env.APCS_TEST_POSTGRES_URL }); await admin.query(`CREATE SCHEMA ${schema}`);
  pool = new Pool({ connectionString: process.env.APCS_TEST_POSTGRES_URL, options: `-c search_path=${schema}` }); journal = new PgCommandJournal(pool); await journal.migrate();
  ca = await readFile(new URL('../../.cache/mqtt-tls-fixture/ca.crt', import.meta.url), 'utf8'); gateway = undefined; device = undefined;
});
afterEach(async () => { await gateway?.stop(); await device?.stop(); await pool?.end(); if (admin) { try { await admin.query(`DROP SCHEMA ${schema} CASCADE`); } finally { await admin.end(); } } });
describe('authenticated TLS MQTT transport and topic boundaries', () => {
  it('verifies an LED command through distinct gateway/device credentials over TLS', async () => {
    const signals = new SignalStore(clock); signals.register({ id: 'led', deviceId: 'led', dataType: 'boolean', freshnessMs: 3000 });
    device = new MqttLedSimulator({ ...base, credentials: { ca, username: 'device', password: 'fixture-device-password' } }, new LedPeer(() => performance.now(), randomUUID()));
    gateway = new MqttLedGateway({ ...base, credentials: { ca, username: 'gateway', password: 'fixture-gateway-password' } }, signals, journal, clock, () => ({ ownerId: 'operator', projectRevision: 1, maxTtlMs: 3000, interlockReason: null }));
    await device.start(); await gateway.start(); await gateway.synchronize(); expect(signals.get('led').quality).toBe('Good');
    const command = { id: randomUUID(), idempotencyKey: randomUUID(), targetSignalId: 'led', actorId: 'operator', value: true, reason: 'TLS bench', ttlMs: 2000, expectedProjectRevision: 1 };
    await journal.request(command, gateway.context(command)); await gateway.dispatchNext();
    await expect.poll(async () => (await journal.get(command.id)).state).toBe('Verified'); expect(device.peer.read()).toBe(true);
  });
  it('does not let a process environment override broker certificate verification', async () => {
    const previous = process.env.NODE_TLS_REJECT_UNAUTHORIZED; process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    try {
      device = new MqttLedSimulator({ ...base, credentials: { username: 'device', password: 'fixture-device-password' } }, new LedPeer(() => performance.now(), randomUUID()));
      await expect(device.start()).rejects.toThrow();
    } finally { if (previous === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED; else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previous; }
  });
  it('rejects bad passwords and prevents a device from publishing control commands', async () => {
    await expect(connectAsync(url, { ca, username: 'device', password: 'incorrect', protocolVersion: 5, reconnectPeriod: 0, connectTimeout: 1000 })).rejects.toThrow();
    const client = await connectAsync(url, { ca, username: 'device', password: 'fixture-device-password', protocolVersion: 5, reconnectPeriod: 0 });
    try { await expect(client.publishAsync('openapcs/led/v1/tls/led/in', 'forged', { qos: 1 })).rejects.toThrow(); }
    finally { await client.endAsync(true); }
  });
});
