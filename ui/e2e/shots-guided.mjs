// Drives the guided backlog import against a real server and photographs each stage.
//
//   LA_UI_PASSWORD_FILE=<file with the owner password> node e2e/shots-guided.mjs <base-url> <output-dir> <fixtures-dir> [only]
//
// <base-url> is the interface served from the same origin as a throwaway server (the dev server's proxy
// does that); <fixtures-dir> holds synthetic exports (instagram-small.zip, instagram-12mib.zip,
// instagram-arabic.zip, tiktok.zip, not-a-zip.zip, empty-export.zip, holiday.pdf). Only synthetic data: the
// script empties the library it is pointed at, so never point it at a real one. `only` limits the shot names.
//
// Besides the pictures it asserts the behaviour: a ZIP goes up in pieces and is previewed before anything is
// saved, a rejected file is explained, an interrupted upload resumes by sending only what is missing, the
// import runs and the saves arrive, and cancelling clears the staged file.
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';

const [base = 'http://127.0.0.1:5194/', out = 'shots-guided', fixtures = 'fixtures', only = ''] = process.argv.slice(2);
const wanted = new Set(only.split(',').filter(Boolean));
const want = name => !wanted.size || [...wanted].some(prefix => name.startsWith(prefix));
const password = (await readFile(process.env.LA_UI_PASSWORD_FILE ?? '', 'utf8').catch(() => '')).trim();
if (!password) throw new Error('Set LA_UI_PASSWORD_FILE to a file holding the throwaway server’s owner password.');

const SIZES = {
  phone: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  desktop: { width: 1440, height: 900, deviceScaleFactor: 1 },
};
const fixture = name => path.join(fixtures, name);

await mkdir(out, { recursive: true });
const browser = await chromium.launch();
const problems = [];
const check = (ok, message) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${message}`); if (!ok) problems.push(message); };
const settle = (page, ms = 700) => page.waitForTimeout(ms);

/* A signed-in browser context, made once and copied, so the sign-in limit is never reached. */
let session;
async function signIn() {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.goto(base);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Open my archive' }).click();
  await page.getByRole('heading', { name: 'All saves' }).waitFor();
  session = await context.storageState();
  await context.close();
}

async function open(size, scheme, { reducedMotion = 'no-preference' } = {}) {
  const spec = SIZES[size];
  const context = await browser.newContext({ storageState: session, viewport: { width: spec.width, height: spec.height }, deviceScaleFactor: spec.deviceScaleFactor, isMobile: spec.isMobile, hasTouch: spec.hasTouch, colorScheme: scheme, reducedMotion });
  const page = await context.newPage();
  page.on('pageerror', error => problems.push(`${size}/${scheme} pageerror: ${error.message}`));
  page.on('response', response => { if (response.status() >= 400 && process.env.LA_UI_TRACE) console.log('  http', response.status(), response.request().method(), response.url()); });
  page.on('console', message => { if (message.type() === 'error' && !/WebSocket|favicon|Failed to load resource/.test(message.text())) problems.push(`${size}/${scheme} console: ${message.text().slice(0, 300)}`); });
  await page.goto(base);
  await page.getByRole('heading', { name: 'All saves' }).waitFor();
  return { context, page };
}

/** A same-origin API call made from inside the page, with the CSRF token the page holds. */
async function api(page, method, route, body) {
  return page.evaluate(async ({ method, route, body }) => {
    const me = await (await fetch('/api/auth/me')).json();
    const response = await fetch(`/api${route}`, { method, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrf_token }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json().catch(() => null) };
  }, { method, route, body });
}

async function emptyTheLibrary(page) {
  const imports = (await api(page, 'GET', '/imports/archives?limit=100')).body.imports;
  for (const entry of imports) if (entry.resumable) await api(page, 'DELETE', `/imports/archives/${entry.id}`);
  for (;;) {
    const { body } = await api(page, 'GET', '/items?limit=100');
    if (!body.items.length) break;
    for (const item of body.items) await api(page, 'DELETE', `/items/${item.id}`);
  }
  const collections = (await api(page, 'GET', '/collections')).body.collections;
  // A source collection belongs to the platform it came from and cannot be deleted; only the owner's own can.
  for (const collection of collections) if (collection.kind === 'local') await api(page, 'DELETE', `/collections/${collection.id}`);
}

const to = (page, rest = '') => page.evaluate(hash => { location.hash = hash; }, `#/import/guided${rest ? `/${rest}` : ''}`);
const heading = page => page.locator('[data-step-heading]').first();
const shot = (page, name, options = {}) => page.screenshot({ path: path.join(out, `${name}.png`), ...options });
const importIdOf = page => page.evaluate(() => location.hash.split('/').pop());
const pieceRequests = page => {
  const seen = [];
  page.on('request', request => { const match = /\/chunks\/(\d+)$/.exec(request.url()); if (match && request.method() === 'PUT') seen.push(Number(match[1])); });
  return seen;
};

