// The library: heading, search and filters, source tabs, the wall, and what to show when there is nothing.
import { useEffect, useRef, useState } from 'react';
import { countLabel, errorMessage } from '@web/utils.js';
import { cn } from 'cn';
import { Archive, ArrowRight, Check, ChevronsUpDown, CircleCheck, FolderPlus, Heart, HeartOff, Inbox, LayoutGrid, Plus, Search, ShieldCheck, Shuffle, Sparkles, Tag as TagIcon, Upload, X } from 'lucide-react';
import { useArchive, useArchiveState, useBusy } from '@/app/archive-context';
import { openDialog, toast } from '@/app/ui-state';
import { AsciiSpinner } from '@/components/fx/ascii';
import { PlatformIcon } from '@/components/icons';
import { Pick } from '@/components/pick';
import { Button } from '@/components/ui/button';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Segmented } from '@/components/ui/segmented';
import { viewTitle, withPlatform } from '@/data/location';
import type { BulkAction, Platform, Sort } from '@/data/types';
import { VIEW_TITLE_ID } from '@/lib/focus';
import { StateCard } from '../feature-kit';
import { Gallery } from './gallery';
import { Hero } from './hero';

const SORTS: { value: Sort; label: string }[] = [
  { value: 'recent', label: 'Recently added' },
  { value: 'oldest', label: 'Oldest first' },
  { value: 'title', label: 'Title A–Z' },
  { value: 'random', label: 'Rediscover' },
];

export const SEARCH_INPUT_ID = 'library-search';

function SearchBox() {
  const archive = useArchive();
  const q = useArchiveState(state => state.loc.q);
  const [text, setText] = useState(q);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const typing = useRef(false);
  // The address owns the search; the box follows it unless the person is in the middle of typing.
  useEffect(() => { if (!typing.current) setText(q); }, [q]);
  useEffect(() => () => clearTimeout(timer.current), []);

  const change = (value: string) => {
    setText(value);
    typing.current = true;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      typing.current = false;
      archive.navigate({ q: value.trim() }, { replace: true });
    }, 250);
  };

  return (
    <div className="relative min-w-[13rem] flex-1">
      <Search className="pointer-events-none absolute start-4 top-1/2 size-4 -translate-y-1/2 text-ink-soft" aria-hidden="true" />
      <input
        id={SEARCH_INPUT_ID}
        type="search"
        value={text}
        onChange={event => change(event.target.value)}
        placeholder="Find something you saved…"
        aria-label="Search titles, captions, tags, and notes"
        autoComplete="off"
        spellCheck={false}
        dir="auto"
        className="h-11 w-full rounded-full border border-line-strong bg-card ps-11 pe-14 text-base text-ink shadow-xs outline-none transition-[border-color,box-shadow] placeholder:text-ink-soft/80 focus-visible:border-sage focus-visible:ring-4 focus-visible:ring-sage/15 dark:bg-card-2 [&::-webkit-search-cancel-button]:appearance-none"
      />
      {text ? (
        <button type="button" aria-label="Clear search" onClick={() => change('')} className="hit-44 absolute end-2.5 top-1/2 grid size-7 -translate-y-1/2 place-items-center rounded-full text-ink-soft hov:bg-card-2 hov:text-ink">
          <X className="size-4" aria-hidden="true" />
        </button>
      ) : (
        <kbd aria-hidden="true" className="num pointer-events-none absolute end-3.5 top-1/2 -translate-y-1/2 rounded-md border border-line bg-card-2 px-1.5 text-2xs text-ink-soft [@media(hover:none)]:hidden">/</kbd>
      )}
    </div>
  );
}

