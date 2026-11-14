// Takes the review screenshots of the ask screen at phone and desktop widths, in light and dark.
//
//   LA_UI_PASSWORD_FILE=<file> node e2e/shots-ask.mjs [output-dir]
//
// It needs a throwaway Little Archive server and the interface's dev server running (LA_ASK_API and LA_ASK_BASE,
// default http://127.0.0.1:8873 and http://127.0.0.1:5193). The library is seeded through the server's real API
// (POST /api/demo and POST /api/items, once). No AI is configured on that server, so the real answers are the
// "ranked only" and "nothing saved" ones. Everything that needs an AI (an answer with quotes, a refused answer,
// an AI outage) is a MOCK: the real request goes to the real server, its real ranked saves come back, and this
// script rewrites the response to the shape API_CONTRACT.md describes. Those shots are named mock-*.
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';

const BASE = process.env.LA_ASK_BASE || 'http://127.0.0.1:5193';
const API = process.env.LA_ASK_API || 'http://127.0.0.1:8873';
const OUT = path.resolve(process.argv[2] || 'shots-ask');
const only = new Set((process.argv[3] || '').split(',').filter(Boolean));
const want = name => !only.size || [...only].some(prefix => name.startsWith(prefix));
if (!process.env.LA_UI_PASSWORD_FILE) throw new Error('Set LA_UI_PASSWORD_FILE to the file that holds the owner password.');
const password = (await readFile(process.env.LA_UI_PASSWORD_FILE, 'utf8')).trim();

const SIZES = {
  phone: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  desktop: { width: 1440, height: 900, deviceScaleFactor: 1 },
};

/* Seeding, through the real API ------------------------------------------------------------------------- */

