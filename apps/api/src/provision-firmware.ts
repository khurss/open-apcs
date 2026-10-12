import { X509Certificate } from 'node:crypto';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { provisioningCsv } from '../../../packages/firmware-tools/src/provision.js';
try {
  const [input, output, ...extra] = process.argv.slice(2);
  if (!input || !output || extra.length) throw new Error('Usage: firmware:provision INPUT.json OUTPUT.csv');
  const info = await stat(input);
  if (!info.isFile() || info.size > 16384 || (info.mode & 0o077)) throw new Error('Provisioning input must be a private regular file of at most 16 KiB (mode 0600)');
  let value: unknown; try { value = JSON.parse(await readFile(input, 'utf8')); } catch { throw new Error('Invalid provisioning JSON'); }
  const csv = provisioningCsv(value);
  try { new X509Certificate((value as { ca: string }).ca); } catch { throw new Error('Invalid CA certificate'); }
  await writeFile(output, csv, { flag: 'wx', mode: 0o600 });
  process.stdout.write('Private NVS CSV created. No device has been flashed.\n');
} catch (error) {
  process.stderr.write(error instanceof Error && !('code' in error) ? `${error.message}\n` : 'Provisioning file operation failed\n'); process.exitCode = 1;
}
