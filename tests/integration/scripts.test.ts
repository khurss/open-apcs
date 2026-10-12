import { beforeEach, describe, expect, it } from 'vitest';
const base = process.env.APCS_SCRIPT_URL;
if (!base) throw new Error('Docker script service required');
async function run(source: string, extra: Record<string, unknown> = {}) {
  return fetch(`${base}/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'evaluate', language: 'javascript', source, inputs: { a: true, b: false }, nowMs: 1234, ...extra }), signal: AbortSignal.timeout(3000) });
}
beforeEach(async () => { await expect.poll(async () => (await fetch(`${base}/live`)).ok, { timeout: 7000 }).toBe(true); });
describe('isolated JavaScript and TypeScript service in Docker', () => {
  it('evaluates JavaScript and transpiles TypeScript with explicit inputs and time', async () => {
    const js = await run('return input.a && !input.b && nowMs === 1234;'); expect(js.status).toBe(200); expect(await js.json()).toMatchObject({ value: true });
    const ts = await run('const enabled: boolean = input.a; const age: number = nowMs; return enabled && age > 1000;', { language: 'typescript' }); expect(ts.status).toBe(200); expect(await ts.json()).toMatchObject({ value: true });
  });
  it('provides no host process, filesystem, network or ambient clock capabilities', async () => {
    const result = await run("return typeof process === 'undefined' && typeof require === 'undefined' && typeof fetch === 'undefined' && typeof WebSocket === 'undefined' && typeof Date === 'undefined' && typeof Math.random === 'undefined' && Function('return typeof process')() === 'undefined';");
    expect(result.status).toBe(200); expect(await result.json()).toMatchObject({ value: true });
  });
  it('uses fresh contexts and immutable copied input objects', async () => {
    expect((await run('Object.prototype.marker = true; globalThis.counter = 42; return true;')).status).toBe(200);
    const clean = await run("return !('marker' in {}) && !('counter' in globalThis) && Object.isFrozen(input);"); expect(await clean.json()).toMatchObject({ value: true });
    expect((await run('input.a = false; return true;')).status).toBe(422);
  });
  it('validates syntax without invoking the function body and rejects invalid result types', async () => {
    const valid = await run("throw new Error('body must not run');", { mode: 'validate' }); expect(valid.status).toBe(200); expect(await valid.json()).toEqual({ valid: true });
    expect((await run('return (;', { mode: 'validate' })).status).toBe(422);
    expect((await run('return true; } globalThis.injected = true; function extra() {', { mode: 'validate' })).status).toBe(422);
    for (const source of ['return 1;', 'return {};', 'return Promise.resolve(true);']) expect((await run(source)).status).toBe(422);
  });
  it('bounds source and refuses caller-provided environment or language overrides', async () => {
    expect((await run('return true;', { environment: { PATH: '/private' } })).status).toBe(400);
    expect((await run('x'.repeat(16385))).status).toBe(400);
    expect((await run('return true;', { language: 'python' })).status).toBe(400);
  });
  it('rejects runaway loops, recursive stacks and memory pressure without exposing source errors', async () => {
    for (const source of ['while (true) {}', 'function recurse() { return recurse(); } return recurse();', "const values = []; while (true) values.push('x'.repeat(10000));"]) {
      await expect.poll(async () => (await fetch(`${base}/live`)).ok, { timeout: 7000 }).toBe(true);
      const result = await run(source); expect([408, 422]).toContain(result.status);
    }
    await expect.poll(async () => (await fetch(`${base}/live`)).ok, { timeout: 7000 }).toBe(true);
    const failure = await run("throw new Error('private-user-source-marker');"); expect(failure.status).toBe(422); expect(await failure.text()).not.toContain('private-user-source-marker');
    expect((await run('return true;')).status).toBe(200);
  });
  it('enforces an external deadline even for a long native operation and recovers its worker', async () => {
    const start = performance.now(); const result = await run("new Array(1_000_000_000) + ''; return true;");
    expect([408, 422]).toContain(result.status); expect(performance.now() - start).toBeLessThan(2500);
    await expect.poll(async () => (await fetch(`${base}/live`)).ok, { timeout: 7000 }).toBe(true);
    const next = await run('return input.a;'); expect(next.status).toBe(200); expect(await next.json()).toMatchObject({ value: true });
  });
});