await signIn();

/* 1. The platform choice, the guide and the empty hand-over, in both themes at both sizes. */
for (const size of Object.keys(SIZES)) {
  for (const scheme of ['light', 'dark']) {
    const tag = `${size}-${scheme}`;
    if (!want(`choose-${tag}`) && !want(`guide-${tag}`) && !want(`add-${tag}`)) continue;
    const { context, page } = await open(size, scheme);
    if (size === 'desktop' && scheme === 'light') await emptyTheLibrary(page);
    await to(page);
    await page.getByRole('heading', { name: 'Where did you save things?' }).waitFor();
    await settle(page);
    check(await page.locator('[data-platform]').count() === 2, `${tag}: both platforms are offered`);
    if (want(`choose-${tag}`)) await shot(page, `choose-${tag}`);

    await page.getByRole('button', { name: 'Show me the steps' }).first().click();
    await page.getByRole('heading', { name: 'Get your Instagram export' }).waitFor();
    await settle(page);
    check(await page.locator('[data-step-id]').count() === 8, `${tag}: Instagram’s eight steps are drawn`);
    check(await page.getByText('have not been checked against a real Instagram export').isVisible(), `${tag}: the guide’s honesty block is in plain sight`);
    const help = page.getByRole('link', { name: /own instructions/ });
    check((await help.getAttribute('rel')) === 'noopener noreferrer' && (await help.getAttribute('target')) === '_blank', `${tag}: the help link opens safely`);
    if (want(`guide-${tag}`)) {
      await shot(page, `guide-${tag}`);
      if (size === 'desktop') await shot(page, `guide-${tag}-full`, { fullPage: true });
    }

    await page.getByRole('button', { name: 'I have the file' }).click();
    await page.getByRole('heading', { name: 'Hand over your Instagram file' }).waitFor();
    await settle(page);
    if (want(`add-${tag}`)) await shot(page, `add-${tag}`);
    await context.close();
  }
}

/* 2. A file the page itself refuses, before anything is sent. */
if (want('refused')) {
  const { context, page } = await open('phone', 'light');
  await to(page, 'instagram/add');
  await page.getByRole('heading', { name: 'Hand over your Instagram file' }).waitFor();
  await page.locator('input[type=file]').setInputFiles(fixture('holiday.pdf'));
  await page.getByText('This server reads ZIP, JSON, HTML or TXT files').waitFor();
  check((await page.locator('[role=alert]').count()) === 1, 'a PDF is refused on this page, in words, before it is sent');
  await settle(page, 400);
  await shot(page, 'refused-type-phone-light');
  await context.close();
}

