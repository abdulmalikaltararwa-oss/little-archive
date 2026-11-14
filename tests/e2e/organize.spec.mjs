import { test, expect, apiAction, closeDialog, createCollection, detailPanel, importJSON, loadedCount, login, pick, saveCount, search, uniqueName } from './fixtures.mjs';

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
  // One page of 60 is loaded; the wall draws only the cards near the screen, so the count comes from the heading and the button.
  await expect(saveCount(page)).toHaveText('205 saves');
  expect(await loadedCount(page)).toBe(60);
  await expect(page.getByRole('button', { name: /^Load more/ })).toContainText('145 remaining');
  await page.getByRole('button', { name: 'Organize library', exact: true }).click();
  const organize = page.getByRole('dialog', { name: 'Organize your library', exact: true });
  await pick(organize, page, 'Organization scope', 'Current view');
  await expect(organize.getByRole('status').filter({ hasText: '205 saves in this scope. Every matching page is included, even if you have not loaded it.' })).toBeVisible();
  await organize.getByLabel('Topic to add', { exact: true }).fill(`categorized-${key}`);
  const tagged = await apiAction(page, 'POST', '/api/items/bulk', () => organize.getByRole('button', { name: 'Add topic to matching saves', exact: true }).click());
  expect(tagged.request().postDataJSON()).toMatchObject({ filters: { q: key }, action: 'tag', value: `categorized-${key}` });
  expect(await tagged.json()).toEqual({ updated: 205 });
  await expect(organize.getByRole('status').filter({ hasText: '205 saves updated.' })).toBeVisible();
  await pick(organize, page, 'Local collection to add', collectionName);
  const collected = await apiAction(page, 'POST', '/api/items/bulk', () => organize.getByRole('button', { name: 'Add matches to collection', exact: true }).click());
  expect(await collected.json()).toEqual({ updated: 205 });
  const matches = await (await context.request.get('/api/items', { params: { q: key, tag: `categorized-${key}`, collection_id: collection.id, limit: 200 } })).json();
  expect(matches.total).toBe(205);
  expect(matches.items).toHaveLength(200);
  await expect(organize.getByRole('button', { name: 'Queue topic suggestions', exact: true })).toBeDisabled();
  await expect(organize.getByText(/Local AI is not configured/)).toBeVisible();
  await organize.getByRole('button', { name: 'Review matching saves', exact: true }).click();
  const detail = detailPanel(page);
  await expect(detail.getByLabel('Title', { exact: true })).toHaveValue(new RegExp(`Library sample ${key}`));
  const firstTitle = await detail.getByLabel('Title', { exact: true }).inputValue();
  const updated = page.waitForResponse(response => response.request().method() === 'PATCH' && /\/api\/items\/[^/]+$/.test(new URL(response.url()).pathname));
  await detail.getByRole('button', { name: 'Mark reviewed & next', exact: true }).click();
  const marked = await (await updated).json();
  expect(marked).toMatchObject({ title: firstTitle, needs_review: false });
  await expect(detailPanel(page).getByLabel('Title', { exact: true })).not.toHaveValue(firstTitle);
  await expect(detailPanel(page).getByLabel('Title', { exact: true })).toHaveValue(new RegExp(`Library sample ${key}`));
  const remaining = await (await context.request.get('/api/items', { params: { q: key, needs_review: true } })).json();
  expect(remaining.total).toBe(204);
});
