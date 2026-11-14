// Seeds a throwaway server with a few recipes through its real API, then takes the review screenshots of the
// recipe screens: the list, a card (and scaled), the edit dialog, cook mode (a running timer, several timers,
// a finished timer, the ingredients), and the empty, locked and AI-read states. No AI provider is configured on
// the server, so the AI-read card and the locked account are drawn from answers a route mock gives in the
// contract's exact shape; everything else is the real server.
//
//   LA_UI_PASSWORD_FILE=<file with the owner password> node e2e/shots-recipes.mjs <base-url> <output-dir> [only]
//
// <base-url> is a dev server proxying a real Little Archive server (for example http://127.0.0.1:5191). `only`
// is a comma-separated list of shot-name prefixes. The password is read from the file and never printed.
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const [base = 'http://127.0.0.1:5191', out = 'shots-recipes', only = ''] = process.argv.slice(2);
const wanted = new Set(only.split(',').filter(Boolean));
const want = name => !wanted.size || [...wanted].some(prefix => name.startsWith(prefix));
// The save's detail only shows a recipe section once the detail panel mounts it, so those shots are taken on request.
const wantOnRequest = name => wanted.size > 0 && [...wanted].some(prefix => name.startsWith(prefix));
const here = path.dirname(fileURLToPath(import.meta.url));
const media = path.resolve(here, '../../web/demo-media');

const SIZES = {
  phone: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  desktop: { width: 1440, height: 900, deviceScaleFactor: 1 },
};

