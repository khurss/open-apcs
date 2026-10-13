import { describe, expect, it } from 'vitest';
import { parsePhysicalConfig, physicalConnection } from './physical-config.js';
const sample = () => ({ url: 'mqtts://broker.local:8883', username: 'gateway', password: 'private-device-password', ca: '-----BEGIN CERTIFICATE-----\nFIXTURE\n-----END CERTIFICATE-----', devices: [{ siteId: 'lab', deviceId: 'led', gpio: 18 }] });
describe('explicit physical LED commissioning configuration', () => {
  it('requires an exact GPIO5 allowlist match for the onboard LED bench', () => {
    const config = parsePhysicalConfig({ ...sample(), devices: [{ siteId: 'lab', deviceId: 'led', gpio: 5 }] });
    expect(physicalConnection(config, { siteId: 'lab', deviceId: 'led', signalId: 'output' }, 5).deviceId).toBe('led');
    expect(() => physicalConnection(config, { siteId: 'lab', deviceId: 'led', signalId: 'output' }, 18)).toThrow(/GPIO/);
  });
  it('binds only an allowlisted device and reviewed GPIO to a copied TLS connection', () => {
    const input = sample(); const config = parsePhysicalConfig(input); input.devices[0]!.gpio = 19;
    const connection = physicalConnection(config, { siteId: 'lab', deviceId: 'led', signalId: 'catalog-output' }, 18);
    expect(connection).toMatchObject({ url: 'mqtts://broker.local:8883', signalId: 'catalog-output', siteId: 'lab', deviceId: 'led', credentials: { username: 'gateway', password: 'private-device-password', ca: sample().ca } });
  });
  it('refuses unlisted devices and GPIO mismatches', () => {
    const config = parsePhysicalConfig(sample());
    expect(() => physicalConnection(config, { siteId: 'other', deviceId: 'led', signalId: 'signal' }, 18)).toThrow(/allowlist/i);
    expect(() => physicalConnection(config, { siteId: 'lab', deviceId: 'led', signalId: 'signal' }, 19)).toThrow(/GPIO/);
  });
  it('refuses plaintext, embedded credentials and security overrides', () => {
    for (const value of [{ ...sample(), url: 'mqtt://broker.local' }, { ...sample(), url: 'mqtts://user:password@broker.local' }, { ...sample(), rejectUnauthorized: false }, { ...sample(), ca: '' }]) expect(() => parsePhysicalConfig(value)).toThrow();
  });
  it('requires a bounded nonempty unique allowlist and safe LED pins', () => {
    for (const devices of [[], Array.from({ length: 17 }, (_, i) => ({ siteId: 'lab', deviceId: `led-${i}`, gpio: 18 })), [...sample().devices, ...sample().devices], [{ siteId: 'lab', deviceId: 'led', gpio: 2 }], [{ siteId: 'lab/#', deviceId: 'led', gpio: 18 }]]) expect(() => parsePhysicalConfig({ ...sample(), devices })).toThrow();
  });
  it('does not include private values in validation diagnostics', () => {
    expect(() => parsePhysicalConfig({ ...sample(), password: 'PRIVATE'.repeat(100) })).toThrow('Invalid physical configuration field: password');
  });
});
