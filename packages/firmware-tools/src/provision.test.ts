import { describe, expect, it } from 'vitest';
import { provisioningCsv } from './provision.js';
const sample = () => ({ ssid: 'Local, lab', password: 'test-only-pass', broker: 'mqtts://broker.local:8883', username: 'bench', secret: 'test-only-device-secret', site: 'lab', device: 'led-1', gpio: 18, ntp: 'time.local', ca: '-----BEGIN CERTIFICATE-----\nTEST_FIXTURE_ONLY\n-----END CERTIFICATE-----\n' });
describe('local ESP32 provisioning encoder', () => {
  it('encodes bounded NVS strings without losing CSV commas, quotes or certificate newlines', () => {
    const csv = provisioningCsv({ ...sample(), ssid: 'Lab "A", Wi-Fi' });
    expect(csv).toContain('"ssid","data","string","Lab ""A"", Wi-Fi"');
    expect(csv).toContain('"gpio","data","i32","18"'); expect(csv).toContain(sample().ca); expect(csv).toContain('"apcs","namespace","",""');
  });
  it('refuses plaintext MQTT, credentials in URLs, unknown fields and non-object input', () => {
    for (const input of [null, [], { ...sample(), extra: true }, { ...sample(), broker: 'mqtt://broker.local' }, { ...sample(), broker: 'mqtts://user:secret@broker.local' }]) expect(() => provisioningCsv(input)).toThrow();
  });
  it('refuses flash, input-only, strapping and uncommissioned pins', () => {
    for (const gpio of [-1, 0, 2, 6, 12, 15, 34, 39, 18.5]) expect(() => provisioningCsv({ ...sample(), gpio })).toThrow();
  });
  it('rejects embedded NUL, invalid topic identifiers and oversized strings', () => {
    for (const update of [{ device: 'other/topic' }, { secret: 'secret\u0000suffix' }, { ssid: 'a'.repeat(33) }, { ntp: '' }, { password: 'short' }]) expect(() => provisioningCsv({ ...sample(), ...update })).toThrow();
  });
  it('never includes supplied credential contents in validation errors', () => {
    expect(() => provisioningCsv({ ...sample(), secret: 'PRIVATE'.repeat(100) })).toThrow('Invalid provisioning field: secret');
  });
});
