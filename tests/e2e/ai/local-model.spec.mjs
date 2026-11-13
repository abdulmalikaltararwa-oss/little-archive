import { test, expect, apiAction, closeDialog, importJSON, login, openItem, search, uniqueName, waitForItems } from '../fixtures.mjs';

test('real local inference queues the complete scope and supports acceptance, dismissal, and persisted review', async ({ page, context }) => {
  await login(page);
  const key = uniqueName('local model').split(' ').at(-1);
  const collectionName = `Original weekend saves ${key}`;
  const records = [
    {
      url: `https://www.instagram.com/p/AI${key}/`, source_account: `synthetic-${key}`,
      title: `Weeknight lemon pasta ${key}`,
      caption: 'A simple pasta recipe using lemon juice, olive oil, parsley, and reserved pasta water. Cook pasta, toss with the sauce, and serve warm.',
      notes: 'Synthetic test note: try this recipe on Friday.', tags: ['my-label'],
      collections: [{ name: collectionName, kind: 'source', source_key: 'weekend-saves' }],
    },
    {
      url: `https://example.com/synthetic-reading-corner/${key}`,
      title: `A quiet reading corner ${key}`,
      caption: 'Interior design ideas for a small reading nook: a comfortable armchair, a warm lamp, and a low shelf for books.',
      notes: 'Synthetic test note: keep my own title and notes.', tags: ['my-label'],
    },
  ];
  const imported = await importJSON(page, { format: 'little-archive', version: 1, items: records });
  expect(imported.result.created).toBe(2);
  await closeDialog(imported.dialog);
  await search(page, key);
  await expect(page.locator('article.card')).toHaveCount(2);
  await page.getByRole('button', { name: 'Organize library', exact: true }).click();
  const organize = page.getByRole('dialog', { name: 'Organize your library', exact: true });
  await organize.getByLabel('Organization scope', { exact: true }).selectOption('view');
  await expect(organize.getByRole('button', { name: 'Queue topic suggestions', exact: true })).toBeEnabled();
  const queued = await apiAction(page, 'POST', '/api/ai/jobs', () => organize.getByRole('button', { name: 'Queue topic suggestions', exact: true }).click());
  expect(queued.request().postDataJSON()).toEqual({ filters: { q: key } });
  expect(await queued.json()).toEqual({ queued: 2, matched: 2, unchanged: 0 });
  const activity = page.getByRole('dialog', { name: 'A little activity', exact: true });
  await expect(activity.getByRole('button', { name: 'AI jobs', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(activity.getByRole('status', { name: 'Classification progress' })).toBeVisible();

  // The server really calls the prestarted loopback Ollama service; no response
  // is stubbed. Polling only observes the actual durable job state.
  await expect.poll(async () => {
    const result = await (await context.request.get('/api/ai/jobs')).json();
    return { completed: result.counts.completed, failed: result.counts.failed };
  }, { message: 'The real local model must complete both classification jobs.', timeout: 3 * 60_000, intervals: [1000, 2000, 3000] }).toEqual({ completed: 2, failed: 0 });
  await expect(activity.locator('.job-counts span').filter({ hasText: 'Completed' }).locator('strong')).toHaveText('2', { timeout: 15_000 });
  await expect(activity.locator('.job-counts span').filter({ hasText: 'Queued' }).locator('strong')).toHaveText('0');
  await expect(activity.locator('.job-counts span').filter({ hasText: 'Running' }).locator('strong')).toHaveText('0');
  const listed = await (await context.request.get('/api/items', { params: { q: key } })).json();
  const first = listed.items.find(item => item.title === records[0].title);
  const second = listed.items.find(item => item.title === records[1].title);
  for (const item of [first, second]) {
    expect(item.ai.evidence_level).toBe('caption-based');
    expect(item.ai.summary.length).toBeGreaterThan(0);
    expect(item.ai.topics.length).toBeGreaterThan(0);
    expect(item.tags).toEqual(['my-label']);
    expect(item.needs_review).toBe(true);
  }
  await activity.locator('.activity-row').filter({ hasText: records[0].title }).getByRole('button', { name: 'Open save', exact: true }).click();
  const detail = page.getByRole('dialog', { name: 'A closer look', exact: true });
  await expect(detail.getByLabel('Title', { exact: true })).toHaveValue(records[0].title);
  await expect(detail.locator('[aria-label="AI suggestion"]')).toBeVisible();
  const acceptedResponse = await apiAction(page, 'POST', `/api/items/${first.id}/ai/accept`, () => detail.getByRole('button', { name: 'Accept suggestions', exact: true }).click());
  const accepted = await acceptedResponse.json();
  expect(accepted).toMatchObject({ title: records[0].title, notes: records[0].notes, summary: first.ai.summary, needs_review: false });
  expect(accepted.tags).toEqual(expect.arrayContaining(['my-label', ...first.ai.topics]));
  expect(accepted.collections).toContainEqual(expect.objectContaining({ name: collectionName, kind: 'source' }));
  await expect(detail.locator('[aria-label="AI suggestion"]')).toHaveCount(0);
  await closeDialog(detail);

  const secondDetail = await openItem(page, records[1].title);
  await apiAction(page, 'POST', `/api/items/${second.id}/ai/dismiss`, () => secondDetail.getByRole('button', { name: 'Dismiss', exact: true }).click());
  await expect(secondDetail.locator('[aria-label="AI suggestion"]')).toHaveCount(0);
  const dismissed = await (await context.request.get(`/api/items/${second.id}`)).json();
  expect(dismissed).toMatchObject({ ai: null, needs_review: false, title: records[1].title, notes: records[1].notes, tags: ['my-label'] });
  await closeDialog(secondDetail);
  await page.reload();
  await waitForItems(page);
  await search(page, key);
  const persisted = await openItem(page, records[0].title);
  await expect(persisted.getByLabel('Summary', { exact: true })).toHaveValue(accepted.summary);
  await expect(persisted.getByLabel('Topics', { exact: true })).toHaveValue(accepted.tags.join(', '));
  await expect(persisted.getByLabel('Keep in Needs review', { exact: true })).not.toBeChecked();
  await closeDialog(persisted);

  await page.getByRole('button', { name: 'Organize library', exact: true }).click();
  const repeat = page.getByRole('dialog', { name: 'Organize your library', exact: true });
  await repeat.getByLabel('Organization scope', { exact: true }).selectOption('view');
  const unchanged = await apiAction(page, 'POST', '/api/ai/jobs', () => repeat.getByRole('button', { name: 'Queue topic suggestions', exact: true }).click());
  expect(await unchanged.json()).toEqual({ queued: 0, matched: 2, unchanged: 2 });
});
