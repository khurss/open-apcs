const limits: Record<string, number> = { ssid: 32, password: 63, broker: 256, username: 128, secret: 256, site: 128, device: 128, ntp: 255, ca: 4095 };
export function provisioningCsv(input: unknown): string {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid provisioning object');
  const value = input as Record<string, unknown>;
  if (Object.keys(value).length !== Object.keys(limits).length + 1 || Object.keys(value).some((key) => key !== 'gpio' && !(key in limits))) throw new Error('Invalid provisioning fields');
  for (const [key, max] of Object.entries(limits)) if (typeof value[key] !== 'string' || !(value[key] as string).trim() || (value[key] as string).includes('\0') || Buffer.byteLength(value[key] as string) > max) throw new Error(`Invalid provisioning field: ${key}`);
  for (const key of ['site', 'device']) if (!/^[A-Za-z0-9_-]+$/.test(value[key] as string)) throw new Error(`Invalid provisioning field: ${key}`);
  if (!/^[\x20-\x7e]{8,63}$/.test(value.password as string)) throw new Error('Invalid provisioning field: password');
  let broker: URL; try { broker = new URL(value.broker as string); } catch { throw new Error('Invalid provisioning field: broker'); }
  if (broker.protocol !== 'mqtts:' || !broker.hostname || broker.username || broker.password || broker.search || broker.hash || !['', '/'].includes(broker.pathname)) throw new Error('Invalid provisioning field: broker');
  if (!/^[A-Za-z0-9_.:-]+$/.test(value.ntp as string)) throw new Error('Invalid provisioning field: ntp');
  if (!(value.ca as string).startsWith('-----BEGIN CERTIFICATE-----') || !(value.ca as string).trimEnd().endsWith('-----END CERTIFICATE-----')) throw new Error('Invalid provisioning field: ca');
  if (![18, 19, 21, 22, 23, 25, 26, 27, 32, 33].includes(value.gpio as number)) throw new Error('Invalid provisioning field: gpio');
  const row = (fields: unknown[]) => fields.map((field) => `"${String(field).replaceAll('"', '""')}"`).join(',');
  return ['key,type,encoding,value', row(['apcs', 'namespace', '', '']), ...Object.keys(limits).map((key) => row([key, 'data', 'string', value[key]])), row(['gpio', 'data', 'i32', value.gpio])].join('\n') + '\n';
}
