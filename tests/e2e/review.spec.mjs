import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test, expect, apiAction, closeDialog, createCollection, detailPanel, importJSON, login, uniqueName } from './fixtures.mjs';

// The suite runs with AI off, so a suggestion is written into the isolated library the way a finished job leaves one
// (seed_suggestion.py). Everything after that is the real interface against the real routes.
function seedSuggestion(id, suggestion, { stale = false } = {}) {
  execFileSync(process.env.LA_E2E_PYTHON || 'python3', [fileURLToPath(new URL('./seed_suggestion.py', import.meta.url)), id, JSON.stringify(suggestion), ...(stale ? ['stale'] : [])], { encoding: 'utf8' });
}

const position = page => page.getByTestId('review-position');
const current = (page, title) => page.getByRole('heading', { level: 2, name: title, exact: true });
// The newest message on the island. An older one may still be on its way out of the page.
const pill = (page, text) => page.locator('#toasts').getByRole('status').filter({ hasText: text }).last();
const putAway = (page, text) => pill(page, text).getByRole('button', { name: 'Dismiss notification', exact: true }).click();

test('Needs review is a queue: one answer per save, undone from the island, and a refusal that changes nothing', async ({ page, context }) => {
  await login(page);
  const key = uniqueName('queue').split(' ').at(-1);
  const collectionName = `Dinners ${key}`;
  const collection = await createCollection(page, collectionName);
  const titles = ['Amber', 'Blue', 'Coral', 'Dune'].map(name => `${name} review ${key}`);
  const imported = await importJSON(page, {
    format: 'little-archive', version: 1,
    items: titles.map((title, index) => ({
      url: `https://example.com/review/${key}/${index}`, title, manual_title: false, needs_review: true,
      caption: index === 0 ? `Two cups of basmati and one whole chicken ${key}` : '', tags: index === 0 ? ['rice'] : [],
    })),
  });
  expect(imported.result.created).toBe(4);
  await closeDialog(imported.dialog);
  const listed = await (await context.request.get('/api/items', { params: { q: key, sort: 'title' } })).json();
  const [amber, blue, coral, dune] = listed.items;
  expect(listed.items.map(item => item.title)).toEqual(titles);
  const read = async item => (await context.request.get(`/api/items/${item.id}`)).json();

  seedSuggestion(amber.id, {
    suggested_title: `Amber machboos ${key}`, summary: 'Chicken machboos with basmati.', topics: ['rice', `chicken-${key}`], content_type: 'post', category: 'Recipes',
    suggested_folder: collectionName, evidence_level: 'caption-based', evidence_sources: ['caption'], evidence_note: 'The video and pictures were not seen.',
  });
  // A suggestion made before the save was edited: the server will refuse to accept it.
  seedSuggestion(blue.id, { summary: 'A day trip.', topics: [`trip-${key}`], content_type: 'post', category: 'Travel', evidence_level: 'text-only', evidence_sources: ['title'] }, { stale: true });

  const answers = [];
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (request.method() !== 'GET' && /^\/api\/items\//.test(path)) answers.push(`${request.method()} ${path.replace(/^\/api\/items\/[^/]+/, '')}`);
  });

  // The address carries the view and its narrowing, as on the wall.
  await page.goto(`/#/review?q=${key}&sort=title`);
  await expect(page.getByRole('heading', { level: 1, name: 'Needs review', exact: true })).toBeVisible();
  await expect(position(page)).toHaveText('1 of 4');
  const strip = page.getByRole('progressbar', { name: 'Reviewed', exact: true });
  await expect(strip).toHaveAttribute('aria-valuenow', '0');
  await expect(strip).toHaveAttribute('aria-valuemax', '4');
  await expect(page.getByText(`Only saves matching “${key}”.`)).toBeVisible();

  // One save: what would change, and what that rests on, in words.
  const card = page.locator('article[data-item-id]');
  await expect(current(page, amber.title)).toBeVisible();
  await expect(card).toHaveAttribute('data-item-id', amber.id);
  await expect(card.getByText('Recipes', { exact: true })).toBeVisible();
  await expect(card.getByText(collectionName, { exact: true })).toBeVisible();
  // Only the topic the save does not already have.
  await expect(card.locator('dd').filter({ hasText: `chicken-${key}` })).toHaveText(`chicken-${key}`);
  await expect(card.getByText(`Amber machboos ${key}`, { exact: true })).toBeVisible();
  await expect(card.getByTestId('evidence-label')).toHaveText('From the caption');
  await expect(card.locator('q')).toHaveText(`Two cups of basmati and one whole chicken ${key}`);
  await expect(card.locator('q')).toHaveAttribute('dir', 'auto');
  await expect(card.getByText('The video and pictures were not seen.')).toBeVisible();

  // Accept: the next save is there at once, and nothing has been sent.
  await page.getByRole('button', { name: 'Accept', exact: true }).press('Enter');
  await expect(current(page, blue.title)).toBeVisible();
  await expect(position(page)).toHaveText('2 of 4');
  await expect(strip).toHaveAttribute('aria-valuenow', '1');
  await expect(pill(page, `Filed in ${collectionName}`)).toBeVisible();
  expect(await read(amber)).toMatchObject({ needs_review: true, title: amber.title, tags: ['rice'] });
  // Undo: back to the save, still nothing sent.
  await pill(page, `Filed in ${collectionName}`).getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(current(page, amber.title)).toBeVisible();
  await expect(position(page)).toHaveText('1 of 4');
  expect(answers).toEqual([]);

  // Accept again and give up the Undo: now the server is told, and the suggestion is applied.
  await page.getByRole('button', { name: 'Accept', exact: true }).click();
  await apiAction(page, 'POST', `/api/items/${amber.id}/ai/accept`, () => putAway(page, `Filed in ${collectionName}`));
  await expect.poll(async () => (await read(amber)).needs_review).toBe(false);
  const accepted = await read(amber);
  expect(accepted.title).toBe(`Amber machboos ${key}`);
  expect(accepted.tags).toEqual(expect.arrayContaining(['rice', `chicken-${key}`]));
  expect(accepted.collections).toContainEqual(expect.objectContaining({ id: collection.id }));
  await expect(position(page)).toHaveText('2 of 4');

  // A refused answer: the save comes back, says nothing changed, and nothing did.
  await expect(current(page, blue.title)).toBeVisible();
  await page.getByRole('button', { name: 'Accept', exact: true }).click();
  await expect(current(page, coral.title)).toBeVisible();
  const refused = page.waitForResponse(response => new URL(response.url()).pathname === `/api/items/${blue.id}/ai/accept`);
  await putAway(page, 'Suggestion accepted');
  expect((await refused).status()).toBe(409);
  await expect(page.getByRole('alert')).toContainText('That was not saved.');
  await expect(page.getByRole('alert')).toContainText(`“${blue.title}” is unchanged. Your other answers are safe.`);
  await expect(current(page, blue.title)).toBeVisible();
  await expect(position(page)).toHaveText('2 of 4');
  await expect(page.getByRole('button', { name: 'Try again', exact: true })).toBeVisible();
  expect(await read(blue)).toMatchObject({ needs_review: true, tags: [] });

  // Leave it for later, then change something first: the usual save detail opens over the queue.
  await page.getByRole('button', { name: 'Leave it for later', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(current(page, coral.title)).toBeVisible();
  await page.getByRole('button', { name: 'Change something first', exact: true }).click();
  await expect(detailPanel(page).getByLabel('Title', { exact: true })).toHaveValue(coral.title);
  await closeDialog(detailPanel(page));

  // A save with no suggestion has one answer. Each answer sends the one before it.
  await expect(page.getByText('There is no suggestion for this save.', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Accept', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Mark as reviewed', exact: true }).click();
  await expect(current(page, dune.title)).toBeVisible();
  await apiAction(page, 'PATCH', `/api/items/${coral.id}`, () => page.getByRole('button', { name: 'Mark as reviewed', exact: true }).click());

  // The end of the first pass: what was decided, and the one left for later.
  await expect(page.getByRole('heading', { level: 2, name: 'That is the end of the queue.', exact: true })).toBeVisible();
  await expect(page.getByText('1 accepted, 2 kept as they were. One save was left for later.')).toBeVisible();
  await apiAction(page, 'PATCH', `/api/items/${dune.id}`, () => putAway(page, 'Marked as reviewed'));
  await page.getByRole('button', { name: 'Go through it again', exact: true }).click();
  await expect(current(page, blue.title)).toBeVisible();
  await expect(position(page)).toHaveText('4 of 4');

  // Keep as it is: the suggestion is dismissed and the save is otherwise untouched.
  await page.getByRole('button', { name: 'Keep as it is', exact: true }).click();
  await expect(page.getByRole('heading', { level: 2, name: 'All reviewed.', exact: true })).toBeVisible();
  await expect(page.getByText('1 accepted, 3 kept as they were.', { exact: false })).toBeVisible();
  await expect(strip).toHaveAttribute('aria-valuenow', '4');
  await apiAction(page, 'POST', `/api/items/${blue.id}/ai/dismiss`, () => putAway(page, 'Kept as it was'));
  await expect.poll(async () => (await read(blue)).needs_review).toBe(false);
  expect(await read(blue)).toMatchObject({ title: blue.title, tags: [], ai: null });
  expect((await (await context.request.get('/api/items', { params: { q: key, needs_review: true } })).json()).total).toBe(0);
  expect(answers).toEqual(['POST /ai/accept', 'POST /ai/accept', `PATCH `, 'PATCH ', 'POST /ai/dismiss']);

  // A reload of an empty queue says so, with no count from before.
  await page.reload();
  await expect(page.getByRole('heading', { level: 2, name: 'Nothing to review.', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Back to your library', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'All saves', exact: true })).toBeVisible();
});
