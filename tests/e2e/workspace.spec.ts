import { expect, test, type Page } from '@playwright/test';

async function login(page: Page) {
  await page.goto('/');
  await page.getByLabel('Username', { exact: true }).fill('operator');
  await page.getByLabel('Password', { exact: true }).fill('E2E fixture password only!');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Overview', exact: true })).toBeVisible();
}

test('creates a project and virtual device, shows unknown signal quality, and audits the workflow', async ({ page }) => {
  const errors: string[] = [];
  const external: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => { if (new URL(request.url()).hostname !== 'localhost') external.push(request.url()); });
  await login(page);
  await page.getByRole('button', { name: 'Projects', exact: true }).click();
  await page.getByLabel('Project name', { exact: true }).fill('Browser LED Demo');
  await page.getByRole('button', { name: 'Create project', exact: true }).click();
  await expect(page.getByText('Browser LED Demo', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Devices', exact: true }).click();
  await page.getByLabel('Device name', { exact: true }).fill('Workbench LED');
  await page.getByLabel('Site ID', { exact: true }).fill('demo');
  await page.getByLabel('Device address', { exact: true }).fill('esp32-1');
  await page.getByRole('button', { name: 'Add device', exact: true }).click();
  await expect(page.getByText('Workbench LED', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Signals', exact: true }).click();
  await expect(page.getByText('Workbench LED.led', { exact: true })).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: 'Workbench LED.led' })).toContainText('Disconnected');
  await expect(page.getByRole('row').filter({ hasText: 'Workbench LED.led' })).toContainText('No data');
  await page.getByRole('button', { name: 'Activity', exact: true }).click();
  await expect(page.getByText('Device created', { exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Overview', exact: true }).click();
  await page.screenshot({ path: 'test-results/overview-desktop.png', fullPage: true });
  await page.getByRole('button', { name: 'Switch to light theme' }).click();
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.screenshot({ path: 'test-results/overview-light.png', fullPage: true });
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  expect(errors).toEqual([]); expect(external).toEqual([]);
});

test('keeps forms and navigation usable on phone and tablet widths', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await login(page);
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('button', { name: 'Devices', exact: true }).click();
  await expect(page.getByLabel('Device name', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/devices-phone.png', fullPage: true });
  await page.setViewportSize({ width: 768, height: 1024 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('shows a useful login failure without exposing protected content', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Username', { exact: true }).fill('operator');
  await page.getByLabel('Password', { exact: true }).fill('incorrect password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Invalid credentials');
  await expect(page.getByRole('button', { name: 'Projects', exact: true })).toHaveCount(0);
});
