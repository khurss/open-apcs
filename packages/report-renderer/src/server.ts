import { createServer } from 'node:http';
import { chromium } from '@playwright/test';
import { reportHtml } from './template.js';
const browser = await chromium.launch({ headless: true, timeout: 10000, args: ['--disable-dev-shm-usage'] });
let busy = false;
const server = createServer({ maxHeaderSize: 8192, headersTimeout: 3000, requestTimeout: 5000 }, async (request, response) => {
  const reject = (code: number) => { if (!response.writableEnded && !response.destroyed) response.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Report rendering unavailable or invalid request' })); };
  if (request.method === 'GET' && request.url === '/live') { response.writeHead(browser.isConnected() ? 200 : 503).end(); return; }
  if (request.method !== 'POST' || request.url !== '/render') { reject(404); request.resume(); return; }
  if (busy) { reject(503); request.resume(); return; }
  busy = true; const deadline = setTimeout(() => process.exit(1), 14000); deadline.unref();
  let context: Awaited<ReturnType<typeof browser.newContext>> | undefined;
  try {
    if (request.headers['content-type']?.split(';')[0] !== 'application/json') { reject(400); request.resume(); return; }
    let size = 0; const chunks: Buffer[] = [];
    for await (const chunk of request) { size += chunk.length; if (size > 131072) { reject(413); request.resume(); return; } chunks.push(chunk); }
    let html: string; try { html = reportHtml(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(400); return; }
    context = await browser.newContext({ javaScriptEnabled: false, serviceWorkers: 'block', offline: true });
    await context.route('**/*', (route) => route.abort());
    response.once('close', () => { if (!response.writableEnded) void context?.close(); });
    const page = await context.newPage(); page.setDefaultTimeout(10000);
    await page.setContent(html, { waitUntil: 'load', timeout: 10000 });
    const pdf = await page.pdf({ preferCSSPageSize: true, printBackground: true });
    if (pdf.length > 2097152) throw new Error('PDF limit exceeded');
    response.writeHead(200, { 'content-type': 'application/pdf', 'cache-control': 'no-store' }).end(pdf);
  } catch { reject(503); }
  finally { await context?.close().catch(() => {}); clearTimeout(deadline); busy = false; }
});
server.maxConnections = 8; server.keepAliveTimeout = 1000; server.maxRequestsPerSocket = 16;
server.listen(4100, '0.0.0.0');
browser.on('disconnected', () => process.exit(1));
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => { server.close(); void browser.close().finally(() => process.exit(0)); });

process.once('disconnect', () => { void browser.close().finally(() => process.exit(0)); });
