import type { LedConnection } from './mqtt-led.js';
import { record } from '../../domain/src/logic.js';
export interface PhysicalConfig { url: string; username: string; password: string; ca: string; devices: { siteId: string; deviceId: string; gpio: number }[]; }
const pins = [5, 18, 19, 21, 22, 23, 25, 26, 27, 32, 33];
export function parsePhysicalConfig(input: unknown): PhysicalConfig {
  const value = record(input, ['url', 'username', 'password', 'ca', 'devices'], 'physical configuration');
  for (const [key, maximum] of Object.entries({ url: 256, username: 128, password: 256, ca: 4095 })) if (typeof value[key] !== 'string' || !(value[key] as string).trim() || (value[key] as string).includes('\0') || Buffer.byteLength(value[key] as string) > maximum) throw new Error(`Invalid physical configuration field: ${key}`);
  let url: URL; try { url = new URL(value.url as string); } catch { throw new Error('Invalid physical configuration field: url'); }
  if (url.protocol !== 'mqtts:' || !url.hostname || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname) || /\s/.test(value.url as string)) throw new Error('Physical connection requires a TLS broker URL without embedded credentials');
  if (!(value.ca as string).startsWith('-----BEGIN CERTIFICATE-----') || !(value.ca as string).trimEnd().endsWith('-----END CERTIFICATE-----')) throw new Error('Invalid physical configuration field: ca');
  if (!Array.isArray(value.devices) || !value.devices.length || value.devices.length > 16) throw new Error('Physical allowlist must contain 1 to 16 devices');
  const seen = new Set<string>();
  for (const inputDevice of value.devices) {
    const device = record(inputDevice, ['siteId', 'deviceId', 'gpio'], 'physical device');
    if (['siteId', 'deviceId'].some((key) => typeof device[key] !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(device[key] as string)) || !pins.includes(device.gpio as number)) throw new Error('Invalid physical allowlist entry or GPIO');
    const key = `${device.siteId}/${device.deviceId}`; if (seen.has(key)) throw new Error('Duplicate physical allowlist entry'); seen.add(key);
  }
  return structuredClone(input) as PhysicalConfig;
}
export function physicalConnection(config: PhysicalConfig, device: { siteId: string; deviceId: string; signalId: string }, gpio: number): LedConnection {
  const entry = config.devices.find((entry) => entry.siteId === device.siteId && entry.deviceId === device.deviceId);
  if (!entry) throw new Error('Physical device is not in the configured allowlist');
  if (entry.gpio !== gpio) throw new Error('Physical GPIO does not match the reviewed configuration');
  return { ...device, url: config.url, credentials: { username: config.username, password: config.password, ca: config.ca } };
}
