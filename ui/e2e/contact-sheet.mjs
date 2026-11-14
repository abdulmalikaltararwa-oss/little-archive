// Lays several screenshots side by side in one image, for reviewing many screens at a glance.
//
//   node e2e/contact-sheet.mjs <output.png> <column-width> <image> [<image> …]
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';

const [output, width = '360', ...images] = process.argv.slice(2);
if (!output || !images.length) throw new Error('Usage: contact-sheet.mjs <output.png> <column-width> <image> …');

const cells = await Promise.all(images.map(async file => {
  const data = (await readFile(file)).toString('base64');
  return `<figure><img src="data:image/png;base64,${data}"><figcaption>${path.basename(file, '.png')}</figcaption></figure>`;
}));
const html = `<!doctype html><style>
  body { margin: 0; padding: 12px; background: #d9d4c7; font: 12px ui-monospace, monospace; display: flex; flex-wrap: wrap; gap: 12px; align-items: flex-start; width: max-content; max-width: ${Math.min(images.length, 6) * (Number(width) + 12) + 12}px; }
  figure { margin: 0; width: ${width}px; } img { width: 100%; display: block; border: 1px solid #0002; } figcaption { padding: 4px 0; color: #333; }
</style>${cells.join('')}`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
await page.setContent(html);
await page.screenshot({ path: output, fullPage: true });
await browser.close();
