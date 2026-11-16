// The command palette: type to find a save, jump to a view, or do something. One field for the whole app.
// Saves are searched by the server (it owns the text index); views and actions are matched here.
// Before anything is typed it offers the searches made on this device and a few built from the library's own
// counts, so the common ones are one tap. On a phone the field sits at the bottom edge, above the keyboard.
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react';
import { countLabel, errorMessage, hostLabel, PLATFORM_NAMES } from '@web/utils.js';
import { Command as CommandPrimitive } from 'cmdk';
import { cn } from 'cn';
import { Activity, Archive, Bookmark, Clock, CookingPot, CornerDownLeft, Folder, Heart, LayoutGrid, MapPinned, MessageCircleQuestion, Monitor, Moon, Plus, Route, Search, Settings, Sparkles, Sun, Tag as TagIcon, Upload } from 'lucide-react';
import { Dialog } from 'radix-ui';
import { useArchive, useArchiveState } from '@/app/archive-context';
import { useTheme } from '@/app/theme';
import { openDialog, type OpenDialog } from '@/app/ui-state';
import { Whisper } from '@/components/field';
import { Ascii, AsciiSpinner } from '@/components/fx/ascii';
import { PlatformIcon } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { HOME, type Loc } from '@/data/location';
import type { Item } from '@/data/types';
import { restoreFocus } from '@/lib/focus';
import { addRecent, clearRecent, readRecent, RECENT_SHOWN } from './recent';
import { foundLine, librarySuggestions, markWords, narrowBySource, queryWords, searchWhisper, topTopics, type Segment, type Suggestion } from './suggest';

interface Entry {
  id: string;
  label: string;
  hint?: string;
  /** A count beside the label, in plain figures. */
  count?: string;
  icon: ReactNode;
  words?: string;
  run(): void;
}

const matches = (entry: Entry, query: string) => !query || `${entry.label} ${entry.words ?? ''}`.toLowerCase().includes(query);

function Row({ entry, onRun }: { entry: Entry; onRun(entry: Entry): void }) {
  return (
    <CommandPrimitive.Item
      value={entry.id}
      onSelect={() => onRun(entry)}
      className="flex min-h-11 cursor-default items-center gap-3 rounded-md px-3 text-sm text-ink select-none data-[selected=true]:bg-sage-pale [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-ink-soft"
    >
      {entry.icon}
      <span dir="auto" className="min-w-0 flex-1 truncate">{entry.label}</span>
      {entry.hint ? <span className="label-mono shrink-0">{entry.hint}</span> : null}
      {entry.count ? <span className="num shrink-0 text-xs text-ink-soft">{entry.count}</span> : null}
    </CommandPrimitive.Item>
  );
}

function Heading({ children }: { children: string }) {
  return <span className="label-mono px-3 pt-3 pb-1.5">{children}</span>;
}

const CHIP = 'inline-flex min-h-11 max-w-full cursor-default items-center gap-1.5 rounded-full border border-line bg-card px-3.5 text-sm text-ink select-none dark:bg-card-2 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-ink-soft';

function ChipBody({ icon, children, count }: { icon?: ReactNode; children: ReactNode; count?: number }) {
  return (
    <>
      {icon}
      <span dir="auto" className="min-w-0 truncate">{children}</span>
      {count != null ? <span className="num shrink-0 text-xs text-ink-soft">{count.toLocaleString('en')}</span> : null}
    </>
  );
}

/** A finished search as a pill: one tap (or Enter) runs it. */
function Chip({ id, onRun, icon, children, count }: { id: string; onRun(): void; icon?: ReactNode; children: ReactNode; count?: number }) {
  return (
    <CommandPrimitive.Item value={id} onSelect={onRun} className={cn(CHIP, 'data-[selected=true]:border-sage data-[selected=true]:bg-sage-pale')}>
      <ChipBody icon={icon} count={count}>{children}</ChipBody>
    </CommandPrimitive.Item>
  );
}

/** Text with the searched words marked. The mark is a tint behind real text, so it reads the same without it. */
function Marked({ segments }: { segments: readonly Segment[] }) {
  return <>{segments.map((segment, index) => (segment.hit ? <mark key={index} className="rounded-[4px] bg-butter-pale px-0.5 text-ink">{segment.text}</mark> : segment.text))}</>;
}

