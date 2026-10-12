import { afterEach, expect, it } from 'vitest';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPhysicalConfig } from './physical-file.js';
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
async function fixture(value: string, mode = 0o600) { const dir = await mkdtemp(join(tmpdir(), 'apcs-config-')); dirs.push(dir); const path = join(dir, 'physical.json'); await writeFile(path, value, { mode }); return path; }
it('keeps physical commissioning disabled when no path was supplied', async () => { expect(await loadPhysicalConfig()).toBeUndefined(); });
it('rejects public, oversized and symlinked configuration files', async () => {
  await expect(loadPhysicalConfig(await fixture('{}', 0o644))).rejects.toThrow(/private/);
  await expect(loadPhysicalConfig(await fixture('x'.repeat(32769)))).rejects.toThrow(/32 KiB/);
  const target = await fixture('{}'); const link = `${target}.link`; await symlink(target, link); await expect(loadPhysicalConfig(link)).rejects.toThrow(/file/);
});
it('does not echo malformed JSON or file paths containing secrets', async () => {
  await expect(loadPhysicalConfig(await fixture('secret-password'))).rejects.toThrow('Invalid physical configuration JSON');
  await expect(loadPhysicalConfig('/no-such-secret-path')).rejects.toThrow('Physical configuration file unavailable');
});