const RECIPES = [
  {
    cover: '002.webp', url: 'https://www.instagram.com/p/LA_RECIPE_001/', title: 'Lemon spaghetti, the quick way', creator: 'nonna.kitchen', tags: ['pasta', 'dinner'],
    caption: `Lemon spaghetti, the quick way
Serves 4

Ingredients:
- 400 g spaghetti
- 3 tbsp olive oil
- 2 cloves garlic, thinly sliced
- zest and juice of 2 lemons
- 60 g Parmesan, finely grated
- a handful of parsley, chopped
- 1 tsp chilli flakes (optional)
- salt and black pepper, to taste

Method:
1. Boil the spaghetti in well salted water for 10 minutes, then keep a mug of the pasta water.
2. Warm the olive oil with the garlic over a low heat for 2 minutes until it just smells sweet.
3. Add the lemon zest, juice and a splash of pasta water and simmer for 3 minutes.
4. Toss the spaghetti through the sauce with the Parmesan, parsley and chilli flakes.
5. Season well and serve straight away.

#pasta #lemon #dinner`,
  },
  {
    cover: '016.webp', url: 'https://www.tiktok.com/@bakes.by.june/video/9100000000000000001', title: 'Brown butter chocolate chip cookies', creator: 'bakes.by.june', tags: ['baking', 'cookies'],
    caption: `Brown butter chocolate chip cookies
Makes 24 cookies

Ingredients:
- 1 cup unsalted butter
- 2 1/4 cups all-purpose flour
- 1 tsp baking soda
- 1 tsp fine salt
- 3/4 cup brown sugar
- 1/2 cup white sugar
- 2 large eggs
- 2 tsp vanilla extract
- 200 g dark chocolate, chopped
- flaky salt, to finish

Method:
1. Melt the butter in a pan over medium heat for 6 minutes until it smells nutty, then cool for 15 minutes.
2. Whisk the flour, baking soda and fine salt together.
3. Beat the browned butter with both sugars, then the eggs and vanilla.
4. Fold in the flour and the chocolate. Chill the dough for 24 hours.
5. Scoop onto trays and bake at 180C for 11 minutes.
6. Finish with flaky salt while they are hot.

#baking #cookies`,
  },
  {
    cover: '017.webp', url: 'https://www.tiktok.com/@onepan.nights/video/9100000000000000002', title: '15-minute garlic chili noodles', creator: 'onepan.nights', tags: ['noodles', 'quick'],
    caption: `15-minute garlic chili noodles

Ingredients:
- 200 g wheat noodles
- 4 cloves garlic, minced
- 2 tbsp soy sauce
- 1 tbsp rice vinegar
- 1 tsp chilli flakes
- 3 tbsp neutral oil
- 2 spring onions, sliced

Method:
1. Cook the noodles for 4 minutes and drain.
2. Put the garlic, chilli flakes and spring onions in a heatproof bowl.
3. Heat the oil until it shimmers, about 2 minutes, and pour it over the garlic.
4. Add the soy sauce and vinegar, then toss in the noodles.

#noodles #easyrecipe`,
  },
  {
    cover: '018.webp', url: 'https://example.com/sunday-focaccia', title: 'Sunday focaccia, step by step', creator: 'The Slow Oven', tags: ['bread'],
    caption: `Sunday focaccia, step by step
Serves 8

Ingredients:
- 500 g bread flour
- 400 ml warm water
- 10 g fine salt
- 7 g instant yeast
- 4 tbsp olive oil, plus more for the tin
- flaky salt and rosemary, to top

Method:
1. Stir the flour, water, salt and yeast into a shaggy dough. Cover and rest for 30 minutes.
2. Fold the dough over itself four times, then rest for 1 hour until puffy.
3. Oil a tin, tip the dough in and dimple it with wet fingers. Rest for 45 minutes.
4. Drizzle with the olive oil, scatter the salt and rosemary, and bake at 220C for 25 minutes.
5. Cool on a rack before slicing.`,
  },
  {
    cover: '020.webp', url: 'https://www.instagram.com/p/LA_RECIPE_005/', title: 'مجبوس دجاج مثل بيت أمي', creator: 'مطبخ أم خالد', tags: ['خليجي'],
    caption: 'مجبوس دجاج مثل بيت أمي. المكونات: دجاجة مقطعة، ٢ كوب رز بسمتي، بصلة كبيرة، ٣ فصوص ثوم. الطريقة: اقلي البصل مع البهارات. أضيفي الدجاج واتركيه ٢٠ دقيقة.',
    edit: {
      title: 'مجبوس دجاج مثل بيت أمي', servings: 4, servings_text: 'يكفي ٤ أشخاص', time: { total_seconds: 3600 },
      ingredients: [
        { quantity: 1, unit: 'piece', name: 'دجاجة مقطعة', text: 'دجاجة مقطعة' }, { quantity: 2, unit: 'cup', name: 'رز بسمتي' }, { quantity: 1, name: 'بصلة كبيرة' },
        { quantity: 3, unit: 'clove', name: 'ثوم' }, { quantity: 1, unit: 'tbsp', name: 'بهارات مجبوس' }, { quantity: 4, name: 'لومي', note: 'مثقوب' },
      ],
      steps: [{ text: 'اقلي البصل مع البهارات حتى يذبل.' }, { text: 'أضيفي الدجاج واتركيه ٢٠ دقيقة.', timer_seconds: 1200 }, { text: 'أضيفي الرز والماء واتركيه ١٥ دقيقة على نار هادئة.', timer_seconds: 900 }],
      notes: 'تقدم مع الدقوس.',
    },
  },
  { cover: '022.webp', url: 'https://example.com/loose-potatoes', title: 'Crispy smashed potatoes', creator: 'Weeknight Garden', tags: ['sides'], caption: 'Crispy smashed potatoes. Boil baby potatoes until tender, smash them flat, drizzle with olive oil and roast hot until the edges shatter. Salt generously.' },
];

await mkdir(out, { recursive: true });
const browser = await chromium.launch();
const problems = [];
const password = (await readFile(process.env.LA_UI_PASSWORD_FILE ?? '', 'utf8').catch(() => '')).trim();
if (!password) throw new Error('Set LA_UI_PASSWORD_FILE to a file holding the owner password.');

/* Sign in once, keep the session, and seed through the real API ------------------------------------------------ */

