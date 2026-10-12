import { createHash, X509Certificate } from 'node:crypto';
import { isIP } from 'node:net';
import { canonicalJson } from '../../domain/src/screen.js';
export type NotificationEventKind = 'Activated' | 'Reactivated' | 'Returned' | 'Unsuppressed';
export interface PublicRoute { id: string; name: string; kind: 'smtp' | 'webhook'; priorities: Array<'low' | 'medium' | 'high'>; events: NotificationEventKind[]; projectIds: string[]; }
interface CommonRoute extends PublicRoute { ca?: string; allowInsecure?: boolean; }
export interface WebhookRoute extends CommonRoute { kind: 'webhook'; url: string; secret: string; }
export interface SmtpRoute extends CommonRoute { kind: 'smtp'; host: string; port: number; security: 'tls' | 'starttls' | 'none'; from: string; to: string; servername?: string; auth?: { username: string; password: string }; }
export type NotificationRoute = WebhookRoute | SmtpRoute;
export interface NotificationConfig { version: 1; routes: NotificationRoute[]; }
function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !keys.includes(key))) throw new Error('Invalid notification configuration fields');
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number, min = 1): value is string { return typeof value === 'string' && value.trim().length >= min && value.length <= max && !value.includes('\0'); }
function host(value: unknown): value is string { return text(value, 253) && (isIP(value) !== 0 || value.split('.').every((label) => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label))); }
function address(value: unknown): value is string { return text(value, 254) && /^[A-Za-z0-9_+.-]{1,64}@[A-Za-z0-9.-]+$/.test(value) && host(value.split('@')[1]); }
function list(value: unknown, maximum: number, accepts: (item: unknown) => boolean, empty = false) {
  if (!Array.isArray(value) || (!empty && !value.length) || value.length > maximum || new Set(value).size !== value.length || value.some((item) => !accepts(item))) throw new Error('Invalid notification routing list');
}
export function parseNotificationConfig(value: unknown): NotificationConfig {
  const config = record(value, ['version', 'routes']);
  if (config.version !== 1 || !Array.isArray(config.routes) || config.routes.length > 16) throw new Error('Notification config requires version 1 and at most 16 routes');
  const ids = new Set<string>();
  for (const item of config.routes) {
    if (!item || typeof item !== 'object' || !('kind' in item) || !['smtp', 'webhook'].includes(item.kind as string)) throw new Error('Invalid notification kind');
    const common = ['id', 'name', 'kind', 'priorities', 'events', 'projectIds', 'ca', 'allowInsecure'];
    const route = record(item, [...common, ...(item.kind === 'webhook' ? ['url', 'secret'] : ['host', 'port', 'security', 'from', 'to', 'servername', 'auth'])]);
    if (!text(route.id, 64) || !/^[A-Za-z][A-Za-z0-9_-]*$/.test(route.id) || !text(route.name, 128)) throw new Error('Invalid notification identity');
    if (ids.has(route.id)) throw new Error('Duplicate notification route ID'); ids.add(route.id);
    list(route.priorities, 3, (entry) => ['low', 'medium', 'high'].includes(entry as string));
    list(route.events, 4, (entry) => ['Activated', 'Reactivated', 'Returned', 'Unsuppressed'].includes(entry as string));
    list(route.projectIds, 10, (entry) => typeof entry === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(entry), true);
    if ('allowInsecure' in route && typeof route.allowInsecure !== 'boolean') throw new Error('Invalid insecure transport option');
    if ('ca' in route) {
      if (!text(route.ca, 16384)) throw new Error('Invalid notification CA');
      try { if (!new X509Certificate(route.ca).ca) throw new Error('CA required'); } catch { throw new Error('Invalid notification CA'); }
    }
    if (route.kind === 'webhook') {
      if (!text(route.url, 2048) || !text(route.secret, 512, 32)) throw new Error('Invalid webhook URL or signing secret');
      let url: URL; try { url = new URL(route.url); } catch { throw new Error('Invalid webhook URL'); }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error('Invalid webhook target');
      if (url.protocol === 'http:' && route.allowInsecure !== true) throw new Error('Explicit insecure transport permission required');
    } else {
      if (!host(route.host) || !Number.isSafeInteger(route.port) || (route.port as number) < 1 || (route.port as number) > 65535 || !['tls', 'starttls', 'none'].includes(route.security as string) || !address(route.from) || !address(route.to)) throw new Error('Invalid SMTP endpoint or address');
      if ('servername' in route && !host(route.servername)) throw new Error('Invalid SMTP TLS servername');
      if (route.security === 'none' && route.allowInsecure !== true) throw new Error('Explicit insecure transport permission required');
      if ('auth' in route) { const auth = record(route.auth, ['username', 'password']); if (!text(auth.username, 256) || !text(auth.password, 1024)) throw new Error('Invalid SMTP credentials'); }
    }
  }
  return structuredClone(value) as NotificationConfig;
}
export function publicRoute(route: NotificationRoute): PublicRoute { return structuredClone({ id: route.id, name: route.name, kind: route.kind, priorities: route.priorities, events: route.events, projectIds: route.projectIds }); }
export function routeFingerprint(route: NotificationRoute): string { return createHash('sha256').update(canonicalJson(route)).digest('hex'); }
