import { createHmac } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import SMTPConnection from 'nodemailer/lib/smtp-connection/index.js';
import { parseNotificationConfig, type NotificationRoute, type SmtpRoute, type WebhookRoute } from './config.js';
export interface NotificationMessage { id: string; eventId: string; body: string; }
export class DeliveryError extends Error { constructor(message: string, readonly retryable: boolean) { super(message); } }
export async function deliverNotification(route: NotificationRoute, message: NotificationMessage, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<void> {
  const safe = parseNotificationConfig({ version: 1, routes: [route] }).routes[0]!;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(message.id) || !/^[A-Za-z0-9:_-]{1,128}$/.test(message.eventId) || typeof message.body !== 'string' || Buffer.byteLength(message.body) > 8192) throw new DeliveryError('Invalid notification message', false);
  try { const parsed = JSON.parse(message.body) as { eventId?: unknown }; if (!parsed || parsed.eventId !== message.eventId) throw new Error('Identity mismatch'); } catch { throw new DeliveryError('Invalid notification message', false); }
  const timeoutMs = options.timeoutMs ?? 5000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 10000) throw new Error('Invalid delivery timeout');
  if (options.signal?.aborted) throw new DeliveryError('Notification delivery cancelled', true);
  return safe.kind === 'webhook' ? webhook(safe, message, timeoutMs, options.signal) : smtp(safe, message, timeoutMs, options.signal);
}
function webhook(route: WebhookRoute, message: NotificationMessage, timeoutMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = createHmac('sha256', route.secret).update(`${timestamp}.${message.body}`).digest('hex');
    let done = false; let timer: ReturnType<typeof setTimeout>;
    const finish = (error?: DeliveryError) => { if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); request.destroy(); if (error) reject(error); else resolve(); };
    const abort = () => finish(new DeliveryError('Notification delivery cancelled', true));
    const url = new URL(route.url);
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      method: 'POST', agent: false, ...(url.protocol === 'https:' ? { rejectUnauthorized: true, ...(route.ca ? { ca: route.ca } : {}) } : {}),
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(message.body), 'x-apcs-event-id': message.eventId, 'x-apcs-delivery-id': message.id, 'x-apcs-timestamp': timestamp, 'x-apcs-signature': `sha256=${signature}` },
    }, (response) => {
      const status = response.statusCode ?? 0; response.destroy();
      finish(status >= 200 && status < 300 ? undefined : new DeliveryError(`Webhook delivery returned HTTP ${status}`, status === 408 || status === 429 || status >= 500 || status === 0));
    });
    request.on('error', () => finish(new DeliveryError('Webhook delivery failed', true)));
    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => finish(new DeliveryError('Webhook delivery deadline exceeded', true)), timeoutMs);
    request.end(message.body);
  });
}
function smtp(route: SmtpRoute, message: NotificationMessage, timeoutMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const connection = new SMTPConnection({ host: route.host, port: route.port, secure: route.security === 'tls', requireTLS: route.security === 'starttls', ignoreTLS: route.security === 'none',
      name: 'open-apcs.local', connectionTimeout: timeoutMs, greetingTimeout: timeoutMs, socketTimeout: timeoutMs, dnsTimeout: timeoutMs, logger: false, debug: false,
      tls: { rejectUnauthorized: true, ...(route.ca ? { ca: route.ca } : {}), ...(route.servername ? { servername: route.servername } : {}) },
    });
    let done = false; let timer: ReturnType<typeof setTimeout>;
    const finish = (error?: DeliveryError) => { if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); connection.close(); if (error) reject(error); else resolve(); };
    const failed = (error?: SMTPConnection.SMTPError | null) => finish(new DeliveryError('SMTP delivery failed', !error?.responseCode || error.responseCode < 500));
    const abort = () => finish(new DeliveryError('Notification delivery cancelled', true));
    const encoded = Buffer.from(message.body).toString('base64').match(/.{1,76}/g)!.join('\r\n');
    const mime = [`From: ${route.from}`, `To: ${route.to}`, 'Subject: Open APCS alarm notification', `Message-ID: <${message.id}@open-apcs.local>`, `X-Open-APCS-Event-ID: ${message.eventId}`, `Date: ${new Date().toUTCString()}`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '', encoded, ''].join('\r\n');
    const send = () => { if (done) return; connection.send({ from: route.from, to: [route.to] }, mime, (error, info) => { if (done) return; if (error || info.accepted.length !== 1 || info.rejected.length) failed(error); else finish(); }); };
    connection.on('error', failed); connection.once('end', () => { if (!done) failed(); });
    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => finish(new DeliveryError('SMTP delivery deadline exceeded', true)), timeoutMs);
    connection.connect((error) => {
      if (done) return; if (error) { failed(error); return; }
      if (!route.auth) send();
      else connection.login({ user: route.auth.username, pass: route.auth.password }, (error) => { if (done) return; if (error) failed(error); else send(); });
    });
  });
}
