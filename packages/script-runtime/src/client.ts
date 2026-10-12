import type { ScriptEvaluation } from '../../domain/src/logic.js';
import { parseScriptRequest, type ScriptRequest } from './contract.js';
export class ScriptClientError extends Error {
  readonly code = 'SCRIPT_REJECTED';
  constructor(readonly statusCode: number, message: string) { super(message); }
}
/** The configured internal endpoint is trusted configuration, never user input. */
export class ScriptClient {
  private readonly endpoint: string;
  constructor(url: string) {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') throw new Error('Invalid script service URL');
    this.endpoint = `${parsed.origin}/run`;
  }
  async evaluate(request: ScriptEvaluation): Promise<boolean> {
    const response = await this.run({ mode: 'evaluate', ...request });
    if (typeof response.value !== 'boolean' || Object.keys(response).length !== 1) throw new ScriptClientError(503, 'Invalid script service response');
    return response.value;
  }
  async validate(request: Pick<ScriptEvaluation, 'source' | 'language'>): Promise<void> {
    const response = await this.run({ mode: 'validate', source: request.source, language: request.language, inputs: { a: false, b: false }, nowMs: 0 });
    if (response.valid !== true || Object.keys(response).length !== 1) throw new ScriptClientError(503, 'Invalid script service response');
  }
  private async run(request: ScriptRequest): Promise<Record<string, unknown>> {
    const body = JSON.stringify(parseScriptRequest(request));
    try {
      const response = await fetch(this.endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body, redirect: 'error', signal: AbortSignal.timeout(1000) });
      if (!response.ok) { await response.body?.cancel(); throw new ScriptClientError([400, 408, 422].includes(response.status) ? 422 : 503, 'Script execution rejected'); }
      const reader = response.body?.getReader(); if (!reader) throw new Error('Missing response');
      const chunks: Uint8Array[] = []; let size = 0;
      try { for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.length; if (size > 1024) throw new Error('Response too large'); chunks.push(next.value); } }
      finally { await reader.cancel(); }
      const data: unknown = JSON.parse(new TextDecoder().decode(Buffer.concat(chunks)));
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid response');
      return data as Record<string, unknown>;
    } catch (error) { if (error instanceof ScriptClientError) throw error; throw new ScriptClientError(503, 'Script service unavailable'); }
  }
}
