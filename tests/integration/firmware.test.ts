import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { decodeFrame, LedPeer, type Frame } from '../../packages/led-protocol/src/index.js';
function native(frames: { now: number; frame: string; retained?: boolean }[]): { reply: Frame | null; output: boolean }[] {
  const result = spawnSync(fileURLToPath(new URL('../../.cache/firmware-native/led-peer', import.meta.url)), [], { input: frames.map((frame) => JSON.stringify(frame)).join('\n') + '\n', encoding: 'utf8', timeout: 2000, maxBuffer: 1024 * 1024 });
  if (result.error) throw result.error;
  expect(result.status).toBe(0);
  return result.stdout.trim().split('\n').map((line) => JSON.parse(line));
}
describe('compiled ESP32 protocol core against the TypeScript contract', () => {
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
