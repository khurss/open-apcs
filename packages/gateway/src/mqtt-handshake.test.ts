import {EventEmitter} from 'node:events';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {SignalStore} from '../../domain/src/signals.js';
import {LedPeer, deviceTopic, type Frame} from '../../led-protocol/src/index.js';
import type {PgCommandJournal} from '../../storage/src/command-journal.js';

const connection = vi.hoisted(() => ({client: null as BrokerStub | null}));
vi.mock('mqtt', () => ({connectAsync: async () => connection.client}));
import {MqttLedGateway} from './mqtt-led.js';

/** Control the two independent acknowledgements without sleeping or using a real socket. */
class BrokerStub extends EventEmitter {
  connected = true;
  brokerDelay = 0;
  replyDelay = 0;
  readonly sent: Frame[] = [];
  readonly peer = new LedPeer(() => performance.now(), 'test-boot');
  async subscribeAsync() {}
  async endAsync() { this.connected = false; }
  publishAsync(_topic: string, payload: string) {
    const frame = JSON.parse(payload) as Frame;
    this.sent.push(frame);
    const response = this.peer.receive(frame);
    if (response) setTimeout(() => this.emit('message', deviceTopic('bench', 'led', 'out'),
      Buffer.from(JSON.stringify(response)), {retain: false}), this.replyDelay);
    return new Promise<void>(resolve => setTimeout(resolve, this.brokerDelay));
  }
}
let gateway: MqttLedGateway;
let client: BrokerStub;
let signals: SignalStore;
beforeEach(async () => {
  vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout', 'performance']});
  connection.client = client = new BrokerStub();
  const clock = {monotonicNow: () => performance.now(), wallNow: () => new Date()};
  signals = new SignalStore(clock);
  signals.register({id: 'signal', deviceId: 'led', dataType: 'boolean', freshnessMs: 3000});
  const journal = {recoverExpired: async () => 0, connectionLost: async () => {}} as unknown as PgCommandJournal;
  gateway = new MqttLedGateway({url: 'mqtt://test', siteId: 'bench', deviceId: 'led', signalId: 'signal'},
    signals, journal, clock, () => ({ownerId: 'operator', projectRevision: 1, maxTtlMs: 3000, interlockReason: null}));
  await gateway.start();
});
afterEach(async () => { await vi.runAllTimersAsync(); await gateway.stop(); vi.useRealTimers(); });

it('bounds the exchange when the device replies but the broker acknowledgement stalls', async () => {
  client.brokerDelay = 900; client.replyDelay = 10;
  let result = 'pending';
  const synchronization = gateway.synchronize().then(() => { result = 'success'; }, error => { result = error.message; });
  await vi.advanceTimersByTimeAsync(501);
  expect(gateway.transport.events.some(event => event.event === 'receive')).toBe(true);
  expect(result).toBe('Device handshake timed out');
  await synchronization;
  await vi.advanceTimersByTimeAsync(1000);
  expect(client.sent.map(frame => frame.kind)).toEqual(['probe']);
  expect(signals.get('signal').quality).toBe('Disconnected');
  expect(gateway.transport.events.filter(event => event.event === 'timeout')).toHaveLength(1);
});

it('accepts both acknowledgements within the existing budget and clears its timeout', async () => {
  client.brokerDelay = 30; client.replyDelay = 10;
  const result = gateway.synchronize();
  await vi.advanceTimersByTimeAsync(100);
  await expect(result).resolves.toBeUndefined();
  expect(signals.get('signal')).toMatchObject({quality: 'Good', value: false});
  await vi.advanceTimersByTimeAsync(500);
  expect(gateway.transport.events.some(event => event.event === 'timeout')).toBe(false);
});

it('shares the 500 ms deadline across both stages and does not revive authority after a late PUBACK', async () => {
  let calls = 0;
  const publish = client.publishAsync.bind(client);
  client.publishAsync = (topic, payload) => { client.brokerDelay = ++calls === 1 ? 200 : 350; return publish(topic, payload); };
  let result = 'pending';
  const synchronization = gateway.synchronize().then(() => { result = 'success'; }, error => { result = error.message; });
  await vi.advanceTimersByTimeAsync(501);
  expect(result).toBe('Device handshake timed out');
  await synchronization;
  await vi.advanceTimersByTimeAsync(1000);
  expect(signals.get('signal').quality).toBe('Disconnected');
  expect(client.sent.map(frame => frame.kind)).toEqual(['probe', 'lease']);
});

it('expires a missing device reply even when the broker acknowledges immediately', async () => {
  client.replyDelay = 600;
  let result = 'pending';
  const synchronization = gateway.synchronize().then(() => { result = 'success'; }, error => { result = error.message; });
  await vi.advanceTimersByTimeAsync(501);
  expect(result).toBe('Device handshake timed out');
  await synchronization;
  await vi.advanceTimersByTimeAsync(1000);
  expect(signals.get('signal').quality).toBe('Disconnected');
  expect(client.sent.map(frame => frame.kind)).toEqual(['probe']);
});

it('revokes an established session when renewal exceeds the deadline', async () => {
  const initial = gateway.synchronize();
  await vi.advanceTimersByTimeAsync(100); await initial;
  expect(signals.get('signal').quality).toBe('Good');
  client.brokerDelay = 900; client.replyDelay = 10;
  let result = 'pending';
  const renewal = gateway.synchronize().then(() => { result = 'success'; }, error => { result = error.message; });
  await vi.advanceTimersByTimeAsync(501);
  expect(result).toBe('Device handshake timed out');
  expect(signals.get('signal').quality).toBe('Disconnected');
  await renewal; await vi.advanceTimersByTimeAsync(1000);
  expect(client.sent.map(frame => frame.kind)).toEqual(['probe', 'lease', 'probe']);
  expect(signals.get('signal').quality).toBe('Disconnected');
});
