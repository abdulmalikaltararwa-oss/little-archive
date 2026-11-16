import { test, expect, apiAction, createCollection, detailPanel, login, saveButton, saveTray, uniqueName } from './fixtures.mjs';

// The tray that answers a save. Everything runs against the real server; no /api response is replaced. The tray leaves
// by itself after five seconds unless it is touched, so each test acts on it at once and never waits it out.

const DIALOG = 'Save a little discovery';

async function itemsMatching(page, key) {
  const response = await page.request.get(`/api/items?${new URLSearchParams({ q: key })}`);
  expect(response.ok()).toBe(true);
  return (await response.json()).items;
}

async function saveFromDialog(page, { url, title = '', collection = '' }) {
  await saveButton(page).click();
  const dialog = page.getByRole('dialog', { name: DIALOG, exact: true });
  await dialog.getByLabel('Link', { exact: true }).fill(url);
  if (title) await dialog.getByLabel('Title', { exact: true }).fill(title);
  if (collection) await dialog.getByLabel(collection, { exact: true }).check();
  const response = await apiAction(page, 'POST', '/api/items', () => dialog.getByRole('button', { name: 'Save to archive', exact: true }).click());
  return response.json();
}

test('a saved link is answered by a tray that files it, and the same link saved again is not kept twice', async ({ page }) => {
  await login(page);
  const name = uniqueName('Shelf');
  const collection = await createCollection(page, name);
  const key = uniqueName('Kept').split(' ').at(-1);
  const title = `Filed while saving ${key}`;
  const url = `https://example.com/e2e/${key}/filed`;

  const item = await saveFromDialog(page, { url, title, collection: name });
  const tray = saveTray(page);
  // Focus moves to the tray, so the keyboard reaches it; a key pressed in it stops the countdown.
  await expect(tray).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(tray.getByRole('button', { name: 'Done', exact: true })).toBeFocused();
  await expect(tray).toHaveAccessibleName('Just saved');
  await expect(tray.getByRole('status')).toContainText('Kept in your archive.');
  await expect(tray.getByRole('status')).toContainText(`${title} · Web`);
  // The save is not opened by itself any more.
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(new URL(page.url()).hash).not.toContain('item=');

  // The collection ticked in the form is shown as chosen. Untapping takes the save out; Undo puts it back.
  const chip = tray.getByRole('button', { name, exact: true });
  await expect(chip).toHaveAttribute('aria-pressed', 'true');
  let response = await apiAction(page, 'PATCH', `/api/items/${item.id}`, () => chip.click());
  expect((await response.json()).collections).toEqual([]);
  await expect(tray.getByRole('status')).toContainText(`Taken out of ${name}.`);
  await expect(chip).toHaveAttribute('aria-pressed', 'false');
  response = await apiAction(page, 'PATCH', `/api/items/${item.id}`, () => tray.getByRole('button', { name: 'Undo', exact: true }).click());
  expect((await response.json()).collections.map(entry => entry.id)).toEqual([collection.id]);
  await expect(chip).toHaveAttribute('aria-pressed', 'true');
  await expect(tray.getByRole('status')).toContainText('Kept in your archive.');

  response = await apiAction(page, 'PATCH', `/api/items/${item.id}`, () => tray.getByRole('button', { name: 'To revisit', exact: true }).click());
  expect((await response.json()).status).toBe('to_revisit');
  await expect(tray.getByRole('status')).toContainText('Marked to revisit.');
  await tray.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(tray).toHaveCount(0);

  // The same link again. The server's timestamps are whole seconds, and that is what tells a first save from a repeat.
  await page.waitForTimeout(1100);
  const again = await saveFromDialog(page, { url });
  expect(again.id).toBe(item.id);
  await expect(tray).toHaveAccessibleName('Already saved');
  await expect(tray.getByRole('status')).toContainText('You already kept this.');
  await expect(tray.getByRole('status')).toContainText(`in ${name}. No second copy was made.`);
  await expect(tray.getByRole('button', { name: 'Mark to revisit', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect((await itemsMatching(page, key)).map(entry => entry.id)).toEqual([item.id]);
  await tray.getByRole('button', { name: 'Open it', exact: true }).click();
  await expect(detailPanel(page).getByLabel('Title', { exact: true })).toHaveValue(title);
  await expect(tray).toHaveCount(0);
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('the tray sits above the dock, fits the screen, and its buttons are finger-sized', async ({ page }) => {
    await login(page);
    const key = uniqueName('Thumb').split(' ').at(-1);
    await saveFromDialog(page, { url: `https://example.com/e2e/${key}/thumb`, title: `A save with a long name that has to be cut short ${key}` });
    const tray = saveTray(page);
    // A touch stops the countdown.
    await tray.getByRole('status').tap();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const box = await tray.boundingBox();
    const dock = await page.getByRole('navigation', { name: 'Quick actions' }).boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    expect(box.y + box.height).toBeLessThanOrEqual(dock.y);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const sizes = await tray.getByRole('button').evaluateAll(buttons => buttons.map(button => { const rect = button.getBoundingClientRect(); return [Math.round(rect.width), Math.round(rect.height)]; }));
    expect(sizes.length).toBeGreaterThanOrEqual(3);
    for (const [width, height] of sizes) {
      expect(width).toBeGreaterThanOrEqual(44);
      expect(height).toBeGreaterThanOrEqual(44);
    }
    await tray.getByRole('button', { name: 'Done', exact: true }).tap();
    await expect(tray).toHaveCount(0);
  });
});
