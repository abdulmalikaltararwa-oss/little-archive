// Measures the wall with a 5,000-save library on a slowed-down phone profile.
//
//   node e2e/perf.mjs <base-url-of-a-built-preview>
//
// The library is synthetic and answered inside the browser (every /api request is fulfilled by this script),
// so no server is needed. The CPU is throttled 4x and the viewport is a phone's, which is roughly a mid-range
// handset's web view. It loads every page, then scrolls the whole wall and reports frame times and how many
// cards exist in the page at once.
import { chromium } from '@playwright/test';

const [base = 'http://127.0.0.1:5184'] = process.argv.slice(2);
const TOTAL = 5000;
const TYPES = ['video', 'image', 'post', 'article', 'link'];
const item = index => ({
  id: `perf-${index}`, platform: ['instagram', 'tiktok', 'web'][index % 3], url: `https://example.com/${index}`, title: `A saved thing number ${index} with a title long enough to wrap`,
  creator: 'perf', caption: '', summary: '', notes: '', content_type: TYPES[index % TYPES.length], preview_url: null, thumbnail_url: null, tags: ['one', 'two'], collections: [],
  favorite: index % 7 === 0, status: 'inbox', needs_review: index % 11 === 0, saved_at: null, created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-01T00:00:00Z', last_seen_at: '2026-11-01T00:00:00Z',
});

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const page = await context.newPage();
const json = body => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
await page.route('**/api/**', route => {
  const url = new URL(route.request().url());
  const path = url.pathname;
  if (path === '/api/auth/me') return route.fulfill(json({ authenticated: true, csrf_token: 'x' }));
  if (path === '/api/stats') return route.fulfill(json({ total: TOTAL, favorites: 715, to_revisit: 0, needs_review: 455, archived: 0, collections: 0, platforms: { instagram: 1667, tiktok: 1667, web: 1666 } }));
  if (path === '/api/collections') return route.fulfill(json({ collections: [] }));
  if (path === '/api/tags') return route.fulfill(json({ tags: [] }));
  if (path === '/api/settings') return route.fulfill(json({ remote_previews: false, ai_enabled: false, ai_model: '' }));
  if (path === '/api/items') {
    const limit = Number(url.searchParams.get('limit'));
    const offset = Number(url.searchParams.get('offset'));
    return route.fulfill(json({ items: Array.from({ length: Math.max(0, Math.min(limit, TOTAL - offset)) }, (_, index) => item(offset + index)), total: TOTAL, limit, offset }));
  }
  return route.fulfill({ status: 404, contentType: 'application/json', body: '{"detail":"Not found"}' });
});

const cdp = await context.newCDPSession(page);
await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });

const started = Date.now();
await page.goto(new URL('/', base).href);
await page.locator('[data-item-id]').first().waitFor();
const firstCards = Date.now() - started;

// Load the whole library the way a person would: by reaching the end of the wall, again and again.
const loadStarted = Date.now();
for (;;) {
  const loaded = await page.evaluate(() => { scrollTo(0, document.documentElement.scrollHeight); return document.querySelector('[role=feed]')?.querySelectorAll('[data-item-id]').length; });
  const text = await page.getByTestId('save-count').textContent();
  const more = await page.getByRole('button', { name: /Load more/ }).count();
  if (!more) break;
  await page.waitForTimeout(60);
  if (Date.now() - loadStarted > 120_000) { console.log('gave up loading', loaded, text); break; }
}
const loadAll = Date.now() - loadStarted;

const result = await page.evaluate(async () => {
  scrollTo(0, 0);
  await new Promise(resolve => setTimeout(resolve, 300));
  const height = document.documentElement.scrollHeight;
  const frames = [];
  let cards = 0;
  let last = performance.now();
  const distance = height - innerHeight;
  const duration = 12_000;
  const begin = performance.now();
  await new Promise(resolve => {
    const step = now => {
      frames.push(now - last);
      last = now;
      cards = Math.max(cards, document.querySelectorAll('[data-item-id]').length);
      const progress = Math.min(1, (now - begin) / duration);
      scrollTo(0, distance * progress);
      if (progress < 1) requestAnimationFrame(step);
      else resolve();
    };
    requestAnimationFrame(step);
  });
  frames.shift();
  const sorted = [...frames].sort((a, b) => a - b);
  const pick = q => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
  return {
    wallHeightPx: height, frames: frames.length, medianMs: +pick(0.5).toFixed(1), p95Ms: +pick(0.95).toFixed(1), worstMs: +pick(1).toFixed(1),
    over33Ms: frames.filter(value => value > 33.4).length, maxCardsInPage: cards, nodes: document.querySelectorAll('*').length,
  };
});

console.log(JSON.stringify({ saves: TOTAL, cpuThrottle: '4x', viewport: '390x844', firstCardsMs: firstCards, loadEveryPageMs: loadAll, scroll: result }, null, 2));
await browser.close();
