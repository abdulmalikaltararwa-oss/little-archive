import { expect, test as base, type Page } from '@playwright/test';

// Every test runs behind a boundary: a request to any other origin fails the test, and so does an uncaught
// error or a Content-Security-Policy violation. The demo page talks to nothing, and this proves it stays so.
const test = base.extend<{ boundary: void }>({
  boundary: [async ({ page, baseURL }, use) => {
    const origin = new URL(baseURL!).origin;
    const problems: string[] = [];
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (['http:', 'https:'].includes(url.protocol) && url.origin !== origin) { problems.push(`request to ${url.origin}`); return route.abort('blockedbyclient'); }
      return route.continue();
    });
    page.on('pageerror', error => problems.push(`page error: ${error.message}`));
    page.on('console', message => { if (message.type() === 'error') problems.push(`console: ${message.text()}`); });
    await use();
    expect(problems, 'no external requests, uncaught errors or policy violations').toEqual([]);
  }, { auto: true }],
});

const isPhone = (page: Page) => (page.viewportSize()?.width ?? 0) < 1024;
const count = (page: Page) => page.getByTestId('save-count');
const cards = (page: Page) => page.locator('[data-item-id]');

async function open(page: Page, hash = '') {
  await page.goto(`/demo.html${hash}`);
  await expect(count(page)).toHaveText(/^\d[\d,]* saves?$|^\d+ of \d[\d,]* saves$/);
}

