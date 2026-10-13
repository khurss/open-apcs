import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

test('development server refuses private cache and generated artifacts before login', async ({ request }) => {
  // Assert the fixtures exist: a missing file would not demonstrate protection.
  await readFile(new URL('../../.cache/e2e/schema.json', import.meta.url));
  await readFile(new URL('../../apps/web/dist/index.html', import.meta.url));
  for (const path of ['.cache/e2e/schema.json', 'apps/web/dist/index.html']) {
    for (const query of ['', '?raw', '?url']) {
      expect((await request.get(`/@fs/workspace/${path}${query}`)).status()).toBe(403);
    }
  }
});