/** Topics can run to hundreds, so the filter is a searchable list rather than a long menu. */
function TopicFilter() {
  const archive = useArchive();
  const tags = useArchiveState(state => state.tags);
  const current = useArchiveState(state => state.filters.tag);
  const [open, setOpen] = useState(false);
  const known = tags.some(tag => tag.name === current);
  const choose = (name: string) => { setOpen(false); archive.navigate({ tag: name }, { replace: true }); };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          role="combobox"
          aria-expanded={open}
          aria-label="Filter by topic"
          className="flex h-11 min-w-0 flex-1 items-center justify-between gap-2 rounded-full border border-line-strong bg-card px-4 text-sm text-ink shadow-xs outline-none transition-[border-color,box-shadow] focus-visible:border-sage focus-visible:ring-4 focus-visible:ring-sage/15 sm:w-44 sm:flex-none dark:bg-card-2"
        >
          <span className="flex min-w-0 items-center gap-2">
            <TagIcon className="size-4 shrink-0 text-ink-soft" aria-hidden="true" />
            <span dir="auto" className="truncate">{current || 'All topics'}</span>
          </span>
          <ChevronsUpDown className="size-3.5 shrink-0 text-ink-soft" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-0">
        <Command>
          <CommandInput placeholder="Find a topic…" aria-label="Find a topic" />
          <CommandList className="max-h-72">
            <CommandEmpty className="px-3 py-5 text-center text-sm text-ink-soft">No topic by that name.</CommandEmpty>
            <CommandGroup>
              <CommandItem value="all topics" onSelect={() => choose('')}>
                <Check className={cn('size-4', current ? 'opacity-0' : 'opacity-100')} aria-hidden="true" />
                All topics
              </CommandItem>
              {current && !known ? (
                <CommandItem value={current} onSelect={() => choose(current)}>
                  <Check className="size-4" aria-hidden="true" />
                  <span dir="auto" className="min-w-0 flex-1 truncate">{current}</span>
                  <span className="num text-2xs text-ink-soft">0</span>
                </CommandItem>
              ) : null}
              {tags.map(tag => (
                <CommandItem key={tag.name} value={tag.name} onSelect={() => choose(tag.name)}>
                  <Check className={cn('size-4', current === tag.name ? 'opacity-100' : 'opacity-0')} aria-hidden="true" />
                  <span dir="auto" className="min-w-0 flex-1 truncate">{tag.name}</span>
                  <span className="num text-2xs text-ink-soft">{tag.count}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function SourceTabs() {
  const archive = useArchive();
  const stats = useArchiveState(state => state.stats);
  const platform = useArchiveState(state => state.filters.platform);
  const options = [
    { value: 'all', label: 'Everything', icon: <LayoutGrid aria-hidden="true" />, count: stats.total || 0 },
    { value: 'instagram', label: 'Instagram', icon: <PlatformIcon platform="instagram" />, count: stats.platforms?.instagram || 0 },
    { value: 'tiktok', label: 'TikTok', icon: <PlatformIcon platform="tiktok" />, count: stats.platforms?.tiktok || 0 },
    { value: 'web', label: 'Web links', icon: <PlatformIcon platform="web" />, count: stats.platforms?.web || 0 },
  ] as const;
  return (
    <div className="scrollbar-none -mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
      <Segmented
        label="Filter by source"
        value={platform || 'all'}
        options={options}
        onValueChange={value => {
          const loc = archive.store.getState().loc;
          const next = withPlatform(loc, value === 'all' ? '' : (value as Platform));
          archive.navigate({ view: next.view, platform: next.platform }, { replace: !loc.view.startsWith('platform:') });
        }}
      />
    </div>
  );
}

/** What can be done to the selected saves. It floats where the thumb is, and takes the dock's place on a phone. */
function BulkBar() {
  const archive = useArchive();
  const count = useArchiveState(state => state.selected.size);
  const [pending, run] = useBusy();
  if (!count) return null;

  const apply = (action: BulkAction) => {
    const ids = [...archive.store.getState().selected].slice(0, 200);
    if (!ids.length) return;
    if (action === 'tag' || action === 'collection') { openDialog({ kind: 'bulk', action, ids }); return; }
    void run(async () => {
      const result = await archive.api.bulk({ ids, action });
      archive.clearSelection();
      await archive.refreshLibrary();
      toast(`${countLabel(result.updated, 'save')} updated.`);
    });
  };

  return (
    <div role="region" aria-label="Selection" className="fixed inset-x-0 bottom-[calc(var(--safe-bottom)+12px)] z-30 mx-auto flex w-fit max-w-[calc(100vw-20px)] animate-in items-center gap-1.5 rounded-full bg-island py-1.5 ps-4 pe-1.5 text-on-island shadow-lg duration-300 fade-in-0 slide-in-from-bottom-6">
      <span role="status" className="num me-1 text-sm whitespace-nowrap">{count} selected</span>
      <Button variant="ghost" size="sm" className="text-on-island hov:bg-on-island/10 max-sm:hidden" onClick={() => archive.selectLoaded()}>Select visible</Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="primary" size="sm" aria-busy={pending || undefined} disabled={pending} className="shadow-none">
            <CircleCheck />
            Apply an action
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" side="top" sideOffset={10} className="min-w-56">
          <DropdownMenuItem className="sm:hidden" onSelect={() => archive.selectLoaded()}><LayoutGrid aria-hidden="true" />Select visible</DropdownMenuItem>
          <DropdownMenuSeparator className="sm:hidden" />
          <DropdownMenuItem onSelect={() => apply('favorite')}><Heart aria-hidden="true" />Add to favorites</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => apply('unfavorite')}><HeartOff aria-hidden="true" />Remove from favorites</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => apply('tag')}><TagIcon aria-hidden="true" />Add a topic</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => apply('collection')}><FolderPlus aria-hidden="true" />Add to a collection</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => apply('archive')}><Archive aria-hidden="true" />Archive</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => apply('restore')}><Inbox aria-hidden="true" />Move to inbox</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <button type="button" aria-label="Clear selection" title="Clear selection" onClick={() => archive.clearSelection()} className="hit-44 grid size-8.5 place-items-center rounded-full text-on-island-soft hov:bg-on-island/10 hov:text-on-island">
        <X className="size-4" aria-hidden="true" />
      </button>
    </div>
  );
}

