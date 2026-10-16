import { expect, test, type Page } from '@playwright/test';

async function packetsStored(page: Page): Promise<number> {
  await page.getByRole('link', { name: 'Simulator & data' }).click();
  const dd = page.locator('dt:text-is("Packets stored") + dd');
  await expect(dd).not.toHaveText('');
  return Number((await dd.innerText()).replace(/,/g, ''));
}

test('seeds 500 trucks into OPFS, survives reload, and works offline', async ({ page, context }) => {
  await page.goto('/');
  await expect(page.getByText('Stored on device')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole('button', { name: /All vehicles/ })).toContainText('500');

  const before = await packetsStored(page);
  expect(before).toBeGreaterThan(10_000);

  await page.reload();
  await expect(page.getByText('Stored on device')).toBeVisible({ timeout: 30_000 });
  const after = await packetsStored(page);
  // Restored from OPFS (not re-seeded, which would reset the counter) and still growing.
  expect(after).toBeGreaterThanOrEqual(before);

  // Wait for the service worker to take control, then go fully offline and reload.
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByText('You are offline')).toBeVisible({ timeout: 30_000 });
  await page.getByRole('link', { name: 'Fleet', exact: true }).click();
  await expect(page.getByRole('button', { name: /All vehicles/ })).toContainText('500');
  await page.getByRole('searchbox', { name: 'Search' }).fill('TRK-001');
  await page.getByRole('link', { name: 'TRK-001' }).click();
  await expect(page.getByRole('heading', { name: 'TRK-001' })).toBeVisible();
  await context.setOffline(false);
});

test('acknowledge an alert, then undo it', async ({ page }) => {
  await page.goto('/attention');
  await expect(page.getByRole('tab', { name: /Needs action/ })).toBeVisible({ timeout: 60_000 });
  const firstAck = page.getByRole('button', { name: 'Acknowledge' }).first();
  await expect(firstAck).toBeVisible({ timeout: 30_000 });
  const item = page.locator('.alert-item').first();
  const vehicle = await item.locator('strong').first().innerText();

  await firstAck.click();
  await expect(page.getByRole('status').getByText(new RegExp(`Acknowledged ${vehicle}`))).toBeVisible();
  await page.getByRole('tab', { name: /Acknowledged/ }).click();
  await expect(page.locator('.alert-item', { hasText: vehicle })).toBeVisible();

  await page.getByRole('button', { name: 'Undo' }).click();
  await page.getByRole('tab', { name: /Needs action/ }).click();
  await expect(page.locator('.alert-item', { hasText: vehicle }).first()).toBeVisible();
});

test('replaying stored packets adds no rows', async ({ page }) => {
  await page.goto('/simulator');
  await page.getByRole('button', { name: /Pause simulator/ }).click({ timeout: 60_000 });
  await page.getByRole('button', { name: /Replay last 1,000 packets/ }).click();
  await expect(page.getByText(/Replayed 1000 packets → 0 new, 1000 duplicates ignored/)).toBeVisible();
  await page.getByRole('button', { name: /Resume simulator/ }).click();
});
