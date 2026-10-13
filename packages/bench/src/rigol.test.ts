import { describe, expect, it } from 'vitest';
import { decodeWaveform, assessPulse, parsePreamble } from './rigol.js';
const preamble = '0,0,1200,1,0.005,-3,0,0.04,-40,127';
function block(data: Buffer) { return Buffer.concat([Buffer.from(`#9${String(data.length).padStart(9, '0')}`), data, Buffer.from('\n')]); }
function pulse() { const data = Buffer.alloc(1200, 87); data.fill(170, 600, 820); return decodeWaveform(preamble, block(data)); }
describe('Rigol captured waveform evidence', () => {
  it('scales BYTE samples using both vertical offsets and the time origin', () => {
    const wave = pulse();
    expect(wave[0]).toEqual({ seconds: -3, volts: 0 });
    expect(wave[600]).toEqual({ seconds: 0, volts: 3.3200000000000003 });
    expect(assessPulse(wave).risingSeconds).toBe(0);
    expect(assessPulse(wave).widthSeconds).toBeCloseTo(1.1);
  });
  it('does not mistake binary newlines or hashes for framing', () => {
    const data = Buffer.alloc(1200, 10); data[1] = 35;
    expect(decodeWaveform(preamble, block(data))).toHaveLength(1200);
  });
  it.each(['#0data\n', '#xdata', '#9000001200short', '#9000000000\n'])('rejects malformed or truncated blocks: %s', (s) => {
    expect(() => decodeWaveform(preamble, Buffer.from(s))).toThrow();
  });
  it('rejects excess data, missing terminators and sample-count mismatches', () => {
    const b = block(Buffer.alloc(1200));
    for (const bad of [Buffer.concat([b, Buffer.from('unexpected')]), b.subarray(0, -1), block(Buffer.alloc(1199))]) expect(() => decodeWaveform(preamble, bad)).toThrow();
  });
  it.each(['0,0,1200,1,NaN,0,0,0.04,0,127', '0,0,1200,1,0,0,0,0.04,0,127', '1,0,1200,1,0.005,0,0,0.04,0,127', '0,0,999999999,1,0.005,0,0,0.04,0,127', '0,0,1200,1,0.005,0,0,-1,0,127', '0,,1200,1,0.005,0,0,0.04,0,127'])('rejects unsupported or invalid preambles: %s', (s) => {
    expect(() => parsePreamble(s)).toThrow();
  });
  it('rejects clipped captures rather than reporting a valid voltage', () => {
    const data = Buffer.alloc(1200, 87); data[600] = 255;
    expect(() => decodeWaveform(preamble, block(data))).toThrow(/clipped/i);
  });
  it('rejects missing, stuck, extra and out-of-range pulses', () => {
    const wave = pulse();
    const bad = [wave.map(p => ({ ...p, volts: 0 })), wave.map(p => ({ ...p, volts: 3.3 })), wave.map((p,i) => ({ ...p, volts: i >= 900 && i < 950 ? 3.3 : p.volts })), wave.map(p => ({ ...p, volts: p.volts * 2 })), wave.map(p => ({ ...p, seconds: p.seconds * 3 }))];
    for (const input of bad) expect(() => assessPulse(input)).toThrow();
  });
  it('rejects incomplete pre/post windows and invalid time ordering', () => {
    const wave = pulse();
    for (const input of [wave.slice(599), wave.slice(0, 821), wave.map(p => ({ ...p, seconds: 0 })), wave.map(p => ({ ...p, volts: NaN }))]) expect(() => assessPulse(input)).toThrow();
  });
});