/** A found save: its title with the words marked, and under it where the words were found. */
function SaveRow({ item, words, onRun }: { item: Item; words: readonly string[]; onRun(): void }) {
  const line = foundLine(item, words);
  return (
    <CommandPrimitive.Item
      value={`save-${item.id}`}
      onSelect={onRun}
      className="flex min-h-14 cursor-default items-center gap-3 rounded-md px-3 py-1.5 text-ink select-none data-[selected=true]:bg-sage-pale"
    >
      <span aria-hidden="true" className="grid size-10 shrink-0 place-items-center rounded-lg bg-card-2 text-ink-soft dark:bg-card-3 [&_svg]:size-4"><PlatformIcon platform={item.platform} /></span>
      <span className="min-w-0 flex-1">
        <span dir="auto" className="block truncate text-sm font-semibold"><Marked segments={markWords(item.title || hostLabel(item.url), words)} /></span>
        <span dir="auto" className="block truncate text-xs text-ink-soft">
          {line.label}
          {line.quote ? <>: “<Marked segments={line.quote} />”</> : null}
        </span>
      </span>
    </CommandPrimitive.Item>
  );
}

const SUGGESTION_ICONS: Record<'tag' | 'folder' | 'clock' | 'heart', ReactNode> = {
  tag: <TagIcon aria-hidden="true" />, folder: <Folder aria-hidden="true" />, clock: <Clock aria-hidden="true" />, heart: <Heart aria-hidden="true" />,
};
const suggestionIcon = (icon: Suggestion['icon']) => (icon === 'instagram' || icon === 'tiktok' || icon === 'web' ? <PlatformIcon platform={icon} /> : SUGGESTION_ICONS[icon]);

/**
 * The part of the screen that is not under the on-screen keyboard, as "height|top". A browser reports it as the visual
 * viewport; the palette's phone layout is sized to it so its field stays above the keyboard. Where it is not reported
 * the layout falls back to the whole screen.
 */
function watchViewport(changed: () => void) {
  const viewport = globalThis.visualViewport;
  if (!viewport) return () => {};
  viewport.addEventListener('resize', changed);
  viewport.addEventListener('scroll', changed);
  return () => { viewport.removeEventListener('resize', changed); viewport.removeEventListener('scroll', changed); };
}
const readViewport = () => {
  const viewport = globalThis.visualViewport;
  return viewport ? `${Math.round(viewport.height)}|${Math.round(viewport.offsetTop)}` : '';
};

const WIDE = '(min-width: 640px)';
function watchWide(changed: () => void) {
  const query = globalThis.matchMedia?.(WIDE);
  if (!query) return () => {};
  query.addEventListener('change', changed);
  return () => query.removeEventListener('change', changed);
}

