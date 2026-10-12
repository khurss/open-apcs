export interface ScriptRequest { mode: 'evaluate' | 'validate'; language: 'javascript' | 'typescript'; source: string; inputs: { a: boolean; b: boolean }; nowMs: number; }
export function parseScriptRequest(value: unknown): ScriptRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid script request');
  const item = value as Record<string, unknown>;
  if (Object.keys(item).some((key) => !['mode', 'language', 'source', 'inputs', 'nowMs'].includes(key)) || !['evaluate', 'validate'].includes(item.mode as string) || !['javascript', 'typescript'].includes(item.language as string)) throw new Error('Invalid script request fields');
  if (typeof item.source !== 'string' || !item.source.trim() || item.source.includes('\0') || new TextEncoder().encode(item.source).length > 16384) throw new Error('Script source must contain 1 to 16384 UTF-8 bytes');
  if (typeof item.nowMs !== 'number' || !Number.isFinite(item.nowMs) || item.nowMs < 0 || item.nowMs > Number.MAX_SAFE_INTEGER) throw new Error('Invalid script input time');
  if (!item.inputs || typeof item.inputs !== 'object' || Array.isArray(item.inputs)) throw new Error('Invalid script inputs');
  const inputs = item.inputs as Record<string, unknown>;
  if (Object.keys(inputs).length !== 2 || Object.keys(inputs).some((key) => !['a', 'b'].includes(key)) || typeof inputs.a !== 'boolean' || typeof inputs.b !== 'boolean') throw new Error('Script inputs a and b must be booleans');
  return structuredClone(value) as ScriptRequest;
}
