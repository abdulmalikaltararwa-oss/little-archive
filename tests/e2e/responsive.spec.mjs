import { test, expect, apiAction, cardTitles, chooseView, closeDialog, login, saveLink, search, searchBox, settings, uniqueName, waitForItems } from './fixtures.mjs';

test('a narrow screen supports navigation, editing, keyboard search and remembered appearance', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  // There is no sidebar and no hamburger: a floating dock holds the four things a thumb reaches for, and Browse opens a sheet.
  const dock = page.getByRole('navigation', { name: 'Quick actions' });
  await expect(dock).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'Library navigation' })).toBeHidden();
  await expect(page.getByRole('button', { name: 'Open navigation', exact: true })).toHaveCount(1);
  await chooseView(page, 'Favorites', 'Your favorites');
  // A view chosen in the sheet closes it and takes focus, so a screen reader announces where it landed.
  await expect(page.getByRole('dialog', { name: 'Browse your archive', exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { level: 1, name: 'Your favorites', exact: true })).toBeFocused();
  await chooseView(page, 'All saves', 'All saves');
  const title = uniqueName('Small screen save');
  const saved = await saveLink(page, { title, url: `https://example.com/e2e/${title.replaceAll(' ', '-')}` });
  // The save opens full screen on a phone.
  const bounds = await saved.detail.boundingBox();
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.width).toBeLessThanOrEqual(390);
  expect(bounds.height).toBeLessThanOrEqual(844);
  await saved.detail.getByLabel('Your notes', { exact: true }).fill('Edited from the narrow layout.');
  await apiAction(page, 'PATCH', `/api/items/${saved.item.id}`, () => saved.detail.getByRole('button', { name: 'Save changes', exact: true }).click());
  await expect(saved.detail.getByLabel('Your notes', { exact: true })).toHaveValue('Edited from the narrow layout.');
  await closeDialog(saved.detail);

  // ⌘K / Ctrl+K opens the palette, and "/" or Ctrl+F (⌘F) goes straight to the search box.
  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog', { name: 'Search or jump to anything', exact: true });
  await expect(palette).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(palette).toHaveCount(0);
  await page.keyboard.press('/');
  await expect(searchBox(page)).toBeFocused();
  await search(page, title);
  await expect(cardTitles(page)).toHaveText(title);
  // The dock's Search button opens the same palette.
  await dock.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(palette).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(palette).toHaveCount(0);

  const preferences = await settings(page);
  await preferences.getByRole('radio', { name: 'Dark', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(preferences.getByRole('radio', { name: 'Dark', exact: true })).toBeChecked();
  // The browser's own chrome follows the page's paper.
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#1a211d');
  await closeDialog(preferences);
  await page.reload();
  await waitForItems(page);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