export function CommandPalette({ spec, close }: { spec: OpenDialog; close(): void }) {
  const archive = useArchive();
  const collections = useArchiveState(state => state.collections);
  const tags = useArchiveState(state => state.tags);
  const stats = useArchiveState(state => state.stats);
  const setTheme = useTheme(state => state.set);
  const remembers = archive.backend.remembers;
  const input = useRef<HTMLInputElement>(null);
  const [text, setText] = useState('');
  const [found, setFound] = useState<{ query: string; items: Item[]; total: number; error: string }>({ query: '', items: [], total: 0, error: '' });
  const [recent, setRecent] = useState(() => readRecent(remembers).slice(0, RECENT_SHOWN));
  const [recentCounts, setRecentCounts] = useState<Record<string, number>>({});
  const query = text.trim();
  const lower = query.toLowerCase();
  const words = queryWords(query);
  const viewport = useSyncExternalStore(watchViewport, readViewport, () => '');
  const wide = useSyncExternalStore(watchWide, () => globalThis.matchMedia?.(WIDE).matches ?? true, () => true);

  // Ask the server once the typing pauses. An answer to an older question is ignored.
  useEffect(() => {
    if (query.length < 2) return;
    let stale = false;
    const timer = setTimeout(() => {
      archive.api.items({ q: query }, 0, 6).then(
        result => { if (!stale) setFound({ query, items: result.items, total: result.total, error: '' }); },
        error => { if (!stale) setFound({ query, items: [], total: 0, error: errorMessage(error) }); },
      );
    }, 180);
    return () => { stale = true; clearTimeout(timer); };
  }, [archive, query]);

  // How many saves each recent search finds now, asked once when the palette opens. A count that cannot be had is left out.
  const [asked] = useState(recent);
  useEffect(() => {
    let stale = false;
    for (const entry of asked) {
      archive.api.items({ q: entry }, 0, 1).then(
        result => { if (!stale) setRecentCounts(counts => ({ ...counts, [entry]: result.total })); },
        () => {},
      );
    }
    return () => { stale = true; };
  }, [archive, asked]);

  const run = (entry: Entry) => { close(); entry.run(); };
  /** For an entry that closes the palette itself. */
  const direct = (entry: Entry) => entry.run();
  const go = (to: Partial<Loc>) => { close(); archive.navigate({ ...HOME, ...to }); };
  /** A search that was carried out is remembered on this device. */
  const search = (q: string, to: Partial<Loc> = {}) => { addRecent(remembers, q); go({ ...to, q }); };

  const views = useMemo<Entry[]>(() => [
    { id: 'go-all', label: 'All saves', icon: <LayoutGrid aria-hidden="true" />, words: 'home library everything', run: () => archive.goView('all') },
    { id: 'go-favorites', label: 'Favorites', icon: <Heart aria-hidden="true" />, words: 'loved hearts', run: () => archive.goView('favorites') },
    { id: 'go-revisit', label: 'To revisit', icon: <Clock aria-hidden="true" />, words: 'later', run: () => archive.goView('revisit') },
    { id: 'go-review', label: 'Needs review', icon: <Sparkles aria-hidden="true" />, words: 'suggestions ai', run: () => archive.goView('review') },
    { id: 'go-rediscover', label: 'Rediscover', icon: <Bookmark aria-hidden="true" />, words: 'random shuffle surprise', run: () => archive.goView('rediscover') },
    { id: 'go-archived', label: 'Archived', icon: <Archive aria-hidden="true" />, run: () => archive.goView('archived') },
    { id: 'go-ask', label: 'Ask your archive…', icon: <MessageCircleQuestion aria-hidden="true" />, words: 'question answer', run: () => archive.goScreen('ask') },
    { id: 'go-recipes', label: 'Recipes', icon: <CookingPot aria-hidden="true" />, words: 'cook food ingredients', run: () => archive.goScreen('recipes') },
    { id: 'go-places', label: 'Places', icon: <MapPinned aria-hidden="true" />, words: 'map where travel', run: () => archive.goScreen('places') },
    ...(['instagram', 'tiktok', 'web'] as const).map(platform => ({ id: `go-${platform}`, label: `${PLATFORM_NAMES[platform]} saves`, icon: <PlatformIcon platform={platform} />, words: 'source', run: () => archive.goView(`platform:${platform}`) })),
    ...collections.map(collection => ({ id: `go-collection-${collection.id}`, label: collection.name, hint: collection.kind === 'source' ? 'source' : 'collection', icon: <Folder aria-hidden="true" />, words: 'collection folder', run: () => archive.goView(`collection:${collection.id}`) })),
  ], [archive, collections]);
  const actions = useMemo<Entry[]>(() => [
    { id: 'do-save', label: 'Save a link', icon: <Plus aria-hidden="true" />, words: 'add new url', run: () => openDialog({ kind: 'save-link' }) },
    { id: 'do-import', label: 'Import your saves', icon: <Upload aria-hidden="true" />, words: 'file export bring', run: () => openDialog({ kind: 'import' }) },
    { id: 'do-guided', label: 'Guided Instagram or TikTok import', icon: <Route aria-hidden="true" />, words: 'backlog export archive zip', run: () => archive.goScreen('guided-import') },
    { id: 'do-organize', label: 'Organize library', icon: <Sparkles aria-hidden="true" />, words: 'topics tags ai bulk', run: () => openDialog({ kind: 'organize' }) },
    { id: 'do-activity', label: 'Import activity', icon: <Activity aria-hidden="true" />, words: 'jobs progress', run: () => openDialog({ kind: 'activity' }) },
    { id: 'do-settings', label: 'Settings & connections', icon: <Settings aria-hidden="true" />, words: 'preferences tokens export backup sign out', run: () => openDialog({ kind: 'settings' }) },
    { id: 'do-light', label: 'Appearance: light', icon: <Sun aria-hidden="true" />, words: 'theme', run: () => setTheme('light') },
    { id: 'do-dark', label: 'Appearance: dark', icon: <Moon aria-hidden="true" />, words: 'theme night', run: () => setTheme('dark') },
    { id: 'do-system', label: 'Appearance: match this device', icon: <Monitor aria-hidden="true" />, words: 'theme system auto', run: () => setTheme('system') },
  ], [archive, setTheme]);
  const suggestions = useMemo(() => librarySuggestions({ stats, tags, collections }), [stats, tags, collections]);

  const shownViews = views.filter(entry => matches(entry, lower)).slice(0, lower ? 8 : 6);
  const shownActions = actions.filter(entry => matches(entry, lower)).slice(0, lower ? 8 : 5);
  const answered = query.length >= 2 && found.query === query;
  const saves = answered ? found.items : [];
  const searching = query.length >= 2 && found.query !== query;
  const narrow = answered ? narrowBySource(saves, found.total) : [];
  // The search found no save and the words name no view or action either: say so, instead of offering an empty library.
  const nothing = answered && !found.error && !saves.length && !shownViews.length && !shownActions.length;
  const [height, top] = viewport ? viewport.split('|') : [];

  return (
    <Dialog.Root open={spec.open} onOpenChange={next => { if (!next) close(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-scrim backdrop-blur-[3px] data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <Dialog.Content
          aria-describedby={undefined}
          onCloseAutoFocus={event => { event.preventDefault(); restoreFocus(spec.opener); }}
          style={height ? ({ '--palette-h': `${height}px`, '--palette-top': `${top}px` } as CSSProperties) : undefined}
          className={cn(
            'fixed z-50 flex flex-col overflow-hidden bg-card shadow-lg outline-none',
            // Phone: the whole screen down to the keyboard, with the field at the bottom edge where the thumb is.
            'max-sm:inset-x-0 max-sm:top-[var(--palette-top,0px)] max-sm:h-[var(--palette-h,100dvh)] max-sm:pt-[var(--safe-top)]',
            'sm:inset-x-3 sm:top-[14vh] sm:mx-auto sm:max-h-[min(72dvh,560px)] sm:max-w-[620px] sm:rounded-xl sm:border sm:border-line',
            'duration-200 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0 sm:data-[state=open]:slide-in-from-top-4',
          )}
        >
          <Dialog.Title className="sr-only">Search or jump to anything</Dialog.Title>
          {/* The field comes first in the page (and so for the keyboard and a screen reader); on a phone it is drawn last. */}
          <CommandPrimitive shouldFilter={false} loop label="Search or jump to anything" className="flex min-h-0 flex-1 flex-col max-sm:flex-col-reverse">
            <div className="flex shrink-0 items-center gap-2 border-line max-sm:border-t max-sm:px-3 max-sm:pt-2.5 max-sm:pb-[calc(var(--safe-bottom)+0.625rem)] sm:h-14 sm:gap-3 sm:border-b sm:px-4">
              <div className="flex min-w-0 flex-1 items-center gap-3 max-sm:h-12 max-sm:rounded-full max-sm:border max-sm:border-line-strong max-sm:px-4 max-sm:transition-[border-color,box-shadow] max-sm:focus-within:border-sage max-sm:focus-within:ring-4 max-sm:focus-within:ring-sage/15 sm:h-full dark:max-sm:bg-card-2">
                <span aria-hidden="true" className="font-mono text-base text-petal-ink max-sm:hidden">&gt;</span>
                <Search aria-hidden="true" className="size-4 shrink-0 text-ink-soft sm:hidden" />
                <CommandPrimitive.Input
                  ref={input}
                  value={text}
                  onValueChange={setText}
                  placeholder={wide ? 'Search your saves, or type a command' : 'Search your saves'}
                  dir="auto"
                  enterKeyHint="search"
                  className="h-full min-w-0 flex-1 bg-transparent text-base text-ink outline-none placeholder:text-ink-soft/80"
                />
                {searching ? <AsciiSpinner /> : <kbd aria-hidden="true" className="num rounded-md border border-line bg-card-2 px-1.5 py-0.5 text-2xs text-ink-soft max-sm:hidden">esc</kbd>}
              </div>
              <Button variant="ghost" className="h-11 px-2.5 sm:hidden" onClick={close}>Cancel</Button>
            </div>
            <CommandPrimitive.List className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2 [&_[cmdk-list-sizer]]:flex [&_[cmdk-list-sizer]]:flex-col">
              <p role="status" className="px-3 pt-2 sm:sr-only"><Whisper>{searchWhisper(stats.total, answered && !found.error ? found.total : null)}</Whisper></p>
              {query ? null : (
                <>
                  {recent.length ? (
                    <>
                      <div className="flex items-center justify-between pe-3">
                        <Heading>recent</Heading>
                        <button
                          type="button"
                          aria-label="Clear recent searches"
                          onClick={() => { setRecent(clearRecent(remembers)); input.current?.focus(); }}
                          className="hit-44 mt-1.5 rounded-sm text-xs font-semibold text-sage hov:underline dark:text-sage-deep"
                        >
                          Clear
                        </button>
                      </div>
                      {recent.map(entry => (
                        <Row
                          key={entry}
                          onRun={direct}
                          entry={{ id: `recent-${entry}`, label: entry, count: recentCounts[entry] == null ? undefined : countLabel(recentCounts[entry], 'save'), icon: <Clock aria-hidden="true" />, run: () => search(entry) }}
                        />
                      ))}
                    </>
                  ) : null}
                  {suggestions.length ? (
                    <>
                      <Heading>from your library</Heading>
                      <div className="flex flex-wrap gap-2 px-3 pt-1 pb-2">
                        {suggestions.map(suggestion => (
                          <Chip key={suggestion.id} id={`suggest-${suggestion.id}`} icon={suggestionIcon(suggestion.icon)} count={suggestion.count} onRun={() => go(suggestion.to)}>{suggestion.label}</Chip>
                        ))}
                      </div>
                    </>
                  ) : null}
                </>
              )}
              {query && !nothing ? (
                <>
                  <Heading>search</Heading>
                  <Row
                    onRun={direct}
                    entry={{ id: 'search-library', label: `Search the library for “${query}”`, hint: 'enter', icon: <Search aria-hidden="true" />, run: () => search(query) }}
                  />
                </>
              ) : null}
              {saves.length ? <Heading>saves</Heading> : null}
              {saves.map(item => (
                <SaveRow key={item.id} item={item} words={words} onRun={() => { addRecent(remembers, query); close(); void archive.openItem(item.id); }} />
              ))}
              {narrow.length ? (
                <div className="flex flex-wrap gap-2 px-3 pt-2 pb-1">
                  {narrow.map(entry => <Chip key={entry.platform} id={`only-${entry.platform}`} count={entry.count} onRun={() => search(query, { platform: entry.platform })}>{entry.label}</Chip>)}
                </div>
              ) : null}
              {nothing ? (
                <div className="flex flex-col items-center gap-3 px-4 pt-8 pb-6 text-center">
                  <Ascii name="search" />
                  <h2 dir="auto" className="display max-w-full text-2xl break-words text-ink">Nothing for “{query}”.</h2>
                  <p className="max-w-[34ch] text-sm leading-relaxed text-ink-soft">Search looks at titles, captions, topics, your notes and transcripts. It cannot see inside a video that has no transcript.</p>
                  <div className="flex flex-wrap justify-center gap-2 pt-1">
                    {/* Buttons, not list entries: Enter on words that found nothing must not run a different search. */}
                    {topTopics(tags).map(tag => (
                      <button key={tag.name} type="button" onClick={() => go({ tag: tag.name })} className={cn(CHIP, 'cursor-pointer hov:border-sage hov:bg-sage-pale')}>
                        <ChipBody count={tag.count}>Try “{tag.name}”</ChipBody>
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
              {found.error && query.length >= 2 ? <p role="alert" className="px-3 py-2 text-xs text-danger">{found.error}</p> : null}
              {shownViews.length ? <Heading>go to</Heading> : null}
              {shownViews.map(entry => <Row key={entry.id} entry={entry} onRun={run} />)}
              {shownActions.length ? <Heading>do</Heading> : null}
              {shownActions.map(entry => <Row key={entry.id} entry={entry} onRun={run} />)}
            </CommandPrimitive.List>
            <div aria-hidden="true" className="flex h-9 shrink-0 items-center justify-between border-t border-line px-4 text-2xs text-ink-soft max-sm:hidden">
              <span className="label-mono">little archive</span>
              <span className="flex items-center gap-1.5 font-mono">↑↓ move <CornerDownLeft className="size-3" /> open</span>
            </div>
          </CommandPrimitive>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
