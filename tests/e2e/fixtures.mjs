import { test as base, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export { expect };

// The interface under test is the React app that the server hands out from ui/dist. Helpers select by role,
// accessible name and label, which is how a person (or a screen reader) finds things; the few test ids and data
// attributes used are the ones the interface exposes on purpose (save-count, data-item-id, data-card-control).

export const test = base.extend({
  // Observe the real application; only unrelated external requests are refused.
  // No /api response is mocked or replaced in this suite.
  networkBoundary: [async ({ context, baseURL }, use) => {
    const unexpected = [];
    const appOrigin = new URL(baseURL).origin;
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (['http:', 'https:'].includes(url.protocol) && url.origin !== appOrigin) {
        unexpected.push(`${route.request().method()} ${url.origin}${url.pathname}`);
        await route.abort('blockedbyclient');
      } else {
        await route.continue();
      }
    });
    await use();
    expect(unexpected, 'The authenticated app must make no external network requests in these tests.').toEqual([]);
  }, { auto: true }],
  browserErrors: [async ({ page }, use) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await use();
    expect(errors, 'No uncaught browser errors should occur.').toEqual([]);
  }, { auto: true }],
  // The server's policy allows styles only from its own files and the page's nonce. Anything the interface does
  // that the policy refuses (an inline style attribute, a <style> element without the nonce) is reported by the
  // browser as a violation, and fails the test that caused it.
  policyViolations: [async ({ page }, use) => {
    const violations = [];
    await page.addInitScript(() => {
      document.addEventListener('securitypolicyviolation', event => {
        console.error(`policy-violation: ${event.violatedDirective} ${event.blockedURI} ${String(event.sample || '').slice(0, 80)}`);
      }, true);
    });
    page.on('console', message => {
      if (/policy-violation:|content[- ]security[- ]policy|refused to (?:apply|load|execute)/i.test(message.text())) violations.push(message.text());
    });
    await use();
    expect(violations, 'The interface must not break the page\'s Content-Security-Policy.').toEqual([]);
  }, { auto: true }],
});

export function uniqueName(prefix = 'Archive') {
  return `${prefix} ${randomUUID().replaceAll('-', '').slice(0, 12)}`;
}

export const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A phone-width page has the dock and sheets; a wide one has the sidebar and the top bar. */
export const isWide = page => (page.viewportSize()?.width ?? 1440) >= 1024;

export const saveCount = page => page.getByTestId('save-count');
export const wall = page => page.getByRole('feed', { name: 'Saved items' });
/** The cards that exist in the page. The wall draws only the saves near the screen, so this is a window, not the whole list. */
export const cards = page => page.locator('article[data-item-id]');
export const cardTitles = page => page.locator('article[data-item-id] h3');
export const searchBox = page => page.getByRole('searchbox', { name: 'Search titles, captions, tags, and notes' });
export const detailPanel = page => page.getByRole('dialog', { name: 'A closer look', exact: true });
/** The tray that answers a save: "Kept in your archive." with places to file it, or "You already kept this." */
export const saveTray = page => page.locator('#save-tray');

export async function waitForItems(page) {
  await expect(saveCount(page)).toHaveText(/^(?:\d[\d,]* of )?\d[\d,]* saves?$/);
  await expect(page.locator('[data-skeleton]')).toHaveCount(0);
  await expect(page.locator('[role="feed"][aria-busy="true"]')).toHaveCount(0);
}

/** How many saves are loaded: the total minus what the "Load more" button says remains. The wall itself shows a window. */
export async function loadedCount(page) {
  // One look at the page, not several: the last page can arrive (and the button go) between two separate reads, and a
  // locator that has just lost its element waits for it to come back.
  const read = async () => {
    const { count, more } = await page.evaluate(() => {
      const button = [...document.querySelectorAll('button')].find(node => /^Load more/.test(node.textContent.trim()));
      return { count: document.querySelector('[data-testid="save-count"]')?.textContent ?? '', more: button ? button.textContent : null };
    });
    const total = Number(count.replace(/^\d[\d,]* of /, '').replace(/\D/g, ''));
    return more === null ? total : total - Number(((more.match(/([\d,]+) remaining/) || [])[1] ?? '').replace(/\D/g, ''));
  };
  // The count and the button are drawn a moment apart when a list arrives, so wait for a reading that holds still.
  let last = await read();
  for (let steady = 0; steady < 3;) {
    await page.waitForTimeout(80);
    const next = await read();
    steady = next === last ? steady + 1 : 0;
    last = next;
  }
  return last;
}

