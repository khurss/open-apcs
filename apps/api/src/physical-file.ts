import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { X509Certificate } from 'node:crypto';
import { parsePhysicalConfig, type PhysicalConfig } from '../../../packages/gateway/src/physical-config.js';
export async function loadPhysicalConfig(path?: string): Promise<PhysicalConfig | undefined> {
  if (!path) return undefined;
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => { throw new Error('Physical configuration file unavailable'); });
  try {
    const info = await file.stat();
    if (!info.isFile() || (info.mode & 0o077)) throw new Error('Physical configuration requires a private regular file');
    if (info.size > 32768) throw new Error('Physical configuration exceeds 32 KiB');
    const bytes = Buffer.alloc(32769); const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 32768) throw new Error('Physical configuration exceeds 32 KiB');
    let value: unknown; try { value = JSON.parse(bytes.subarray(0, bytesRead).toString('utf8')); } catch { throw new Error('Invalid physical configuration JSON'); }
    const config = parsePhysicalConfig(value);
    try { const ca = new X509Certificate(config.ca); if (!ca.ca) throw new Error(); } catch { throw new Error('Physical configuration requires a valid CA certificate'); }
    return config;
  } finally { await file.close(); }
}
