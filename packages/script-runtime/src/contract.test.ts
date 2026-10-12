import { describe, expect, it } from 'vitest';
import { parseScriptRequest } from './contract.js';
const fixture = () => ({ mode: 'evaluate', source: 'return input.a && !input.b;', language: 'typescript', inputs: { a: true, b: false }, nowMs: 1000 });
describe('bounded script service contract', () => {
  it('copies a valid request without retaining caller-owned input references', () => { const input = fixture(); const parsed = parseScriptRequest(input); input.inputs.a = false; expect(parsed.inputs.a).toBe(true); });
  it('requires an exact envelope and rejects host capabilities or extra input names', () => {
    for (const value of [{ ...fixture(), environment: { SECRET: 'fixture-only' } }, { ...fixture(), inputs: { a: true, b: false, path: '/tmp' } }, { ...fixture(), inputs: { a: true } }, { ...fixture(), inputs: { a: 1, b: false } }]) expect(() => parseScriptRequest(value)).toThrow();
  });
  it('bounds UTF-8 source and validates language, operation and monotonic input time', () => {
    for (const value of [{ ...fixture(), source: '' }, { ...fixture(), source: 'x'.repeat(16385) }, { ...fixture(), source: '\0' }, { ...fixture(), source: 'é'.repeat(8193) }, { ...fixture(), language: 'python' }, { ...fixture(), mode: 'install' }, { ...fixture(), nowMs: NaN }, { ...fixture(), nowMs: -1 }]) expect(() => parseScriptRequest(value)).toThrow();
    expect(parseScriptRequest({ ...fixture(), mode: 'validate' }).mode).toBe('validate');
  });
});
