import { describe, expect, it } from 'vitest';
import { VirtualLed, type SimulatedWrite } from './virtual-led.js';

function fixture() {
  let now = 0;
  const led = new VirtualLed(() => now, 'boot-1');
  const write: SimulatedWrite = {
    id: 'cmd-1', bootId: 'boot-1', controlSessionId: 'runtime-1', value: true, expiresAt: 2_000,
  };
  return { led, write, advance: (ms: number) => { now += ms; } };
}

describe('AT-04 / AT-16: virtual LED and local watchdog', () => {
  it('starts OFF and refuses control without a live lease', () => {
    const { led, write } = fixture();
    expect(led.read()).toBe(false);
    expect(led.apply(write)).toMatchObject({ status: 'failed' });
    expect(led.read()).toBe(false);
  });

  it('applies a fresh command in the current control and boot session', () => {
    const { led, write } = fixture();
    led.grantLease('runtime-1', 3_000);
    expect(led.apply(write)).toEqual({ id: 'cmd-1', status: 'applied', value: true });
    expect(led.read()).toBe(true);
  });

  it('switches OFF at the lease deadline even when telemetry continues', () => {
    const { led, write, advance } = fixture();
    led.grantLease('runtime-1', 3_000);
    led.apply(write);
    advance(2_999);
    expect(led.read()).toBe(true);
    advance(1);
    expect(led.read()).toBe(false);
    led.grantLease('runtime-1', 6_000);
    expect(led.read()).toBe(false);
  });

  it('a repeated command returns the original result without repeating the write', () => {
    const { led, write } = fixture();
    led.grantLease('runtime-1', 3_000);
    const ack = led.apply(write);
    led.apply({ ...write, id: 'off', value: false });
    expect(led.apply(write)).toEqual(ack);
    expect(led.read()).toBe(false);
    expect(led.apply({ ...write, value: false })).toMatchObject({ status: 'failed' });
  });

  it('does not restart the TTL when a delayed command arrives', () => {
    const { led, write, advance } = fixture();
    led.grantLease('runtime-1', 3_000);
    advance(2_000);
    expect(led.apply(write)).toMatchObject({ status: 'failed' });
    expect(led.read()).toBe(false);
  });

  it('control ownership changes force OFF and fence old commands', () => {
    const { led, write } = fixture();
    led.grantLease('runtime-1', 3_000);
    led.apply(write);
    led.grantLease('runtime-2', 3_000);
    expect(led.read()).toBe(false);
    expect(led.apply({ ...write, id: 'late' })).toMatchObject({ status: 'failed' });
    expect(led.apply({ ...write, id: 'new', controlSessionId: 'runtime-2' }).status).toBe('applied');
  });

  it('reboot starts OFF, clears the lease and rejects commands from the old boot', () => {
    const { led, write } = fixture();
    led.grantLease('runtime-1', 3_000);
    led.apply(write);
    led.reboot('boot-2');
    expect(led.read()).toBe(false);
    expect(led.apply({ ...write, bootId: 'boot-2' }).status).toBe('failed');
    led.grantLease('runtime-1', 3_000);
    expect(led.apply(write).status).toBe('failed');
    expect(led.apply({ ...write, bootId: 'boot-2' }).status).toBe('applied');
  });

  it.each([NaN, Infinity, -1, 0, 3_001])('rejects invalid lease deadline %s without energizing the output', (deadline) => {
    const { led } = fixture();
    expect(() => led.grantLease('runtime-1', deadline)).toThrow(/lease/i);
    expect(led.read()).toBe(false);
  });

  it('old and duplicate leases cannot extend a newer lease', () => {
    const { led, write, advance } = fixture();
    led.grantLease('runtime-1', 3_000);
    led.apply(write);
    advance(1_000);
    led.grantLease('runtime-1', 4_000);
    led.grantLease('runtime-1', 3_000);
    advance(3_000);
    expect(led.read()).toBe(false);
  });

  it('malformed writes cannot energize an output or poison the deduplication cache', () => {
    const { led, write } = fixture();
    led.grantLease('runtime-1', 3_000);
    expect(led.apply({ ...write, expiresAt: NaN }).status).toBe('failed');
    expect(led.apply({ ...write, value: 1 as unknown as boolean }).status).toBe('failed');
    expect(led.read()).toBe(false);
    expect(led.apply(write).status).toBe('applied');
  });
});

it('retains at most 128 live command identities and frees only expired entries without changing the output', () => {
  const { led, write, advance } = fixture(); led.grantLease('runtime-1', 3000);
  for (let i = 0; i < 128; i++) expect(led.apply({ ...write, id: `command-${i}`, value: true, expiresAt: i === 127 ? 2500 : 2000 }).status).toBe('applied');
  expect(led.apply({ ...write, id: 'overflow', value: false }).status).toBe('failed'); expect(led.read()).toBe(true);
  advance(2000); expect(led.read()).toBe(true);
  expect(led.apply({ ...write, id: 'next', value: false, expiresAt: 2900 }).status).toBe('applied');
  expect(led.apply({ ...write, id: 'command-127', expiresAt: 2500 }).status).toBe('applied'); expect(led.read()).toBe(false);
  expect(led.apply({ ...write, id: 'command-127', value: false, expiresAt: 2500 }).status).toBe('failed');
  advance(500); expect(led.apply({ ...write, id: 'command-127', expiresAt: 2500 }).status).toBe('failed'); expect(led.read()).toBe(false);
});
it('executes 12000 expiring commands across renewed leases without exhausting a boot lifetime cache', () => {
  let now = 0; const led = new VirtualLed(() => now, 'boot'); let applied = 0;
  for (let i = 0; i < 12000; i++) {
    now = i * 1000; led.grantLease('session', now + 3000);
    if (led.apply({ id: `command-${i}`, bootId: 'boot', controlSessionId: 'session', value: i % 2 === 1, expiresAt: now + 900 }).status !== 'applied') break;
    applied++;
  }
  expect(applied).toBe(12000); expect(led.read()).toBe(true);
  expect(led.apply({ id: 'command-0', bootId: 'boot', controlSessionId: 'session', value: false, expiresAt: 900 }).status).toBe('failed'); expect(led.read()).toBe(true);
});
it('rejects a command whose deadline exceeds its current control lease', () => {
  const { led, write } = fixture(); led.grantLease('runtime-1', 3000);
  expect(led.apply({ ...write, expiresAt: 3001 }).status).toBe('failed'); expect(led.read()).toBe(false);
});
