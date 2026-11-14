import {
  test, expect, apiAction, cards, chooseView, closeDialog, detailPanel, importJSON, isWide, loadedCount, login, navigation, saveButton,
  saveCount, search, searchBox, settingsButton, sortBy, uniqueName, waitForItems,
} from './fixtures.mjs';

// The wall draws only the cards near the screen, and the next page loads by itself as the end comes near. So these
// tests read the whole list from the server (its order is the truth), look at the cards that are in the page by
// their place in the set (aria-posinset), and take "how many are loaded" from the Load more button.

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

/** Scrolling to the end brings the next page, until nothing is left to load. */
async function loadAll(page) {
  const total = Number(((await saveCount(page).textContent()).match(/(\d[\d,]*) saves?$/) || [])[1].replace(/\D/g, ''));
  for (let guard = 0; guard < 12; guard++) {
    const before = await loadedCount(page);
    if (before >= total) break;
    await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
    await expect.poll(() => loadedCount(page), { message: 'The next page should load as the end of the wall nears.' }).toBeGreaterThan(before);
    await waitForItems(page);
  }
  expect(await loadedCount(page)).toBe(total);
  await expect(page.getByRole('button', { name: /^Load more/ })).toHaveCount(0);
}

/** The whole list in the server's order, for the current search. */
async function listFrom(context, params) {
  const ids = [];
  for (let offset = 0; ; offset += 200) {
    const page = await (await context.request.get('/api/items', { params: { ...params, limit: 200, offset } })).json();
    ids.push(...page.items.map(item => ({ id: item.id, title: item.title })));
    if (ids.length >= page.total || !page.items.length) return ids;
  }
}

/** Which saves are in the page, each with its place in the set. */
const inventory = async page => (await page.locator('article[data-item-id]').evaluateAll(nodes => nodes.map(node => [Number(node.getAttribute('aria-posinset')), node.dataset.itemId])))
  .sort((a, b) => a[0] - b[0]);
/** The window of cards once it has caught up with the last scroll (it follows the scroll position a frame later). */
async function settledInventory(page) {
  let last = JSON.stringify(await inventory(page));
  for (let steady = 0; steady < 3;) {
    await page.waitForTimeout(100);
    const next = JSON.stringify(await inventory(page));
    steady = next === last ? steady + 1 : 0;
    last = next;
  }
  return JSON.parse(last);
}
const scrollY = page => page.evaluate(() => window.scrollY);
/** How far the open save's own scroll area has moved: the first scrolling element inside the dialog. */
const drawerScroll = detail => detail.evaluate(node => {
  const area = [node, ...node.querySelectorAll('*')].find(entry => ['auto', 'scroll'].includes(getComputedStyle(entry).overflowY) && entry.scrollHeight > entry.clientHeight);
  return area ? area.scrollTop : 0;
});
const expectPosition = async (page, before) => expect.poll(async () => Math.abs(await scrollY(page) - before), { message: 'The gallery must keep the same reading position.' }).toBeLessThan(5);

/** The cards in the page are exactly the saves at their places in `list`. */
async function expectWindowToMatch(page, list) {
  const shown = await inventory(page);
  expect(shown.length).toBeGreaterThan(0);
  for (const [place, id] of shown) expect(id, `place ${place}`).toBe(list[place - 1].id);
}