const bootstrap = await browser.newContext();
const first = await bootstrap.newPage();
await first.goto(base);
await first.getByLabel('Password', { exact: true }).fill(password);
await first.getByRole('button', { name: 'Open my archive' }).click();
await first.getByRole('heading', { name: 'All saves' }).waitFor();
const csrf = (await (await bootstrap.request.get(`${base}/api/auth/me`)).json()).csrf_token;
const call = async (method, route, body, headers = {}) => {
  const response = await bootstrap.request.fetch(`${base}/api${route}`, { method, headers: { 'X-CSRF-Token': csrf, ...headers }, data: body });
  const json = await response.json().catch(() => ({}));
  if (!response.ok()) throw new Error(`${method} ${route} -> ${response.status()}`);
  return json;
};

if ((await call('GET', '/recipes')).total < RECIPES.length - 1) {
  for (const entry of RECIPES) {
    const created = await call('POST', '/items', { url: entry.url, title: entry.title, creator: entry.creator, caption: entry.caption, tags: entry.tags });
    await call('POST', `/items/${created.id}/thumbnail`, await readFile(path.join(media, entry.cover)), { 'Content-Type': 'image/webp' });
    await call('POST', `/items/${created.id}/recipe/extract`, { method: 'auto' });
    if (entry.edit) await call('PUT', `/items/${created.id}/recipe`, entry.edit);
  }
}
const rows = (await call('GET', '/recipes')).recipes;
const idOf = title => rows.find(row => row.title.startsWith(title))?.item_id ?? '';
const SPAGHETTI = idOf('Lemon spaghetti');
const COOKIES = idOf('Brown butter');
const NOODLES = idOf('15-minute');
const ARABIC = idOf('مجبوس');
const POTATOES = (await call('GET', '/items?q=smashed&limit=1')).items[0]?.id ?? '';
const state = await bootstrap.storageState();
await bootstrap.close();

/* Helpers ------------------------------------------------------------------------------------------------------ */

async function open(size, scheme, { reducedMotion = 'no-preference', before } = {}) {
  const spec = SIZES[size];
  const context = await browser.newContext({ storageState: state, viewport: { width: spec.width, height: spec.height }, deviceScaleFactor: spec.deviceScaleFactor, isMobile: spec.isMobile, hasTouch: spec.hasTouch, colorScheme: scheme, reducedMotion, permissions: [] });
  const page = await context.newPage();
  page.on('pageerror', error => problems.push(`${size}/${scheme} pageerror: ${error.message}`));
  page.on('console', message => { if (message.type() === 'error' && !/ws:\/\/|WebSocket|Failed to load resource/.test(message.text())) problems.push(`${size}/${scheme} console: ${message.text().slice(0, 300)}`); });
  if (before) await before(page);
  return { context, page };
}

const settle = (page, ms = 700) => page.waitForTimeout(ms);
const shot = (page, name, options = {}) => page.screenshot({ path: path.join(out, `${name}.png`), ...options });
const go = async (page, hash) => { await page.goto(`${base}/${hash}`); await settle(page, 500); };
const heading = (page, name) => page.getByRole('heading', { name }).first().waitFor();

/* The shots ---------------------------------------------------------------------------------------------------- */

