import { afterEach, expect, it, vi } from 'vitest';
import { ScriptClient } from './client.js';
afterEach(() => vi.unstubAllGlobals());
const request = { source: 'return input.a;', language: 'typescript' as const, inputs: { a: true, b: false }, nowMs: 0 };
it('sends a strict bounded request and accepts only the expected response type', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => new Response('{"value":true}')); vi.stubGlobal('fetch', fetcher);
  const client = new ScriptClient('http://script-runner:4000'); expect(await client.evaluate(request)).toBe(true);
  expect(JSON.parse(fetcher.mock.calls[0]![1]!.body as string)).toEqual({ mode: 'evaluate', ...request });
  for (const body of ['{"value":1}', '{"valid":true}', 'x'.repeat(1025)]) { fetcher.mockResolvedValueOnce(new Response(body)); await expect(client.evaluate(request)).rejects.toThrow(); }
  fetcher.mockResolvedValueOnce(new Response('{"valid":true}')); await expect(client.validate(request)).resolves.toBeUndefined();
});
it('does not retry errors and hides remote diagnostics', async () => {
  const fetcher = vi.fn(async () => new Response('private-source', { status: 422 })); vi.stubGlobal('fetch', fetcher);
  await expect(new ScriptClient('http://script-runner:4000').evaluate(request)).rejects.toMatchObject({ statusCode: 422, message: 'Script execution rejected' }); expect(fetcher).toHaveBeenCalledTimes(1);
  fetcher.mockRejectedValueOnce(new Error('private-endpoint')); await expect(new ScriptClient('http://script-runner:4000').evaluate(request)).rejects.toMatchObject({ statusCode: 503, message: 'Script service unavailable' });
});