/** Waits until the page has stopped moving: the same scroll position on several frames in a row. */
async function scrollSettled(page) {
  await page.evaluate(() => new Promise(resolve => {
    let last = scrollY;
    let still = 0;
    const frame = () => {
      still = scrollY === last ? still + 1 : 0;
      last = scrollY;
      if (still >= 4) resolve(); else requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }));
}

/**
 * Scrolls until the save at `index` of the set is in the page, then puts it in the middle of the screen and waits for the
 * page to be still. The page is moved by script, in whole steps, rather than by the wheel: where a browser eases a wheel
 * turn (smooth scrolling) the page is still moving when the card first appears, and a card put "in view" on the way can
 * end up at the very top, where the test's assumptions about what else is on screen do not hold.
 */
async function bringIntoView(page, id, index) {
  const card = page.locator(`[data-item-id="${id}"]`);
  for (let attempt = 0; attempt < 150 && !(await card.count()); attempt++) {
    const places = (await inventory(page)).map(entry => entry[0]);
    await page.evaluate(distance => scrollBy({ top: distance, behavior: 'instant' }), places.length && index + 1 < Math.min(...places) ? -900 : 900);
    await scrollSettled(page);
  }
  await expect(card).toHaveCount(1);
  await card.evaluate(node => node.scrollIntoView({ block: 'center', behavior: 'instant' }));
  await scrollSettled(page);
  return card;
}

test('favoriting and editing retain every loaded page, their nodes, scroll, and return focus', async ({ page, context }) => {
  await login(page);
  const key = await importLibrary(page, 260);
  await sortBy(page, 'title');
  await loadAll(page);
  await expect(saveCount(page)).toHaveText('260 saves');
  const list = await listFrom(context, { q: key, sort: 'title' });
  expect(list).toHaveLength(260);
  const { id } = list[210];
  const card = await bringIntoView(page, id, 210);
  const favorite = card.getByRole('button', { name: 'Add to favorites', exact: true });
  await favorite.focus();
  const originalPosition = await scrollY(page);
  const before = await settledInventory(page);
  await card.evaluate(node => { window.retainedArchiveCard = node; });

  // Pressed, not clicked: this is about where the keyboard's focus stays, and Safari does not give a button focus when it is clicked.
  await apiAction(page, 'PATCH', `/api/items/${id}`, () => favorite.press('Enter'));
  await expect(card.getByRole('button', { name: 'Remove from favorites', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(saveCount(page)).toHaveText('260 saves');
  expect(await loadedCount(page)).toBe(260);
  expect(await inventory(page)).toEqual(before);
  expect(await page.evaluate(selector => window.retainedArchiveCard === document.querySelector(selector), `[data-item-id="${id}"]`)).toBe(true);
  await expectPosition(page, originalPosition);
  await expect(card.getByRole('button', { name: 'Remove from favorites', exact: true })).toBeFocused();

  const title = await card.locator('h3').textContent();
  const opener = card.getByRole('button', { name: `Open ${title}`, exact: true });
  await opener.focus();
  const editPosition = await scrollY(page);
  await opener.press('Enter');
  const detail = detailPanel(page);
  await expect(detail.getByLabel('Title', { exact: true })).toHaveValue(title);
  await expect(page).toHaveURL(new RegExp(`item=${id}`));
  const detailFavorite = detail.getByRole('button', { name: 'Remove from favorites', exact: true });
  await detailFavorite.focus();
  await apiAction(page, 'PATCH', `/api/items/${id}`, () => detailFavorite.press('Enter'));
  await expect(detail.getByRole('button', { name: 'Add to favorites', exact: true })).toBeEnabled();
  await expect(detail.getByRole('button', { name: 'Add to favorites', exact: true })).toBeFocused();
  await expect(card.locator('[data-card-control="favorite"]')).toHaveAttribute('aria-pressed', 'false');
  expect(await inventory(page)).toEqual(before);
  await expectPosition(page, editPosition);
  const notes = 'A useful reminder, saved after loading every gallery page.';
  await detail.getByLabel('Your notes', { exact: true }).fill(notes);
  const save = detail.getByRole('button', { name: 'Save changes', exact: true });
  await save.focus();
  const drawerPosition = await drawerScroll(detail);
  const reads = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (request.method() === 'GET' && url.pathname === '/api/items') reads.push({ offset: Number(url.searchParams.get('offset')), limit: Number(url.searchParams.get('limit')) });
  });
  await apiAction(page, 'PATCH', `/api/items/${id}`, () => save.press('Enter'));
  await expect(page.getByRole('status').filter({ hasText: 'Your changes are saved.' })).toBeVisible();
  await expect(detail.getByLabel('Your notes', { exact: true })).toHaveValue(notes);
  await expect(detail.getByRole('button', { name: 'Save changes', exact: true })).toBeFocused();
  expect(Math.abs(await drawerScroll(detail) - drawerPosition)).toBeLessThan(5);
  // Search is still server-authoritative, including a loaded window larger than the server's page maximum: the
  // same 260 saves are asked for again, in two bounded requests, not 60 and not all at once.
  await expect.poll(() => reads).toEqual([{ offset: 0, limit: 200 }, { offset: 200, limit: 60 }]);
  expect(await loadedCount(page)).toBe(260);
  expect(await inventory(page)).toEqual(before);
  expect(await page.evaluate(selector => window.retainedArchiveCard === document.querySelector(selector), `[data-item-id="${id}"]`)).toBe(true);
  await closeDialog(detail);
  await expect(opener).toBeFocused();
  await expect(page).not.toHaveURL(/item=/);
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
  await loadAll(page);
  await expect(saveCount(page)).toHaveText('121 saves');
  const ids = await listFrom(context, { q: key, favorite: true, sort: 'title' });
  expect(ids).toHaveLength(121);
  const removed = ids[90];
  const removedCard = await bringIntoView(page, removed.id, 90);
  await removedCard.getByRole('button', { name: 'Remove from favorites', exact: true }).focus();
  // The reading position is the first card on screen in the set's order. (The wall is a masonry: cards after the one
  // that leaves reflow into the gap, so only cards before it are expected to stay exactly where they are.)
  const anchor = await page.locator('article[data-item-id]').evaluateAll((nodes, exclude) => {
    const onScreen = nodes.filter(entry => entry.dataset.itemId !== exclude && entry.getBoundingClientRect().bottom > 0 && entry.getBoundingClientRect().top < innerHeight)
      .sort((a, b) => Number(a.getAttribute('aria-posinset')) - Number(b.getAttribute('aria-posinset')));
    return { id: onScreen[0].dataset.itemId, place: Number(onScreen[0].getAttribute('aria-posinset')), top: onScreen[0].getBoundingClientRect().top };
  }, removed.id);
  expect(anchor.place, 'the card that leaves is not the first one on screen').toBeLessThan(91);
  // Pressed, not clicked: the keyboard holds focus on the card that leaves. (Safari hands a clicked button's focus to the page's
  // main area instead, so a click never puts the keyboard on the card.)
  await apiAction(page, 'PATCH', `/api/items/${removed.id}`, () => removedCard.getByRole('button', { name: 'Remove from favorites', exact: true }).press('Enter'));
  await expect(removedCard).toHaveCount(0);
  await expect(saveCount(page)).toHaveText('120 saves');
  await expect(page.getByRole('button', { name: /^Load more/ })).toHaveCount(0);
  const favorites = await listFrom(context, { q: key, favorite: true, sort: 'title' });
  expect(favorites).toHaveLength(120);
  expect(favorites.map(entry => entry.id)).toEqual(ids.filter(entry => entry.id !== removed.id).map(entry => entry.id));
  await expectWindowToMatch(page, favorites);
  expect(Math.abs(await page.locator(`[data-item-id="${anchor.id}"]`).evaluate(node => node.getBoundingClientRect().top) - anchor.top)).toBeLessThan(5);
  // The card that held focus left the wall, so focus moves to a card that is still on screen, never to the page.
  await expect.poll(() => page.evaluate(() => document.activeElement.matches('[data-card-control="open"]'))).toBe(true);
  expect((await (await context.request.get(`/api/items/${removed.id}`)).json()).favorite).toBe(false);

  const edited = favorites[85];
  await bringIntoView(page, edited.id, 85);
  // Opened with the keyboard, which is what leaves focus on the card to return to (Safari gives a clicked button no focus).
  await page.getByRole('button', { name: `Open ${edited.title}`, exact: true }).press('Enter');
  const detail = detailPanel(page);
  await expect(detail.getByLabel('Title', { exact: true })).toHaveValue(edited.title);
  const renamed = `A renamed journal ${key}`;
  await detail.getByLabel('Title', { exact: true }).fill(renamed);
  await apiAction(page, 'PATCH', `/api/items/${edited.id}`, () => detail.getByRole('button', { name: 'Save changes', exact: true }).click());
  await expect(page.getByRole('status').filter({ hasText: 'Your changes are saved.' })).toBeVisible();
  await expect(saveCount(page)).toHaveText('120 saves');
  expect(await loadedCount(page)).toBe(120);
  // The new title sorts first, and every card in the page is at the place the server now puts it.
  const reordered = favorites.map(entry => (entry.id === edited.id ? { ...entry, title: renamed } : entry))
    .sort((a, b) => a.title.toLowerCase().localeCompare(b.title.toLowerCase()));
  expect(reordered[0].title).toBe(renamed);
  await expect.poll(async () => (await listFrom(context, { q: key, favorite: true, sort: 'title' })).map(entry => entry.id)).toEqual(reordered.map(entry => entry.id));
  await expectWindowToMatch(page, reordered);
  const closingPosition = await scrollY(page);
  await closeDialog(detail);
  await expectPosition(page, closingPosition);
  await expect.poll(() => page.evaluate(() => {
    const rect = document.activeElement.getBoundingClientRect();
    return document.activeElement.matches('[data-card-control="open"]') && rect.bottom > 0 && rect.top < innerHeight;
  })).toBe(true);
  await page.evaluate(() => scrollTo(0, 0));
  await expect(page.locator('article[data-item-id] h3').first()).toHaveText(renamed);
});

test('favoriting a Rediscover result keeps the same sampled inventory and order', async ({ page }) => {
  await login(page);
  await importLibrary(page, 75);
  await sortBy(page, 'random');
  await expect(saveCount(page)).toHaveText('60 of 75 saves');
  const before = await settledInventory(page);
  expect(before.length).toBeGreaterThan(5);
  // A new sort lists the saves in another order. The page stays where it was (the top); it does not follow the card that used
  // to be first to wherever the new order puts it.
  expect(await scrollY(page)).toBe(0);
  expect(before[0][0]).toBe(1);
  const [place, id] = before[Math.min(before.length - 1, 12)];
  const card = page.locator(`[data-item-id="${id}"]`);
  await card.scrollIntoViewIfNeeded();
  await card.getByRole('button', { name: 'Add to favorites', exact: true }).focus();
  const position = await scrollY(page);
  const shown = await settledInventory(page);
  await apiAction(page, 'PATCH', `/api/items/${id}`, () => card.getByRole('button', { name: 'Add to favorites', exact: true }).click());
  await expect(card.getByRole('button', { name: 'Remove from favorites', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect(await inventory(page)).toEqual(shown);
  expect(place).toBeGreaterThan(0);
  await expectPosition(page, position);
  await expect(saveCount(page)).toHaveText('60 of 75 saves');
  // A shuffled sample does not load more by itself: asking again is its own button.
  await expect(page.getByRole('button', { name: 'Shuffle these discoveries', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Load more/ })).toHaveCount(0);
});

test('keyboard focus inside a save survives its full record arriving a moment after it opens', async ({ page }) => {
  await login(page);
  await importLibrary(page, 6);
  // The panel shows what the wall already knows at once and swaps in the full record when it arrives. Hold the answer
  // back (not change it), as a slow connection would, and put the keyboard in the panel meanwhile.
  await page.route(url => /^\/api\/items\/[^/]+$/.test(url.pathname), async route => {
    if (route.request().method() !== 'GET') return route.fallback();
    await new Promise(resolve => setTimeout(resolve, 900));
    return route.continue();
  });
  const arrived = page.waitForResponse(response => response.request().method() === 'GET' && /^\/api\/items\/[^/]+$/.test(new URL(response.url()).pathname));
  await cards(page).first().getByRole('button', { name: /^Open /, exact: false }).click();
  const detail = detailPanel(page);
  const favorite = detail.getByRole('button', { name: /^(Add to|Remove from) favorites$/ });
  await favorite.focus();
  await expect(favorite).toBeFocused();
  await arrived;
  await page.waitForTimeout(300);
  await expect(favorite).toBeFocused();
  expect(await page.evaluate(() => document.activeElement.tagName)).toBe('BUTTON');
});

test('the next page loads by itself near the end, once, and Load more stays for the keyboard', async ({ page }) => {
  await login(page);
  await importLibrary(page, 130);
  await expect(saveCount(page)).toHaveText('130 saves');
  expect(await loadedCount(page)).toBe(60);
  const reads = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (request.method() === 'GET' && url.pathname === '/api/items') reads.push({ offset: Number(url.searchParams.get('offset')), limit: Number(url.searchParams.get('limit')) });
  });
  // Nothing loads while the end is far away.
  await page.waitForTimeout(500);
  expect(reads).toEqual([]);
  await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
  await expect.poll(() => loadedCount(page)).toBe(120);
  await waitForItems(page);
  // One request for one page: the end moved away when the page arrived, so nothing asks again.
  await page.waitForTimeout(500);
  expect(reads).toEqual([{ offset: 60, limit: 60 }]);

  const more = page.getByRole('button', { name: /^Load more/ });
  await expect(more).toContainText('10 remaining');
  await more.focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => loadedCount(page)).toBe(130);
  await expect(more).toHaveCount(0);
  expect(reads.at(-1)).toEqual({ offset: 120, limit: 60 });
  await expect(saveCount(page)).toHaveText('130 saves');
});

test('the address carries the view, the filters and the open save, and Back keeps unsaved edits safe', async ({ page, context }) => {
  await login(page);
  const key = await importLibrary(page, 12, { favorite: true });
  const list = await listFrom(context, { q: key, sort: 'title', favorite: true });
  await chooseView(page, 'Favorites', 'Your favorites');
  await search(page, key);
  await sortBy(page, 'title');
  await expect(page).toHaveURL(new RegExp(`#/favorites\\?q=${key}&sort=title$`));
  const target = list[3];
  await page.getByRole('button', { name: `Open ${target.title}`, exact: true }).click();
  const detail = detailPanel(page);
  await expect(detail.getByLabel('Title', { exact: true })).toHaveValue(target.title);
  await expect(page).toHaveURL(new RegExp(`#/favorites\\?q=${key}&sort=title&item=${target.id}$`));

  // A reload, or the same address pasted into a new tab, comes back to the same view, filters and open save.
  const address = page.url();
  await page.reload();
  await expect(detailPanel(page).getByLabel('Title', { exact: true })).toHaveValue(target.title);
  // While a save is open the page behind it is hidden from assistive technology, so these are found by their ids.
  await expect(page.locator('#view-title')).toHaveText('Your favorites');
  await expect(page.locator('#library-search')).toHaveValue(key);
  await expect(page.getByTestId('save-count')).toHaveText('12 saves');
  const fresh = await context.newPage();
  await fresh.goto(address);
  await expect(detailPanel(fresh).getByLabel('Title', { exact: true })).toHaveValue(target.title);
  await fresh.close();

  // Back from the open save returns to the list; Forward opens it again.
  await page.goBack();
  await expect(detailPanel(page)).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`#/favorites\\?q=${key}&sort=title$`));
  await page.goForward();
  await expect(detailPanel(page).getByLabel('Title', { exact: true })).toHaveValue(target.title);

  // Leaving a save with unsaved edits asks first, and the browser's Back button is no exception.
  await detail.getByLabel('Your notes', { exact: true }).fill('An unsaved thought.');
  await page.goBack();
  const question = page.getByRole('alertdialog', { name: 'Discard your unsaved changes?', exact: true });
  await expect(question).toBeVisible();
  await question.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await expect(question).toHaveCount(0);
  await expect(detail.getByLabel('Your notes', { exact: true })).toHaveValue('An unsaved thought.');
  await expect(page).toHaveURL(new RegExp(`item=${target.id}`));
  await page.goBack();
  await page.getByRole('alertdialog', { name: 'Discard your unsaved changes?', exact: true }).getByRole('button', { name: 'Discard changes', exact: true }).click();
  await expect(detailPanel(page)).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`#/favorites\\?q=${key}&sort=title$`));
  expect((await (await context.request.get(`/api/items/${target.id}`)).json()).notes).not.toBe('An unsaved thought.');

  // The view itself is in the history too: Back goes to where the person was before Favorites, search and all.
  await page.goBack();
  await expect(page.getByRole('heading', { level: 1, name: 'All saves', exact: true })).toBeVisible();
  await expect(searchBox(page)).toHaveValue(key);
  await waitForItems(page);
});

