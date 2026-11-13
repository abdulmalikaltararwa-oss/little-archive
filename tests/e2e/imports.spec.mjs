import { test, expect, chooseSource, closeDialog, download, importJSON, login, openItem, search, settings, uniqueName } from './fixtures.mjs';

test('portable JSON imports, source collections and exports round-trip through the real UI', async ({ page, context }, testInfo) => {
  await login(page);
  const key = uniqueName('portable').split(' ').at(-1);
  const localName = `Creative weekend ${key}`;
  const sourceName = `Original inspiration ${key}`;
  const emptyName = `Empty future ideas ${key}`;
  const unsafeText = `<img src=x onerror=window.__archiveInjected=true> Ceramic study ${key}`;
  const notes = 'Keep <script>literal text</script>, an ampersand &, and العربية.';
  const savedAt = '2025-03-14T12:30:00+00:00';
  const instagramURL = `https://www.instagram.com/p/CI${key}/`;
  const tiktokURL = `https://www.tiktok.com/@synthetic_archive/video/${7_000_000_000_000_000_000n + BigInt(`0x${key}`)}`;
  const archive = {
    format: 'little-archive', version: 1,
    collections: [
      { id: 'local-weekend', name: localName, kind: 'local', color: '#c9959c' },
      { id: 'empty-plans', name: emptyName, kind: 'local', color: '#8ea8b7' },
      { id: 'original-board', name: sourceName, kind: 'source', platform: 'instagram', source_account: `fixture-${key}`, source_key: 'original-board', color: '#c4aa70' },
    ],
    items: [
      {
        url: instagramURL, source_account: `fixture-${key}`, title: unsafeText,
        caption: 'A synthetic palette caption, preserved as source evidence.', creator: 'synthetic_archive',
        summary: 'Original collection and personal organization coexist.', notes,
        tags: ['ceramics', 'تعلم'], favorite: true, status: 'to_revisit', needs_review: false,
        saved_at: savedAt, content_type: 'post', preview_url: 'https://example.invalid/must-never-be-requested.png',
        collections: ['local-weekend', 'original-board'],
      },
      { url: tiktokURL, source_account: `fixture-${key}`, title: `A tiny studio tour ${key}`, caption: 'Synthetic video metadata, with no actual media download.', tags: ['studio'], status: 'inbox', collections: ['local-weekend'], content_type: 'video' },
    ],
  };
  const imported = await importJSON(page, archive);
  expect(imported.result).toMatchObject({ created: 2, updated: 0, skipped: 0, coverage: 'partial', errors: [] });
  await closeDialog(imported.dialog);
  await search(page, key);
  await expect(page.locator('article.card')).toHaveCount(2);
  await chooseSource(page, 'TikTok', 'tiktok');
  await expect(page.locator('.card-title')).toHaveText(`A tiny studio tour ${key}`);
  await chooseSource(page, 'Instagram', 'instagram');
  await expect(page.locator('.card-title')).toHaveText(unsafeText);
  await expect(page.locator('img[src="x"]')).toHaveCount(0);
  expect(await page.evaluate(() => window.__archiveInjected)).toBeUndefined();
  const detail = await openItem(page, unsafeText);
  await expect(detail.getByLabel('Your notes', { exact: true })).toHaveValue(notes);
  await expect(detail.getByRole('heading', { name: 'Original collections', exact: true })).toBeVisible();
  await expect(detail.locator('.tag.source')).toHaveText(sourceName);
  await expect(detail.getByLabel(localName, { exact: true })).toBeChecked();
  await expect(detail.getByLabel('Progress', { exact: true })).toHaveValue('to_revisit');
  await detail.getByText('Source text & evidence', { exact: true }).click();
  await expect(detail.getByText(archive.items[0].caption, { exact: true })).toBeVisible();
  await closeDialog(detail);

  await page.getByRole('button', { name: 'Import activity', exact: true }).click();
  const activity = page.getByRole('dialog', { name: 'A little activity', exact: true });
  await expect(activity.getByRole('button', { name: 'Imports', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const latestImport = activity.locator('.activity-row').filter({ hasText: '2 new · 0 updated · 0 skipped' }).first();
  await expect(latestImport).toContainText('completed');
  await expect(latestImport).toContainText('Coverage: partial');
  await closeDialog(activity);

  const preferences = await settings(page);
  await expect(preferences.getByLabel('Load remote image previews')).not.toBeChecked();
  const exported = await download(page, preferences.getByRole('button', { name: 'JSON', exact: true }), testInfo, 'round-trip-export.json');
  expect(exported.file.suggestedFilename()).toBe('little-archive-export.json');
  const portable = JSON.parse(exported.bytes.toString('utf8'));
  expect(portable).toMatchObject({ format: 'little-archive', version: 1 });
  const restoredItem = portable.items.find(item => item.url === instagramURL && item.source_account === `fixture-${key}`);
  expect(restoredItem).toMatchObject({ title: unsafeText, notes, favorite: true, status: 'to_revisit', needs_review: false, saved_at: savedAt, tags: ['ceramics', 'تعلم'] });
  expect(restoredItem.collections).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: sourceName, kind: 'source', platform: 'instagram', source_account: `fixture-${key}`, source_key: 'original-board' }),
    expect.objectContaining({ name: localName, kind: 'local' }),
  ]));
  expect(portable.collections).toContainEqual(expect.objectContaining({ name: emptyName, kind: 'local', color: '#8ea8b7', count: 0 }));
  expect(exported.bytes.toString('utf8')).not.toContain(process.env.LA_E2E_OWNER_PASSWORD);
  expect(exported.bytes.toString('utf8')).not.toContain('password_hash');
  await closeDialog(preferences);

  // Import the actual downloaded bytes again: identities must update, not duplicate.
  const again = await importJSON(page, portable, 'downloaded-export.json');
  expect(again.result.created).toBe(0);
  expect(again.result.updated).toBe(portable.items.length);
  expect(again.result.skipped).toBe(0);
  await closeDialog(again.dialog);
  const matches = await (await context.request.get('/api/items', { params: { q: key } })).json();
  expect(matches.total).toBe(2);
  const finalItem = matches.items.find(item => item.url === instagramURL);
  expect(finalItem).toMatchObject({ title: unsafeText, notes, favorite: true, status: 'to_revisit' });
  expect(finalItem.collections).toHaveLength(2);
});

test('an invalid JSON file reports a real error and leaves the library unchanged', async ({ page, context }) => {
  await login(page);
  const before = await (await context.request.get('/api/stats')).json();
  await page.locator('.topbar').getByRole('button', { name: 'Import', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Bring your saves home', exact: true });
  await dialog.getByLabel('Choose an export file').setInputFiles({ name: 'invalid.json', mimeType: 'application/json', buffer: Buffer.from('{"items": [this is not JSON]}') });
  const response = page.waitForResponse(response => new URL(response.url()).pathname === '/api/imports/file');
  await dialog.getByRole('button', { name: 'Import file', exact: true }).click();
  expect((await response).status()).toBe(400);
  await expect(dialog.getByRole('alert')).toBeVisible();
  await expect(dialog.getByRole('alert')).not.toBeEmpty();
  await expect(dialog.getByRole('heading', { name: 'Your import is ready' })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Import file', exact: true })).toBeEnabled();
  const after = await (await context.request.get('/api/stats')).json();
  expect(after).toEqual(before);
});