export async function apiAction(page, method, pathname, action) {
  const responsePromise = page.waitForResponse(response => new URL(response.url()).pathname === pathname && response.request().method() === method);
  await action();
  const response = await responsePromise;
  expect(response.ok(), `${method} ${pathname} returned ${response.status()}`).toBe(true);
  return response;
}

export async function login(page) {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Your archive awaits.' })).toBeVisible();
  await page.getByLabel('Password', { exact: true }).fill(process.env.LA_E2E_OWNER_PASSWORD);
  const response = await apiAction(page, 'POST', '/api/auth/login', () => page.getByRole('button', { name: 'Open my archive', exact: true }).click());
  const auth = await response.json();
  expect(auth.authenticated).toBe(true);
  await expect(page.getByRole('heading', { level: 1, name: 'All saves', exact: true })).toBeVisible();
  await waitForItems(page);
  await expect(page.locator('[data-demo="true"]')).toHaveCount(0);
  return auth;
}

/** The place the library's views and collections live: the sidebar on a wide screen, the Browse sheet on a phone. */
export async function navigation(page) {
  if (isWide(page)) return page.getByRole('complementary', { name: 'Library navigation' });
  await page.getByRole('navigation', { name: 'Quick actions' }).getByRole('button', { name: 'Open navigation', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'Browse your archive', exact: true });
  await expect(sheet).toBeVisible();
  return sheet;
}

/** The Save a link button of this layout: in the top bar on a wide screen, in the middle of the dock on a phone. */
export const saveButton = page => isWide(page)
  ? page.getByRole('banner').getByRole('button', { name: 'Save a link', exact: true })
  : page.getByRole('navigation', { name: 'Quick actions' }).getByRole('button', { name: 'Save a link', exact: true });

export const settingsButton = page => isWide(page)
  ? page.getByRole('complementary', { name: 'Library navigation' }).getByRole('button', { name: 'Settings & connections', exact: true })
  : page.getByRole('navigation', { name: 'Quick actions' }).getByRole('button', { name: 'Settings & connections', exact: true });

export async function settings(page) {
  await settingsButton(page).click();
  const dialog = page.getByRole('dialog', { name: 'Make yourself at home', exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

export async function closeDialog(dialog) {
  await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await expect(dialog).not.toBeVisible();
}

const COLORS = { '#94a98b': 'Sage', '#c9959c': 'Blush', '#8ea8b7': 'Sky', '#c4aa70': 'Honey' };

export async function chooseColor(dialog, color) {
  await dialog.getByRole('radiogroup', { name: 'Color', exact: true }).getByText(COLORS[color], { exact: true }).click();
  await expect(dialog.getByRole('radio', { name: COLORS[color], exact: true })).toBeChecked();
}

export const collectionButton = (scope, name) => scope.getByRole('button', { name: new RegExp(`^${escapeRegExp(name)}(?:\\s\\d[\\d,]*)?$`) });

export async function createCollection(page, name, color = '#c9959c') {
  const nav = await navigation(page);
  await nav.getByRole('button', { name: 'Create a collection', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Make a collection', exact: true });
  await dialog.getByLabel('Name', { exact: true }).fill(name);
  await chooseColor(dialog, color);
  const response = await apiAction(page, 'POST', '/api/collections', () => dialog.getByRole('button', { name: 'Create collection', exact: true }).click());
  await expect(dialog).not.toBeVisible();
  await waitForItems(page);
  const collection = await response.json();
  const after = await navigation(page);
  await expect(after.getByRole('button', { name: `Edit ${name}`, exact: true })).toBeVisible();
  await closeNavigation(page, after);
  return collection;
}

/** On a phone the Browse sheet stays open until it is closed; on a wide screen there is nothing to close. */
export async function closeNavigation(page, nav) {
  if (!isWide(page)) await closeDialog(nav);
}

export async function saveLink(page, { title, url, notes = '', topics = '', collection } = {}) {
  await saveButton(page).click();
  const add = page.getByRole('dialog', { name: 'Save a little discovery', exact: true });
  await add.getByLabel('Link', { exact: true }).fill(url);
  await add.getByLabel('Title', { exact: true }).fill(title);
  await add.getByLabel('Your notes', { exact: true }).fill(notes);
  await add.getByLabel('Topics', { exact: true }).fill(topics);
  if (collection) await add.getByLabel(collection, { exact: true }).check();
  const response = await apiAction(page, 'POST', '/api/items', () => add.getByRole('button', { name: 'Save to archive', exact: true }).click());
  const item = await response.json();
  await expect(add).not.toBeVisible();
  // A save is answered by the tray, not by opening it; the save is one tap away there.
  await saveTray(page).getByRole('button', { name: 'Open it', exact: true }).click();
  const detail = detailPanel(page);
  await expect(detail.getByLabel('Title', { exact: true })).toHaveValue(title);
  return { item, detail };
}

export async function openItem(page, title) {
  await page.getByRole('button', { name: `Open ${title}`, exact: true }).click();
  const detail = detailPanel(page);
  await expect(detail.getByLabel('Title', { exact: true })).toHaveValue(title);
  return detail;
}

/** Types into the search box and waits for the server's answer to exactly that search. */
export async function search(page, value) {
  const input = searchBox(page);
  if (await input.inputValue() !== value) {
    const response = page.waitForResponse(response => {
      const url = new URL(response.url());
      return url.pathname === '/api/items' && (url.searchParams.get('q') || '') === value.trim();
    });
    await input.fill(value);
    expect((await response).ok()).toBe(true);
  }
  await waitForItems(page);
}

export async function chooseView(page, label, heading) {
  const nav = await navigation(page);
  await nav.getByRole('button', { name: new RegExp(`^${escapeRegExp(label)}(?:\\s|$)`) }).click();
  await expect(page.getByRole('heading', { level: 1, name: heading, exact: true })).toBeVisible();
  await waitForItems(page);
}

export async function chooseSource(page, label, platform) {
  const response = page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.pathname === '/api/items' && (url.searchParams.get('platform') || '') === platform;
  });
  await page.getByRole('radiogroup', { name: 'Filter by source' }).getByRole('radio', { name: new RegExp(`^${escapeRegExp(label)}(?:\\s|$)`) }).click();
  expect((await response).ok()).toBe(true);
  await waitForItems(page);
}

const SORTS = { recent: 'Recently added', oldest: 'Oldest first', title: 'Title A–Z', random: 'Rediscover' };

export async function sortBy(page, value) {
  const response = page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.pathname === '/api/items' && url.searchParams.get('sort') === value;
  });
  await page.getByRole('combobox', { name: 'Sort saves', exact: true }).click();
  await page.getByRole('option', { name: SORTS[value], exact: true }).click();
  expect((await response).ok()).toBe(true);
  await waitForItems(page);
}

export async function chooseTopic(page, topic) {
  const response = page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.pathname === '/api/items' && (url.searchParams.get('tag') || '') === topic;
  });
  await page.getByRole('combobox', { name: 'Filter by topic', exact: true }).click();
  const list = page.getByRole('listbox');
  await page.getByRole('option', { name: topic ? new RegExp(`^${escapeRegExp(topic)}(?:\\s\\d+)?$`) : 'All topics', exact: !topic }).click();
  await expect(list).toHaveCount(0);
  expect((await response).ok()).toBe(true);
  await waitForItems(page);
}

