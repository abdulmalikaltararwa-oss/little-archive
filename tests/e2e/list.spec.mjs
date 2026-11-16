import { test, expect, apiAction, cards, cardTitles, closeDialog, createCollection, detailPanel, importJSON, login, pick, saveCount, search, sortBy, uniqueName, waitForItems } from './fixtures.mjs';

// A finger on a row, as the browser reports it: pointer events of type "touch". The moves go to the row itself, the way
// they do while a finger is on it. `dx` is across the screen (positive is to the right), `dy` down it.
async function touchSwipe(row, dx, dy = 0) {
  await row.evaluate((node, [dx, dy]) => {
    const box = node.getBoundingClientRect();
    const x = box.left + box.width / 2;
    const y = box.top + box.height / 2;
    const fire = (type, step) => node.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, pointerId: 11, pointerType: 'touch', isPrimary: true, clientX: x + dx * step, clientY: y + dy * step,
    }));
    fire('pointerdown', 0);
    for (let step = 1; step <= 5; step++) fire('pointermove', step / 5);
    fire('pointerup', 1);
  }, [dx, dy]);
}

const row = (page, title) => cards(page).filter({ hasText: title });
const island = page => page.locator('#toasts');
// The newest message about a delete. An older one may still be on its way out of the page.
const deletedPill = page => island(page).getByRole('status').filter({ hasText: 'Deleted' }).last();

