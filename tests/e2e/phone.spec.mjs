import { test, expect, apiAction, login, uniqueName, waitForItems } from './fixtures.mjs';

// Installable app and share target. Everything runs against the real server and the real UI;
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

test.describe('installable app', () => {
  test('the manifest, icons and page tags are served for installation and load under the existing policy', async ({ page }) => {
    const violations = [];
    page.on('console', message => { if (/content security policy/i.test(message.text())) violations.push(message.text()); });
    const home = await page.goto('/');
    expect(home.headers()['content-security-policy']).toContain("script-src 'self'");
    await expect(page.getByRole('heading', { name: 'Your archive awaits.' })).toBeVisible();

    const href = await page.locator('link[rel="manifest"]').getAttribute('href');
    const served = await page.request.get(href);
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
    const touchIcon = page.locator('link[rel="apple-touch-icon"]');
    expect(pngSize(await (await page.request.get(await touchIcon.getAttribute('href'))).body())).toBe('180x180');
    await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', manifest.theme_color);

    // The browser's chrome follows the page's own dark token too.
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Your archive awaits.' })).toBeVisible();
    await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#1c231f');
    expect(violations).toEqual([]);
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
    await expect(page.getByRole('dialog', { name: 'A closer look', exact: true })).toBeVisible();
    await expect.poll(() => new URL(page.url()).pathname + new URL(page.url()).search).toBe('/');
    await page.reload();
    await waitForItems(page);
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  test('cancelling a shared link keeps nothing and returns the address to the app', async ({ page }) => {
    await login(page);
    const key = uniqueName('Cancelled').split(' ').at(-1);
    await page.goto(shareAddress({ url: `https://example.com/e2e/${key}/skipped` }));
    const dialog = page.getByRole('dialog', { name: DIALOG, exact: true });
    await expect(dialog.getByLabel('Link', { exact: true })).toHaveValue(`https://example.com/e2e/${key}/skipped`);
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect.poll(() => new URL(page.url()).pathname + new URL(page.url()).search).toBe('/');
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
    // With no usable link the form refuses to submit, so nothing is sent.
    await dialog.getByRole('button', { name: 'Save to archive', exact: true }).click();
    expect(await dialog.getByLabel('Link', { exact: true }).evaluate(field => field.validity.valueMissing)).toBe(true);
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
