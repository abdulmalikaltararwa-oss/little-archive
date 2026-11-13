import { test, expect, apiAction, closeDialog, createCollection, importJSON, login, search, uniqueName } from './fixtures.mjs';

test('Organize categorizes every match across gallery pages and moves through review', async ({ page, context }) => {
  await login(page);
  const key = uniqueName('organize').split(' ').at(-1);
  const collectionName = `Whole collection ${key}`;
  const collection = await createCollection(page, collectionName);
  const imported = await importJSON(page, {
    format: 'little-archive', version: 1,
    items: Array.from({ length: 205 }, (_, index) => ({
      url: `https://example.com/whole-library/${key}/${index}`,
      title: `Library sample ${key} number ${index}`,
      tags: [`batch-${key}`], needs_review: true,
    })),
  });
  expect(imported.result.created).toBe(205);
  await closeDialog(imported.dialog);
  await search(page, key);
  await expect(page.locator('article.card')).toHaveCount(60);
  await expect(page.locator('.library-title > span')).toHaveText('205 saves');
  await page.getByRole('button', { name: 'Organize library', exact: true }).click();
  const organize = page.getByRole('dialog', { name: 'Organize your library', exact: true });
  await organize.getByLabel('Organization scope', { exact: true }).selectOption('view');
  await expect(organize.getByText('205 saves in this scope. Every matching page is included, even if you have not loaded it.', { exact: true })).toBeVisible();
  await organize.getByLabel('Topic to add', { exact: true }).fill(`categorized-${key}`);
  const tagged = await apiAction(page, 'POST', '/api/items/bulk', () => organize.getByRole('button', { name: 'Add topic to matching saves', exact: true }).click());
  expect(tagged.request().postDataJSON()).toMatchObject({ filters: { q: key }, action: 'tag', value: `categorized-${key}` });
  expect(await tagged.json()).toEqual({ updated: 205 });
  await expect(organize.getByRole('status').filter({ hasText: '205 saves updated.' })).toBeVisible();
  await organize.getByLabel('Local collection to add', { exact: true }).selectOption(collection.id);
  const collected = await apiAction(page, 'POST', '/api/items/bulk', () => organize.getByRole('button', { name: 'Add matches to collection', exact: true }).click());
  expect(await collected.json()).toEqual({ updated: 205 });
  const matches = await (await context.request.get('/api/items', { params: { q: key, tag: `categorized-${key}`, collection_id: collection.id, limit: 200 } })).json();
  expect(matches.total).toBe(205);
  expect(matches.items).toHaveLength(200);
  await expect(organize.getByRole('button', { name: 'Queue topic suggestions', exact: true })).toBeDisabled();
  await expect(organize.getByText(/Local AI is not configured/)).toBeVisible();
  await organize.getByRole('button', { name: 'Review matching saves', exact: true }).click();
  const detail = page.getByRole('dialog', { name: 'A closer look', exact: true });
  await expect(detail.getByLabel('Title', { exact: true })).toHaveValue(new RegExp(`Library sample ${key}`));
  const firstTitle = await detail.getByLabel('Title', { exact: true }).inputValue();
  const updated = page.waitForResponse(response => response.request().method() === 'PATCH' && /\/api\/items\/[^/]+$/.test(new URL(response.url()).pathname));
  await detail.getByRole('button', { name: 'Mark reviewed & next', exact: true }).click();
  const marked = await (await updated).json();
  expect(marked).toMatchObject({ title: firstTitle, needs_review: false });
  await expect(page.getByRole('dialog', { name: 'A closer look', exact: true }).getByLabel('Title', { exact: true })).not.toHaveValue(firstTitle);
  await expect(page.getByRole('dialog', { name: 'A closer look', exact: true }).getByLabel('Title', { exact: true })).toHaveValue(new RegExp(`Library sample ${key}`));
  const remaining = await (await context.request.get('/api/items', { params: { q: key, needs_review: true } })).json();
  expect(remaining.total).toBe(204);
});
