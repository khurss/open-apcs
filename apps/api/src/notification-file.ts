import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { parseNotificationConfig, type NotificationConfig } from '../../../packages/notifications/src/config.js';
export async function loadNotificationConfig(path: string): Promise<NotificationConfig> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => { throw new Error('Notification configuration unavailable'); });
  try {
    const info = await file.stat();
    if (!info.isFile() || (info.mode & 0o077)) throw new Error('Notification configuration requires a private regular file');
    if (info.size > 524288) throw new Error('Notification configuration exceeds 512 KiB');
    const bytes = Buffer.alloc(524289); const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 524288) throw new Error('Notification configuration exceeds 512 KiB');
    let value: unknown; try { value = JSON.parse(bytes.subarray(0, bytesRead).toString('utf8')); } catch { throw new Error('Invalid notification configuration JSON'); }
    return parseNotificationConfig(value);
  } finally { await file.close(); }
}
