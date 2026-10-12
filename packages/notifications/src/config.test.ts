import { describe, expect, it } from 'vitest';
import { parseNotificationConfig, publicRoute, routeFingerprint } from './config.js';
const webhook = () => ({ id: 'local-webhook', name: 'Local events', kind: 'webhook', url: 'https://events.local/apcs', secret: 'fixture-not-a-real-secret-32-characters', priorities: ['high'], events: ['Activated', 'Returned'], projectIds: [] });
const smtp = () => ({ id: 'local-smtp', name: 'Local mail', kind: 'smtp', host: 'mail.local', port: 465, security: 'tls', from: 'apcs@example.test', to: 'operator@example.test', priorities: ['high', 'medium'], events: ['Activated'], projectIds: [] });
describe('private notification destinations', () => {
  it('accepts explicit TLS destinations and copies private configuration', () => {
    const input = { version: 1, routes: [webhook(), smtp()] }; const parsed = parseNotificationConfig(input);
    expect(parsed.routes).toHaveLength(2); input.routes[0]!.name = 'Changed'; expect(parsed.routes[0]!.name).toBe('Local events');
    expect(parseNotificationConfig({ version: 1, routes: [] }).routes).toEqual([]);
  });
  it('rejects insecure transport unless the operator explicitly allows it', () => {
    expect(() => parseNotificationConfig({ version: 1, routes: [{ ...webhook(), url: 'http://events.local/apcs' }] })).toThrow(/insecure/i);
    expect(() => parseNotificationConfig({ version: 1, routes: [{ ...smtp(), security: 'none', port: 25 }] })).toThrow(/insecure/i);
    expect(parseNotificationConfig({ version: 1, routes: [{ ...webhook(), url: 'http://fixture:4001/events', allowInsecure: true }] }).routes).toHaveLength(1);
  });
  it('bounds routing and rejects duplicate IDs, arbitrary fields, headers and malformed targets', () => {
    for (const route of [{ ...webhook(), secret: 'short' }, { ...webhook(), headers: {} }, { ...webhook(), url: 'file:///private' }, { ...webhook(), url: 'https://user:password@events.local/' }, { ...smtp(), to: 'a@example.test\r\nBcc: b@example.test' }, { ...smtp(), port: 0 }, { ...smtp(), security: 'invalid' }, { ...webhook(), priorities: [] }, { ...webhook(), events: ['Anything'] }, { ...webhook(), projectIds: ['foreign'] }]) expect(() => parseNotificationConfig({ version: 1, routes: [route] })).toThrow();
    expect(() => parseNotificationConfig({ version: 1, routes: [webhook(), webhook()] })).toThrow(/duplicate/i);
    expect(() => parseNotificationConfig({ version: 1, routes: Array.from({ length: 17 }, (_, i) => ({ ...webhook(), id: `route-${i}` })) })).toThrow(/16/);
  });
  it('provides secret-free metadata and a stable fingerprint that changes with private settings', () => {
    const route = parseNotificationConfig({ version: 1, routes: [webhook()] }).routes[0]!;
    expect(publicRoute(route)).toEqual({ id: 'local-webhook', name: 'Local events', kind: 'webhook', priorities: ['high'], events: ['Activated', 'Returned'], projectIds: [] });
    expect(JSON.stringify(publicRoute(route))).not.toContain('secret'); expect(JSON.stringify(publicRoute(route))).not.toContain('events.local');
    expect(routeFingerprint(route)).toMatch(/^[a-f0-9]{64}$/);
    expect(routeFingerprint(route)).toBe(routeFingerprint({ ...route }));
    expect(routeFingerprint(route)).not.toBe(routeFingerprint({ ...route, name: 'Changed' }));
  });
});
