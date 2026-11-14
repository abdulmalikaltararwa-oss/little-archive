import { test, expect, apiAction, chooseView, closeDialog, importJSON, login, openItem, search, uniqueName, waitForItems } from './fixtures.mjs';

async function importLibrary(page, count, { favorite = false } = {}) {
  const key = uniqueName('navigation').split(' ').at(-1);
  const imported = await importJSON(page, {
    format: 'little-archive', version: 1,
    items: Array.from({ length: count }, (_, index) => ({
      url: `https://example.com/navigation-regression/${key}/${index}`,
      title: `Journal ${key} ${String(index).padStart(3, '0')}`,
      notes: 'Synthetic browsing regression fixture.', favorite,
    })),
  });
  expect(imported.result.created).toBe(count);
  await closeDialog(imported.dialog);
  await search(page, key);
  return key;
}

async function sortBy(page, value) {
  const response = page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.pathname === '/api/items' && url.searchParams.get('sort') === value;
  });
  await page.getByLabel('Sort saves').selectOption(value);
  expect((await response).ok()).toBe(true);
  await waitForItems(page);
}

async function loadTo(page, count) {
  for (let loaded = 60; loaded < count; loaded += 60) {
    await page.getByRole('button', { name: /^Load more/ }).click();
    await expect(page.locator('article.card')).toHaveCount(Math.min(loaded + 60, count));
    await waitForItems(page);
  }
}

const inventory = page => page.locator('article.card').evaluateAll(cards => cards.map(card => card.dataset.itemId));
const scrollY = page => page.evaluate(() => window.scrollY);
const expectPosition = async (page, before) => expect.poll(async () => Math.abs(await scrollY(page) - before), { message: 'The gallery must keep the same reading position.' }).toBeLessThan(5);

test('favoriting and editing retain four loaded pages, their nodes, scroll, and return focus', async ({ page, context }) => {
  await login(page);
  await importLibrary(page, 260);
  await sortBy(page, 'title');
  await loadTo(page, 240);
  const before = await inventory(page);
  const id = before[210];
  const card = page.locator(`[data-item-id="${id}"]`);
  const favorite = card.getByRole('button', { name: 'Add to favorites', exact: true });
  await card.scrollIntoViewIfNeeded();
  await favorite.focus();
  const originalPosition = await scrollY(page);
  await page.evaluate(() => { window.retainedArchiveCard = document.querySelector('article.card'); });

  await apiAction(page, 'PATCH', `/api/items/${id}`, () => favorite.click());
  await expect(card.getByRole('button', { name: 'Remove from favorites', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('article.card')).toHaveCount(240);
  expect(await inventory(page)).toEqual(before);
  expect(await page.evaluate(() => window.retainedArchiveCard === document.querySelector('article.card'))).toBe(true);
  await expectPosition(page, originalPosition);
  await expect(card.getByRole('button', { name: 'Remove from favorites', exact: true })).toBeFocused();

  const title = await card.locator('.card-title').textContent();
  const opener = card.getByRole('button', { name: `Open ${title}`, exact: true });
  await opener.focus();
  const editPosition = await scrollY(page);
  await opener.press('Enter');
  const detail = page.getByRole('dialog', { name: 'A closer look', exact: true });
  await expect(detail.getByLabel('Title', { exact: true })).toHaveValue(title);
  const detailFavorite = detail.getByRole('button', { name: 'Remove from favorites', exact: true });
  await detailFavorite.focus();
  await apiAction(page, 'PATCH', `/api/items/${id}`, () => detailFavorite.click());
  await expect(detail.getByRole('button', { name: 'Add to favorites', exact: true })).toBeEnabled();
  await expect(detail.getByRole('button', { name: 'Add to favorites', exact: true })).toBeFocused();
  await expect(card.locator('.card-favorite')).toHaveAttribute('aria-pressed', 'false');
  expect(await inventory(page)).toEqual(before);
  await expectPosition(page, editPosition);
  const notes = 'A useful reminder, saved after loading four gallery pages.';
  await detail.getByLabel('Your notes', { exact: true }).fill(notes);
  const save = detail.getByRole('button', { name: 'Save changes', exact: true });
  await save.focus();
  const drawerPosition = await detail.evaluate(node => node.scrollTop);
  const reads = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (request.method() === 'GET' && url.pathname === '/api/items') reads.push({ offset: Number(url.searchParams.get('offset')), limit: Number(url.searchParams.get('limit')) });
  });
  await apiAction(page, 'PATCH', `/api/items/${id}`, () => save.click());
  await expect(page.locator('.toast').filter({ hasText: 'Your changes are saved.' })).toBeVisible();
  await expect(detail.getByLabel('Your notes', { exact: true })).toHaveValue(notes);
  await expect(detail.getByRole('button', { name: 'Save changes', exact: true })).toBeFocused();
  expect(Math.abs(await detail.evaluate(node => node.scrollTop) - drawerPosition)).toBeLessThan(5);
  // Search is still server-authoritative, including a retained window larger than its page maximum.
  expect(reads).toEqual([{ offset: 0, limit: 200 }, { offset: 200, limit: 40 }]);
  expect(await inventory(page)).toEqual(before);
  expect(await page.evaluate(() => window.retainedArchiveCard === document.querySelector('article.card'))).toBe(true);
  await closeDialog(detail);
  await expect(opener).toBeFocused();
  await expectPosition(page, editPosition);
  const persisted = await (await context.request.get(`/api/items/${id}`)).json();
  expect(persisted).toMatchObject({ notes, favorite: false });
});