export function LibraryScreen({ demo }: { demo: boolean }) {
  const archive = useArchive();
  const loc = useArchiveState(state => state.loc);
  const filters = useArchiveState(state => state.filters);
  const collections = useArchiveState(state => state.collections);
  const stats = useArchiveState(state => state.stats);
  const count = useArchiveState(state => state.items.length);
  const total = useArchiveState(state => state.total);
  const list = useArchiveState(state => state.list);
  const listError = useArchiveState(state => state.listError);
  const loadingMore = useArchiveState(state => state.loadingMore);
  const selecting = useArchiveState(state => state.selecting || state.selected.size > 0);
  const [demoBusy, runDemo] = useBusy();
  const [retrying, runRetry] = useBusy();
  const [moreBusy, runMore] = useBusy();

  const title = viewTitle(loc, filters, collections);
  useEffect(() => { document.title = `${title} — Little Archive${demo ? ' demo' : ''}`; }, [title, demo]);

  const narrowed = Boolean(loc.q || loc.tag || loc.platform);
  const libraryEmpty = !stats.total && !stats.archived;
  const countText = list === 'loading' ? 'Finding your saves…' : list === 'error' ? 'Unable to load' : filters.sort === 'random' && count < total ? `${count} of ${countLabel(total, 'save')}` : countLabel(total, 'save');
  const addDemo = () => runDemo(async () => {
    const result = await archive.api.addDemo();
    await archive.refreshLibrary();
    toast(result.created ? `${result.created} synthetic demo saves added. Enjoy exploring.` : 'Your demo saves are already here.');
  });

  return (
    <>
      {loc.view === 'all' && !narrowed ? <Hero /> : null}

      <div className="mb-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 id={VIEW_TITLE_ID} tabIndex={-1} dir="auto" className="display text-3xl text-ink outline-none focus-visible:underline focus-visible:decoration-sage focus-visible:decoration-2 focus-visible:underline-offset-8 sm:text-[2.1rem]">{title}</h1>
          <span role="status" data-testid="save-count" className="num inline-flex items-center gap-1.5 rounded-full bg-card-2 px-2.5 py-0.5 text-xs text-ink-soft">
            {list === 'loading' ? <AsciiSpinner /> : null}
            {countText}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <Button variant="soft" size="sm" aria-label="Organize library" onClick={() => openDialog({ kind: 'organize' })}><Sparkles />Organize</Button>
          <Button variant="ghost" size="sm" aria-pressed={selecting} onClick={() => archive.setSelecting(!selecting)}>
            <CircleCheck />
            {selecting ? 'Cancel selection' : 'Select'}
          </Button>
        </div>
      </div>

      <div className="mb-3.5 flex flex-wrap items-center gap-2.5">
        <SearchBox />
        <div className="flex w-full gap-2.5 sm:w-auto">
          <TopicFilter />
          <Pick<Sort> label="Sort saves" value={filters.sort} options={SORTS} onChange={sort => archive.navigate({ sort }, { replace: true })} className="min-w-0 flex-1 sm:w-44 sm:flex-none" />
        </div>
      </div>
      <div className="mb-6"><SourceTabs /></div>

      {list === 'error' ? (
        <StateCard art="cloud" title="A little interruption." actions={<Button variant="primary" aria-busy={retrying || undefined} onClick={() => void runRetry(() => archive.refreshLibrary())}><ArrowRight />Try again</Button>}>
          {listError || errorMessage(null)}
        </StateCard>
      ) : list === 'ready' && !count ? (
        libraryEmpty ? (
          <StateCard
            art="pot"
            title="Every collection starts somewhere."
            actions={
              <>
                <Button variant="primary" onClick={() => openDialog({ kind: 'save-link' })}><Plus />Save a link</Button>
                <Button onClick={() => openDialog({ kind: 'import' })}><Upload />Import your saves</Button>
                <Button variant="ghost" aria-busy={demoBusy || undefined} onClick={() => void addDemo()}><Sparkles />Try demo saves</Button>
              </>
            }
          >
            Save your first link, bring in an export, or explore with a small collection of clearly labeled demo saves.
          </StateCard>
        ) : (
          <StateCard art="search" title="Nothing here just yet." actions={<Button variant="primary" onClick={() => archive.goView('all')}><X />Clear filters</Button>}>
            Try a different search or filter. Your next rediscovery might be one collection over.
          </StateCard>
        )
      ) : (
        <Gallery />
      )}

      <div className="flex min-h-10 justify-center pt-8">
        {list === 'ready' && count > 0 && filters.sort === 'random' ? (
          <Button aria-busy={moreBusy || undefined} onClick={() => void runMore(() => archive.loadItems())}><Shuffle />Shuffle these discoveries</Button>
        ) : list === 'ready' && count < total ? (
          <Button aria-busy={moreBusy || loadingMore || undefined} disabled={loadingMore} onClick={() => void runMore(() => archive.loadItems(true))}>
            {loadingMore ? <AsciiSpinner /> : <Plus />}
            Load more · <span className="num">{(total - count).toLocaleString()}</span> remaining
          </Button>
        ) : null}
      </div>

      <p className="mt-8 flex items-center justify-center gap-2 text-center text-xs text-ink-soft">
        <ShieldCheck className="size-3.5 shrink-0" aria-hidden="true" />
        Your collection. Your server. A little more peace of mind.
      </p>
      <BulkBar />
    </>
  );
}