for (const size of Object.keys(SIZES)) {
  for (const scheme of ['light', 'dark']) {
    const tag = `${size}-${scheme}`;

    if (want(`list-${tag}`) || want(`card-${tag}`) || want(`edit-${tag}`)) {
      const { context, page } = await open(size, scheme);
      if (want(`list-${tag}`)) {
        await go(page, '#/recipes');
        await heading(page, 'Recipes, ready to cook');
        await page.locator('[data-testid="recipe-list"] article').first().waitFor();
        await settle(page, 1600);
        await shot(page, `list-${tag}`);
      }
      if (want(`card-${tag}`)) {
        await go(page, `#/recipes/${SPAGHETTI}`);
        await page.getByTestId('recipe-card').waitFor();
        await settle(page, 900);
        await shot(page, `card-${tag}`);
        await shot(page, `card-full-${tag}`, { fullPage: true });
        // Servings, scaled by the server.
        await page.getByRole('button', { name: 'One serving more' }).click();
        await page.getByRole('button', { name: 'One serving more' }).click();
        await settle(page, 900);
        await shot(page, `card-scaled-${tag}`);
        // No stated servings: a factor instead.
        await go(page, `#/recipes/${NOODLES}`);
        await page.getByTestId('recipe-card').waitFor();
        await page.getByRole('radio', { name: '×2' }).click();
        await settle(page, 900);
        await shot(page, `card-factor-${tag}`);
        // Where each line came from.
        await page.getByLabel('Show where each line came from').click();
        await settle(page, 400);
        await shot(page, `card-sources-${tag}`, { fullPage: true });
      }
      if (want(`edit-${tag}`)) {
        await go(page, `#/recipes/${SPAGHETTI}`);
        await page.getByTestId('recipe-card').waitFor();
        await page.getByRole('button', { name: 'Edit', exact: true }).click();
        await page.getByTestId('recipe-edit').waitFor();
        await settle(page, 700);
        await shot(page, `edit-${tag}`);
        await page.getByTestId('recipe-edit').getByLabel('Step 1', { exact: true }).fill('Boil the spaghetti in well salted water for 12 minutes.');
        await page.getByTestId('recipe-edit').getByRole('button', { name: 'Add a step' }).scrollIntoViewIfNeeded();
        await settle(page, 300);
        await shot(page, `edit-steps-${tag}`);
      }
      await context.close();
    }

    if (want(`cook-${tag}`)) {
      const { context, page } = await open(size, scheme, { before: p => p.clock.install() });
      await go(page, `#/recipes/${SPAGHETTI}`);
      await page.getByTestId('recipe-card').waitFor();
      await page.getByRole('button', { name: 'Cook', exact: true }).click();
      await page.getByTestId('cook-mode').waitFor();
      await settle(page, 900);
      await shot(page, `cook-step-${tag}`);
      // The first timer, running.
      await page.getByRole('button', { name: 'Start timer' }).click();
      await page.clock.fastForward('01:30');
      await settle(page, 500);
      await shot(page, `cook-timer-${tag}`);
      // On to the second step; its timer runs beside the first.
      await page.getByRole('button', { name: 'Next step' }).click();
      await settle(page, 600);
      await page.getByRole('button', { name: 'Start timer' }).click();
      await page.getByRole('button', { name: 'Next step' }).click();
      await settle(page, 700);
      await shot(page, `cook-many-${tag}`);
      // Time passes with nobody looking: the second step's timer ends.
      await page.clock.fastForward('02:30');
      await settle(page, 700);
      await shot(page, `cook-others-${tag}`);
      await page.getByRole('button', { name: /Step 2: time is up/ }).click();
      await settle(page, 800);
      await shot(page, `cook-finished-${tag}`);
      if (size === 'phone') {
        await page.getByRole('button', { name: /^Ingredients, / }).click();
        await settle(page, 700);
        await shot(page, `cook-ingredients-${tag}`);
        await page.getByRole('button', { name: 'Close the ingredients' }).click();
        await settle(page, 400);
      } else {
        await page.getByRole('checkbox').nth(1).check({ force: true });
        await page.getByRole('checkbox').nth(2).check({ force: true });
        await settle(page, 400);
        await shot(page, `cook-ingredients-${tag}`);
      }
      // All the way to the end.
      for (let step = 0; step < 6; step += 1) {
        const next = page.getByRole('button', { name: /^(Next step|Finish)$/ });
        if (!(await next.count())) break;
        await next.click();
        await settle(page, 200);
      }
      await settle(page, 700);
      await shot(page, `cook-done-${tag}`);
      await context.close();
    }

    if (want(`rtl-${tag}`)) {
      const { context, page } = await open(size, scheme);
      await go(page, `#/recipes/${ARABIC}`);
      await page.getByTestId('recipe-card').waitFor();
      await page.evaluate(() => { document.documentElement.dir = 'rtl'; });
      await settle(page, 700);
      await shot(page, `rtl-card-${tag}`);
      await page.getByRole('button', { name: 'Cook', exact: true }).click();
      await page.getByTestId('cook-mode').waitFor();
      await settle(page, 900);
      await shot(page, `rtl-cook-${tag}`);
      await context.close();
    }

    if (want(`states-${tag}`)) {
      const { context, page } = await open(size, scheme);
      // A library with no recipe cards.
      await page.route('**/api/recipes?*', route => route.fulfill({ json: { recipes: [], total: 0, limit: 24, offset: 0 } }));
      await go(page, '#/recipes');
      await heading(page, 'No recipe cards yet');
      await settle(page, 900);
      await shot(page, `states-empty-${tag}`);
      await page.unroute('**/api/recipes?*');
      // An account that has not unlocked recipes: the feature list says so, and so does any call.
      await page.route('**/api/features', async route => {
        const answer = await (await route.fetch()).json();
        await route.fulfill({ json: { ...answer, mode: 'hosted', unlocked: false, recipes: { ...answer.recipes, locked: true } } });
      });
      // The feature list is read when the app starts, so start it again.
      await page.reload();
      await heading(page, 'Recipes are locked for now');
      await settle(page, 700);
      await shot(page, `states-locked-${tag}`);
      await context.close();
    }

    if (want(`ai-${tag}`)) {
      // A recipe read by a model: the contract's exact shape, from a route mock, because no AI is configured on this server.
      const { context, page } = await open(size, scheme);
      const real = await (await context.request.get(`${base}/api/items/${COOKIES}/recipe?factor=1`)).json();
      const label = { method: 'ai', evidence_level: 'caption-based', evidence_sources: ['title', 'caption'], evidence_note: 'Read from the title and caption by a model that was asked to copy spans, and every span was checked against the text. The pictures and video themselves were not seen.', provider: 'ollama', model: 'qwen2.5:7b' };
      const recipe = { ...real.recipe, confidence: 'medium', provenance: label, dropped: { ingredients: 2, steps: 1 }, reason: 'most_ingredients_unverified', steps: real.recipe.steps.map(step => ({ ...step, source: 'caption', quote: step.text.slice(0, 48) })) };
      await page.route(`**/api/items/${COOKIES}/recipe*`, route => route.fulfill({ json: { ...real, recipe, extracted: recipe, extraction: { method: 'ai', at: real.extraction.at, stale: true }, available: { jsonld: false, rules: true, ai: true } } }));
      await go(page, `#/recipes/${COOKIES}`);
      await page.getByTestId('recipe-card').waitFor();
      await page.getByLabel('Show where each line came from').click();
      await page.getByTestId('evidence-label').scrollIntoViewIfNeeded();
      await settle(page, 1200);
      await shot(page, `ai-card-${tag}`, { fullPage: true });
      await context.close();
    }

    if (wantOnRequest(`entry-${tag}`)) {
      const { context, page } = await open(size, scheme);
      await go(page, `#/?item=${SPAGHETTI}`);
      await page.getByTestId('recipe-entry').waitFor();
      await page.getByTestId('recipe-entry').scrollIntoViewIfNeeded();
      await settle(page, 900);
      await shot(page, `entry-recipe-${tag}`);
      await go(page, `#/?item=${POTATOES}`);
      await page.getByTestId('recipe-entry').getByRole('button', { name: 'Look for a recipe' }).waitFor();
      await page.getByTestId('recipe-entry').scrollIntoViewIfNeeded();
      await page.getByTestId('recipe-entry').getByRole('button', { name: 'Look for a recipe' }).click();
      await page.getByTestId('recipe-entry').getByRole('status').filter({ hasText: /./ }).first().waitFor();
      await settle(page, 700);
      await shot(page, `entry-none-${tag}`);
      await context.close();
    }
  }
}

await browser.close();
if (problems.length) {
  console.error(`${problems.length} problem(s):\n${[...new Set(problems)].join('\n')}`);
  process.exitCode = 1;
} else console.log(`Done. Screenshots are in ${out}`);
