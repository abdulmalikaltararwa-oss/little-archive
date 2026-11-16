// The question field: one large box with a mono prompt, the quiet narrowing row, a character count and the
// Ask button. Enter asks and Shift+Enter starts a new line; Enter while an input method is composing a word
// (Arabic, Japanese, Chinese) belongs to the input method and is left alone.
import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { cn } from 'cn';
import { CornerDownLeft, Folder, Globe, Tag, X } from 'lucide-react';
import { useArchive, useArchiveState } from '@/app/archive-context';
import { Button } from '@/components/ui/button';
import { allowAi } from '@/features/ai-permission/gate';
import { QUESTION_MAX } from './api';
import { checkQuestion, COMPOSER_ID, isNarrowed, NO_FILTERS, problemText, SOURCE_NAMES } from './logic';
import { NarrowMenu, type NarrowOption } from './narrow-menu';
import type { AskSession } from './session';
import { useAskState } from './use-ask';

const MAX_HEIGHT = 192;

export function Composer({ session }: { session: AskSession }) {
  const archive = useArchive();
  const draft = useAskState(session, state => state.draft);
  const filters = useAskState(session, state => state.filters);
  const stats = useArchiveState(state => state.stats);
  const collections = useArchiveState(state => state.collections);
  const tags = useArchiveState(state => state.tags);
  const field = useRef<HTMLTextAreaElement>(null);
  const [tried, setTried] = useState(false);

  const check = checkQuestion(draft);
  // Too long is said at once; too short or empty only once the person has tried to ask.
  const problem = check.over || tried ? problemText(check) : '';

  const sources = useMemo<NarrowOption[]>(() => [
    { value: '', label: 'Any source' },
    ...(['instagram', 'tiktok', 'web'] as const).map(platform => ({ value: platform, label: SOURCE_NAMES[platform], hint: stats.platforms?.[platform] != null ? String(stats.platforms[platform]) : undefined })),
  ], [stats.platforms]);
  const collectionOptions = useMemo<NarrowOption[]>(() => [
    { value: '', label: 'Any collection' },
    ...collections.map(collection => ({ value: collection.id, label: collection.name, hint: collection.count != null ? String(collection.count) : undefined })),
  ], [collections]);
  const topicOptions = useMemo<NarrowOption[]>(() => [{ value: '', label: 'Any topic' }, ...tags.map(tag => ({ value: tag.name, label: tag.name, hint: String(tag.count) }))], [tags]);

  // The box grows with what is typed, up to a few lines, then scrolls.
  useLayoutEffect(() => {
    const box = field.current;
    if (!box) return;
    box.style.height = 'auto';
    box.style.height = `${Math.min(box.scrollHeight, MAX_HEIGHT)}px`;
  }, [draft]);

  const submit = async () => {
    if (!check.ok) { setTried(true); return; }
    // Asked before the question joins the page: on "Not now" it stays in the box and nothing is sent.
    if (!(await allowAi(archive, 'ask'))) return;
    if (!session.submit()) return;
    setTried(false);
    // On a phone the keyboard would cover the answer.
    if (typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches) field.current?.blur();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    void submit();
  };

  const hintId = `${COMPOSER_ID}-hint`;
  const countId = `${COMPOSER_ID}-count`;
  const problemId = `${COMPOSER_ID}-problem`;
  const near = check.count >= QUESTION_MAX - 50;
  return (
    <form
      onSubmit={event => { event.preventDefault(); void submit(); }}
      aria-label="Ask a question"
      className="rounded-lg border border-line-strong bg-card shadow-xs transition-[border-color,box-shadow] duration-200 focus-within:border-sage focus-within:ring-4 focus-within:ring-sage/15 dark:bg-card-2"
    >
      <div className="flex gap-3 px-4 pt-4 sm:px-5 sm:pt-5">
        <span aria-hidden="true" className="pt-0.5 font-mono text-lg leading-relaxed text-petal-ink select-none">&gt;</span>
        <label htmlFor={COMPOSER_ID} className="sr-only">Your question</label>
        <span id={hintId} className="sr-only">Enter asks. Shift and Enter start a new line.</span>
        <textarea
          ref={field}
          id={COMPOSER_ID}
          rows={2}
          value={draft}
          dir="auto"
          enterKeyHint="send"
          placeholder="What are you trying to remember?"
          title="Enter asks. Shift+Enter starts a new line."
          aria-describedby={`${hintId} ${countId}${problem ? ` ${problemId}` : ''}`}
          aria-invalid={Boolean(problem) || undefined}
          onChange={event => session.dispatch({ type: 'drafted', text: event.target.value })}
          onKeyDown={onKeyDown}
          className="block max-h-48 min-h-[3.25rem] w-full min-w-0 resize-none bg-transparent text-lg leading-relaxed text-ink outline-none placeholder:text-ink-soft/70"
        />
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-3 border-t border-line px-3 py-3 sm:px-4">
        <div role="group" aria-label="Narrow the question to part of your archive" className="flex min-w-0 flex-wrap items-center gap-2">
          <NarrowMenu label="Source" icon={<Globe />} value={filters.platform} options={sources} onChange={value => session.dispatch({ type: 'narrowed', filters: { platform: value as typeof filters.platform } })} />
          <NarrowMenu label="Collection" icon={<Folder />} value={filters.collection_id} shownAs="A collection that is gone" options={collectionOptions} searchable={collections.length > 6} onChange={value => session.dispatch({ type: 'narrowed', filters: { collection_id: value } })} />
          <NarrowMenu label="Topic" icon={<Tag />} value={filters.tag} options={topicOptions} searchable onChange={value => session.dispatch({ type: 'narrowed', filters: { tag: value } })} />
          {isNarrowed(filters) ? (
            <button type="button" onClick={() => session.dispatch({ type: 'narrowed', filters: NO_FILTERS })} className="hit-44 inline-flex h-9 items-center gap-1 rounded-full px-2 text-xs text-ink-soft outline-none hov:text-ink coarse:h-11"><X className="size-3.5" aria-hidden="true" />Clear</button>
          ) : null}
        </div>
        <div className="ms-auto flex items-center gap-3">
          <span id={countId} className={cn('num text-2xs', check.over ? 'text-danger' : near ? 'text-butter-ink' : 'text-ink-soft')}>
            {check.count.toLocaleString()} / {QUESTION_MAX}
            <span className="sr-only"> characters</span>
          </span>
          <Button type="submit" variant="primary" disabled={!check.ok}>
            Ask
            <CornerDownLeft aria-hidden="true" />
          </Button>
        </div>
      </div>
      {problem ? <p id={problemId} role="status" className="border-t border-danger/20 bg-danger-pale rounded-b-lg px-4 py-2 text-xs text-danger sm:px-5">{problem}</p> : null}
    </form>
  );
}
