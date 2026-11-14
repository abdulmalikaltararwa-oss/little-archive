// Takes the review screenshots: every key screen at phone, tablet and desktop widths, in light and dark.
//
//   node e2e/shots.mjs <base-url> <output-dir> [only]
//
// <base-url> is a running build or dev server (the demo page is used, so no account is needed). With
// LA_UI_PASSWORD_FILE set, the sign-in screen of a real server at the same origin is captured too.
// `only` is a comma-separated list of shot names to limit the run.
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';

const [base = 'http://127.0.0.1:5183', out = 'shots', only = ''] = process.argv.slice(2);
const wanted = new Set(only.split(',').filter(Boolean));
const want = name => !wanted.size || [...wanted].some(prefix => name.startsWith(prefix));

const SIZES = {
  phone: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  tablet: { width: 834, height: 1112, deviceScaleFactor: 2, hasTouch: true },
  desktop: { width: 1440, height: 900, deviceScaleFactor: 1 },
};

await mkdir(out, { recursive: true });
const browser = await chromium.launch();
const problems = [];

async function open(size, scheme, url = '/demo.html', { reducedMotion = 'no-preference' } = {}) {
  const context = await browser.newContext({ viewport: { width: SIZES[size].width, height: SIZES[size].height }, deviceScaleFactor: SIZES[size].deviceScaleFactor, isMobile: SIZES[size].isMobile, hasTouch: SIZES[size].hasTouch, colorScheme: scheme, reducedMotion });
  const page = await context.newPage();
  page.on('pageerror', error => problems.push(`${size}/${scheme} pageerror: ${error.message}`));
  page.on('console', message => {
    // The dev server's own live-reload socket is refused by the demo page's policy; a build has no such socket.
    if (message.type() === 'error' && !/ws:\/\/|WebSocket/.test(message.text())) problems.push(`${size}/${scheme} console: ${message.text().slice(0, 300)}`);
  });
  await page.goto(new URL(url, base).href);
  return { context, page };
}

const settle = (page, ms = 900) => page.waitForTimeout(ms);
const shot = (page, name, options = {}) => page.screenshot({ path: path.join(out, `${name}.png`), ...options });
const ready = page => page.getByTestId('save-count').filter({ hasText: /saves?$/ }).waitFor();

for (const size of Object.keys(SIZES)) {
  for (const scheme of ['light', 'dark']) {
    const tag = `${size}-${scheme}`;
    if (!want(`library-${tag}`) && !want(`detail-${tag}`) && !want(`dialogs-${tag}`)) continue;
    const { context, page } = await open(size, scheme);
    await ready(page);
    await settle(page, 2400);
    if (want(`library-${tag}`)) {
      await shot(page, `library-${tag}`);
      await shot(page, `library-${tag}-full`, { fullPage: true });
    }

    if (want(`detail-${tag}`)) {
      await page.locator('[data-card-control="open"]').nth(1).click();
      await page.getByTestId('detail').waitFor();
      await settle(page, 900);
      await shot(page, `detail-${tag}`);
      await page.getByRole('button', { name: 'Close dialog' }).click();
      await settle(page, 600);
    }

    if (want(`dialogs-${tag}`)) {
      const dialogs = [
        ['save', async () => { if (size === 'desktop') await page.getByRole('button', { name: 'Save a link', exact: true }).click(); else await page.getByRole('navigation', { name: 'Quick actions' }).getByRole('button', { name: 'Save a link' }).click(); }],
        ['palette', async () => { await page.keyboard.press('Control+k'); await page.keyboard.type('pasta'); }],
        ['organize', async () => page.getByRole('button', { name: 'Organize library' }).click()],
        ['import', async () => page.getByRole('button', { name: 'Import', exact: true }).click()],
        ['settings', async () => { if (size === 'desktop') await page.getByRole('button', { name: 'Settings & connections' }).click(); else await page.getByRole('navigation', { name: 'Quick actions' }).getByRole('button', { name: 'Settings & connections' }).click(); }],
      ];
      for (const [name, act] of dialogs) {
        await act();
        await settle(page, 700);
        await shot(page, `${name}-${tag}`);
        await page.keyboard.press('Escape');
        await settle(page, 450);
      }
      if (size !== 'desktop') {
        await page.getByRole('button', { name: 'Open navigation' }).click();
        await settle(page, 600);
        await shot(page, `browse-${tag}`);
        await page.keyboard.press('Escape');
        await settle(page, 400);
      }
      // Selection and the bulk bar.
      await page.getByRole('button', { name: 'Select', exact: true }).click();
      for (const index of [0, 1, 2]) await page.locator('[data-card-control="select"]').nth(index).check({ force: true });
      await settle(page, 500);
      await shot(page, `selection-${tag}`);
      await page.getByRole('button', { name: 'Clear selection' }).click();
      // An empty search.
      await page.getByLabel('Search titles, captions, tags, and notes').fill('zzzz nothing matches this');
      await page.getByRole('heading', { name: 'Nothing here just yet.' }).waitFor();
      await settle(page, 300);
      await shot(page, `empty-${tag}`);
      // A screen arriving next.
      await page.goto(new URL('/demo.html#/recipes', base).href);
      await settle(page, 900);
      await shot(page, `seam-${tag}`);
    }
    await context.close();
  }
}

if (process.env.LA_UI_PASSWORD_FILE && want('login')) {
  for (const size of ['phone', 'desktop']) {
    for (const scheme of ['light', 'dark']) {
      const { context, page } = await open(size, scheme, '/');
      await page.getByRole('heading', { name: 'Your archive awaits.' }).waitFor();
      await settle(page, 2600);
      await shot(page, `login-${size}-${scheme}`);
      if (size === 'desktop' && scheme === 'light') {
        await page.getByLabel('Password', { exact: true }).fill((await readFile(process.env.LA_UI_PASSWORD_FILE, 'utf8')).trim());
        await page.getByRole('button', { name: 'Open my archive' }).click();
        await page.getByRole('heading', { name: 'All saves' }).waitFor();
        await settle(page, 1500);
        await shot(page, 'real-first-run-desktop-light');
      }
      await context.close();
    }
  }
}

await browser.close();
if (problems.length) {
  console.log(`Browser problems (${problems.length}):`);
  for (const problem of [...new Set(problems)].slice(0, 30)) console.log(` - ${problem}`);
  process.exitCode = 1;
} else console.log('No browser errors.');