test('the list: a swipe or the row menu marks a save done, files it, and deletes it with a way back', async ({ page, context }) => {
  await login(page);
  const key = uniqueName('rows').split(' ').at(-1);
  const collectionName = `Row shelf ${key}`;
  const collection = await createCollection(page, collectionName);
  const titles = ['Amber', 'Blue', 'Coral'].map(name => `${name} row ${key}`);
  const imported = await importJSON(page, {
    format: 'little-archive', version: 1,
    items: titles.map((title, index) => ({ url: `https://example.com/rows/${key}/${index}`, title })),
  });
  expect(imported.result.created).toBe(3);
  await closeDialog(imported.dialog);
  await search(page, key);
  await sortBy(page, 'title');
  const listed = await (await context.request.get('/api/items', { params: { q: key, sort: 'title' } })).json();
  const [amber, blue, coral] = listed.items;
  expect(listed.items.map(item => item.title)).toEqual(titles);

  // The wall is the default; the list is a choice, kept across a reload.
  const layout = page.getByRole('radiogroup', { name: 'Layout', exact: true });
  await expect(layout.getByRole('radio', { name: 'Wall', exact: true })).toBeChecked();
  await layout.getByRole('radio', { name: 'List', exact: true }).click();
  await expect(page.getByRole('feed', { name: 'Saved items' })).toHaveAttribute('data-layout', 'list');
  await page.reload();
  await waitForItems(page);
  await expect(page.getByRole('feed', { name: 'Saved items' })).toHaveAttribute('data-layout', 'list');
  await expect(cards(page)).toHaveCount(3);
  await expect(cardTitles(page)).toHaveText(titles);

  // At rest the actions under a row cannot be reached, by a pointer or by the keyboard.
  const amberRow = row(page, amber.title);
  for (const name of ['Done', 'File', 'Delete']) {
    expect(await amberRow.getByRole('button', { name, exact: true }).evaluate(node => Boolean(node.closest('[inert]')))).toBe(true);
  }

  // A mouse does not swipe: dragging across a row moves nothing, and the press still opens the save as a click does.
  const box = await amberRow.boundingBox();
  await page.mouse.move(box.x + 200, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 420, box.y + box.height / 2, { steps: 6 });
  await expect(amberRow).not.toHaveAttribute('data-swipe');
  expect(await amberRow.locator('[data-row-slider]').evaluate(node => node.style.transform)).toBe('');
  await page.mouse.up();
  await expect(amberRow).not.toHaveAttribute('data-swipe');
  await expect(detailPanel(page).getByLabel('Title', { exact: true })).toHaveValue(amber.title);
  await closeDialog(detailPanel(page));

  // A finger moving down the page is a scroll, not a swipe.
  await touchSwipe(amberRow, 6, 90);
  await expect(amberRow).not.toHaveAttribute('data-swipe');

  // Towards the end of the line: Done and File. The swipe itself does not open the save.
  await touchSwipe(amberRow, 180);
  await expect(amberRow).toHaveAttribute('data-swipe', 'start');
  await expect(detailPanel(page)).not.toBeVisible();
  await expect(amberRow.getByRole('button', { name: 'File', exact: true })).toBeVisible();
  // Only one row is open at a time.
  const blueRow = row(page, blue.title);
  await touchSwipe(blueRow, 180);
  await expect(blueRow).toHaveAttribute('data-swipe', 'start');
  await expect(amberRow).not.toHaveAttribute('data-swipe');
  await apiAction(page, 'PATCH', `/api/items/${blue.id}`, () => blueRow.getByRole('button', { name: 'Done', exact: true }).click());
  await expect(blueRow).not.toHaveAttribute('data-swipe');
  await expect(blueRow.getByRole('img', { name: 'Done', exact: true })).toBeVisible();
  expect((await (await context.request.get(`/api/items/${blue.id}`)).json()).status).toBe('done');

  // File opens the collection dialog for that one save.
  await touchSwipe(amberRow, 180);
  await amberRow.getByRole('button', { name: 'File', exact: true }).click();
  const fileDialog = page.getByRole('dialog', { name: 'Collect your selection', exact: true });
  await pick(fileDialog, page, 'Collection', collectionName);
  await apiAction(page, 'POST', '/api/items/bulk', () => fileDialog.getByRole('button', { name: 'Update 1 save', exact: true }).click());
  await expect(fileDialog).not.toBeVisible();
  await waitForItems(page);
  expect((await (await context.request.get(`/api/items/${amber.id}`)).json()).collections).toContainEqual(expect.objectContaining({ id: collection.id }));

  // Towards the start of the line: Delete. The row leaves and the count drops, but nothing is sent while Undo is offered.
  const coralRow = row(page, coral.title);
  let deletes = 0;
  page.on('request', request => { if (request.method() === 'DELETE' && new URL(request.url()).pathname.startsWith('/api/items/')) deletes += 1; });
  await touchSwipe(coralRow, -110);
  await expect(coralRow).toHaveAttribute('data-swipe', 'end');
  await coralRow.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(coralRow).toHaveCount(0);
  await expect(saveCount(page)).toHaveText('2 saves');
  await expect(island(page)).toContainText(`Deleted “${coral.title}”`);
  expect((await context.request.get(`/api/items/${coral.id}`)).status()).toBe(200);
  await deletedPill(page).getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(coralRow).toHaveCount(1);
  await expect(saveCount(page)).toHaveText('3 saves');
  expect(deletes).toBe(0);

  // Without the gesture: the row's menu, from the keyboard. Putting the message away gives up the Undo, and the save is deleted.
  await coralRow.getByRole('button', { name: `Actions for ${coral.title}`, exact: true }).focus();
  await page.keyboard.press('Enter');
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('menuitem')).toHaveText(['Mark as done', 'File in a collection…', 'Add to favorites', 'Delete']);
  await menu.getByRole('menuitem', { name: 'Delete', exact: true }).press('Enter');
  await expect(coralRow).toHaveCount(0);
  await expect(saveCount(page)).toHaveText('2 saves');
  await apiAction(page, 'DELETE', `/api/items/${coral.id}`, () => deletedPill(page).getByRole('button', { name: 'Dismiss notification', exact: true }).click());
  await expect.poll(async () => (await context.request.get(`/api/items/${coral.id}`)).status()).toBe(404);
  await expect(saveCount(page)).toHaveText('2 saves');
  await expect(cardTitles(page)).toHaveText([amber.title, blue.title]);
  expect(deletes).toBe(1);

  // Right to left the gesture mirrors: the same move to the right is now towards the start of the line, and shows Delete.
  await page.evaluate(() => { document.documentElement.dir = 'rtl'; });
  await touchSwipe(amberRow, 180);
  await expect(amberRow).toHaveAttribute('data-swipe', 'end');
  await touchSwipe(amberRow, -300);
  await expect(amberRow).toHaveAttribute('data-swipe', 'start');
  await page.evaluate(() => { document.documentElement.dir = 'ltr'; });
});

