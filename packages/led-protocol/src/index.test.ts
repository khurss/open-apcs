import { describe, expect, it } from 'vitest';
import { decodeFrame, deviceTopic, GatewaySession, LedPeer, type Frame } from './index.js';

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
function bench() {
  let gatewayTime = 100_000;
  let deviceTime = 17;
  const gateway = new GatewaySession(() => gatewayTime, 'session-1');
  const device = new LedPeer(() => deviceTime, 'boot-1');
  const advance = (ms: number) => { gatewayTime += ms; deviceTime += ms; };
  const handshake = (nonce = 'probe-1') => {
    const probe = gateway.probe(nonce);
    advance(10);
    const snapshot = device.receive(probe)!;
    advance(10);
    const lease = gateway.snapshot(snapshot);
    advance(10);
    const ready = device.receive(lease)!;
    advance(10);
    gateway.ready(ready);
    return lease;
  };
  return { gateway, device, advance, handshake, now: () => gatewayTime };
}

describe('LED wire format', () => {
  it('decodes a versioned frame', () => {
    const input = { v: 1, kind: 'probe', nonce: 'nonce-1' };
    expect(decodeFrame(encode(input))).toEqual(input);
  });
  it.each([
    null, [], { v: 2, kind: 'probe', nonce: 'n' }, { v: 1, kind: 'probe', nonce: '' },
    { v: 1, kind: 'probe', nonce: 'n', extra: true },
    { v: 1, kind: 'write', id: 'c', bootId: 'b', sessionId: 's', expiresAtMs: -1, value: true },
    { v: 1, kind: 'write', id: 'c', bootId: 'b', sessionId: 's', expiresAtMs: 20, value: 'true' },
    { v: 1, kind: 'snapshot', nonce: 'n', bootId: 'b', deviceTimeMs: 0, sequence: 0.5, value: false },
    { v: 1, kind: 'ack', id: 'c', bootId: 'b', sessionId: 's', status: 'applied' },
  ])('rejects malformed or incompatible data: %j', (value) => {
    expect(() => decodeFrame(encode(value))).toThrow(/frame|version|field/i);
  });
  it('rejects retained frames even when the payload is valid', () => {
    expect(() => decodeFrame(encode({ v: 1, kind: 'probe', nonce: 'n' }), true)).toThrow(/retain/i);
  });
  it('bounds payload size and rejects invalid UTF-8/JSON', () => {
    for (const payload of [new Uint8Array(4097), new Uint8Array([0xff]), encode('{')]) {
      expect(() => decodeFrame(payload)).toThrow();
    }
  });
  it('restricts device topic segments and isolates sites', () => {
    expect(deviceTopic('site-1', 'led-1', 'in')).toBe('openapcs/led/v1/site-1/led-1/in');
    for (const id of ['+', '#', 'a/b', '', '../x']) expect(() => deviceTopic('site', id, 'in')).toThrow();
  });
});

describe('independent monotonic clocks and LED control sessions', () => {
  it('starts OFF and cannot write before handshake', () => {
    const b = bench();
    expect(b.device.read()).toBe(false);
    expect(b.gateway.active()).toBe(false);
    expect(() => b.gateway.command('c', true, b.now() + 100)).toThrow(/session/i);
  });
  it('maps deadlines between clocks with different origins', () => {
    const b = bench(); b.handshake();
    const command = b.gateway.command('c', true, b.now() + 500);
    expect(command).toMatchObject({ kind: 'write', bootId: 'boot-1', sessionId: 'session-1' });
    expect(b.device.receive(command)).toMatchObject({ kind: 'ack', status: 'applied', value: true });
    expect(b.device.read()).toBe(true);
  });
  it('rejects delayed delivery after the original command deadline', () => {
    const b = bench(); b.handshake();
    const command = b.gateway.command('c', true, b.now() + 100);
    b.advance(101);
    expect(b.device.receive(command)).toMatchObject({ status: 'failed' });
    expect(b.device.read()).toBe(false);
  });
  it('deduplicates commands without replaying a previous output after a later OFF', () => {
    const b = bench(); b.handshake();
    const on = b.gateway.command('on', true, b.now() + 1000);
    b.device.receive(on);
    b.device.receive(b.gateway.command('off', false, b.now() + 1000));
    expect(b.device.receive(on)).toMatchObject({ status: 'applied', value: true });
    expect(b.device.read()).toBe(false);
  });
  it('expires the device lease even when no gateway or wall clock is available', () => {
    const b = bench(); b.handshake();
    b.device.receive(b.gateway.command('c', true, b.now() + 500));
    b.advance(3000);
    expect(b.device.read()).toBe(false);
    expect(b.gateway.active()).toBe(false);
    expect(() => b.gateway.command('next', true, b.now() + 500)).toThrow(/session/i);
  });
  it('renews a live lease without forcing an ON output OFF', () => {
    const b = bench(); b.handshake();
    b.device.receive(b.gateway.command('c', true, b.now() + 500));
    b.advance(1000); b.handshake('probe-2');
    expect(b.device.read()).toBe(true);
  });
  it('does not renew a lease from replayed setup frames', () => {
    const b = bench(); const lease = b.handshake();
    b.device.receive(b.gateway.command('c', true, b.now() + 500));
    b.advance(1000);
    expect(b.device.receive(lease)).toBeNull();
    b.advance(2000);
    expect(b.device.read()).toBe(false);
  });
  it('rejects an old setup frame after a newer probe has been accepted', () => {
    const b = bench();
    const first = b.device.receive(b.gateway.probe('one'))!;
    const oldLease = b.gateway.snapshot(first);
    b.handshake('two');
    expect(b.device.receive(oldLease)).toBeNull();
  });
  it('rejects uncorrelated and slow handshake responses', () => {
    const b = bench();
    const snapshot = b.device.receive(b.gateway.probe('one'))!;
    expect(() => b.gateway.snapshot({ ...snapshot, nonce: 'wrong' } as Frame)).toThrow();
    b.advance(251);
    expect(() => b.gateway.snapshot(snapshot)).toThrow(/fresh|slow|expired/i);
  });
  it('requires device confirmation before allowing commands', () => {
    const b = bench();
    b.gateway.snapshot(b.device.receive(b.gateway.probe('one'))!);
    expect(b.gateway.active()).toBe(false);
    expect(() => b.gateway.command('c', true, b.now() + 100)).toThrow();
  });
  it('invalidates the gateway immediately on disconnect', () => {
    const b = bench(); b.handshake(); b.gateway.disconnect();
    expect(b.gateway.active()).toBe(false);
    expect(b.gateway.bootId).toBeNull();
  });
  it('does not authorize old commands on a new boot', () => {
    const b = bench(); b.handshake();
    const old = b.gateway.command('c', true, b.now() + 1000);
    const rebooted = new LedPeer(() => 0, 'boot-2');
    expect(rebooted.receive(old)).toMatchObject({ status: 'failed' });
    expect(rebooted.read()).toBe(false);
  });
  it('does not extend a deadline beyond the live lease', () => {
    const b = bench(); b.handshake();
    const write = b.gateway.command('c', true, b.now() + 10000);
    b.advance(3001);
    expect(b.device.receive(write)).toMatchObject({ status: 'failed' });
  });
  it('does not automatically restore ON after lease expiry and a new handshake', () => {
    const b = bench(); b.handshake();
    b.device.receive(b.gateway.command('c', true, b.now() + 100));
    b.advance(3000); b.handshake('new');
    expect(b.device.read()).toBe(false);
  });
});
