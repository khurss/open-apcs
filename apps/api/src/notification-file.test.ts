import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { loadNotificationConfig } from './notification-file.js';
let dir: string | undefined;
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); dir = undefined; });
it('requires a bounded private regular configuration and never follows links', async () => {
  dir = await mkdtemp(join(tmpdir(), 'apcs-notify-')); const file = join(dir, 'config.json');
  await writeFile(file, JSON.stringify({ version: 1, routes: [] }), { mode: 0o600 });
  expect(await loadNotificationConfig(file)).toEqual({ version: 1, routes: [] });
  await symlink(file, join(dir, 'link')); await expect(loadNotificationConfig(join(dir, 'link'))).rejects.toThrow(/unavailable/);
  await chmod(file, 0o644); await expect(loadNotificationConfig(file)).rejects.toThrow(/private/);
  await chmod(file, 0o600); await writeFile(file, 'x'.repeat(524289)); await expect(loadNotificationConfig(file)).rejects.toThrow(/512 KiB/);
  await writeFile(file, '{'); await expect(loadNotificationConfig(file)).rejects.toThrow(/JSON/);
  await chmod(dir, 0o700); await expect(loadNotificationConfig(dir)).rejects.toThrow(/regular/);
});
