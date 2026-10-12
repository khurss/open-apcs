import { createHmac } from 'node:crypto';
import { createServer as httpServer, type Server } from 'node:http';
import { createServer as httpsServer } from 'node:https';
import { readFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { SMTPServer } from 'smtp-server';
import { afterEach, describe, expect, it } from 'vitest';
import { deliverNotification } from '../../packages/notifications/src/transport.js';
import type { WebhookRoute, SmtpRoute } from '../../packages/notifications/src/config.js';
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const message = { id: 'delivery-fixture', eventId: 'alarm-fixture:1', body: JSON.stringify({ eventId: 'alarm-fixture:1', kind: 'Activated', alarm: 'Fixture alarm' }) };
const base = { id: 'route', name: 'Fixture', priorities: ['high' as const], events: ['Activated' as const], projectIds: [] };
async function listen(server: Server) { await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve)); cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }); return (server.address() as AddressInfo).port; }
async function certificates() { const base = new URL('../../.cache/mqtt-tls-fixture/', import.meta.url); return { key: await readFile(new URL('server.key', base)), cert: await readFile(new URL('server.crt', base)), ca: await readFile(new URL('ca.crt', base), 'utf8') }; }
describe('real local notification transports inside Docker', () => {
  it('posts a stable event body with a verifiable signature over TLS and does not expose its secret', async () => {
    const tls = await certificates(); let received: { body: string; signature: string; at: string; id: string } | undefined;
    const server = httpsServer(tls, (request, response) => { const chunks: Buffer[] = []; request.on('data', (chunk) => chunks.push(chunk)); request.on('end', () => { received = { body: Buffer.concat(chunks).toString(), signature: String(request.headers['x-apcs-signature']), at: String(request.headers['x-apcs-timestamp']), id: String(request.headers['x-apcs-event-id']) }; response.writeHead(204); response.end(); }); });
    const port = await listen(server); const route: WebhookRoute = { ...base, kind: 'webhook', url: `https://127.0.0.1:${port}/events`, ca: tls.ca, secret: 'fixture-not-a-real-secret-32-characters' };
    await deliverNotification(route, message);
    expect(received?.body).toBe(message.body); expect(received?.id).toBe(message.eventId);
    expect(received?.signature).toBe(`sha256=${createHmac('sha256', route.secret).update(`${received!.at}.${message.body}`).digest('hex')}`);
    expect(JSON.stringify(received)).not.toContain(route.secret);
    const { ca: _ca, ...untrusted } = route; await expect(deliverNotification(untrusted, message)).rejects.toThrow(/delivery/i);
  });
  it('does not follow redirects or retry HTTP errors inside a transport attempt', async () => {
    let calls = 0; let status = 429; const port = await listen(httpServer((_request, response) => { calls++; response.writeHead(status, { location: '/must-not-follow' }); response.end('private-response'); }));
    const route: WebhookRoute = { ...base, kind: 'webhook', url: `http://127.0.0.1:${port}/events`, allowInsecure: true, secret: 'fixture-not-a-real-secret-32-characters' };
    await expect(deliverNotification(route, message)).rejects.toMatchObject({ retryable: true }); expect(calls).toBe(1);
    status = 302; await expect(deliverNotification(route, message)).rejects.toMatchObject({ retryable: false }); expect(calls).toBe(2);
  });
  it('bounds an unresponsive endpoint and aborts without leaving an open connection', async () => {
    const port = await listen(httpServer(() => {})); const route: WebhookRoute = { ...base, kind: 'webhook', url: `http://127.0.0.1:${port}/events`, allowInsecure: true, secret: 'fixture-not-a-real-secret-32-characters' };
    const start = performance.now(); await expect(deliverNotification(route, message, { timeoutMs: 100 })).rejects.toMatchObject({ retryable: true }); expect(performance.now() - start).toBeLessThan(1000);
    const abort = new AbortController(); abort.abort(); await expect(deliverNotification(route, message, { signal: abort.signal })).rejects.toThrow(/cancel/i);
  });
  it('sends a bounded JSON MIME message through authenticated TLS SMTP with a stable Message-ID', async () => {
    const tls = await certificates(); const received: string[] = [];
    const server = new SMTPServer({ ...tls, secure: true, logger: false, onAuth(auth, _session, callback) { callback(auth.username === 'fixture' && auth.password === 'fixture-password' ? null : new Error('Fixture credentials rejected'), { user: 'fixture' }); }, onData(stream, _session, callback) { const chunks: Buffer[] = []; stream.on('data', (chunk) => chunks.push(chunk)); stream.on('end', () => { received.push(Buffer.concat(chunks).toString()); callback(); }); } });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve)); cleanups.push(() => new Promise<void>((resolve) => server.close(resolve)));
    const port = (server.server.address() as AddressInfo).port;
    const route: SmtpRoute = { ...base, kind: 'smtp', host: '127.0.0.1', port, security: 'tls', ca: tls.ca, from: 'apcs@example.test', to: 'operator@example.test', auth: { username: 'fixture', password: 'fixture-password' } };
    await deliverNotification(route, message); expect(received).toHaveLength(1);
    expect(received[0]).toContain('Message-ID: <delivery-fixture@open-apcs.local>');
    const encoded = received[0]!.split('\r\n\r\n')[1]!.replaceAll(/\s/g, ''); expect(Buffer.from(encoded, 'base64').toString()).toBe(message.body);
    await expect(deliverNotification({ ...route, auth: { username: 'fixture', password: 'wrong' } }, message)).rejects.toThrow(/delivery/i); expect(received).toHaveLength(1);
  });
  it('rejects unsafe identities and oversized payloads before any network attempt', async () => {
    const route: WebhookRoute = { ...base, kind: 'webhook', url: 'https://does-not-exist.invalid/events', secret: 'fixture-not-a-real-secret-32-characters' };
    await expect(deliverNotification(route, { ...message, eventId: 'bad\r\nheader' })).rejects.toThrow(/message/i);
    await expect(deliverNotification(route, { ...message, body: 'x'.repeat(8193) })).rejects.toThrow(/message/i);
  });
});