test('leaving Favorites and editing a sorted title refresh the loaded window without losing pages', async ({ page, context }) => {
  await login(page);
  const key = await importLibrary(page, 121, { favorite: true });
  await chooseView(page, 'Favorites', 'Your favorites');
  await search(page, key);
  await sortBy(page, 'title');
  await loadTo(page, 120);
  const ids = await inventory(page);
  const removedId = ids[90];
  const removedCard = page.locator(`[data-item-id="${removedId}"]`);
  await removedCard.scrollIntoViewIfNeeded();
  await removedCard.getByRole('button', { name: 'Remove from favorites', exact: true }).focus();
  const anchor = await page.locator('article.card').evaluateAll((cards, exclude) => {
    const card = cards.find(node => node.dataset.itemId !== exclude && node.getBoundingClientRect().bottom > 0 && node.getBoundingClientRect().top < innerHeight);
    return { id: card.dataset.itemId, top: card.getBoundingClientRect().top };
  }, removedId);
  await apiAction(page, 'PATCH', `/api/items/${removedId}`, () => removedCard.getByRole('button', { name: 'Remove from favorites', exact: true }).click());
  await expect(removedCard).toHaveCount(0);
  await expect(page.locator('article.card')).toHaveCount(120);
  await expect(page.locator('.library-title > span')).toHaveText('120 saves');
  await expect(page.getByRole('button', { name: /^Load more/ })).toHaveCount(0);
  const favorites = await (await context.request.get('/api/items', { params: { q: key, favorite: true, sort: 'title', limit: 200 } })).json();
  expect(await inventory(page)).toEqual(favorites.items.map(item => item.id));
  expect(Math.abs(await page.locator(`[data-item-id="${anchor.id}"]`).evaluate(node => node.getBoundingClientRect().top) - anchor.top)).toBeLessThan(5);
  expect(await page.evaluate(() => document.activeElement.matches('.card-open'))).toBe(true);
  expect((await (await context.request.get(`/api/items/${removedId}`)).json()).favorite).toBe(false);

  const edited = favorites.items[85];
  const detail = await openItem(page, edited.title);
  const renamed = `A renamed journal ${key}`;
  await detail.getByLabel('Title', { exact: true }).fill(renamed);
  await apiAction(page, 'PATCH', `/api/items/${edited.id}`, () => detail.getByRole('button', { name: 'Save changes', exact: true }).click());
  await expect(page.locator('.toast').filter({ hasText: 'Your changes are saved.' })).toBeVisible();
  await expect(page.locator('article.card')).toHaveCount(120);
  await expect(page.locator('.card-title').first()).toHaveText(renamed);
  const expectedTitles = favorites.items.map(item => item.id === edited.id ? renamed : item.title).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  await expect(page.locator('.card-title')).toHaveText(expectedTitles);
  const closingPosition = await scrollY(page);
  await closeDialog(detail);
  await expectPosition(page, closingPosition);
  // Focus returns in the dialog's close event, which the browser dispatches as a later task than the close itself.
  await expect.poll(() => page.evaluate(() => {
    const rect = document.activeElement.getBoundingClientRect();
    return document.activeElement.matches('.card-open') && rect.bottom > 0 && rect.top < innerHeight;
  })).toBe(true);
});

