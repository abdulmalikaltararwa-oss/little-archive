// The command palette: type to find a save, jump to a view, or do something. One field for the whole app.
// Saves are searched by the server (it owns the text index); views and actions are matched here.
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { errorMessage, hostLabel, PLATFORM_NAMES } from '@web/utils.js';
import { Command as CommandPrimitive } from 'cmdk';
import { cn } from 'cn';
import { Activity, Archive, Bookmark, Clock, CornerDownLeft, Folder, Heart, LayoutGrid, Monitor, Moon, Plus, Search, Settings, Sparkles, Sun, Upload } from 'lucide-react';
import { Dialog } from 'radix-ui';
import { useArchive, useArchiveState } from '@/app/archive-context';
import { useTheme } from '@/app/theme';
import { openDialog, type OpenDialog } from '@/app/ui-state';
import { AsciiSpinner } from '@/components/fx/ascii';
import { PlatformIcon } from '@/components/icons';
import type { Item } from '@/data/types';
import { restoreFocus } from '@/lib/focus';

interface Entry {
  id: string;
  label: string;
  hint?: string;
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
    </CommandPrimitive.Item>
  );
}

function Heading({ children }: { children: string }) {
  return <span className="label-mono px-3 pt-3 pb-1.5">{children}</span>;
}

