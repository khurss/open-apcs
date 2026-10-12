import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e', testMatch: '**/*.spec.ts', workers: 1, retries: 0,
  timeout: 20000, expect: { timeout: 5000 },
  use: { baseURL: 'http://localhost:5173', browserName: 'chromium', viewport: { width: 1440, height: 1000 }, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  reporter: [['list'], ['junit', { outputFile: 'test-results/e2e-junit.xml' }]],
});
