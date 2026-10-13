import { signIn } from './auth.js';
import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';

test('monitors a large signal page and disables controls when a refresh fails', async ({ page }) => {
  const signals = Array.from({ length: 101 }, (_, index) => ({ id: randomUUID(), deviceId: randomUUID(),
    name: `Monitor fixture ${index}`, dataType: 'boolean', direction: 'output' }));
  let value = false; let unavailable = false;
  const singleReads: string[] = [];
  await page.route(/\/api\/v1\/signals(?:\?.*)?$/, (route) => route.fulfill({ json: { items: signals, nextCursor: null } }));
  await page.route('**/api/v1/signals/*/value', (route) => { singleReads.push(route.request().url()); return route.abort(); });
  await page.route('**/api/v1/signals/values?*', (route) => {
    const ids = new URL(route.request().url()).searchParams.get('ids')!.split(',');
    expect(ids.length).toBeLessThanOrEqual(100);
    return unavailable ? route.fulfill({ status: 503, json: { message: 'Runtime unavailable' } })
      : route.fulfill({ json: Object.fromEntries(ids.map((id) => [id, { value, quality: 'Good', receivedTime: new Date().toISOString() }])) });
  });
  await signIn(page);
  await page.getByRole('button', { name: 'Signals', exact: true }).click();
  const rows = page.getByRole('row').filter({ hasText: 'Monitor fixture' });
  await expect(rows).toHaveCount(101);
  await expect(rows.last()).toContainText('Good');
  await expect(rows.last()).toContainText('OFF');
  value = true;
  await expect(rows.first()).toContainText('ON');
  await expect(rows.last()).toContainText('ON');
  unavailable = true;
  await expect(rows.first()).toContainText('Disconnected');
  await expect(rows.last().getByRole('button', { name: 'Control', exact: true })).toBeDisabled();
  unavailable = false;
  await expect(rows.last()).toContainText('Good');
  await expect(rows.last().getByRole('button', { name: 'Control', exact: true })).toBeEnabled();
  expect(singleReads).toEqual([]);
});
