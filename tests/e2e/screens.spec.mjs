import { test, expect, importJSON, closeDialog, login, navigation, pick, saveButton, saveLink, settings, uniqueName, waitForItems, openItem } from './fixtures.mjs';

// Every screen and dialog of the interface, opened on the real server under its real Content-Security-Policy
// (styles from the page's own files and its nonce only). The suite's fixtures fail a test on any policy violation or
// uncaught error, so this is the check that nothing the interface draws needs an inline style.

test('every screen and dialog opens under the page policy', async ({ page }) => {
  await login(page);
  const key = uniqueName('screens').split(' ').at(-1);
  const imported = await importJSON(page, { format: 'little-archive', version: 1, items: [{ url: `https://example.com/screens/${key}`, title: `A screen test save ${key}`, tags: ['screens'] }] });
  await closeDialog(imported.dialog);

  // The screens that are addresses of their own.
  for (const [hash, heading] of [['#/recipes', /recipe/i], ['#/places', 'Places you kept'], ['#/ask', 'Ask your archive'], ['#/import/guided', 'Bring your whole backlog home.'], ['#/unlock', 'Everything is open.']]) {
    await page.goto(`/${hash}`);
    await expect(page.getByRole('heading', { level: 1, name: heading }).first()).toBeVisible();
    await expect(page.locator('#main')).toBeVisible();
  }
  await page.goto('/');
  await waitForItems(page);

  // The dialogs, each with the controls that add their own styles: the select's menu, the palette's list, the scroll lock.
  await settings(page).then(dialog => closeDialog(dialog));
  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog', { name: 'Search or jump to anything', exact: true });
  await palette.getByRole('combobox').fill('screens');
  await expect(palette.getByRole('option').first()).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(palette).toHaveCount(0);

  await (await navigation(page)).getByRole('button', { name: 'Import activity', exact: true }).click();
  const activity = page.getByRole('dialog', { name: 'A little activity', exact: true });
  await activity.getByRole('radio', { name: 'AI jobs', exact: true }).click();
  await expect(activity.getByRole('status', { name: 'Classification progress' })).toBeVisible();
  await closeDialog(activity);

  await page.getByRole('button', { name: 'Organize library', exact: true }).click();
  const organize = page.getByRole('dialog', { name: 'Organize your library', exact: true });
  await pick(organize, page, 'Organization scope', 'Needs review');
  await closeDialog(organize);

  // The save's panel, with its status select, and the confirmation dialog.
  const detail = await openItem(page, `A screen test save ${key}`);
  await pick(detail, page, 'Progress', 'Done');
  await detail.getByRole('button', { name: 'Delete from this archive', exact: true }).click();
  const question = page.getByRole('alertdialog', { name: 'Delete this saved item?', exact: true });
  await expect(question).toBeVisible();
  await question.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(question).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.getByRole('alertdialog', { name: 'Discard your unsaved changes?', exact: true }).getByRole('button', { name: 'Discard changes', exact: true }).click();
  await expect(detail).toHaveCount(0);

  await saveButton(page).click();
  await expect(page.getByRole('dialog', { name: 'Save a little discovery', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('the dark theme and the settings screen open under the same policy', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await login(page);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  const preferences = await settings(page);
  await preferences.getByRole('radio', { name: 'Light', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await closeDialog(preferences);
  const saved = await saveLink(page, { title: uniqueName('Policy check'), url: `https://example.com/policy/${uniqueName('x').replace(' ', '-')}` });
  await closeDialog(saved.detail);
});
