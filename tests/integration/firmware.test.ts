import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { decodeFrame, GatewaySession, LedPeer, type Frame } from '../../packages/led-protocol/src/index.js';
function native(frames: { now: number; frame: string; retained?: boolean }[]): { reply: Frame | null; output: boolean }[] {
  const result = spawnSync(fileURLToPath(new URL('../../.cache/firmware-native/led-peer', import.meta.url)), [], { input: frames.map((frame) => JSON.stringify(frame)).join('\n') + '\n', encoding: 'utf8', timeout: 2000, maxBuffer: 1024 * 1024 });
  if (result.error) throw result.error;
  expect(result.status).toBe(0);
  return result.stdout.trim().split('\n').map((line) => JSON.parse(line));
}
describe('compiled ESP32 protocol core against the TypeScript contract', () => {
  it('confirms a lease across JSON encoders with fractional hardware timestamps', () => {
    for (const deviceTime of [30082.126, 269885.341, 113542.365]) {
      let now = 0;
      const gateway = new GatewaySession(() => now, 'fractional-session');
      const probe = { now: deviceTime, frame: JSON.stringify(gateway.probe('fractional-probe')) };
      const snapshot = native([probe])[0]!.reply!;
      now = 20;
      const lease = gateway.snapshot(snapshot);
      const ready = native([probe, { now: deviceTime + 20, frame: JSON.stringify(lease) }])[1]!.reply;
      expect(ready?.kind).toBe('ready');
      now = 40;
      expect(() => gateway.ready(ready!)).not.toThrow();
      expect(gateway.active()).toBe(true);
    }
  });
  it('matches the simulator handshake, writes, deduplication and expired lease output', () => {
    const frames: { now: number; frame: Frame }[] = [
      { now: 100, frame: { v: 1, kind: 'probe', nonce: 'n1' } },
      { now: 110, frame: { v: 1, kind: 'lease', nonce: 'n1', bootId: 'native-boot', sessionId: 's1', expiresAtMs: 3100 } },
      { now: 120, frame: { v: 1, kind: 'write', id: 'on', bootId: 'native-boot', sessionId: 's1', expiresAtMs: 2100.5, value: true } },
      { now: 121, frame: { v: 1, kind: 'write', id: 'off', bootId: 'native-boot', sessionId: 's1', expiresAtMs: 2100.5, value: false } },
      { now: 122, frame: { v: 1, kind: 'write', id: 'on', bootId: 'native-boot', sessionId: 's1', expiresAtMs: 2100.5, value: true } },
      { now: 123, frame: { v: 1, kind: 'write', id: 'next', bootId: 'native-boot', sessionId: 's1', expiresAtMs: 2100.5, value: true } },
      { now: 3100, frame: { v: 1, kind: 'probe', nonce: 'n2' } },
    ];
    const actual = native(frames.map(({ now, frame }) => ({ now, frame: JSON.stringify(frame) })));
    let now = 0; const peer = new LedPeer(() => now, 'native-boot');
    frames.forEach((entry, index) => { now = entry.now; const reply = peer.receive(entry.frame); expect(actual[index]).toEqual({ reply, output: peer.read() }); if (actual[index]!.reply) expect(decodeFrame(Buffer.from(JSON.stringify(actual[index]!.reply)))).toEqual(reply); });
  });
  it('rejects retained and oversized messages without enabling the output', () => {
    const actual = native([{ now: 0, retained: true, frame: JSON.stringify({ v: 1, kind: 'probe', nonce: 'n' }) }, { now: 1, frame: ' '.repeat(4097) }]);
    expect(actual).toEqual([{ reply: null, output: false }, { reply: null, output: false }]);
  });
});

it('keeps native and TypeScript wire behavior aligned beyond the old 128-command boot limit', () => {
  const frames: { now: number; frame: Frame }[] = [];
  for (let i = 0; i < 300; i++) {
    const now = i * 1000;
    frames.push({ now, frame: { v: 1, kind: 'probe', nonce: `probe-${i}` } },
      { now: now + 1, frame: { v: 1, kind: 'lease', nonce: `probe-${i}`, bootId: 'native-boot', sessionId: 'session', expiresAtMs: now + 3000 } },
      { now: now + 2, frame: { v: 1, kind: 'write', id: `command-${i}`, bootId: 'native-boot', sessionId: 'session', expiresAtMs: now + 900, value: i % 2 === 1 } });
  }
  frames.push({ now: 299003, frame: { v: 1, kind: 'write', id: 'command-0', bootId: 'native-boot', sessionId: 'session', expiresAtMs: 900, value: false } });
  const actual = native(frames.map(({ now, frame }) => ({ now, frame: JSON.stringify(frame) })));
  let now = 0; const peer = new LedPeer(() => now, 'native-boot'); const expected = frames.map((entry) => { now = entry.now; return { reply: peer.receive(entry.frame), output: peer.read() }; });
  expect(actual).toEqual(expected);
  expect(actual.filter((row) => row.reply?.kind === 'ack' && row.reply.status === 'applied')).toHaveLength(300);
  expect(actual.at(-1)).toMatchObject({ output: true, reply: { status: 'failed', reason: 'Command expired' } });
});
