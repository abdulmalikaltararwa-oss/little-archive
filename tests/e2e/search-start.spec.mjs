import { test, expect, cardTitles, closeDialog, login, saveLink, uniqueName, waitForItems } from './fixtures.mjs';

// Search that starts with what you want: the palette's recent searches (kept in this browser), the searches it builds
// from the library, results that say where the words were found, and what it says when nothing is found. Everything
// runs against the real server; the library is shared with the other specs, so only what a test made is asserted on.

const palette = page => page.getByRole('dialog', { name: 'Search or jump to anything', exact: true });

async function openPalette(page) {
  await expect(page.getByRole('dialog')).toHaveCount(0);
  // Wait for a closed dialog to hand focus back before the shortcut, or the key goes to a page with nothing focused.
  await expect.poll(() => page.evaluate(() => document.activeElement !== document.body)).toBe(true);
  await page.keyboard.press('Control+k');
  await expect(palette(page)).toBeVisible();
  return palette(page);
}

test('search offers recent searches, marks where the words were found, and says when there is nothing', async ({ page }) => {
  await login(page);
  const key = uniqueName('Sought').split(' ').at(-1);
  const noteWord = `balcony${key}`;
  const title = `Karak ${key} at home`;
  const saved = await saveLink(page, { title, url: `https://example.com/e2e/${key}/karak`, notes: `for the ${noteWord} in spring`, topics: `topic-${key}` });
  await closeDialog(saved.detail);
  await waitForItems(page);

  // Before anything is typed: no recent searches yet in this browser, and searches built from the library.
  let dialog = await openPalette(page);
  await expect(dialog.getByRole('status')).toHaveText(/search · [\d,]+ saves?/);
  await expect(dialog.getByText('recent', { exact: true })).toHaveCount(0);
  await expect(dialog.getByText('from your library', { exact: true })).toBeVisible();
  // Which source is the largest depends on what the other specs saved, so any of them will do.
  await expect(dialog.getByRole('option', { name: /^From (?:Web|Instagram|TikTok)\s*[\d,]+$/ })).toBeVisible();

  // Typing: the result marks the word in the title and says where it is from.
  await dialog.getByRole('combobox').fill(key);
  const result = dialog.getByRole('option', { name: new RegExp(`^${title}`) });
  await expect(result).toBeVisible();
  await expect(result.locator('mark')).toHaveText(key);
  await expect(result).toContainText('Web · example.com');
  await expect(dialog.getByRole('status')).toHaveText(/search · 1 of [\d,]+/);
  // Carrying the search out goes to the library with it, and remembers it.
  await dialog.getByRole('option', { name: `Search the library for “${key}”`, exact: false }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`[?&]q=${key}`));
  await expect(cardTitles(page)).toHaveText(title);

  // A word that is only in the note: the result says so and quotes it.
  dialog = await openPalette(page);
  await dialog.getByRole('combobox').fill(noteWord);
  const inNote = dialog.getByRole('option', { name: new RegExp(`^${title}`) });
  await expect(inNote).toContainText(`In your note: “for the ${noteWord} in spring”`);
  await expect(inNote.locator('mark')).toHaveText(noteWord);

  // Nothing found: it says so and offers no empty library; Enter does nothing.
  const missing = `zz${key}qq`;
  await dialog.getByRole('combobox').fill(missing);
  await expect(dialog.getByRole('heading', { name: `Nothing for “${missing}”.`, exact: true })).toBeVisible();
  await expect(dialog.getByRole('status')).toHaveText(/search · 0 of [\d,]+/);
  await expect(dialog.getByRole('option')).toHaveCount(0);
  await page.keyboard.press('Enter');
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');

  // The search that was carried out is offered next time, with how many saves it finds now, and survives a reload.
  await page.reload();
  await waitForItems(page);
  await page.locator('#main').focus();
  dialog = await openPalette(page);
  const recent = dialog.getByRole('option', { name: new RegExp(`^${key}`) });
  await expect(recent).toContainText('1 save');
  await recent.click();
  await expect(dialog).toHaveCount(0);
  await expect(cardTitles(page)).toHaveText(title);

  // Clear forgets them on this device.
  dialog = await openPalette(page);
  await dialog.getByRole('button', { name: 'Clear recent searches', exact: true }).click();
  await expect(dialog.getByRole('option', { name: new RegExp(`^${key}`) })).toHaveCount(0);
  await expect(dialog.getByRole('combobox')).toBeFocused();
  expect(await page.evaluate(() => localStorage.getItem('la:search:recent'))).toBeNull();
  await page.keyboard.press('Escape');
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('search fills the screen with its field at the bottom edge, beside Cancel', async ({ page }) => {
    await login(page);
    await page.getByRole('navigation', { name: 'Quick actions' }).getByRole('button', { name: 'Search', exact: true }).tap();
    const dialog = palette(page);
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('combobox')).toBeFocused();
    await expect(dialog.getByRole('combobox')).toHaveAttribute('placeholder', 'Search your saves');
    // Measured once the dialog has finished arriving.
    await page.evaluate(() => Promise.all(document.getAnimations().filter(animation => Number.isFinite(animation.effect?.getComputedTiming().endTime)).map(animation => animation.finished.catch(() => {}))));
    const box = await dialog.boundingBox();
    expect(box).toMatchObject({ x: 0, y: 0, width: 390, height: 844 });
    const field = await dialog.getByRole('combobox').boundingBox();
    expect(field.y).toBeGreaterThan(844 - 90);
    expect(field.y + field.height).toBeLessThanOrEqual(844);
    // iOS Safari zooms the page into a text field under 16px.
    expect(await dialog.getByRole('combobox').evaluate(input => parseFloat(getComputedStyle(input).fontSize))).toBeGreaterThanOrEqual(16);
    const cancel = dialog.getByRole('button', { name: 'Cancel', exact: true });
    const size = await cancel.boundingBox();
    expect(size.height).toBeGreaterThanOrEqual(44);
    expect(size.width).toBeGreaterThanOrEqual(44);
    expect(size.x).toBeGreaterThan(field.x + field.width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    // The suggestions are finger-sized.
    // Measured through a plain selector: Playwright's Firefox crashes the page on evaluateAll under a dialog found by its name.
    await expect(dialog.getByRole('option').first()).toBeVisible();
    const chips = await page.locator('[role="dialog"] [role="option"]').evaluateAll(options => options.map(option => Math.round(option.getBoundingClientRect().height)));
    expect(chips.length).toBeGreaterThan(0);
    for (const height of chips) expect(height).toBeGreaterThanOrEqual(44);
    await cancel.tap();
    await expect(dialog).toHaveCount(0);
  });
});
