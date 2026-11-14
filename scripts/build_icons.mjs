#!/usr/bin/env node
/**
 * Render the installable-app PNG icons from web/icon.svg.
 *
 *   npm run build:icons
 *
 * Uses the Chromium that the browser tests already pin (npx playwright install chromium).
 * The PNGs are committed, so a normal checkout, container build or test run needs no
 * rendering. Run this only after web/icon.svg changes, then review the four files.
 *
 *   web/icons/icon-192.png          192x192  any      rounded tile, transparent corners
 *   web/icons/icon-512.png          512x512  any      rounded tile, transparent corners
 *   web/icons/icon-maskable-512.png 512x512  maskable full-bleed tile; the mark sits inside the safe circle
 *   web/apple-touch-icon.png        180x180  iOS      full-bleed and opaque (iOS rounds it, and fills transparency with black)
 */
import { chromium } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = await readFile(path.join(root, 'web/icon.svg'), 'utf8');
if (!source.includes('rx="20"')) throw new Error('web/icon.svg no longer has the rounded tile this script squares off for the full-bleed icons. Update the script.');
const fullBleed = source.replace('rx="20"', 'rx="0"');

const icons = [
  { file: 'web/icons/icon-192.png', size: 192, svg: source },
  { file: 'web/icons/icon-512.png', size: 512, svg: source },
  { file: 'web/icons/icon-maskable-512.png', size: 512, svg: fullBleed },
  { file: 'web/apple-touch-icon.png', size: 180, svg: fullBleed },
];

const browser = await chromium.launch();
try {
  for (const { file, size, svg } of icons) {
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    const data = Buffer.from(svg).toString('base64');
    await page.setContent(`<!doctype html><style>html,body{margin:0;background:transparent}img{display:block}</style><img width="${size}" height="${size}" src="data:image/svg+xml;base64,${data}">`);
    await page.evaluate(() => document.images[0].decode());
    const png = await page.screenshot({ type: 'png', omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), png);
    console.log(`${file} ${size}x${size} ${png.length} bytes`);
    await page.close();
  }
} finally {
  await browser.close();
}