test('the library opens with its saves, one heading and a window of cards', async ({ page }) => {
  await open(page);
  await expect(page.getByRole('heading', { level: 1, name: 'All saves' })).toBeVisible();
  await expect(page.locator('h1')).toHaveCount(1);
  await expect(page.getByRole('note')).toContainText('Interactive demo');
  const total = Number((await count(page).textContent())!.replace(/\D/g, ''));
  expect(total).toBeGreaterThan(20);
  // Only the cards near the screen are in the page.
  expect(await cards(page).count()).toBeLessThan(total);
  // Nothing scrolls sideways.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

test('search narrows the wall, says when nothing matches, and clears', async ({ page }) => {
  await open(page);
  const search = page.getByLabel('Search titles, captions, tags, and notes');
  await search.fill('lemon pasta');
  await expect(count(page)).toHaveText('1 save');
  await expect(page).toHaveURL(/#\/\?q=lemon\+pasta$/);
  await search.fill('zzzz nothing matches this');
  await expect(page.getByRole('heading', { name: 'Nothing here just yet.' })).toBeVisible();
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(search).toHaveValue('');
  await expect(count(page)).not.toHaveText('0 saves');
});

test('a save opens, keeps an edit, and asks before unsaved edits are dropped', async ({ page }) => {
  await open(page);
  const first = page.locator('[data-card-control="open"]').first();
  const name = (await first.getAttribute('aria-label'))!.replace(/^Open /, '');
  await first.click();
  const detail = page.getByTestId('detail');
  await expect(detail.getByRole('heading', { level: 2, name, exact: true })).toBeVisible();
  await expect(page).toHaveURL(/item=demo-item-\d+/);

  const notes = detail.getByLabel('Your notes');
  await notes.fill('Try this on Sunday. جرّبها يوم الأحد');
  await detail.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Your changes are saved.' })).toBeVisible();

  await notes.fill('An edit that will be thrown away');
  await page.keyboard.press('Escape');
  const question = page.getByRole('alertdialog', { name: 'Discard your unsaved changes?' });
  await question.getByRole('button', { name: 'Keep editing' }).click();
  await expect(question).toBeHidden();
  await expect(notes).toBeFocused();
  await page.keyboard.press('Escape');
  await question.getByRole('button', { name: 'Discard changes' }).click();
  await expect(detail).toBeHidden();
  // Focus returns to the card that opened the save.
  await expect(first).toBeFocused();
  await expect(page).not.toHaveURL(/item=/);

  await first.click();
  await expect(detail.getByLabel('Your notes')).toHaveValue('Try this on Sunday. جرّبها يوم الأحد');
  await page.goBack();
  await expect(detail).toBeHidden();
});

test('a favourite can be toggled from a card', async ({ page }) => {
  await open(page);
  const id = await page.locator('article:has([data-card-control="favorite"][aria-pressed="false"])').first().getAttribute('data-item-id');
  const heart = page.locator(`[data-item-id="${id}"] [data-card-control="favorite"]`);
  await expect(heart).toHaveAccessibleName('Add to favorites');
  await heart.click();
  await expect(heart).toHaveAttribute('aria-pressed', 'true');
  await expect(heart).toHaveAccessibleName('Remove from favorites');
});

test('a selection can be favourited in one action', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  for (const index of [0, 1, 2]) await page.locator('[data-card-control="select"]').nth(index).check();
  const bar = page.getByRole('region', { name: 'Selection' });
  await expect(bar).toContainText('3 selected');
  await bar.getByRole('button', { name: 'Apply an action' }).click();
  await page.getByRole('menuitem', { name: 'Add to favorites' }).click();
  await expect(page.getByRole('status').filter({ hasText: '3 saves updated.' })).toBeVisible();
  await expect(bar).toBeHidden();
});

test('a link is saved only when Save is pressed, then opens', async ({ page }) => {
  await open(page);
  const before = Number((await count(page).textContent())!.replace(/\D/g, ''));
  if (isPhone(page)) await page.getByRole('navigation', { name: 'Quick actions' }).getByRole('button', { name: 'Save a link' }).click();
  else await page.getByRole('button', { name: 'Save a link', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Save a little discovery' });
  await dialog.getByRole('button', { name: 'Save to archive' }).click();
  await expect(dialog.getByRole('alert')).toHaveText('Enter a complete HTTP or HTTPS link.');
  await dialog.getByLabel('Link').fill('https://example.com/a-new-discovery');
  await dialog.getByLabel('Title').fill('A new discovery <b>not markup</b>');
  await dialog.getByLabel('Topics').fill('smoke, test');
  await dialog.getByRole('button', { name: 'Save to archive' }).click();
  const tray = page.getByRole('region', { name: 'Just saved' });
  await expect(tray.getByRole('status')).toContainText('Kept in your archive.');
  await tray.getByRole('button', { name: 'Open it' }).click();
  const detail = page.getByTestId('detail');
  await expect(detail.getByRole('heading', { level: 2, name: 'A new discovery <b>not markup</b>' })).toBeVisible();
  await expect(detail.locator('b')).toHaveCount(0);
  await detail.getByRole('button', { name: 'Close dialog' }).click();
  await expect(count(page)).toHaveText(`${before + 1} saves`);
});

test('the palette jumps to a view, the address follows, and Back returns', async ({ page }) => {
  await open(page);
  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog', { name: 'Search or jump to anything' });
  await palette.getByRole('combobox').fill('Favorites');
  await palette.getByRole('option', { name: 'Favorites', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Your favorites' })).toBeVisible();
  await expect(page).toHaveURL(/#\/favorites$/);
  await page.goBack();
  await expect(page.getByRole('heading', { level: 1, name: 'All saves' })).toBeVisible();
});

test('an address opens the view and the save it names', async ({ page }) => {
  await open(page, '#/favorites?item=demo-item-1');
  const detail = page.getByTestId('detail');
  await expect(detail).toBeVisible();
  await detail.getByRole('button', { name: 'Close dialog' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Your favorites' })).toBeVisible();
  await expect(page).toHaveURL(/#\/favorites$/);
});

test('appearance switches between light and dark', async ({ page }) => {
  await open(page);
  if (isPhone(page)) await page.getByRole('navigation', { name: 'Quick actions' }).getByRole('button', { name: 'Settings & connections' }).click();
  else await page.getByRole('button', { name: 'Settings & connections' }).click();
  const settings = page.getByRole('dialog', { name: 'Make yourself at home' });
  await settings.getByRole('radio', { name: 'Dark' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await settings.getByRole('radio', { name: 'Light' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  // The demo remembers nothing.
  expect(await page.evaluate(() => localStorage.getItem('little-archive-theme'))).toBeNull();
});

test('a collection can be made and appears in the navigation', async ({ page }) => {
  await open(page);
  if (isPhone(page)) await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('button', { name: 'Create a collection' }).click();
  const dialog = page.getByRole('dialog', { name: 'Make a collection' });
  await dialog.getByLabel('Name').fill('Smoke test shelf');
  await dialog.getByRole('radio', { name: 'Blush' }).check({ force: true });
  await dialog.getByRole('button', { name: 'Create collection' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Your new collection is ready.' })).toBeVisible();
  if (isPhone(page)) await page.getByRole('button', { name: 'Open navigation' }).click();
  await expect(page.getByRole('button', { name: /^Smoke test shelf/ })).toBeVisible();
});

test('a screen the demo cannot offer says so instead of pretending', async ({ page }) => {
  await open(page);
  await page.goto('/demo.html#/ask');
  await expect(page.getByRole('heading', { name: 'Not in the demo' })).toBeVisible();
  await page.goto('/demo.html#/unlock');
  await expect(page.getByRole('heading', { level: 1, name: 'Free on your own server.' })).toBeVisible();
  // Nothing is claimed to be open or locked in a demo that has no account.
  await expect(page.getByText('not in the demo').first()).toBeVisible();
});

test('on a phone the dock navigates and the new view takes focus', async ({ page }) => {
  test.skip(!isPhone(page), 'the dock is the phone’s navigation');
  await open(page);
  const dock = page.getByRole('navigation', { name: 'Quick actions' });
  await expect(dock).toBeVisible();
  for (const button of await dock.getByRole('button').all()) {
    const box = (await button.boundingBox())!;
    expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(44);
  }
  await dock.getByRole('button', { name: 'Open navigation' }).click();
  const sheet = page.getByRole('dialog', { name: 'Browse your archive' });
  await sheet.getByRole('button', { name: /^Favorites/ }).click();
  await expect(sheet).toBeHidden();
  await expect(page.getByRole('heading', { level: 1, name: 'Your favorites' })).toBeFocused();
});

test('on a wide screen the keyboard reaches search and the skip link', async ({ page }) => {
  test.skip(isPhone(page), 'keyboard shortcuts are for a keyboard');
  await open(page);
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
  await page.keyboard.press('/');
  await expect(page.getByLabel('Search titles, captions, tags, and notes')).toBeFocused();
});