test('a dialog traps the keyboard and scroll, and hands focus back where it came from', async ({ page }) => {
  await login(page);
  await settingsButton(page).focus();
  await settingsButton(page).press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Make yourself at home', exact: true });
  await expect(dialog).toBeVisible();
  // The dialog's scroll lock is a style element that the page's nonce allows: if the policy had refused it, the page would still scroll.
  await expect(page.locator('body')).toHaveAttribute('data-scroll-locked', /.+/);
  expect(await page.evaluate(() => getComputedStyle(document.body).overflow)).toBe('hidden');
  for (let step = 0; step < 40; step++) {
    await page.keyboard.press('Tab');
    expect(await dialog.evaluate(node => node.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(settingsButton(page)).toBeFocused();
  await expect(page.locator('body')).not.toHaveAttribute('data-scroll-locked', /.+/);
  expect(await page.evaluate(() => getComputedStyle(document.body).overflow)).not.toBe('hidden');
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('the dock is the only navigation, its sheet traps focus, and focus follows open, close, dialogs and resizing', async ({ page }) => {
    await login(page);
    const dock = page.getByRole('navigation', { name: 'Quick actions' });
    const sidebar = page.getByRole('complementary', { name: 'Library navigation' });
    const browse = dock.getByRole('button', { name: 'Open navigation', exact: true });
    // No sidebar: it is not drawn, so it is not in the accessibility tree and no key can reach it.
    await expect(dock).toBeVisible();
    await expect(sidebar).toBeHidden();
    await expect(page.getByRole('navigation', { name: 'Library views', exact: true })).toHaveCount(0);
    await browse.focus();
    for (let index = 0; index < 18; index++) {
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => Boolean(document.activeElement.closest('aside')))).toBe(false);
    }

    // Opening the sheet moves focus into it, Tab and Shift+Tab stay inside it, and Escape returns to the button.
    await browse.focus();
    await browse.press('Enter');
    const sheet = page.getByRole('dialog', { name: 'Browse your archive', exact: true });
    await expect(sheet).toBeVisible();
    await expect.poll(() => sheet.evaluate(node => node.contains(document.activeElement))).toBe(true);
    for (let step = 0; step < 30; step++) {
      await page.keyboard.press(step % 2 ? 'Shift+Tab' : 'Tab');
      expect(await sheet.evaluate(node => node.contains(document.activeElement))).toBe(true);
    }
    await page.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);
    await expect(browse).toBeFocused();

    await browse.press('Enter');
    await sheet.getByRole('button', { name: 'Close dialog', exact: true }).click();
    await expect(sheet).toHaveCount(0);
    await expect(browse).toBeFocused();
    // Pressing outside the sheet closes it too.
    await browse.press('Enter');
    await expect(sheet).toBeVisible();
    // The dialog library starts listening for presses outside a moment after the dialog appears.
    await page.waitForTimeout(300);
    await page.mouse.click(195, 12);
    await expect(sheet).toHaveCount(0);
    await expect(browse).toBeFocused();

    // A view chosen in the sheet closes it and takes focus on its heading, and the address follows.
    await browse.press('Enter');
    await sheet.getByRole('button', { name: /^Favorites(?:\s|$)/ }).click();
    await waitForItems(page);
    await expect(sheet).toHaveCount(0);
    await expect(page.getByRole('heading', { level: 1, name: 'Your favorites', exact: true })).toBeFocused();
    await expect(page).toHaveURL(/#\/favorites$/);

    // A dialog opened from the sheet closes the sheet; when it is done focus goes to the view's heading, not to the page.
    await browse.click();
    await sheet.getByRole('button', { name: 'Settings & connections', exact: true }).click();
    const settings = page.getByRole('dialog', { name: 'Make yourself at home', exact: true });
    await expect(settings).toBeVisible();
    await expect(sheet).toHaveCount(0);
    await closeDialog(settings);
    await expect(page.getByRole('heading', { level: 1, name: 'Your favorites', exact: true })).toBeFocused();

    // The keyboard's shortcuts work on any layout: the palette, and straight to search.
    await page.keyboard.press('Control+k');
    const palette = page.getByRole('dialog', { name: 'Search or jump to anything', exact: true });
    await expect(palette).toBeVisible();
    await page.keyboard.press('Control+k');
    await expect(palette).toHaveCount(0);
    // The dialog leaves the page first and hands focus back a moment later; a key pressed in between would be answered by
    // whatever the page has focused then. A person cannot press that fast, so wait for the hand-back before the next key.
    await expect(page.getByRole('heading', { level: 1, name: 'Your favorites', exact: true })).toBeFocused();
    await page.keyboard.press('/');
    await expect(searchBox(page)).toBeFocused();
    await expect(searchBox(page)).toHaveValue('');
    await page.getByRole('heading', { level: 1, name: 'Your favorites', exact: true }).focus();
    await page.keyboard.press('Control+f');
    await expect(searchBox(page)).toBeFocused();
    await expect(sheet).toHaveCount(0);

    // Resizing to a wide screen swaps the dock for the sidebar; resizing back swaps them again.
    await browse.focus();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await expect(sidebar).toBeVisible();
    await expect(dock).toBeHidden();
    await expect(sidebar.getByRole('button', { name: /^Favorites(?:\s|$)/ })).toHaveAttribute('aria-current', 'page');
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(dock).toBeVisible();
    await expect(sidebar).toBeHidden();
    await expect(saveButton(page)).toBeVisible();
  });

  test('a selection takes the dock\'s place, and clearing it brings the dock back', async ({ page }) => {
    await login(page);
    await importLibrary(page, 8);
    const dock = page.getByRole('navigation', { name: 'Quick actions' });
    await expect(dock).toBeVisible();
    await page.getByRole('button', { name: 'Select', exact: true }).click();
    await cards(page).first().getByRole('checkbox').check();
    const bar = page.getByRole('region', { name: 'Selection' });
    await expect(bar).toContainText('1 selected');
    // The dock steps aside (out of reach of touch and keyboard) while the bulk bar is up.
    await expect(dock).toHaveAttribute('inert', '');
    await bar.getByRole('button', { name: 'Clear selection', exact: true }).click();
    await expect(bar).toHaveCount(0);
    await expect(dock).not.toHaveAttribute('inert');
    await expect(dock.getByRole('button', { name: 'Save a link', exact: true })).toBeEnabled();
  });
});

test('on a wide screen the sidebar is the navigation and keeps the current view marked', async ({ page, browserName }) => {
  test.skip(!isWide(page), 'the sidebar is the wide layout');
  await login(page);
  const nav = await navigation(page);
  await expect(nav.getByRole('button', { name: /^All saves(?:\s|$)/ })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('navigation', { name: 'Quick actions' })).toBeHidden();
  await chooseView(page, 'Favorites', 'Your favorites');
  await expect(nav.getByRole('button', { name: /^Favorites(?:\s|$)/ })).toHaveAttribute('aria-current', 'page');
  await expect(nav.getByRole('button', { name: /^All saves(?:\s|$)/ })).not.toHaveAttribute('aria-current', 'page');
  // On a fresh page the skip link is the first stop, and the palette opens from the top bar as well as from the keyboard.
  await page.reload();
  await waitForItems(page);
  await expect(page.locator('#view-title')).toHaveText('Your favorites');
  // Safari on a Mac moves between controls with Tab but only stops at links with Option+Tab (its default setting).
  await page.keyboard.press(browserName === 'webkit' && process.platform === 'darwin' ? 'Alt+Tab' : 'Tab');
  await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
  await page.getByRole('button', { name: 'Search or jump to anything', exact: true }).click();
  const palette = page.getByRole('dialog', { name: 'Search or jump to anything', exact: true });
  await palette.getByRole('combobox').fill('Archived');
  await palette.getByRole('option', { name: /^Archived/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Archived saves', exact: true })).toBeVisible();
  await expect(page).toHaveURL(/#\/archived$/);
});