test('favoriting a Rediscover result keeps the same sampled inventory and order', async ({ page }) => {
  await login(page);
  await importLibrary(page, 75);
  await sortBy(page, 'random');
  await expect(page.locator('.library-title > span')).toHaveText('60 of 75 saves');
  const before = await inventory(page);
  const card = page.locator(`[data-item-id="${before[35]}"]`);
  await card.scrollIntoViewIfNeeded();
  await card.getByRole('button', { name: 'Add to favorites', exact: true }).focus();
  const position = await scrollY(page);
  await apiAction(page, 'PATCH', `/api/items/${before[35]}`, () => card.getByRole('button', { name: 'Add to favorites', exact: true }).click());
  await expect(card.getByRole('button', { name: 'Remove from favorites', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect(await inventory(page)).toEqual(before);
  await expectPosition(page, position);
  await expect(page.getByRole('button', { name: 'Shuffle these discoveries', exact: true })).toBeVisible();
});

test('closed narrow navigation is inaccessible and keyboard focus follows open, close, dialogs and resizing', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  const sidebar = page.locator('#sidebar');
  const menu = page.locator('.mobile-menu');
  const main = page.locator('main.main');
  await expect(sidebar).toHaveAttribute('inert', '');
  await expect(sidebar).toHaveAttribute('aria-hidden', 'true');
  await expect(page.getByRole('navigation', { name: 'Library views', exact: true })).toHaveCount(0);
  await menu.focus();
  for (let index = 0; index < 18; index++) {
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => Boolean(document.activeElement.closest('#sidebar')))).toBe(false);
  }

  await menu.focus();
  await menu.press('Enter');
  const close = sidebar.getByRole('button', { name: 'Close navigation', exact: true });
  await expect(sidebar).not.toHaveAttribute('inert', '');
  await expect(sidebar).toHaveAttribute('role', 'dialog');
  await expect(sidebar).toHaveAttribute('aria-modal', 'true');
  await expect(main).toHaveAttribute('inert', '');
  await expect(close).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(sidebar.getByRole('button', { name: 'Settings & connections', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(close).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toBeFocused();
  await expect(sidebar).toHaveAttribute('inert', '');
  await expect(main).not.toHaveAttribute('inert', '');

  await menu.press('Enter');
  await close.click();
  await expect(menu).toBeFocused();
  await menu.press('Enter');
  await page.locator('.mobile-scrim').click({ position: { x: 375, y: 100 } });
  await expect(menu).toBeFocused();
  await menu.press('Enter');
  await sidebar.getByRole('button', { name: /^Favorites(?:\s|$)/ }).click();
  await waitForItems(page);
  await expect(page.getByRole('heading', { name: 'Your favorites', exact: true })).toBeFocused();
  await expect(menu).toHaveAttribute('aria-expanded', 'false');

  await menu.click();
  await sidebar.getByRole('button', { name: 'Settings & connections', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Make yourself at home', exact: true });
  await expect(settings).toBeVisible();
  await expect(sidebar).toHaveAttribute('inert', '');
  await closeDialog(settings);
  await expect(menu).toBeFocused();

  await menu.press('Enter');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(sidebar).not.toHaveAttribute('inert', '');
  await expect(sidebar).not.toHaveAttribute('aria-hidden', 'true');
  await expect(main).not.toHaveAttribute('inert', '');
  await expect(sidebar.locator('.nav-button.active').first()).toBeFocused();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(sidebar).toHaveAttribute('inert', '');
  await expect(menu).toBeFocused();
  await menu.press('Enter');
  await page.keyboard.press('Control+k');
  await expect(page.getByRole('searchbox', { name: 'Search titles, captions, tags, and notes' })).toBeFocused();
  await expect(sidebar).toHaveAttribute('aria-hidden', 'true');
});
