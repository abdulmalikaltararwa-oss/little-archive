import { test as base, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export { expect };
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
});

export function uniqueName(prefix = 'Archive') {
  return `${prefix} ${randomUUID().replaceAll('-', '').slice(0, 12)}`;
}

export async function waitForItems(page) {
  await expect(page.locator('.library-title > span')).toHaveText(/^(?:\d[\d,]* of )?\d[\d,]* saves?$/);
  await expect(page.locator('.grid')).toBeVisible();
  await expect(page.locator('.grid')).not.toHaveAttribute('aria-busy', 'true');
  await expect(page.locator('.skeleton')).toHaveCount(0);
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
  await expect(page.getByRole('heading', { name: 'All saves', exact: true })).toBeVisible();
  await waitForItems(page);
  await expect(page.locator('[data-demo="true"]')).toHaveCount(0);
  return auth;
}

export async function openNavigation(page) {
  const button = page.getByRole('button', { name: 'Open navigation', exact: true });
  if (await button.isVisible() && await button.getAttribute('aria-expanded') !== 'true') await button.click();
}

export async function settings(page) {
  await openNavigation(page);
  await page.getByRole('button', { name: 'Settings & connections', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Make yourself at home', exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

export async function closeDialog(dialog) {
  await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await expect(dialog).not.toBeVisible();
}

export async function createCollection(page, name, color = '#c9959c') {
  await openNavigation(page);
  await page.getByRole('button', { name: 'Create a collection', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Make a collection', exact: true });
  await dialog.getByLabel('Name', { exact: true }).fill(name);
  await dialog.getByLabel('Color', { exact: true }).selectOption(color);
  const response = await apiAction(page, 'POST', '/api/collections', () => dialog.getByRole('button', { name: 'Create collection', exact: true }).click());
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('button', { name: `Edit ${name}`, exact: true })).toBeVisible();
  await waitForItems(page);
  return response.json();
}

export async function saveLink(page, { title, url, notes = '', topics = '', collection } = {}) {
  await page.locator('.topbar').getByRole('button', { name: 'Save a link', exact: true }).click();
  const add = page.getByRole('dialog', { name: 'Save a little discovery', exact: true });
  await add.getByLabel('Link', { exact: true }).fill(url);
  await add.getByLabel('Title', { exact: true }).fill(title);
  await add.getByLabel('Your notes', { exact: true }).fill(notes);
  await add.getByLabel('Topics', { exact: true }).fill(topics);
  if (collection) await add.getByLabel(collection, { exact: true }).check();
  const response = await apiAction(page, 'POST', '/api/items', () => add.getByRole('button', { name: 'Save to archive', exact: true }).click());
  const item = await response.json();
  await expect(add).not.toBeVisible();
  const detail = page.getByRole('dialog', { name: 'A closer look', exact: true });
  await expect(detail.getByLabel('Title', { exact: true })).toHaveValue(title);
  return { item, detail };
}

export async function openItem(page, title) {
  await page.getByRole('button', { name: `Open ${title}`, exact: true }).click();
  const detail = page.getByRole('dialog', { name: 'A closer look', exact: true });
  await expect(detail.getByLabel('Title', { exact: true })).toHaveValue(title);
  return detail;
}

export async function search(page, value) {
  const input = page.getByRole('searchbox', { name: 'Search titles, captions, tags, and notes' });
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
  await openNavigation(page);
  await page.locator('.sidebar').getByRole('button', { name: new RegExp(`^${label}(?:\\s|$)`) }).click();
  await expect(page.locator('.library-title h2')).toHaveText(heading);
  await waitForItems(page);
}

export async function chooseSource(page, label, platform) {
  const response = page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.pathname === '/api/items' && (url.searchParams.get('platform') || '') === platform;
  });
  await page.locator('.source-tabs').getByRole('button', { name: new RegExp(`^${label}(?:\\s|$)`) }).click();
  expect((await response).ok()).toBe(true);
  await waitForItems(page);
}

export async function importJSON(page, value, name = 'little-archive-e2e.json') {
  await page.locator('.topbar').getByRole('button', { name: 'Import', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Bring your saves home', exact: true });
  await dialog.getByLabel('Choose an export file').setInputFiles({ name, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(value)) });
  const response = await apiAction(page, 'POST', '/api/imports/file', () => dialog.getByRole('button', { name: 'Import file', exact: true }).click());
  const result = await response.json();
  await expect(dialog.getByRole('heading', { name: 'Your import is ready' })).toBeVisible();
  await expect(dialog.getByText(`${result.created} new · ${result.updated} updated · ${result.skipped} skipped`, { exact: true })).toBeVisible();
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
