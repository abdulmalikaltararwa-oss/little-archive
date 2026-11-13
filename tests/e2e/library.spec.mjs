import { test, expect, apiAction, chooseSource, chooseView, closeDialog, createCollection, login, openItem, saveLink, search, uniqueName, waitForItems } from './fixtures.mjs';

test('links, notes, topics, favorites, progress and collections survive editing and reload', async ({ page, context }) => {
  await login(page);
  const key = uniqueName('garden').split(' ').at(-1);
  const collectionName = `Weekend ideas ${key}`;
  const collection = await createCollection(page, collectionName);
  expect(collection).toMatchObject({ name: collectionName, kind: 'local', color: '#c9959c' });
  const initialTitle = `Weeknight noodles ${key}`;
  const title = `Sesame noodle bowl ${key}`;
  const notes = `Try bookmarkquartz${key} with crisp vegetables. Keep <b>literal notes</b> & a little lemon.`;
  const summary = 'A quick pantry dinner, ready to revisit.';
  const saved = await saveLink(page, {
    title: initialTitle,
    url: `https://example.com/e2e/${key}/noodles?utm_source=test`,
    notes: 'Remember this dinner.', topics: 'food, pantry', collection: collectionName,
  });
  expect(saved.item.url).toBe(`https://example.com/e2e/${key}/noodles`);
  expect(saved.item.platform).toBe('web');
  await apiAction(page, 'PATCH', `/api/items/${saved.item.id}`, () => saved.detail.getByRole('button', { name: 'Add to favorites', exact: true }).click());
  await expect(saved.detail.getByRole('button', { name: 'Remove from favorites', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await saved.detail.getByLabel('Title', { exact: true }).fill(title);
  await saved.detail.getByLabel('Summary', { exact: true }).fill(summary);
  await saved.detail.getByLabel('Your notes', { exact: true }).fill(notes);
  await saved.detail.getByLabel('Topics', { exact: true }).fill('food, weekday cooking, تعلم');
  await saved.detail.getByLabel('Progress', { exact: true }).selectOption('to_revisit');
  await saved.detail.getByLabel('Keep in Needs review', { exact: true }).uncheck();
  await apiAction(page, 'PATCH', `/api/items/${saved.item.id}`, () => saved.detail.getByRole('button', { name: 'Save changes', exact: true }).click());
  await expect(saved.detail.getByLabel('Your notes', { exact: true })).toHaveValue(notes);
  await expect(saved.detail.locator('.detail-title')).toHaveText(title);
  await closeDialog(saved.detail);

  const secondTitle = `Morning ceramics ${key}`;
  const second = await saveLink(page, { title: secondTitle, url: `https://www.instagram.com/p/CI${key}/`, topics: 'craft' });
  expect(second.item.platform).toBe('instagram');
  await closeDialog(second.detail);

  await search(page, `bookmarkquartz${key}`);
  await expect(page.locator('article.card')).toHaveCount(1);
  await expect(page.getByRole('button', { name: `Open ${title}`, exact: true })).toBeVisible();
  await search(page, key);
  await expect(page.locator('article.card')).toHaveCount(2);
  await chooseSource(page, 'Web links', 'web');
  await expect(page.locator('article.card')).toHaveCount(1);
  await expect(page.locator('.card-title')).toHaveText(title);
  await chooseSource(page, 'Instagram', 'instagram');
  await expect(page.locator('.card-title')).toHaveText(secondTitle);
  await chooseSource(page, 'Everything', '');
  const topicResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/items' && new URL(response.url()).searchParams.get('tag') === 'food');
  await page.getByLabel('Filter by topic').selectOption('food');
  expect((await topicResponse).ok()).toBe(true);
  await waitForItems(page);
  await expect(page.locator('.card-title')).toHaveText(title);
  await page.getByLabel('Filter by topic').selectOption('');
  await expect(page.locator('article.card')).toHaveCount(2);
  const sorted = page.waitForResponse(response => new URL(response.url()).pathname === '/api/items' && new URL(response.url()).searchParams.get('sort') === 'title');
  await page.getByLabel('Sort saves').selectOption('title');
  expect((await sorted).ok()).toBe(true);
  await expect(page.locator('.card-title')).toHaveText([secondTitle, title]);

  await chooseView(page, 'Favorites', 'Your favorites');
  await search(page, key);
  await expect(page.locator('.card-title')).toHaveText(title);
  await chooseView(page, 'To revisit', 'A little later');
  await search(page, key);
  await expect(page.locator('.card-title')).toHaveText(title);
  await chooseView(page, 'Needs review', 'Needs a little review');
  await search(page, key);
  await expect(page.locator('.card-title')).toHaveText(secondTitle);
  await page.locator('.sidebar').getByRole('button', { name: new RegExp(`^${collectionName}\\s`) }).click();
  await expect(page.locator('.library-title h2')).toHaveText(collectionName);
  await expect(page.locator('.card-title')).toHaveText(title);

  await page.reload();
  await waitForItems(page);
  const reopened = await openItem(page, title);
  await expect(reopened.getByLabel('Summary', { exact: true })).toHaveValue(summary);
  await expect(reopened.getByLabel('Your notes', { exact: true })).toHaveValue(notes);
  await expect(reopened.getByLabel('Topics', { exact: true })).toHaveValue('food, weekday cooking, تعلم');
  await expect(reopened.getByLabel('Progress', { exact: true })).toHaveValue('to_revisit');
  await expect(reopened.getByLabel(collectionName, { exact: true })).toBeChecked();
  await expect(reopened.getByLabel('Keep in Needs review', { exact: true })).not.toBeChecked();
  await expect(reopened.getByRole('button', { name: 'Remove from favorites', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await closeDialog(reopened);
  const persisted = await (await context.request.get(`/api/items/${saved.item.id}`)).json();
  expect(persisted).toMatchObject({ title, summary, notes, favorite: true, status: 'to_revisit', needs_review: false });
  expect(persisted.tags).toEqual(['food', 'weekday cooking', 'تعلم']);
  expect(persisted.collections).toContainEqual(expect.objectContaining({ id: collection.id, name: collectionName }));

  await page.getByRole('button', { name: `Edit ${collectionName}`, exact: true }).click();
  const edit = page.getByRole('dialog', { name: 'Edit collection', exact: true });
  const renamed = `Dinner plans ${key}`;
  await edit.getByLabel('Name', { exact: true }).fill(renamed);
  await edit.getByLabel('Color', { exact: true }).selectOption('#8ea8b7');
  await apiAction(page, 'PATCH', `/api/collections/${collection.id}`, () => edit.getByRole('button', { name: 'Save changes', exact: true }).click());
  await expect(edit).not.toBeVisible();
  await expect(page.getByRole('button', { name: `Edit ${renamed}`, exact: true })).toBeVisible();
  const afterRename = await openItem(page, title);
  await expect(afterRename.getByLabel(renamed, { exact: true })).toBeChecked();
  await closeDialog(afterRename);
  await page.getByRole('button', { name: `Edit ${renamed}`, exact: true }).click();
  await page.getByRole('dialog', { name: 'Edit collection', exact: true }).getByRole('button', { name: 'Delete', exact: true }).click();
  const confirm = page.getByRole('dialog', { name: 'Delete this collection?', exact: true });
  await apiAction(page, 'DELETE', `/api/collections/${collection.id}`, () => confirm.getByRole('button', { name: 'Delete', exact: true }).click());
  await expect(page.getByRole('button', { name: `Edit ${renamed}`, exact: true })).toHaveCount(0);
  expect((await context.request.get(`/api/items/${saved.item.id}`)).status()).toBe(200);
  await expect(page.getByRole('button', { name: `Open ${title}`, exact: true })).toBeVisible();
});

test('bulk organization, archive, restore and delete update the selected items only', async ({ page, context }) => {
  await login(page);
  const key = uniqueName('bulk').split(' ').at(-1);
  const entries = [];
  for (const name of ['Amber reading list', 'Blue reading list']) {
    const entry = await saveLink(page, { title: `${name} ${key}`, url: `https://example.com/e2e/${key}/${name.replaceAll(' ', '-')}` });
    entries.push(entry.item);
    await closeDialog(entry.detail);
  }
  await search(page, key);
  await expect(page.locator('article.card')).toHaveCount(2);
  const selectBoth = async () => {
    await page.getByRole('button', { name: 'Select', exact: true }).click();
    for (const entry of entries) await page.getByRole('checkbox', { name: `Select ${entry.title}`, exact: true }).check();
    await expect(page.locator('.bulkbar')).toContainText('2 selected');
  };
  const bulk = async action => {
    await selectBoth();
    await page.getByLabel('Bulk action').selectOption(action);
    const response = await apiAction(page, 'POST', '/api/items/bulk', () => page.locator('.bulkbar').getByRole('button', { name: 'Apply', exact: true }).click());
    expect(await response.json()).toEqual({ updated: 2 });
    await waitForItems(page);
  };
  await bulk('favorite');
  for (const entry of entries) await expect(page.locator(`[data-item-id="${entry.id}"]`).getByRole('button', { name: 'Remove from favorites', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await selectBoth();
  await page.getByLabel('Bulk action').selectOption('tag');
  await page.locator('.bulkbar').getByRole('button', { name: 'Apply', exact: true }).click();
  const tagDialog = page.getByRole('dialog', { name: 'Add a topic to your selection', exact: true });
  await tagDialog.getByLabel('Topic', { exact: true }).fill(`reading-${key}`);
  await apiAction(page, 'POST', '/api/items/bulk', () => tagDialog.getByRole('button', { name: 'Update 2 saves', exact: true }).click());
  await expect(tagDialog).not.toBeVisible();
  await waitForItems(page);
  for (const entry of entries) expect((await (await context.request.get(`/api/items/${entry.id}`)).json()).tags).toContain(`reading-${key}`);
  await bulk('archive');
  await expect(page.locator('article.card')).toHaveCount(0);
  await chooseView(page, 'Archived', 'Archived saves');
  await search(page, key);
  await expect(page.locator('article.card')).toHaveCount(2);
  await bulk('restore');
  await expect(page.locator('article.card')).toHaveCount(0);
  await chooseView(page, 'All saves', 'All saves');
  await search(page, key);
  await expect(page.locator('article.card')).toHaveCount(2);
  const detail = await openItem(page, entries[0].title);
  await detail.getByRole('button', { name: 'Delete from this archive', exact: true }).click();
  const confirm = page.getByRole('dialog', { name: 'Delete this saved item?', exact: true });
  await apiAction(page, 'DELETE', `/api/items/${entries[0].id}`, () => confirm.getByRole('button', { name: 'Delete', exact: true }).click());
  await expect(page.locator('.card-title')).toHaveText(entries[1].title);
  expect((await context.request.get(`/api/items/${entries[0].id}`)).status()).toBe(404);
  expect((await context.request.get(`/api/items/${entries[1].id}`)).status()).toBe(200);
});