let cookie = '';
let csrf = '';
async function call(method, route, body) {
  const response = await fetch(`${API}/api${route}`, {
    method,
    headers: { Origin: BASE, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(csrf && method !== 'GET' ? { 'X-CSRF-Token': csrf } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const set = response.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${method} ${route} -> ${response.status}`);
  return json;
}

const LEMON_CAPTION = `Lemon spaghetti, the quick way
Serves 4

Ingredients:
- 400 g spaghetti
- 3 tbsp olive oil
- 2 cloves garlic, thinly sliced
- zest and juice of 2 lemons
- 60 g Parmesan, finely grated
- a handful of parsley, chopped

Method:
1. Boil the spaghetti in well salted water for 10 minutes, then keep a mug of the pasta water.
2. Warm the olive oil with the garlic over a low heat for 2 minutes until it just smells sweet.
3. Add the lemon zest, juice and a splash of pasta water and simmer for 3 minutes.
4. Toss the spaghetti through the sauce with the Parmesan and parsley.

#pasta #lemon #dinner`;
const WATER_CAPTION = 'Always keep a mug of the starchy pasta water. It turns oil and cheese into a silky sauce, so tip it in a splash at a time.';

const SEED = [
  { url: 'https://www.instagram.com/p/LA_ASK_001/', title: 'Lemon spaghetti, the quick way', creator: 'nonna.kitchen', caption: LEMON_CAPTION, tags: ['pasta', 'dinner'], collection: 'Kitchen notes' },
  { url: 'https://www.tiktok.com/@pasta.tips/video/9300000000000000002', title: 'Pasta water is liquid gold', creator: 'pasta.tips', caption: WATER_CAPTION, tags: ['pasta'], collection: 'Kitchen notes' },
  { url: 'https://www.tiktok.com/@oven.nights/video/9300000000000000003', title: 'Tomato pasta bake', creator: 'oven.nights', caption: 'A pasta bake with tomato, mozzarella and basil. Forty minutes in a hot oven, then rest it for ten.', tags: ['pasta', 'dinner'], collection: 'Kitchen notes' },
  { url: 'https://www.instagram.com/p/LA_ASK_004/', title: 'Lemon squash for hot afternoons', creator: 'cool.drinks', caption: 'Lemon squash cordial: lemon juice, sugar and water, and more lemon in every glass. Keeps a week in the fridge.', tags: ['drinks'], collection: 'Kitchen notes' },
  { url: 'https://example.org/sourdough-long-rise', title: 'Sourdough with a long cold rise', creator: 'slow.bread', caption: 'Mix the dough in the evening and leave it in the fridge overnight. Bake in a very hot dutch oven for the first twenty minutes with the lid on.', tags: ['baking', 'bread'], collection: 'Kitchen notes' },
  { url: 'https://example.org/pruning-roses', title: 'Pruning roses in early spring', creator: 'the.garden.diary', caption: 'Prune the roses in early spring, just above an outward bud. Cut out anything dead, damaged or crossing, and leave an open middle.', tags: ['garden'], collection: 'Garden' },
  { url: 'https://example.org/seed-saving', title: 'Seed saving for beginners', creator: 'the.garden.diary', caption: 'Let a few bean pods dry on the plant, then shell them and keep the seeds in a paper envelope somewhere dry.', tags: ['garden'], collection: 'Garden' },
  { url: 'https://www.tiktok.com/@slow.travel/video/9300000000000000008', title: 'Café hopping in Lisbon', creator: 'slow.travel', caption: 'Five cafés in Alfama and Baixa worth the walk: custard tarts warm from the oven, a flat white by the window, and a tiny place with only six seats.', tags: ['travel', 'lisbon'], collection: 'Trips to plan' },
  { url: 'https://example.org/first-pot', title: 'Throwing a first pot on the wheel', creator: 'clay.club', caption: 'Centre the clay before you open it. Wet hands, a slow wheel, and lean your elbows against your thighs.', tags: ['ceramics'], collection: '' },
  { url: 'https://example.org/standing-desk', title: 'A standing desk setup that lasts', creator: 'calm.desk', caption: 'Set the monitor an arm’s length away with the top edge at eye level. Elbows at ninety degrees, feet flat.', tags: ['desk'], collection: '' },
  { url: 'https://example.org/labneh', title: 'لبنة بالزعتر', creator: 'مطبخ.جدتي', caption: 'وصفة لبنة منزلية بالزعتر وزيت الزيتون. اتركوها في القماش ليلة كاملة ثم قدموها مع الخبز.', tags: ['وصفات'], collection: 'Kitchen notes' },
];

async function seed() {
  const login = await call('POST', '/auth/login', { password });
  csrf = login.csrf_token;
  // Seeded once: the first of my saves marks a library that already has them.
  const marker = await call('GET', `/items?q=${encodeURIComponent('spaghetti')}&limit=5`);
  if (marker.items.some(item => item.title === SEED[0].title)) return (await call('GET', '/stats')).total;
  if ((await call('GET', '/stats')).total === 0) await call('POST', '/demo');
  const made = new Map();
  for (const entry of SEED) {
    if (entry.collection && !made.has(entry.collection)) made.set(entry.collection, (await call('POST', '/collections', { name: entry.collection, color: '#94a98b' })).id);
    await call('POST', '/items', {
      url: entry.url, title: entry.title, creator: entry.creator, caption: entry.caption, tags: entry.tags,
      ...(entry.collection ? { collection_ids: [made.get(entry.collection)] } : {}),
    });
  }
  return (await call('GET', '/stats')).total;
}

/* Mocks: the contract's shape, built on the real server's ranked saves ---------------------------------- */

const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
const quoteOf = (captionText, from, length) => captionText.slice(captionText.indexOf(from), captionText.indexOf(from) + length);

/** Rewrites the real ranked_only response into a model-answered one. Marked `mock` in every file name. */
function mockAnswer(real) {
  const pick = title => real.sources.find(source => source.title === title);
  const lemon = pick('Lemon spaghetti, the quick way');
  const water = pick('Pasta water is liquid gold');
  const citations = [
    lemon && { item_id: lemon.item_id, title: lemon.title, url: lemon.url, quote: quoteOf(LEMON_CAPTION, 'Warm the olive oil with the garlic', 79), field: 'caption' },
    water && { item_id: water.item_id, title: water.title, url: water.url, quote: quoteOf(WATER_CAPTION, 'Always keep a mug of the starchy pasta water', 45), field: 'caption' },
  ].filter(Boolean);
  const sources = real.sources.map((source, index) => ({
    ...source,
    used_in_answer: citations.some(entry => entry.item_id === source.item_id),
    withheld_from_answer: index === real.sources.length - 1 && real.sources.length > 5 ? 'context_full' : null,
  }));
  return {
    ...real,
    mode: 'answer',
    answered: true,
    answer: 'You saved a quick lemon spaghetti: garlic warmed in olive oil, then lemon zest and juice, tossed through the pasta with Parmesan and parsley. Another save says to keep a mug of the starchy pasta water for the sauce.',
    reason: '',
    notice: null,
    citations,
    sources,
    context: { saves: Math.max(1, sources.length - 1), passages: sources.length + 1, chars: 1480, truncated: sources.some(source => source.withheld_from_answer === 'context_full') },
    ai: { available: true, provider: 'ollama', model: 'qwen3:8b' },
    evidence: { level: 'caption-based', sources: ['caption'], note: `Based on captions from up to ${Math.max(1, sources.length - 1)} of your saves. The pictures and videos themselves were not seen. Only the saves cited are the source.` },
  };
}

const MOCKS = {
  answer: mockAnswer,
  unverified: real => ({ ...mockAnswer(real), answered: false, answer: null, reason: 'unverified', notice: 'The model’s answer could not be checked against your saves, so it is not shown. Here are the closest ones.', citations: [], sources: real.sources.map(source => ({ ...source, used_in_answer: false, withheld_from_answer: null })) }),
  'not-in-saves': real => ({ ...mockAnswer(real), answered: false, answer: null, reason: 'not_in_saves', notice: 'Your saves don’t seem to say. Here are the closest ones.', citations: [], sources: real.sources.map(source => ({ ...source, used_in_answer: false, withheld_from_answer: null })) }),
  'ai-failed': real => ({ ...real, mode: 'ranked_only', answered: false, answer: null, reason: 'ai_failed', notice: 'The AI provider could not answer just now, so these are the best-matching saves only.', ai: { available: true, provider: 'ollama', model: 'qwen3:8b', error: 'The local model service could not be reached.' }, context: { saves: real.sources.length, passages: real.sources.length, chars: 900, truncated: false } }),
  instructions: real => ({ ...real, mode: 'ranked_only', answered: false, answer: null, reason: 'contains_instructions', notice: 'The matching saves contain text that looks like instructions to an AI, so none were sent to the model. Here they are.', ai: { available: true, provider: 'ollama', model: 'qwen3:8b' }, sources: real.sources.map(source => ({ ...source, withheld_from_answer: 'contains_instructions' })) }),
  'no-text': real => ({ ...real, mode: 'ranked_only', answered: false, answer: null, reason: 'no_shareable_text', notice: 'The matching text is in your private notes, which this service does not send to its hosted model. Here they are.', ai: { available: true, provider: 'openai-compatible', model: 'hosted-1' }, sources: real.sources.map(source => ({ ...source, withheld_from_answer: 'no_shareable_text' })) }),
};

/** Answers POST /api/ask with a rewritten copy of what the real server said. */
async function mockAsk(page, kind) {
  await page.route('**/api/ask', async route => {
    const real = await (await route.fetch()).json();
    await json(route, MOCKS[kind](real));
  });
}

/* The pages --------------------------------------------------------------------------------------------- */

await mkdir(OUT, { recursive: true });
const total = await seed();
console.log(`Library seeded: ${total} saves.`);

const browser = await chromium.launch();
const problems = [];
const settle = (page, ms = 900) => page.waitForTimeout(ms);
const shot = async (page, name, options = {}) => {
  // A full-page capture draws fixed things (the phone's dock, the skip link) wherever the viewport happened to be.
  if (options.fullPage) await page.addStyleTag({ content: 'nav[aria-label="Quick actions"], a[href="#main"] { display: none !important; }' });
  await page.screenshot({ path: path.join(OUT, `${name}.png`), ...options });
};

async function signIn() {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await page.goto(`${BASE}/`);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Open my archive' }).click();
  await page.getByRole('heading', { name: 'All saves' }).waitFor();
  const state = await context.storageState();
  await context.close();
  return state;
}

const storageState = await signIn();

async function open(size, scheme, { reducedMotion = 'no-preference' } = {}) {
  const spec = SIZES[size];
  const context = await browser.newContext({ storageState, viewport: { width: spec.width, height: spec.height }, deviceScaleFactor: spec.deviceScaleFactor, isMobile: spec.isMobile, hasTouch: spec.hasTouch, colorScheme: scheme, reducedMotion });
  const page = await context.newPage();
  page.on('pageerror', error => problems.push(`${size}/${scheme} pageerror: ${error.message}`));
  page.on('console', message => {
    if (message.type() === 'error' && !/Failed to load resource|ws:\/\/|WebSocket|net::ERR_FAILED/.test(message.text())) problems.push(`${size}/${scheme} console: ${message.text().slice(0, 300)}`);
  });
  return { context, page };
}

async function fresh(page) {
  // A mock from the shot before must not answer this one.
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await page.goto(`${BASE}/#/ask`);
  await page.reload();
  await page.getByRole('heading', { name: 'Ask your archive', level: 1 }).waitFor();
  await settle(page, 800);
}

async function ask(page, text) {
  const box = page.getByLabel('Your question');
  await box.fill(text);
  await box.press('Enter');
}

const LEMON = 'What was that lemon pasta recipe I saved?';
const NOTHING = 'What did I save about submarines?';

for (const size of Object.keys(SIZES)) {
  for (const scheme of ['light', 'dark']) {
    const tag = `${size}-${scheme}`;
    const { context, page } = await open(size, scheme);

    if (want(`empty-${tag}`)) {
      await fresh(page);
      await shot(page, `empty-${tag}`);
      if (size === 'phone') await shot(page, `empty-${tag}-full`, { fullPage: true });
    }

    if (want(`waiting-${tag}`)) {
      await fresh(page);
      // The real server answers at once, so the wait is held here: the real request goes through after a pause.
      await page.route('**/api/ask', async route => { await new Promise(resolve => setTimeout(resolve, 20000)); await route.continue().catch(() => {}); });
      await ask(page, LEMON);
      await page.getByRole('status').filter({ hasText: /reading your saves/i }).waitFor();
      await settle(page, 1200);
      await shot(page, `waiting-${tag}`);
      await page.getByRole('button', { name: 'Stop' }).click();
      await page.unrouteAll({ behavior: 'ignoreErrors' });
    }

    if (want(`ranked-only-${tag}`)) {
      await fresh(page);
      await ask(page, LEMON);
      await page.getByRole('heading', { name: 'This server has no AI set up' }).waitFor();
      await settle(page, 1100);
      await shot(page, `ranked-only-${tag}`);
      await shot(page, `ranked-only-${tag}-full`, { fullPage: true });
    }

    if (want(`no-results-${tag}`)) {
      await fresh(page);
      await ask(page, NOTHING);
      await page.getByRole('heading', { name: 'Nothing saved about that.' }).waitFor();
      await settle(page, 1100);
      await shot(page, `no-results-${tag}`);
    }

    if (want(`mock-answer-${tag}`)) {
      await fresh(page);
      await mockAsk(page, 'answer');
      await ask(page, LEMON);
      await page.getByTestId('answer-text').waitFor();
      await settle(page, 1500);
      await shot(page, `mock-answer-${tag}`);
      await shot(page, `mock-answer-${tag}-full`, { fullPage: true });
    }

    if (want(`mock-refused-${tag}`)) {
      await fresh(page);
      await mockAsk(page, 'unverified');
      await ask(page, LEMON);
      await page.getByRole('heading', { name: 'An answer was held back' }).waitFor();
      await settle(page, 1100);
      await shot(page, `mock-refused-${tag}`);
      await shot(page, `mock-refused-${tag}-full`, { fullPage: true });
    }

    if (want(`mock-held-back-${tag}`)) {
      await fresh(page);
      await mockAsk(page, 'instructions');
      await ask(page, LEMON);
      await page.getByRole('heading', { name: 'Nothing was sent to the AI' }).waitFor();
      await settle(page, 1100);
      await shot(page, `mock-held-back-${tag}`);
    }

    if (want(`mock-ai-failed-${tag}`)) {
      await fresh(page);
      await mockAsk(page, 'ai-failed');
      await ask(page, LEMON);
      await page.getByRole('heading', { name: 'The AI could not answer just now' }).waitFor();
      await settle(page, 1100);
      await shot(page, `mock-ai-failed-${tag}`);
    }

    if (want(`error-${tag}`)) {
      await fresh(page);
      await page.route('**/api/ask', route => route.abort('failed'));
      await ask(page, LEMON);
      await page.getByRole('alert').filter({ hasText: 'That did not go through' }).waitFor();
      await settle(page, 900);
      await shot(page, `error-${tag}`);
    }

    if (want(`locked-${tag}`)) {
      await fresh(page);
      await page.route('**/api/ask', route => json(route, { detail: 'This comes with the full unlock.', code: 'unlock_required', feature: 'ask' }, 402));
      await ask(page, LEMON);
      await page.getByRole('heading', { name: /is locked for now/ }).waitFor();
      await settle(page, 900);
      await shot(page, `locked-${tag}`);
    }

    if (want(`history-${tag}`)) {
      await fresh(page);
      await ask(page, LEMON);
      await page.getByRole('heading', { name: 'This server has no AI set up' }).waitFor();
      await ask(page, NOTHING);
      await page.getByRole('heading', { name: 'Nothing saved about that.' }).waitFor();
      await ask(page, 'when do I prune the roses?');
      await page.getByRole('heading', { name: 'This server has no AI set up' }).waitFor();
      await settle(page, 1100);
      await shot(page, `history-${tag}`);
    }

    if (want(`narrow-${tag}`)) {
      await fresh(page);
      await page.getByRole('combobox', { name: /Narrow by topic/ }).click();
      await settle(page, 500);
      await shot(page, `narrow-menu-${tag}`);
      await page.getByRole('option', { name: /pasta/ }).first().click();
      await settle(page, 300);
      await ask(page, 'dinner ideas');
      await page.getByRole('heading', { name: /./, level: 3 }).first().waitFor();
      await settle(page, 1100);
      await shot(page, `narrow-set-${tag}`);
    }

    if (want(`rtl-${tag}`)) {
      await fresh(page);
      await ask(page, 'وين وصفة اللبنة اللي حفظتها؟');
      await page.getByRole('heading', { name: 'This server has no AI set up' }).waitFor();
      await settle(page, 1100);
      await shot(page, `rtl-${tag}`);
    }

    await context.close();
  }
}

// The same screen when the server says the feature is locked before anything is asked (the feature gate).
for (const size of Object.keys(SIZES)) {
  const tag = `${size}-light`;
  if (!want(`locked-gate-${tag}`)) continue;
  const { context, page } = await open(size, 'light');
  await page.route('**/api/features', async route => {
    const real = await (await route.fetch()).json();
    await json(route, { ...real, mode: 'hosted', unlocked: false, ask: { ...real.ask, available: true, locked: true } });
  });
  await page.goto(`${BASE}/#/ask`);
  await page.reload();
  await page.getByRole('heading', { name: /is locked for now/ }).waitFor();
  await settle(page, 600);
  await shot(page, `locked-gate-${tag}`);
  await context.close();
}

await browser.close();
if (problems.length) {
  console.log(`Browser problems (${problems.length}):`);
  for (const problem of [...new Set(problems)].slice(0, 30)) console.log(` - ${problem}`);
  process.exitCode = 1;
} else console.log('No browser errors.');
