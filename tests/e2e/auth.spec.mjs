import { test, expect, apiAction, login, settings, uniqueName, waitForItems } from './fixtures.mjs';

test('owner sign-in, strict session cookies, CSRF defenses, reload and sign-out use the real server', async ({ page, context, browser, baseURL }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Your archive awaits.' })).toBeVisible();
  expect((await context.request.get('/api/items')).status()).toBe(401);
  expect((await context.request.get('/api/export?format=json')).status()).toBe(401);
  expect((await context.request.get('/api/backup')).status()).toBe(401);
  expect(await (await context.request.get('/api/auth/me')).json()).toMatchObject({ authenticated: false });

  await page.getByLabel('Password', { exact: true }).fill(uniqueName('incorrect password'));
  const rejectedLogin = page.waitForResponse(response => new URL(response.url()).pathname === '/api/auth/login');
  await page.getByRole('button', { name: 'Open my archive', exact: true }).click();
  expect((await rejectedLogin).status()).toBe(401);
  await expect(page.getByRole('alert')).toHaveText('That password did not match.');
  expect((await context.cookies()).some(cookie => cookie.name === 'little_archive_session')).toBe(false);

  await page.getByLabel('Password', { exact: true }).fill(process.env.LA_E2E_OWNER_PASSWORD);
  const signedIn = await apiAction(page, 'POST', '/api/auth/login', () => page.getByRole('button', { name: 'Open my archive', exact: true }).click());
  const auth = await signedIn.json();
  expect(auth.authenticated).toBe(true);
  expect(auth.csrf_token.length).toBeGreaterThanOrEqual(32);
  await waitForItems(page);
  const cookie = (await context.cookies()).find(entry => entry.name === 'little_archive_session');
  expect({ httpOnly: cookie.httpOnly, sameSite: cookie.sameSite, secure: cookie.secure, path: cookie.path }).toEqual({ httpOnly: true, sameSite: 'Strict', secure: false, path: '/' });
  expect(cookie.value.length).toBeGreaterThanOrEqual(32);
  expect(await page.evaluate(() => document.cookie)).not.toContain('little_archive_session');
  expect((await context.request.get('/api/items')).status()).toBe(200);

  const forbiddenName = uniqueName('Rejected collection');
  for (const headers of [
    {},
    { 'X-CSRF-Token': 'not-the-session-token' },
    { 'X-CSRF-Token': auth.csrf_token, Origin: 'https://other-site.invalid' },
    { 'X-CSRF-Token': auth.csrf_token, Origin: baseURL, 'Sec-Fetch-Site': 'cross-site' },
  ]) {
    const rejected = await context.request.post('/api/collections', { data: { name: forbiddenName }, headers });
    expect(rejected.status()).toBe(403);
  }
  const collections = await (await context.request.get('/api/collections')).json();
  expect(collections.collections.some(collection => collection.name === forbiddenName)).toBe(false);
  const accepted = await context.request.post('/api/collections', {
    data: { name: uniqueName('Authorized collection') },
    headers: { 'X-CSRF-Token': auth.csrf_token, Origin: baseURL },
  });
  expect(accepted.status()).toBe(200);

  await page.reload();
  await waitForItems(page);
  await expect(page.getByLabel('Password', { exact: true })).toHaveCount(0);
  const retainedSession = await (await context.request.get('/api/auth/me')).json();
  expect(retainedSession.authenticated).toBe(true);
  expect(retainedSession.csrf_token === auth.csrf_token).toBe(true);
  const preferences = await settings(page);
  await apiAction(page, 'POST', '/api/auth/logout', () => preferences.getByRole('button', { name: 'Sign out', exact: true }).click());
  await expect(page.getByRole('heading', { name: 'Your archive awaits.' })).toBeVisible();
  expect((await context.cookies()).some(entry => entry.name === 'little_archive_session')).toBe(false);
  expect((await context.request.get('/api/items')).status()).toBe(401);

  // A copied old cookie must not remain usable after server-side revocation.
  const replay = await browser.newContext({ baseURL, storageState: { cookies: [cookie], origins: [] } });
  try {
    expect((await replay.request.get('/api/items')).status()).toBe(401);
    expect(await (await replay.request.get('/api/auth/me')).json()).toMatchObject({ authenticated: false });
  } finally { await replay.close(); }

  const newAuth = await login(page);
  const newCookie = (await context.cookies()).find(entry => entry.name === 'little_archive_session');
  expect(newCookie.value !== cookie.value).toBe(true);
  expect(newAuth.csrf_token !== auth.csrf_token).toBe(true);
});

test('a revoked session returns the browser to sign-in without committing an edit', async ({ page, context, baseURL }) => {
  const auth = await login(page);
  const revoked = await context.request.post('/api/auth/logout', { headers: { 'X-CSRF-Token': auth.csrf_token, Origin: baseURL } });
  expect(revoked.status()).toBe(200);
  // The page still has its previous in-memory session state. Exercise a real UI write.
  await page.locator('.topbar').getByRole('button', { name: 'Save a link', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Save a little discovery', exact: true });
  const title = uniqueName('Expired session must not save');
  await dialog.getByLabel('Link', { exact: true }).fill(`https://example.com/${title.replaceAll(' ', '-')}`);
  await dialog.getByLabel('Title', { exact: true }).fill(title);
  const response = page.waitForResponse(response => new URL(response.url()).pathname === '/api/items' && response.request().method() === 'POST');
  await dialog.getByRole('button', { name: 'Save to archive', exact: true }).click();
  expect((await response).status()).toBe(401);
  await expect(page.getByRole('heading', { name: 'Your archive awaits.' })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveText('Your session expired. Sign in to continue.');
  await login(page);
  const items = await (await context.request.get('/api/items', { params: { q: title } })).json();
  expect(items.total).toBe(0);
});
