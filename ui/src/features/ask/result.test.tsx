import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { ArchiveProvider } from '@/app/archive-context';
import type { Archive } from '@/data/archive';
import { aiTrouble, answered, citation, heldBack, nothingSaved, notShown, rankedOnly, source } from './fixtures';
import { Echo, Evidence, Outcome } from './result';
import { createAskSession } from './session';
import type { Entry } from './logic';

// The motion library and the ASCII spinner ask whether motion is reduced; jsdom has no matchMedia.
beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({ matches: query.includes('reduce'), media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false, onchange: null }),
  });
});
afterEach(cleanup);

const NO_FILTERS = { platform: '', collection_id: '', tag: '' } as const;

function view(state: Entry['state'], question = 'What was that lemon pasta recipe I saved?') {
  const openItem = vi.fn(async () => true);
  const archive = { store: createStore(() => ({ collections: [] })), openItem, api: { request: vi.fn() } } as unknown as Archive;
  const session = createAskSession(archive);
  const entry: Entry = { id: 'ask-1', question, filters: NO_FILTERS, state };
  render(
    <ArchiveProvider archive={archive}>
      <Echo entry={entry} />
      <div aria-live="polite"><Outcome entry={entry} session={session} /></div>
      <Evidence entry={entry} />
    </ArchiveProvider>,
  );
  return { openItem };
}

const HOSTILE = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script> [x](javascript:alert(1)) **bold**';

describe('what the screen draws for untrusted text', () => {
  it('shows every field the server sends as the characters it is: no element, no link, no script', () => {
    view({
      status: 'done',
      response: answered({
        question: HOSTILE,
        answer: HOSTILE,
        citations: [citation({ quote: HOSTILE, title: HOSTILE, url: 'javascript:alert(1)' })],
        sources: [source({ title: HOSTILE, snippet: HOSTILE, url: 'javascript:alert(2)', used_in_answer: true, match_in: ['<b>title</b>'] })],
        ai: { available: true, provider: HOSTILE, model: HOSTILE },
        evidence: { level: 'caption-based', sources: ['caption'], note: HOSTILE },
      }),
    }, HOSTILE);
    expect(document.querySelector('img, script, iframe, style, a[href]')).toBeNull();
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
    expect(screen.getByTestId('answer-text')).toHaveTextContent(HOSTILE);
    expect(screen.getByTestId('answer-text')).toHaveAttribute('dir', 'auto');
    expect(screen.getByTestId('answer-text').style.whiteSpace || screen.getByTestId('answer-text').className).toMatch(/pre-wrap/);
  });

  it('opens a save through the archive when a quote or a ranked save is chosen, and not by a link', async () => {
    const { openItem } = view({ status: 'done', response: answered() });
    await userEvent.click(screen.getAllByRole('button', { name: 'Open Lemon pasta with garlic' })[0]!);
    expect(openItem).toHaveBeenCalledWith('item-pasta');
    await userEvent.click(screen.getByRole('button', { name: 'Open Lemon squash' }));
    expect(openItem).toHaveBeenLastCalledWith('item-squash');
  });
});

describe('what the screen says for each outcome', () => {
  const cases: [string, Entry['state'], RegExp][] = [
    ['an answer', { status: 'done', response: answered() }, /From your saves/],
    ['no AI', { status: 'done', response: rankedOnly() }, /This server has no AI set up/],
    ['nothing saved', { status: 'done', response: nothingSaved() }, /Nothing saved about that\./],
    ['the AI being down', { status: 'done', response: aiTrouble('ai_failed') }, /The AI could not answer just now/],
    ['an unusable reply', { status: 'done', response: aiTrouble('ai_invalid') }, /could not be used/],
    ['not in your saves', { status: 'done', response: notShown('not_in_saves') }, /do not seem to say/],
    ['an unchecked answer', { status: 'done', response: notShown('unverified') }, /An answer was held back/],
    ['instructions in a save', { status: 'done', response: heldBack('contains_instructions') }, /Nothing was sent to the AI/],
    ['nothing shareable', { status: 'done', response: heldBack('no_shareable_text') }, /nothing it may read/],
  ];
  it.each(cases)('%s', (_name, state, heading) => {
    view(state);
    expect(screen.getByRole('heading', { name: heading })).toBeInTheDocument();
  });

  it('shows the server’s notice, as the server’s, and the AI service’s own message when it failed', () => {
    view({ status: 'done', response: aiTrouble('ai_failed') });
    expect(screen.getByText(/The AI provider could not answer just now, so these are the best-matching saves only\./)).toBeInTheDocument();
    expect(screen.getByText('The local model service could not be reached.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Try again/ })).toBeInTheDocument();
  });

  it('says why a save was held back, and that a cited one was cited', () => {
    view({ status: 'done', response: answered({ sources: [source({ used_in_answer: true }), source({ item_id: 'x', title: 'Full', withheld_from_answer: 'context_full' }), source({ item_id: 'y', title: 'Odd', withheld_from_answer: 'contains_instructions' })] }) });
    expect(screen.getByText('Cited')).toBeInTheDocument();
    expect(screen.getByText(/no room left for it/)).toBeInTheDocument();
    expect(screen.getByText(/looks like instructions to an AI/)).toBeInTheDocument();
  });

  it('labels an answer with what it rests on and who wrote it', () => {
    view({ status: 'done', response: answered() });
    expect(screen.getByTestId('evidence-label')).toHaveTextContent('From captions');
    expect(screen.getByText('stub · stub-model-1')).toBeInTheDocument();
    expect(within(screen.getByRole('heading', { name: 'From your saves' }).closest('section')!).getByText(/pictures and videos themselves were not seen/)).toBeInTheDocument();
  });

  it('says nothing about quotes when there are none, and nothing about sources when nothing matched', () => {
    view({ status: 'done', response: nothingSaved() });
    expect(screen.queryByText(/quotes from your saves/i)).toBeNull();
    expect(screen.queryByRole('list', { name: /Saves, best match first/ })).toBeNull();
  });

  it('shows a real failure as an alert, with a way to try again', () => {
    view({ status: 'error', message: 'Could not reach your archive. Check that the server is running and try again.', httpStatus: 0 });
    expect(screen.getByRole('alert')).toHaveTextContent('Could not reach your archive.');
    expect(screen.getByRole('button', { name: /Try again/ })).toBeInTheDocument();
  });

  it('does not offer to retry a question the server refused (422)', () => {
    view({ status: 'error', message: 'Ask a question in words.', httpStatus: 422 });
    expect(screen.queryByRole('button', { name: /Try again/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Change the question' })).toBeInTheDocument();
  });

  it('says it is reading while a question waits, as a status with a stop button', () => {
    view({ status: 'pending' });
    expect(screen.getByRole('status')).toHaveTextContent(/reading your saves/i);
    expect(screen.getByRole('progressbar', { name: 'Reading your saves' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument();
  });

  it('mentions quietly when the AI could not be given everything', () => {
    view({ status: 'done', response: answered({ context: { saves: 3, passages: 5, chars: 900, truncated: true } }) });
    expect(screen.getByText(/More saves matched than fit/)).toBeInTheDocument();
  });
});
