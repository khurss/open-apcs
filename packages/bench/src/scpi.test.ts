import { expect, it } from 'vitest';
import { Scpi } from './scpi.js';
function peer(parts: Buffer[]) { const writes: string[] = []; return { scope: new Scpi({ write: b => { writes.push(b.toString()); }, read: () => parts.shift() ?? Buffer.alloc(0) }), writes }; }
it('reads a fragmented definite-length binary block including embedded LF bytes', () => {
  const data = Buffer.from('#13\n#x\n');
  const { scope, writes } = peer([...data].map(b => Buffer.from([b])));
  expect(scope.queryBlock(':WAV:DATA?')).toEqual(data);
  expect(writes).toEqual([':WAV:DATA?\n']);
});
it('rejects empty, unbounded, excessive and trailing binary responses', () => {
  for (const text of ['', '#0abc\n', '#9999999999', '#11a\nextra']) expect(() => peer([Buffer.from(text)]).scope.queryBlock(':WAV:DATA?')).toThrow();
});
it('frames a text reply across reads and refuses extra replies', () => {
  expect(peer([Buffer.from('RI'), Buffer.from('GOL\n')]).scope.queryText('*IDN?')).toBe('RIGOL');
  expect(() => peer([Buffer.from('first\nsecond\n')]).scope.queryText('*IDN?')).toThrow();
});
it('rejects multiline commands and bounded-read exhaustion', () => {
  expect(() => peer([]).scope.write('*IDN?\n:RUN')).toThrow();
  expect(() => peer(Array.from({length: 65}, () => Buffer.from('x'))).scope.queryText('*IDN?')).toThrow();
});
