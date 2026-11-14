// Captures frame sequences of the three moments with motion: the flower field settling, a card's cover
// moving into the detail, and the island's "saved". Frames are numbered in the order they were taken; the
// gap between them is roughly the time a screenshot takes (40 to 90ms).
//
//   node e2e/frames.mjs <base-url> <output-dir>
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';

const [base = 'http://127.0.0.1:5183', out = 'frames'] = process.argv.slice(2);
await mkdir(out, { recursive: true });
const browser = await chromium.launch();

async function sequence(page, name, count, options = {}, gap = 0) {
  for (let index = 0; index < count; index++) {
    await page.screenshot({ path: path.join(out, `${name}-${String(index).padStart(2, '0')}.png`), ...options });
    if (gap) await page.waitForTimeout(gap);
  }
}

for (const [label, viewport] of [['desktop', { width: 1440, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: label === 'phone' ? 2 : 1, isMobile: label === 'phone', hasTouch: label === 'phone' });
  const page = await context.newPage();

  // 1. The flower field arrives as noise and settles into the mark.
  await page.goto(new URL('/demo.html', base).href);
  const hero = page.getByRole('region', { name: 'Your personal archive' });
  await hero.locator('canvas').waitFor();
  await sequence(page, `hero-${label}`, 14, { clip: await hero.boundingBox() }, 70);

  // 2. A card's cover becomes the detail's cover.
  await page.waitForTimeout(1200);
  await page.evaluate(() => scrollTo(0, 420));
  await page.waitForTimeout(300);
  const card = page.locator('[data-card-control="open"]').nth(1);
  const click = card.click();
  await sequence(page, `open-${label}`, 10);
  await click;
  await page.waitForTimeout(500);
  const close = page.getByRole('button', { name: 'Close dialog' }).click();
  await sequence(page, `close-${label}`, 8);
  await close;

  // 3. Saving a link: the flower opens in the island, then the island says what happened.
  await page.waitForTimeout(600);
  if (label === 'desktop') await page.getByRole('button', { name: 'Save a link', exact: true }).click();
  else await page.getByRole('navigation', { name: 'Quick actions' }).getByRole('button', { name: 'Save a link' }).click();
  const dialog = page.getByRole('dialog', { name: 'Save a little discovery' });
  await dialog.getByLabel('Link').fill('https://example.com/a-frame-by-frame-save');
  await dialog.getByLabel('Title').fill('A save, frame by frame');
  const save = dialog.getByRole('button', { name: 'Save to archive' }).click();
  await sequence(page, `saved-${label}`, 16, { clip: { x: 0, y: 0, width: viewport.width, height: 150 } });
  await save;
  await context.close();
}

await browser.close();
console.log('frames written to', out);
