import { test, expect, apiAction, cards, detailPanel, login, navigation, saveButton, saveCount, saveTray, searchBox, uniqueName, waitForItems } from './fixtures.mjs';

// Installable app, share target and phone layout. Everything runs against the real server and the real interface;
// no /api response is replaced. Share links are plain GET navigations, exactly what Android's share sheet opens.

const DIALOG = 'Save a little discovery';

function shareAddress(fields) {
  return `/share?${new URLSearchParams(fields)}`;
}

function pngSize(bytes) {
  expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  return `${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}`;
}

// Records every request that could change data. A share link must never produce one on its own.
function watchWrites(page) {
  const writes = [];
  page.on('request', request => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) writes.push(`${request.method()} ${new URL(request.url()).pathname}`);
  });
  return writes;
}

async function itemsMatching(page, key) {
  const response = await page.request.get(`/api/items?${new URLSearchParams({ q: key })}`);
  expect(response.ok()).toBe(true);
  return (await response.json()).items;
}

async function signIn(page) {
  await page.getByLabel('Password', { exact: true }).fill(process.env.LA_E2E_OWNER_PASSWORD);
  await apiAction(page, 'POST', '/api/auth/login', () => page.getByRole('button', { name: 'Open my archive', exact: true }).click());
}

// The page's address without the part the app owns after the save: "/" with nothing after it but the app's own hash.
const pathAndSearch = page => new URL(page.url()).pathname + new URL(page.url()).search;

// A control counts as finger-sized when a 44px cross centred on it still lands on it (or the label around a checkbox).
// Hit-testing includes the invisible areas that CSS adds around small controls. It is done on the finished layout: a
// dialog that has just opened is still on its way in for a frame or two (a sheet rises from the bottom edge, so its
// footer buttons start below the screen), and a slower machine measures it there.
async function undersizedTargets(page, rootSelector) {
  return page.evaluate(async rootSelector => {
    const finite = document.getAnimations().filter(animation => Number.isFinite(animation.effect?.getComputedTiming().endTime));
    await Promise.all(finite.map(animation => animation.finished.catch(() => {})));
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const root = document.querySelector(rootSelector);
    const problems = [];
    const seen = new Set();
    for (const element of root.querySelectorAll('button, a[href], select, textarea, summary, [role="combobox"], [role="radio"], [role="switch"], [role="checkbox"], input:not([type="hidden"]):not([type="file"])')) {
      if (element.closest('[inert], [hidden], [aria-hidden="true"]') || element.classList.contains('sr-only')) continue;
      const control = element.matches('input[type="checkbox"], input[type="radio"]') ? element.closest('label') || element : element;
      if (seen.has(control)) continue;
      seen.add(control);
      const style = getComputedStyle(control);
      // A control that takes no touches (the card checkboxes until Select is tapped) is not a target yet.
      if (style.visibility === 'hidden' || style.display === 'none' || style.pointerEvents === 'none') continue;
      control.scrollIntoView({ block: 'center', inline: 'center' });
      const box = control.getBoundingClientRect();
      if (!box.width || !box.height) continue;
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      const missed = [[0, 0], [-21, 0], [21, 0], [0, -21], [0, 21]].filter(([dx, dy]) => {
        const hit = document.elementFromPoint(x + dx, y + dy);
        // A tap on the label that belongs to a checkbox or a switch is a tap on it.
        const label = hit && hit.closest ? hit.closest('label') : null;
        return !hit || !(hit === control || control.contains(hit) || label === control || (label && label.control === control));
      });
      if (missed.length) problems.push(`${control.tagName.toLowerCase()} "${(control.getAttribute('aria-label') || control.textContent || '').trim().slice(0, 30)}" ${Math.round(box.width)}x${Math.round(box.height)}`);
    }
    return problems;
  }, rootSelector);
}

const noSidewaysScroll = page => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