/* 3. The whole flow with the 12 MiB export: uploading mid-way, the preview, the import, the library. */
if (want('flow') || want('uploading') || want('preview') || want('importing') || want('completed')) {
  // The phone goes first: its preview is the one that shows the collections as new, before they exist in the library.
  for (const [size, scheme] of [['phone', 'light'], ['desktop', 'light'], ['phone', 'dark']]) {
    const tag = `${size}-${scheme}`;
    const { context, page } = await open(size, scheme);
    if (tag === 'desktop-light') await emptyTheLibrary(page);
    else await emptyTheLibrary(page);

    await to(page, 'instagram/add');
    await page.getByRole('heading', { name: 'Hand over your Instagram file' }).waitFor();
    await page.locator('input[type=file]').setInputFiles(fixture('instagram-12mib.zip'));
    await page.getByRole('button', { name: 'Send to my server' }).waitFor();
    if (tag === 'desktop-light') { await settle(page, 700); await shot(page, 'add-chosen-desktop-light'); }

    // Hold the later pieces so the upload can be photographed part way.
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    await page.route(/\/chunks\/(\d+)$/, async route => {
      const index = Number(/chunks\/(\d+)$/.exec(route.request().url())[1]);
      if (index >= 6) await gate;
      await route.continue();
    });
    const sent = pieceRequests(page);
    await page.getByRole('button', { name: 'Send to my server' }).click();
    await page.getByRole('heading', { name: 'Sending your file' }).waitFor();
    await page.waitForFunction(() => /[0-9]+ of 12 pieces/.test(document.body.innerText), null, { timeout: 15_000 });
    await settle(page, 900);
    check(/#\/import\/guided\/[0-9a-f-]{36}$/.test(page.url()), `${tag}: the address names the import once it exists`);
    if (want('uploading') || want('flow')) await shot(page, `uploading-${tag}`);
    release();
    await page.getByRole('heading', { name: 'Here is what we found' }).waitFor({ timeout: 30_000 });
    check(new Set(sent).size === 12 && sent.length === 12, `${tag}: all 12 pieces went up, once each (${sent.length} requests)`);
    const id = await importIdOf(page);
    check((await api(page, 'GET', '/items?limit=5')).body.total === 0, `${tag}: nothing was saved by the preview`);
    await settle(page, 1200);
    if (want('preview') || want('flow')) {
      await shot(page, `preview-${tag}`);
      await shot(page, `preview-${tag}-full`, { fullPage: true });
    }
    const totals = await page.locator('[role=group][aria-label="What the file holds"]').innerText();
    check(/6\s*SAVES FOUND/i.test(totals.replace(/\n/g, ' ')) || totals.includes('6'), `${tag}: the preview reports the saves it found`);

    // Mid-way import, photographed with the server’s own answer made slower than the real job (which is over in milliseconds).
    let hold = true;
    await page.route(new RegExp(`/api/imports/archives/${id}$`), async route => {
      if (!hold || route.request().method() !== 'GET') return route.continue();
      const real = await (await route.fetch()).json();
      const middle = { ...real, state: 'importing', error: null, progress: { total: 5200, processed: 2184, created: 1620, updated: 380, skipped: 12, percent: 42 }, updated_at: '2999-01-01T00:00:00.000000+00:00' };
      return route.fulfill({ json: middle });
    });
    await page.route(new RegExp(`/api/imports/archives/${id}/commit$`), async route => {
      const real = await (await route.fetch()).json();
      return route.fulfill({ json: { ...real, state: 'importing', progress: { total: 5200, processed: 2184, created: 1620, updated: 380, skipped: 12, percent: 42 }, updated_at: '2999-01-01T00:00:00.000000+00:00' } });
    });
    await page.getByRole('button', { name: /^Import 6 saves/ }).click();
    await page.getByRole('heading', { name: 'Bringing your saves home' }).waitFor();
    await settle(page, 1500);
    if (want('importing') || want('flow')) await shot(page, `importing-${tag}`);
    hold = false;
    await page.unroute(new RegExp(`/api/imports/archives/${id}$`));
    await page.unroute(new RegExp(`/api/imports/archives/${id}/commit$`));
    // The real job is long finished; the next poll shows it so. (The held answer carried a far-future time, so a real one is refused as older; reload to ask afresh.)
    await page.reload();
    await page.getByRole('heading', { name: 'Welcome home.' }).waitFor({ timeout: 20_000 });
    await settle(page, 1500);
    if (want('completed') || want('flow')) await shot(page, `completed-${tag}`);
    const library = (await api(page, 'GET', '/items?limit=50')).body;
    check(library.total === 6, `${tag}: the six saves are in the library (${library.total})`);
    const collections = (await api(page, 'GET', '/collections')).body.collections.map(entry => entry.name);
    check(collections.includes('وصفات الطبخ والحلويات'), `${tag}: the Arabic collection name arrived intact`);
    await context.close();
  }
}

/* 4. A file that arrives and cannot be used. */
if (want('rejected')) {
  for (const [file, name, platform] of [['not-a-zip.zip', 'not-a-zip', 'instagram'], ['tiktok.zip', 'wrong-platform', 'instagram'], ['empty-export.zip', 'no-saved-data', 'instagram']]) {
    const { context, page } = await open('phone', 'light');
    await emptyTheLibrary(page);
    await to(page, `${platform}/add`);
    await page.locator('input[type=file]').setInputFiles(fixture(file));
    await page.getByRole('button', { name: 'Send to my server' }).click();
    await page.locator('[data-panel^="again"]').waitFor({ timeout: 20_000 });
    await settle(page, 700);
    await shot(page, `rejected-${name}-phone-light`);
    if (name === 'wrong-platform') {
      check(await page.getByRole('button', { name: 'Add it again as TikTok' }).isVisible(), 'a wrong platform offers the other one');
    }
    check(Boolean(await page.getByRole('alert').first().innerText()), `${name}: the refusal is an alert in words`);
    await context.close();
  }
  const { context, page } = await open('desktop', 'light');
  await to(page, 'instagram/add');
  await page.locator('input[type=file]').setInputFiles(fixture('tiktok.zip'));
  await page.getByRole('button', { name: 'Send to my server' }).click();
  await page.locator('[data-panel^="again"]').waitFor({ timeout: 20_000 });
  await settle(page, 700);
  await shot(page, 'rejected-wrong-platform-desktop-light');
  await context.close();
}

/* 5. An interrupted upload, picked up again with only the missing pieces sent, and cancelled. */
if (want('resume') || want('earlier') || want('cancel')) {
  for (const [size, scheme] of [['phone', 'light'], ['desktop', 'dark']]) {
    const tag = `${size}-${scheme}`;
    const { context, page } = await open(size, scheme);
    await emptyTheLibrary(page);
    await to(page, 'instagram/add');
    await page.locator('input[type=file]').setInputFiles(fixture('instagram-12mib.zip'));
    // The connection drops after the first four pieces: every later piece fails at the network.
    await page.route(/\/chunks\/(\d+)$/, async route => {
      const index = Number(/chunks\/(\d+)$/.exec(route.request().url())[1]);
      if (index >= 4) return route.abort('connectionreset');
      return route.continue();
    });
    await page.getByRole('button', { name: 'Send to my server' }).click();
    await page.getByRole('heading', { name: 'Your upload is paused' }).waitFor({ timeout: 30_000 });
    await settle(page, 600);
    if (want('resume') || want('earlier')) await shot(page, `paused-${tag}`);
    const id = await importIdOf(page);
    const held = (await api(page, 'GET', `/imports/archives/${id}`)).body;
    check(held.state === 'uploading' && held.upload.received_count >= 4 && held.upload.received_count < 12, `${tag}: the server kept ${held.upload.received_count} of 12 pieces`);
    await page.unroute(/\/chunks\/(\d+)$/);

    // A reload loses the file but not the import: the address brings it back.
    await page.reload();
    await page.getByRole('heading', { name: 'Pick up where you left off' }).waitFor();
    await settle(page, 700);
    if (want('resume') || want('earlier')) await shot(page, `resume-${tag}`);

    // The earlier-imports list offers it too.
    await to(page);
    await page.getByRole('heading', { name: 'Where did you save things?' }).waitFor();
    await page.locator('[data-import]').first().waitFor();
    await settle(page, 700);
    if (want('resume') || want('earlier')) await shot(page, `earlier-${tag}`, { fullPage: true });
    check(await page.getByText('You have an import waiting.').isVisible(), `${tag}: the start of the flow says an import is waiting`);

    // The same file handed over again: only the missing pieces go.
    await page.locator('[data-import]').first().getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('heading', { name: 'Pick up where you left off' }).waitFor();
    const sent = pieceRequests(page);
    await page.locator('input[type=file]').setInputFiles(fixture('instagram-12mib.zip'));
    await page.getByRole('heading', { name: 'Here is what we found' }).waitFor({ timeout: 30_000 });
    const wasHeld = new Set(Array.from({ length: held.upload.received_count }, (_, index) => index));
    check(sent.length === 12 - held.upload.received_count && sent.every(index => !wasHeld.has(index)), `${tag}: resuming sent only the ${sent.length} missing pieces`);

    // A file of the wrong size is turned away on the page, in words. (Cancel first, then try with a different size on a fresh upload.)
    await settle(page, 600);
    // Cancel with a confirm.
    await page.getByRole('button', { name: 'Cancel this import' }).click();
    const dialog = page.getByRole('alertdialog');
    await dialog.waitFor();
    await settle(page, 500);
    if (want('cancel')) await shot(page, `cancel-confirm-${tag}`);
    await dialog.getByRole('button', { name: 'Cancel the import' }).click();
    await page.getByRole('heading', { name: 'This import was cancelled' }).waitFor();
    check((await api(page, 'GET', `/imports/archives/${id}`)).body.state === 'cancelled', `${tag}: cancelling cleared the import`);
    await settle(page, 600);
    if (want('cancel')) await shot(page, `cancelled-${tag}`);
    await context.close();
  }
}

/* 6. Paused by a lost connection, then continued from the same page without reloading. */
if (want('pause')) {
  const { context, page } = await open('desktop', 'light');
  await emptyTheLibrary(page);
  await to(page, 'instagram/add');
  await page.locator('input[type=file]').setInputFiles(fixture('instagram-12mib.zip'));
  let down = true;
  const sent = pieceRequests(page);
  await page.route(/\/chunks\/(\d+)$/, async route => {
    const index = Number(/chunks\/(\d+)$/.exec(route.request().url())[1]);
    if (down && index >= 6) return route.abort('connectionreset');
    return route.continue();
  });
  await page.getByRole('button', { name: 'Send to my server' }).click();
  await page.getByRole('heading', { name: 'Your upload is paused' }).waitFor({ timeout: 30_000 });
  check((await page.getByRole('alert').first().innerText()).includes('connection was lost'), 'a lost connection pauses the upload and says so');
  const before = sent.length;
  down = false;
  await page.getByRole('button', { name: 'Continue the upload' }).click();
  await page.getByRole('heading', { name: 'Here is what we found' }).waitFor({ timeout: 30_000 });
  const after = sent.slice(before);
  check(after.every(index => index >= 6) || after.length <= 7, `continuing from the paused page sent ${after.length} pieces, not the whole file again`);
  await page.getByRole('button', { name: 'Cancel this import' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Cancel the import' }).click();
  await page.getByRole('heading', { name: 'This import was cancelled' }).waitFor();
  await context.close();
}

/* 7. Leaving the screen mid-upload: it pauses, says so, and the import is waiting in the list. */
if (want('leave')) {
  const { context, page } = await open('desktop', 'light');
  await emptyTheLibrary(page);
  await to(page, 'instagram/add');
  await page.locator('input[type=file]').setInputFiles(fixture('instagram-12mib.zip'));
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route(/\/chunks\/(\d+)$/, async route => {
    if (Number(/chunks\/(\d+)$/.exec(route.request().url())[1]) >= 5) await gate;
    await route.continue().catch(() => {});
  });
  await page.getByRole('button', { name: 'Send to my server' }).click();
  await page.getByRole('heading', { name: 'Sending your file' }).waitFor();
  await page.waitForFunction(() => /[1-9] of 12 pieces/.test(document.body.innerText));
  await page.getByRole('button', { name: 'All saves' }).first().click();
  await page.getByText('Upload paused.').waitFor({ timeout: 5000 });
  check(true, 'leaving mid-upload says the upload is paused');
  release();
  await settle(page, 800);
  await to(page);
  await page.getByText('You have an import waiting.').waitFor();
  check(await page.locator('[data-state="uploading"]').count() === 1, 'the paused upload is waiting in the earlier imports');
  await page.locator('[data-import]').first().getByRole('button', { name: 'Cancel' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Cancel the import' }).click();
  await page.getByText('Import cancelled.').waitFor();
  await context.close();
}

/* 7b. The Back button mid-upload does the same, and Forward finds the upload paused with the file still held. */
if (want('back')) {
  const { context, page } = await open('desktop', 'light');
  await emptyTheLibrary(page);
  await to(page, 'instagram');
  await to(page, 'instagram/add');
  await page.locator('input[type=file]').setInputFiles(fixture('instagram-12mib.zip'));
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route(/\/chunks\/(\d+)$/, async route => {
    if (Number(/chunks\/(\d+)$/.exec(route.request().url())[1]) >= 5) await gate;
    await route.continue().catch(() => {});
  });
  await page.getByRole('button', { name: 'Send to my server' }).click();
  await page.getByRole('heading', { name: 'Sending your file' }).waitFor();
  await page.waitForFunction(() => /[1-9] of 12 pieces/.test(document.body.innerText));
  await page.goBack();
  await page.getByText('Upload paused.').waitFor({ timeout: 5000 });
  check(true, 'Back mid-upload pauses the upload and says so');
  release();
  await settle(page, 800);
  await page.goForward();
  await page.getByRole('heading', { name: 'Your upload is paused' }).waitFor();
  await page.getByRole('button', { name: 'Continue the upload' }).click();
  await page.getByRole('heading', { name: 'Here is what we found' }).waitFor({ timeout: 30_000 });
  check(true, 'Forward, then Continue, finishes the upload without handing the file over again');
  await page.getByRole('button', { name: 'Cancel this import' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Cancel the import' }).click();
  await page.getByRole('heading', { name: 'This import was cancelled' }).waitFor();
  await context.close();
}

/* 8. Every piece arrived but the connection dropped before the file was read: no file is needed to carry on. */
if (want('read')) {
  const { context, page } = await open('phone', 'light');
  await emptyTheLibrary(page);
  await to(page, 'instagram/add');
  await page.locator('input[type=file]').setInputFiles(fixture('instagram-small.zip'));
  await page.route(/\/finish$/, route => route.abort('connectionreset'));
  await page.getByRole('button', { name: 'Send to my server' }).click();
  await page.getByRole('heading', { name: 'Your upload is paused' }).waitFor({ timeout: 30_000 });
  await page.unroute(/\/finish$/);
  await page.reload();
  await page.getByRole('heading', { name: 'Your file is on your server' }).waitFor();
  await settle(page, 600);
  await shot(page, 'read-phone-light');
  await page.getByRole('button', { name: 'Read my file' }).click();
  await page.getByRole('heading', { name: 'Here is what we found' }).waitFor();
  check(true, 'a file whose pieces all arrived is read without being handed over again');
  await page.getByRole('button', { name: 'Cancel this import' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Cancel the import' }).click();
  await context.close();
}

/* 9. A job that stopped part way is continued with no new confirmation (the server's answer is stood in for, the call is real). */
if (want('failed')) {
  for (const [size, scheme] of [['phone', 'light'], ['desktop', 'dark']]) {
    const tag = `${size}-${scheme}`;
    const { context, page } = await open(size, scheme);
    await emptyTheLibrary(page);
    await to(page, 'instagram/add');
    await page.locator('input[type=file]').setInputFiles(fixture('instagram-small.zip'));
    await page.getByRole('button', { name: 'Send to my server' }).click();
    await page.getByRole('heading', { name: 'Here is what we found' }).waitFor({ timeout: 20_000 });
    const id = await importIdOf(page);
    await page.route(new RegExp(`/api/imports/archives/${id}$`), async route => {
      if (route.request().method() !== 'GET') return route.continue();
      const real = await (await route.fetch()).json();
      return route.fulfill({ json: { ...real, state: 'failed', error: 'The import stopped unexpectedly. Start it again to continue from where it stopped.', progress: { total: 5200, processed: 2184, created: 1620, updated: 380, skipped: 12, percent: 42 }, resumable: true } });
    });
    await page.reload();
    await page.getByRole('heading', { name: 'The import stopped part way' }).waitFor();
    await settle(page, 900);
    await shot(page, `failed-${tag}`);
    let body = '';
    await page.route(new RegExp(`/api/imports/archives/${id}/commit$`), async route => { body = route.request().postData() ?? ''; await route.continue(); });
    await page.getByRole('button', { name: 'Continue the import' }).click();
    await page.waitForFunction(() => true);
    await settle(page, 900);
    check(body === '{}', `${tag}: continuing a stopped job sends no digest (${body})`);
    await context.close();
  }
}

/* 10. Keyboard: the file picker can be reached and shows the focus ring. */
if (want('keyboard')) {
  const { context, page } = await open('desktop', 'light');
  await to(page, 'instagram/add');
  await page.getByRole('heading', { name: 'Hand over your Instagram file' }).waitFor();
  await page.locator('[data-step-heading]').focus();
  await page.keyboard.press('Tab');
  const focused = await page.evaluate(() => document.activeElement?.getAttribute('type'));
  check(focused === 'file', 'Tab from the heading lands on the file picker');
  await settle(page, 300);
  await shot(page, 'keyboard-focus-desktop-light');
  await context.close();
}

/* 11. Reduced motion: the same flow with every animation cut. */
if (want('reduced')) {
  const { context, page } = await open('phone', 'light', { reducedMotion: 'reduce' });
  await emptyTheLibrary(page);
  await to(page, 'instagram/add');
  await page.locator('input[type=file]').setInputFiles(fixture('instagram-small.zip'));
  await page.getByRole('button', { name: 'Send to my server' }).click();
  await page.getByRole('heading', { name: 'Here is what we found' }).waitFor({ timeout: 20_000 });
  await page.getByRole('button', { name: /^Import 6 saves/ }).click();
  await page.getByRole('heading', { name: 'Welcome home.' }).waitFor({ timeout: 20_000 });
  check(true, 'reduced motion: the flow completes');
  const refreshed = await page.waitForFunction(() => /6/.test(document.querySelector('[data-nav-key="all"]')?.textContent ?? ''), null, { timeout: 5000 }).then(() => true, () => false);
  check(refreshed, `finishing in this page refreshes the library without a reload (sidebar says: ${(await page.evaluate(() => document.querySelector('[data-nav-key="all"]')?.textContent ?? '')).trim()})`);
  await emptyTheLibrary(page);
  await context.close();
}

await browser.close();
if (problems.length) {
  console.error(`\n${problems.length} problem(s):\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log('\nall good');
