import { createServer } from 'node:http';
import { parseScriptRequest } from './contract.js';
import { ScriptQueue, ScriptError } from './queue.js';
import { WorkerEngine } from './worker-engine.js';
const engine = new WorkerEngine(); const queue = new ScriptQueue((request, signal) => engine.execute(request, signal));
const server = createServer({ maxHeaderSize: 8192, headersTimeout: 3000, requestTimeout: 3000 }, async (request, reply) => {
  const send = (status: number, body: unknown) => { if (reply.destroyed || reply.writableEnded) return; reply.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); reply.end(JSON.stringify(body)); };
  if (request.method === 'GET' && request.url === '/live') { send(engine.ready ? 200 : 503, { ready: engine.ready }); return; }
  if (request.method !== 'POST' || request.url !== '/run') { send(404, { error: 'Not found' }); request.resume(); return; }
  const abort = new AbortController(); reply.once('close', () => { if (!reply.writableEnded) abort.abort(); });
  try {
    if (request.headers['content-type']?.split(';')[0] !== 'application/json') throw new ScriptError(400, 'JSON content type required');
    const chunks: Buffer[] = []; let length = 0;
    for await (const chunk of request) { length += chunk.length; if (length > 65536) throw new ScriptError(413, 'Script request too large'); chunks.push(chunk); }
    let parsed; try { parsed = parseScriptRequest(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { throw new ScriptError(400, 'Invalid script request'); }
    send(200, await queue.run(parsed, abort.signal));
  } catch (error) { send(error instanceof ScriptError ? error.status : 503, { error: error instanceof ScriptError ? error.message : 'Script service unavailable' }); request.resume(); }
});
server.maxConnections = 32; server.keepAliveTimeout = 1000; server.maxRequestsPerSocket = 64;
server.listen(4000, '0.0.0.0');
let closed = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => { if (closed) return; closed = true; queue.close(); server.close(); void engine.close(); });