test.describe('installable app', () => {
  test('the manifest, icons and page tags are served for installation and load under the existing policy', async ({ page }) => {
    const home = await page.goto('/');
    const policy = home.headers()['content-security-policy'];
    expect(policy).toContain("script-src 'self'");
    expect(policy).toMatch(/style-src 'self' 'nonce-[A-Za-z0-9_-]+'(?:;|$)/);
    expect(policy).not.toContain('unsafe-inline');
    await expect(page.getByRole('heading', { name: 'Your archive awaits.' })).toBeVisible();

    const manifestLink = await page.locator('link[rel="manifest"]').getAttribute('href');
    const served = await page.request.get(new URL(manifestLink, page.url()).href);
    expect(served.status()).toBe(200);
    expect(served.headers()['content-type']).toMatch(/^application\/manifest\+json/);
    const manifest = await served.json();
    expect(manifest).toMatchObject({ name: 'Little Archive', display: 'standalone', start_url: '/', scope: '/', share_target: { action: '/share', method: 'GET' } });
    for (const icon of manifest.icons) {
      const response = await page.request.get(icon.src);
      expect(response.status(), icon.src).toBe(200);
      expect(response.headers()['content-type'], icon.src).toBe(icon.type);
      if (icon.type === 'image/png') expect(pngSize(await response.body()), icon.src).toBe(icon.sizes);
    }
    const touchIcon = await page.locator('link[rel="apple-touch-icon"]').getAttribute('href');
    expect(pngSize(await (await page.request.get(new URL(touchIcon, page.url()).href)).body())).toBe('180x180');
    await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', manifest.theme_color);

    // The browser's chrome follows the page's own dark paper too.
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Your archive awaits.' })).toBeVisible();
    await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#1a211d');
  });

  test('Chromium parses the manifest without errors and reports nothing blocking installation', async ({ page, context, browserName }) => {
    test.skip(browserName !== 'chromium', 'The manifest parser and installability report are Chromium DevTools features.');
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Your archive awaits.' })).toBeVisible();
    const session = await context.newCDPSession(page);
    await session.send('Page.enable');
    const parsed = await session.send('Page.getAppManifest');
    expect(parsed.errors).toEqual([]);
    expect(JSON.parse(parsed.data).share_target.params).toEqual({ title: 'title', text: 'text', url: 'url' });
    expect((await session.send('Page.getInstallabilityErrors')).installabilityErrors).toEqual([]);
  });

  test('a shared link opens the save dialog prefilled, saves nothing until Save is tapped, and tidies the address', async ({ page }) => {
    await login(page);
    const writes = watchWrites(page);
    const key = uniqueName('Shared').split(' ').at(-1);
    const title = `Weeknight pasta ${key}`;
    await page.goto(shareAddress({ title, text: `Worth a look! https://example.com/e2e/${key}/pasta?utm_source=share.` }));
    const dialog = page.getByRole('dialog', { name: DIALOG, exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel('Link', { exact: true })).toHaveValue(`https://example.com/e2e/${key}/pasta?utm_source=share`);
    await expect(dialog.getByLabel('Title', { exact: true })).toHaveValue(title);
    await expect(dialog.getByLabel('Your notes', { exact: true })).toHaveValue('Worth a look!');
    await expect(dialog.getByText('Shared with Little Archive.')).toBeVisible();
    await expect(dialog.getByText('Check the link from example.com, then tap Save.')).toBeVisible();
    // Nothing was sent, and nothing exists on the server, until the owner taps Save.
    await page.waitForTimeout(500);
    expect(writes).toEqual([]);
    expect(await itemsMatching(page, key)).toEqual([]);
    expect(new URL(page.url()).pathname).toBe('/share');

    const response = await apiAction(page, 'POST', '/api/items', () => dialog.getByRole('button', { name: 'Save to archive', exact: true }).click());
    const item = await response.json();
    expect(item).toMatchObject({ url: `https://example.com/e2e/${key}/pasta`, title, notes: 'Worth a look!' });
    // The tray says it was kept and names it; the save itself is opened from there.
    await expect(saveTray(page).getByRole('status')).toContainText('Kept in your archive.');
    await expect(saveTray(page).getByRole('status')).toContainText(`${title} · Web`);
    await expect.poll(() => pathAndSearch(page)).toBe('/');
    await saveTray(page).getByRole('button', { name: 'Open it', exact: true }).click();
    await expect(detailPanel(page)).toBeVisible();
    // The address now names the open save, so a reload comes back to it. (The share link itself is gone from the address.)
    await expect(page).toHaveURL(new RegExp(`#/\\?item=${item.id}$`));
    await page.reload();
    await expect(detailPanel(page).getByLabel('Title', { exact: true })).toHaveValue(title);
    await detailPanel(page).getByRole('button', { name: 'Close dialog', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await waitForItems(page);
  });

  test('cancelling a shared link keeps nothing and returns the address to the app', async ({ page }) => {
    await login(page);
    const key = uniqueName('Cancelled').split(' ').at(-1);
    await page.goto(shareAddress({ url: `https://example.com/e2e/${key}/skipped` }));
    const dialog = page.getByRole('dialog', { name: DIALOG, exact: true });
    await expect(dialog.getByLabel('Link', { exact: true })).toHaveValue(`https://example.com/e2e/${key}/skipped`);
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect.poll(() => pathAndSearch(page)).toBe('/');
    expect(await itemsMatching(page, key)).toEqual([]);
  });

  test('signed out, the shared link waits through sign-in instead of being lost', async ({ page }) => {
    const key = uniqueName('Waiting').split(' ').at(-1);
    const writes = watchWrites(page);
    await page.goto(shareAddress({ title: `Saved later ${key}`, text: `See https://example.com/e2e/${key}/later` }));
    await expect(page.getByRole('heading', { name: 'Your archive awaits.' })).toBeVisible();
    await expect(page.getByText('Sign in to review and save the link you shared from example.com. It is waiting for you.')).toBeVisible();
    expect(new URL(page.url()).pathname).toBe('/share');
    await signIn(page);
    const dialog = page.getByRole('dialog', { name: DIALOG, exact: true });
    await expect(dialog.getByLabel('Link', { exact: true })).toHaveValue(`https://example.com/e2e/${key}/later`);
    await expect(dialog.getByLabel('Title', { exact: true })).toHaveValue(`Saved later ${key}`);
    expect(writes).toEqual(['POST /api/auth/login']);
    expect(await itemsMatching(page, key)).toEqual([]);
    await apiAction(page, 'POST', '/api/items', () => dialog.getByRole('button', { name: 'Save to archive', exact: true }).click());
    expect((await itemsMatching(page, key)).map(item => item.url)).toEqual([`https://example.com/e2e/${key}/later`]);
  });

  test('hostile share values stay text: no script runs, no markup appears, and nothing is saved', async ({ page }) => {
    await login(page);
    const writes = watchWrites(page);
    const key = uniqueName('Hostile').split(' ').at(-1);
    const title = `<svg onload="window.__owned=1"> ${key}`;
    const text = '"><img src=x onerror="window.__owned=1"><script>window.__owned=1</script> https://user:secret@evil.example/ data:text/html,<b>x</b>';
    await page.goto(shareAddress({ url: 'javascript:window.__owned=1', title, text }));
    const dialog = page.getByRole('dialog', { name: DIALOG, exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel('Link', { exact: true })).toHaveValue('');
    await expect(dialog.getByText('We could not find a web link in it. Paste the link below.')).toBeVisible();
    // The values are shown exactly as text in fields, never as markup.
    await expect(dialog.getByLabel('Your notes', { exact: true })).toHaveValue(text);
    await expect(dialog.getByLabel('Title', { exact: true })).toHaveValue(title);
    expect(await dialog.locator('form img, form script, form b, form svg[onload]').count()).toBe(0);
    expect(await page.evaluate(() => window.__owned)).toBeUndefined();
    // With no usable link the form says so and sends nothing.
    await dialog.getByRole('button', { name: 'Save to archive', exact: true }).click();
    await expect(dialog.getByRole('alert')).toHaveText('Enter a complete HTTP or HTTPS link.');
    await page.waitForTimeout(300);
    expect(writes).toEqual([]);
    expect(await itemsMatching(page, key)).toEqual([]);
  });

  test('a TikTok short link is explained before saving and refused by the server without creating anything', async ({ page }) => {
    await login(page);
    const key = uniqueName('Short').split(' ').at(-1);
    await page.goto(shareAddress({ text: `A synthetic video ${key} https://vm.tiktok.com/ZMsynthetic/` }));
    const dialog = page.getByRole('dialog', { name: DIALOG, exact: true });
    await expect(dialog.getByLabel('Link', { exact: true })).toHaveValue('https://vm.tiktok.com/ZMsynthetic/');
    await expect(dialog.getByText('This is a TikTok short link, which Little Archive cannot save.')).toBeVisible();
    const refused = page.waitForResponse(response => new URL(response.url()).pathname === '/api/items' && response.request().method() === 'POST');
    await dialog.getByRole('button', { name: 'Save to archive', exact: true }).click();
    expect((await refused).status()).toBe(400);
    await expect(dialog.getByRole('alert')).toContainText('Open the TikTok short link and copy the full post URL');
    expect(await itemsMatching(page, key)).toEqual([]);
  });
});

test.describe('on a phone', () => {
  // Decided before any browser context is created: Playwright rejects isMobile for Firefox.
  test.skip(({ browserName }) => browserName === 'firefox', 'Playwright cannot emulate a mobile device in Firefox.');
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });

  test('the gallery and the save-a-link flow have finger-sized targets, 16px form text and no sideways scroll', async ({ page }) => {
    const auth = await login(page);
    const headers = { 'X-CSRF-Token': auth.csrf_token, Origin: new URL(page.url()).origin };
    const key = uniqueName('Phone').split(' ').at(-1);
    const collection = await page.request.post('/api/collections', { headers, data: { name: `Phone shelf ${key}` } });
    expect(collection.ok()).toBe(true);
    for (const [index, url] of [`https://example.com/e2e/${key}/page`, `https://www.instagram.com/p/PHONE${key}/`].entries()) {
      const created = await page.request.post('/api/items', { headers, data: { url, title: `Phone card ${key} ${index}` } });
      expect(created.ok(), await created.text()).toBe(true);
    }
    await page.reload();
    await waitForItems(page);
    expect(await noSidewaysScroll(page)).toBe(true);
    expect(await undersizedTargets(page, 'main')).toEqual([]);
    // Once Select is tapped the card checkboxes take touches, and they are finger-sized too.
    await page.getByRole('button', { name: 'Select', exact: true }).tap();
    await expect(page.getByRole('button', { name: 'Cancel selection', exact: true })).toBeVisible();
    expect(await undersizedTargets(page, 'main')).toEqual([]);
    await page.getByRole('button', { name: 'Cancel selection', exact: true }).tap();
    // The dock is the phone's navigation and its buttons are finger-sized too.
    expect(await undersizedTargets(page, 'nav[aria-label="Quick actions"]')).toEqual([]);

    await saveButton(page).tap();
    const dialog = page.getByRole('dialog', { name: DIALOG, exact: true });
    await expect(dialog).toBeVisible();
    expect(await undersizedTargets(page, '[role="dialog"]')).toEqual([]);
    expect(await noSidewaysScroll(page)).toBe(true);
    // iOS Safari zooms the page into any text field under 16px. Check every visible text control.
    const smallText = await dialog.locator('input[type="url"], input[type="text"], textarea').evaluateAll(fields => fields.map(field => parseFloat(getComputedStyle(field).fontSize)).filter(size => size < 16));
    expect(smallText).toEqual([]);

    // On a short screen the dialog scrolls, and Save stays in view rather than below the fold.
    await page.setViewportSize({ width: 390, height: 560 });
    const scrolls = await dialog.evaluate(element => [element, ...element.querySelectorAll('*')].some(node => ['auto', 'scroll'].includes(getComputedStyle(node).overflowY) && node.scrollHeight > node.clientHeight));
    expect(scrolls).toBe(true);
    const save = await dialog.getByRole('button', { name: 'Save to archive', exact: true }).boundingBox();
    expect(save.y).toBeGreaterThanOrEqual(0);
    expect(save.y + save.height).toBeLessThanOrEqual(560);
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).tap();
    await page.setViewportSize({ width: 390, height: 844 });

    await page.locator('[data-card-control="open"]').first().tap();
    const detail = detailPanel(page);
    // The dialog opens with a loading line; measure once the save's own controls have rendered.
    await expect(detail.getByRole('button', { name: 'Save changes', exact: true })).toBeVisible();
    expect(await undersizedTargets(page, '[role="dialog"]')).toEqual([]);
    expect(await noSidewaysScroll(page)).toBe(true);
    await detail.getByRole('button', { name: 'Close dialog', exact: true }).tap();
    await expect(detail).toHaveCount(0);

    const sheet = await navigation(page);
    await expect(sheet).toBeVisible();
    expect(await undersizedTargets(page, '[role="dialog"]')).toEqual([]);
    // Touch has no hover, so the way to edit a collection is visible.
    await expect(sheet.getByRole('button', { name: `Edit Phone shelf ${key}`, exact: true })).toBeVisible();
    await sheet.getByRole('button', { name: 'Close dialog', exact: true }).tap();
    // And the "/" key hint, which only a keyboard can use, is not shown.
    await expect(page.locator('kbd').filter({ hasText: '/' })).toBeHidden();
    await expect(searchBox(page)).toBeVisible();
  });

  test('the small select checkbox and favorite heart can be hit anywhere in a 44px area', async ({ page }) => {
    const auth = await login(page);
    const headers = { 'X-CSRF-Token': auth.csrf_token, Origin: new URL(page.url()).origin };
    const key = uniqueName('Targets').split(' ').at(-1);
    const created = await page.request.post('/api/items', { headers, data: { url: `https://example.com/e2e/${key}`, title: `Target card ${key}` } });
    expect(created.ok()).toBe(true);
    await page.reload();
    await waitForItems(page);
    const card = cards(page).filter({ hasText: `Target card ${key}` });
    await expect(card).toHaveCount(1);
    await card.scrollIntoViewIfNeeded();

    // On touch the checkboxes appear once Select is tapped, so a stray tap on a card never selects it.
    await page.getByRole('button', { name: 'Select', exact: true }).tap();
    const checkbox = await card.locator('[data-card-control="select"]').boundingBox();
    expect(checkbox.width).toBeLessThan(24);
    await page.touchscreen.tap(checkbox.x + checkbox.width / 2 - 14, checkbox.y + checkbox.height / 2 - 14);
    await expect(page.getByRole('region', { name: 'Selection' })).toContainText('1 selected');
    await expect(card.locator('[data-card-control="select"]')).toBeChecked();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.getByRole('region', { name: 'Selection' }).getByRole('button', { name: 'Clear selection', exact: true }).tap();

    const heart = await card.locator('[data-card-control="favorite"]').boundingBox();
    expect(heart.width).toBeLessThan(36);
    await apiAction(page, 'PATCH', `/api/items/${(await created.json()).id}`, () => page.touchscreen.tap(heart.x + heart.width / 2, heart.y + heart.height / 2 + 15));
    await expect(card.locator('[data-card-control="favorite"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(saveCount(page)).toHaveText(/saves?$/);
  });
});