export function CommandPalette({ spec, close }: { spec: OpenDialog; close(): void }) {
  const archive = useArchive();
  const collections = useArchiveState(state => state.collections);
  const setTheme = useTheme(state => state.set);
  const [text, setText] = useState('');
  const [found, setFound] = useState<{ query: string; items: Item[]; error: string }>({ query: '', items: [], error: '' });
  const query = text.trim();
  const lower = query.toLowerCase();

  // Ask the server once the typing pauses. An answer to an older question is ignored.
  useEffect(() => {
    if (query.length < 2) return;
    let stale = false;
    const timer = setTimeout(() => {
      archive.api.items({ q: query }, 0, 6).then(
        result => { if (!stale) setFound({ query, items: result.items, error: '' }); },
        error => { if (!stale) setFound({ query, items: [], error: errorMessage(error) }); },
      );
    }, 180);
    return () => { stale = true; clearTimeout(timer); };
  }, [archive, query]);

  const run = (entry: Entry) => { close(); entry.run(); };
  const views = useMemo<Entry[]>(() => [
    { id: 'go-all', label: 'All saves', icon: <LayoutGrid aria-hidden="true" />, words: 'home library everything', run: () => archive.goView('all') },
    { id: 'go-favorites', label: 'Favorites', icon: <Heart aria-hidden="true" />, words: 'loved hearts', run: () => archive.goView('favorites') },
    { id: 'go-revisit', label: 'To revisit', icon: <Clock aria-hidden="true" />, words: 'later', run: () => archive.goView('revisit') },
    { id: 'go-review', label: 'Needs review', icon: <Sparkles aria-hidden="true" />, words: 'suggestions ai', run: () => archive.goView('review') },
    { id: 'go-rediscover', label: 'Rediscover', icon: <Bookmark aria-hidden="true" />, words: 'random shuffle surprise', run: () => archive.goView('rediscover') },
    { id: 'go-archived', label: 'Archived', icon: <Archive aria-hidden="true" />, run: () => archive.goView('archived') },
    ...(['instagram', 'tiktok', 'web'] as const).map(platform => ({ id: `go-${platform}`, label: `${PLATFORM_NAMES[platform]} saves`, icon: <PlatformIcon platform={platform} />, words: 'source', run: () => archive.goView(`platform:${platform}`) })),
    ...collections.map(collection => ({ id: `go-collection-${collection.id}`, label: collection.name, hint: collection.kind === 'source' ? 'source' : 'collection', icon: <Folder aria-hidden="true" />, words: 'collection folder', run: () => archive.goView(`collection:${collection.id}`) })),
  ], [archive, collections]);
  const actions = useMemo<Entry[]>(() => [
    { id: 'do-save', label: 'Save a link', icon: <Plus aria-hidden="true" />, words: 'add new url', run: () => openDialog({ kind: 'save-link' }) },
    { id: 'do-import', label: 'Import your saves', icon: <Upload aria-hidden="true" />, words: 'file export bring', run: () => openDialog({ kind: 'import' }) },
    { id: 'do-organize', label: 'Organize library', icon: <Sparkles aria-hidden="true" />, words: 'topics tags ai bulk', run: () => openDialog({ kind: 'organize' }) },
    { id: 'do-activity', label: 'Import activity', icon: <Activity aria-hidden="true" />, words: 'jobs progress', run: () => openDialog({ kind: 'activity' }) },
    { id: 'do-settings', label: 'Settings & connections', icon: <Settings aria-hidden="true" />, words: 'preferences tokens export backup sign out', run: () => openDialog({ kind: 'settings' }) },
    { id: 'do-light', label: 'Appearance: light', icon: <Sun aria-hidden="true" />, words: 'theme', run: () => setTheme('light') },
    { id: 'do-dark', label: 'Appearance: dark', icon: <Moon aria-hidden="true" />, words: 'theme night', run: () => setTheme('dark') },
    { id: 'do-system', label: 'Appearance: match this device', icon: <Monitor aria-hidden="true" />, words: 'theme system auto', run: () => setTheme('system') },
  ], [setTheme]);

  const shownViews = views.filter(entry => matches(entry, lower)).slice(0, lower ? 8 : 6);
  const shownActions = actions.filter(entry => matches(entry, lower)).slice(0, lower ? 8 : 5);
  const saves = query.length >= 2 && found.query === query ? found.items : [];
  const searching = query.length >= 2 && found.query !== query;

  return (
    <Dialog.Root open={spec.open} onOpenChange={next => { if (!next) close(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-scrim backdrop-blur-[3px] data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <Dialog.Content
          aria-describedby={undefined}
          onCloseAutoFocus={event => { event.preventDefault(); restoreFocus(spec.opener); }}
          className={cn(
            'fixed inset-x-3 top-[calc(var(--safe-top)+12px)] z-50 mx-auto flex max-h-[min(72dvh,560px)] max-w-[620px] flex-col overflow-hidden rounded-xl border border-line bg-card shadow-lg outline-none',
            'duration-200 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:slide-in-from-top-4 sm:top-[14vh]',
          )}
        >
          <Dialog.Title className="sr-only">Search or jump to anything</Dialog.Title>
          <CommandPrimitive shouldFilter={false} loop label="Search or jump to anything" className="flex min-h-0 flex-1 flex-col">
            <div className="flex h-14 shrink-0 items-center gap-3 border-b border-line px-4">
              <span aria-hidden="true" className="font-mono text-base text-petal-ink">&gt;</span>
              <CommandPrimitive.Input
                value={text}
                onValueChange={setText}
                placeholder="Find a save, a view, or something to do…"
                dir="auto"
                className="h-full min-w-0 flex-1 bg-transparent text-base text-ink outline-none placeholder:text-ink-soft/80"
              />
              {searching ? <AsciiSpinner /> : <kbd aria-hidden="true" className="num rounded-md border border-line bg-card-2 px-1.5 py-0.5 text-2xs text-ink-soft max-sm:hidden">esc</kbd>}
            </div>
            <CommandPrimitive.List className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2 [&_[cmdk-list-sizer]]:flex [&_[cmdk-list-sizer]]:flex-col">
              {query ? (
                <>
                  <Heading>search</Heading>
                  <Row
                    onRun={run}
                    entry={{ id: 'search-library', label: `Search the library for “${query}”`, hint: 'enter', icon: <Search aria-hidden="true" />, run: () => archive.navigate({ screen: 'library', view: 'all', q: query, platform: '', tag: '', sort: '', item: '', rest: '' }) }}
                  />
                </>
              ) : null}
              {saves.length ? <Heading>saves</Heading> : null}
              {saves.map(item => (
                <Row
                  key={item.id}
                  onRun={run}
                  entry={{ id: `save-${item.id}`, label: item.title || hostLabel(item.url), hint: (item.match_in || [])[0]?.replaceAll('_', ' '), icon: <PlatformIcon platform={item.platform} />, run: () => void archive.openItem(item.id) }}
                />
              ))}
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
