import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const excluded = new Set([
  '.git', 'node_modules', 'dist', 'build', 'coverage', 'test-results',
  'playwright-report', '.pnpm-store', '.cache',
]);
const cyrillic = /\p{Script=Cyrillic}/u;
const decoder = new TextDecoder('utf-8', { fatal: true });
const failures = [];
let checked = 0;

async function scan(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (excluded.has(entry.name) || (entry.name.startsWith('.env') && entry.name !== '.env.example')) continue;
    const filename = path.join(directory, entry.name);
    const relative = path.relative(root, filename);
    if (cyrillic.test(entry.name)) failures.push(`${relative}: filename contains Cyrillic`);
    if (entry.isDirectory()) {
      await scan(filename);
    } else if (entry.isFile()) {
      const bytes = await readFile(filename);
      if (bytes.includes(0)) continue;
      let contents;
      try { contents = decoder.decode(bytes); } catch { continue; }
      checked++;
      for (const [index, line] of contents.split('\n').entries()) {
        if (cyrillic.test(line)) failures.push(`${relative}:${index + 1}`);
      }
    }
  }
}

await scan(root);
if (failures.length > 0) {
  console.error('Repository content must be in English. Cyrillic found at:');
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`English-content check passed (${checked} text files; no Cyrillic).`);
}
