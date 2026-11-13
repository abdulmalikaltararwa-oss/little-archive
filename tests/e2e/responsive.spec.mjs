import { test, expect, apiAction, chooseView, closeDialog, login, saveLink, search, settings, uniqueName, waitForItems } from './fixtures.mjs';

test('a narrow screen supports navigation, editing, keyboard search and remembered appearance', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const menu = page.getByRole('button', { name: 'Open navigation', exact: true });
  await expect(menu).toBeVisible();
  await chooseView(page, 'Favorites', 'Your favorites');
  await expect(menu).toHaveAttribute('aria-expanded', 'false');
  await chooseView(page, 'All saves', 'All saves');
  const title = uniqueName('Small screen save');
  const saved = await saveLink(page, { title, url: `https://example.com/e2e/${title.replaceAll(' ', '-')}` });
  const bounds = await saved.detail.boundingBox();
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.width).toBeLessThanOrEqual(390);
  expect(bounds.height).toBeLessThanOrEqual(844);
  await saved.detail.getByLabel('Your notes', { exact: true }).fill('Edited from the narrow layout.');
  await apiAction(page, 'PATCH', `/api/items/${saved.item.id}`, () => saved.detail.getByRole('button', { name: 'Save changes', exact: true }).click());
  await expect(saved.detail.getByLabel('Your notes', { exact: true })).toHaveValue('Edited from the narrow layout.');
  await closeDialog(saved.detail);
  await page.keyboard.press('Control+k');
  await expect(page.getByRole('searchbox', { name: 'Search titles, captions, tags, and notes' })).toBeFocused();
  await search(page, title);
  await expect(page.locator('.card-title')).toHaveText(title);

  const preferences = await settings(page);
  await preferences.getByRole('button', { name: 'Dark', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(preferences.getByRole('button', { name: 'Dark', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await closeDialog(preferences);
  await page.reload();
  await waitForItems(page);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