/** Opens a Progress-style select inside a form and picks a visible option. */
export async function pick(scope, page, label, option) {
  await scope.getByLabel(label, { exact: true }).click();
  await page.getByRole('option', { name: option, exact: true }).click();
}

export async function importJSON(page, value, name = 'little-archive-e2e.json') {
  await page.getByRole('banner').getByRole('button', { name: 'Import', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Bring your saves home', exact: true });
  await dialog.getByLabel('Choose an export file').setInputFiles({ name, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(value)) });
  const response = await apiAction(page, 'POST', '/api/imports/file', () => dialog.getByRole('button', { name: 'Import file', exact: true }).click());
  const result = await response.json();
  await expect(dialog.getByRole('heading', { name: 'Your import is ready' })).toBeVisible();
  await expect(dialog.getByText(`${result.created} new · ${result.updated} updated · ${result.skipped} skipped`, { exact: true })).toBeAttached();
  await expect(dialog.getByText('Coverage is partial. Your existing saves have been preserved.', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Import file', exact: true })).toBeEnabled();
  return { result, dialog };
}

export async function download(page, button, testInfo, filename) {
  const pending = page.waitForEvent('download');
  await button.click();
  const file = await pending;
  expect(await file.failure()).toBeNull();
  const destination = testInfo.outputPath(filename || file.suggestedFilename());
  await file.saveAs(destination);
  const bytes = await readFile(destination);
  expect(bytes.length).toBeGreaterThan(0);
  return { file, destination, bytes };
}

/** Scrolls until `locator` exists in the page (the wall draws only the cards near the screen). */
export async function scrollTo(page, locator, { step = 700, limit = 80 } = {}) {
  for (let attempt = 0; attempt < limit; attempt++) {
    if (await locator.count()) break;
    await page.mouse.wheel(0, step);
    await page.waitForTimeout(40);
  }
  await expect(locator).toHaveCount(1);
  await locator.scrollIntoViewIfNeeded();
}
