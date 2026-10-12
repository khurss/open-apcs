import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { connectAsync, type MqttClient } from 'mqtt';
import { Client } from 'pg';

const clients: MqttClient[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.endAsync(true)));
});

function endpoint(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must point to an isolated Docker test fixture`);
  return value;
}

describe('M0: real container infrastructure, not mocked transports', () => {
  it('PostgreSQL rolls back uncommitted changes', async () => {
    const client = new Client({ connectionString: endpoint('APCS_TEST_POSTGRES_URL') });
    await client.connect();
    try {
      await client.query('CREATE TEMP TABLE test_events (id text PRIMARY KEY)');
      await client.query('BEGIN');
      await client.query('INSERT INTO test_events VALUES ($1)', [randomUUID()]);
      await client.query('ROLLBACK');
      const result = await client.query<{ count: string }>('SELECT count(*) FROM test_events');
      expect(result.rows[0]?.count).toBe('0');
    } finally {
      await client.end();
    }
  });

  it('delivers a command and an application acknowledgement over real MQTT', async () => {
    const url = endpoint('APCS_TEST_MQTT_URL');
    const topic = `test/${randomUUID()}`;
    const device = await connectAsync(url, { reconnectPeriod: 0, connectTimeout: 3_000 });
    clients.push(device);
    const gateway = await connectAsync(url, { reconnectPeriod: 0, connectTimeout: 3_000 });
    clients.push(gateway);
    await device.subscribeAsync(`${topic}/commands`, { qos: 1 });
    await gateway.subscribeAsync(`${topic}/acks`, { qos: 1 });

    const id = randomUUID();
    const acknowledgement = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('MQTT application ACK timed out')), 3_000);
      gateway.once('message', (_topic, payload) => {
        clearTimeout(timeout);
        try { resolve(JSON.parse(payload.toString())); } catch (error) { reject(error); }
      });
    });
    device.once('message', (_topic, payload) => {
      // Device fixture; this does not substitute for future gateway/firmware tests.
      const command = JSON.parse(payload.toString()) as { id: string; value: boolean };
      device.publish(`${topic}/acks`, JSON.stringify({ id: command.id, value: command.value }), { qos: 1, retain: false });
    });
    await gateway.publishAsync(`${topic}/commands`, JSON.stringify({ id, value: true }), { qos: 1, retain: false });
    await expect(acknowledgement).resolves.toEqual({ id, value: true });
  });
});
