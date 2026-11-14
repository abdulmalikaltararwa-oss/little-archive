// The wall of saves. Cards are placed by layoutWall (arithmetic, no measuring) and only the ones near the
// screen exist in the page, so a library of thousands scrolls like a library of twenty.
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { hostLabel, PLATFORM_NAMES } from '@web/utils.js';
import { cn } from 'cn';
import { Check, Clock, Heart, Sparkles } from 'lucide-react';
import { useArchive, useArchiveState, useBusy } from '@/app/archive-context';
import { toast } from '@/app/ui-state';
import { PlatformIcon } from '@/components/icons';
import type { Item } from '@/data/types';
import { recoverFocus } from '@/lib/focus';
import { COVER_TRANSITION, useMorph } from '@/lib/transition';
import { Cover } from './cover';
import { BODY_HEIGHT, CARD_PADDING, layoutWall, windowRange, type Tile } from './masonry';

const OVERSCAN = 900;

interface CardProps {
  item: Item;
  tile: Tile;
  index: number;
  total: number;
  compact: boolean;
  selected: boolean;
  selecting: boolean;
  remotePreviews: boolean;
  fresh: boolean;
  morphing: boolean;
}

const SaveCard = memo(function SaveCard({ item, tile, index, total, compact, selected, selecting, remotePreviews, fresh, morphing }: CardProps) {
  const archive = useArchive();
  const [pending, run] = useBusy();
  const title = item.title || hostLabel(item.url);
  const coverHeight = tile.height - CARD_PADDING * 2 - (compact ? BODY_HEIGHT.compact : BODY_HEIGHT.regular);

  const toggleFavorite = () => run(async () => {
    const updated = await archive.api.patchItem(item.id, { favorite: !item.favorite });
    await archive.refreshEditedItem(updated);
    // In Favorites the card has just left the wall; focus moves to one that is still there.
    requestAnimationFrame(recoverFocus);
  });

  return (
    <article
      data-item-id={item.id}
      aria-posinset={index + 1}
      aria-setsize={total}
      aria-labelledby={`save-${item.id}`}
      style={{ insetInlineStart: tile.x, top: tile.y, width: tile.width, height: tile.height }}
      className={cn(
        'group/card absolute rounded-lg border border-line bg-card p-1.5 shadow-xs [contain:layout_style]',
        'transition-[transform,box-shadow,border-color] duration-300 ease-spring hov:z-10 hov:-translate-y-1 hov:border-sage/35 hov:shadow-md',
        index % 2 ? 'hov:rotate-[0.5deg]' : 'hov:-rotate-[0.5deg]',
        'has-[[data-card-control=open]:active]:scale-[0.985]',
        selected && 'border-sage ring-2 ring-sage',
        fresh && 'animate-welcome',
      )}
    >
      <div className="relative overflow-hidden rounded-[16px]" style={{ height: coverHeight, viewTransitionName: morphing ? COVER_TRANSITION : undefined }}>
        <Cover item={item} remotePreviews={remotePreviews} />
      </div>
      <div className="flex flex-col px-2 pt-2.5" style={{ height: compact ? BODY_HEIGHT.compact : BODY_HEIGHT.regular }}>
        <div className="flex items-center justify-between gap-2 text-ink-soft">
          <span className="label-mono flex min-w-0 items-center gap-1.5">
            <PlatformIcon platform={item.platform} className="size-3.5 shrink-0" />
            <span className="truncate">{PLATFORM_NAMES[item.platform] || 'Web'}</span>
          </span>
          <span className="flex shrink-0 items-center gap-1.5">
            {item.needs_review && compact ? <Sparkles className="size-3.5 text-petal-ink" role="img" aria-label="To review" /> : null}
            {item.status === 'done' ? <Check className="size-3.5" role="img" aria-label="Done" /> : item.status === 'to_revisit' ? <Clock className="size-3.5" role="img" aria-label="To revisit" /> : null}
          </span>
        </div>
        <h3 id={`save-${item.id}`} dir="auto" className="mt-1.5 line-clamp-2 text-sm leading-snug font-semibold text-ink">
          <button
            type="button"
            data-card-control="open"
            aria-label={`Open ${item.title || 'saved item'}`}
            onClick={() => void archive.openItem(item.id)}
            className="rounded-sm text-start outline-none after:absolute after:inset-0 after:rounded-lg focus-visible:after:outline-[2.5px] focus-visible:after:outline-offset-2 focus-visible:after:outline-sage"
          >
            {title}
          </button>
        </h3>
        <p dir="auto" className="mt-0.5 truncate text-xs text-ink-soft">{item.creator || hostLabel(item.url)}</p>
        {compact ? null : (
          <div className="mt-auto flex h-6 items-center gap-1.5 overflow-hidden pb-0.5">
            {/* The review chip comes first: it is the one that must never be the chip that gets cut off. */}
            {item.needs_review ? <span className="shrink-0 rounded-full bg-petal-pale px-2 py-0.5 text-2xs font-medium text-petal-ink">To review</span> : null}
            {(item.tags || []).slice(0, 2).map(tag => (
              <span key={tag} dir="auto" className="min-w-0 max-w-[46%] truncate rounded-full bg-card-2 px-2 py-0.5 text-2xs text-ink-soft">{tag}</span>
            ))}
          </div>
        )}
      </div>

      {/* A finger-sized area around the small checkbox. It shows on hover, on focus, and while selecting. */}
      <label
        className={cn(
          'absolute start-1 top-1 z-[2] grid size-11 place-items-center opacity-0 transition-opacity duration-150',
          'group-hover/card:opacity-100 group-focus-within/card:opacity-100 has-checked:opacity-100',
          selecting ? 'opacity-100' : 'coarse:pointer-events-none coarse:has-checked:pointer-events-auto',
        )}
      >
        <input
          type="checkbox"
          data-card-control="select"
          checked={selected}
          aria-label={`Select ${item.title || 'saved item'}`}
          onChange={event => {
            if (!archive.select(item.id, event.target.checked)) toast('Select up to 200 saves, or use Organize to update every match.');
          }}
          className="peer size-5 cursor-pointer appearance-none rounded-[7px] border-[1.5px] border-line-strong bg-card shadow-xs transition-colors checked:border-sage checked:bg-sage"
        />
        <Check className="pointer-events-none absolute size-3.5 text-on-sage opacity-0 peer-checked:opacity-100" strokeWidth={3.4} aria-hidden="true" />
      </label>

      <button
        type="button"
        data-card-control="favorite"
        aria-pressed={item.favorite}
        aria-busy={pending || undefined}
        disabled={pending}
        aria-label={item.favorite ? 'Remove from favorites' : 'Add to favorites'}
        title={item.favorite ? 'Remove from favorites' : 'Add to favorites'}
        onClick={() => void toggleFavorite()}
        className={cn(
          'hit-44 absolute end-3.5 top-3.5 z-[2] grid size-8 place-items-center rounded-full bg-card/92 text-ink-soft shadow-xs backdrop-blur-sm',
          'transition-transform duration-200 ease-spring hov:scale-115 active:scale-90 disabled:opacity-70',
          item.favorite && 'animate-pop bg-petal-pale text-petal-ink',
        )}
      >
        <Heart className={cn('size-4', item.favorite && 'fill-current')} aria-hidden="true" />
      </button>
    </article>
  );
});

// Placeholder shapes while a view loads: the same wall, drawn in paper.
const GHOSTS = Array.from({ length: 10 }, (_, index) => ({ id: `ghost-${index * 7}`, content_type: (['image', 'video', 'article', 'post', 'link'] as const)[index % 5]! }));

export function Gallery() {
  const archive = useArchive();
  const items = useArchiveState(state => state.items);
  const total = useArchiveState(state => state.total);
  const list = useArchiveState(state => state.list);
  const busy = useArchiveState(state => state.busy);
  const revision = useArchiveState(state => state.revision);
  const selected = useArchiveState(state => state.selected);
  const selecting = useArchiveState(state => state.selecting);
  const remotePreviews = useArchiveState(state => state.settings.remote_previews);
  const fresh = useArchiveState(state => state.justSaved);
  const openItem = useArchiveState(state => state.loc.item);
  const morphId = useMorph(state => state.coverId);

  const host = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const loading = list === 'loading';
  const source = loading ? GHOSTS : items;
  const wall = useMemo(() => layoutWall(source, width), [source, width]);
  const [range, setRange] = useState<[number, number]>([0, -1]);
  const [focused, setFocused] = useState(-1);
  // The reading position: the first card on screen and where its top edge sits.
  const anchor = useRef<{ id: string; top: number } | null>(null);

  useLayoutEffect(() => {
    const node = host.current;
    if (!node) return;
    setWidth(node.clientWidth);
    const observer = new ResizeObserver(() => setWidth(node.clientWidth));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const measure = useCallback(() => {
    const node = host.current;
    if (!node) return;
    const top = node.getBoundingClientRect().top;
    const next = windowRange(wall.tiles, -top - OVERSCAN, -top + innerHeight + OVERSCAN);
    setRange(previous => (previous[0] === next[0] && previous[1] === next[1] ? previous : next));
    if (loading) return;
    const [first, last] = windowRange(wall.tiles, -top, -top + innerHeight);
    anchor.current = last >= first && items[first] ? { id: items[first].id, top: top + wall.tiles[first]!.y } : null;
  }, [wall, items, loading]);

  // When loaded saves change (an edit, a refetch of the loaded window), keep the first visible card where it was.
  const seen = useRef(revision);
  useLayoutEffect(() => {
    const node = host.current;
    if (node && seen.current !== revision && anchor.current) {
      const index = items.findIndex(item => item.id === anchor.current!.id);
      const tile = index >= 0 ? wall.tiles[index] : undefined;
      if (tile) {
        const shift = node.getBoundingClientRect().top + tile.y - anchor.current.top;
        if (Math.abs(shift) > 1) scrollBy({ top: shift, behavior: 'instant' });
      }
    }
    seen.current = revision;
    measure();
  }, [revision, wall, items, measure]);

  useEffect(() => {
    let frame = 0;
    const schedule = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; measure(); }); };
    addEventListener('scroll', schedule, { passive: true });
    addEventListener('resize', schedule, { passive: true });
    return () => { removeEventListener('scroll', schedule); removeEventListener('resize', schedule); cancelAnimationFrame(frame); };
  }, [measure]);

  const indexes = useMemo(() => {
    const visible: number[] = [];
    for (let index = range[0]; index <= range[1] && index < source.length; index++) visible.push(index);
    // A card that holds keyboard focus stays in the page even when it scrolls out of the window.
    if (focused >= 0 && focused < source.length && (focused < range[0] || focused > range[1])) visible.push(focused);
    return visible;
  }, [range, focused, source.length]);

  return (
    <div
      ref={host}
      role="feed"
      aria-label="Saved items"
      aria-busy={busy || undefined}
      data-selecting={selecting || selected.size > 0 || undefined}
      className="relative w-full"
      style={{ height: wall.height }}
      onFocusCapture={event => {
        const id = (event.target as HTMLElement).closest<HTMLElement>('[data-item-id]')?.dataset.itemId;
        setFocused(id ? items.findIndex(item => item.id === id) : -1);
      }}
      onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(-1); }}
    >
      {loading
        ? indexes.map(index => {
            const tile = wall.tiles[index];
            return tile ? (
              <div
                key={index}
                aria-hidden="true"
                data-skeleton
                style={{ insetInlineStart: tile.x, top: tile.y, width: tile.width, height: tile.height }}
                className="absolute animate-shimmer rounded-lg border border-line bg-[linear-gradient(110deg,var(--card-2)_25%,var(--card)_40%,var(--card-2)_55%)] bg-[length:200%_100%]"
              />
            ) : null;
          })
        : indexes.map(index => {
            const item = items[index];
            const tile = wall.tiles[index];
            if (!item || !tile) return null;
            return (
              <SaveCard
                key={item.id}
                item={item}
                tile={tile}
                index={index}
                total={total}
                compact={wall.compact}
                selected={selected.has(item.id)}
                selecting={selecting || selected.size > 0}
                remotePreviews={remotePreviews}
                fresh={fresh === item.id}
                morphing={morphId === item.id && !openItem}
              />
            );
          })}
      <AutoLoad archive={archive} />
    </div>
  );
}

/** Asks for the next page a little before the end of the wall is reached. The "Load more" button stays for the keyboard. */
function AutoLoad({ archive }: { archive: ReturnType<typeof useArchive> }) {
  const node = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const target = node.current;
    if (!target) return;
    const observer = new IntersectionObserver(entries => {
      if (!entries[0]?.isIntersecting) return;
      const state = archive.store.getState();
      if (state.list === 'ready' && !state.busy && state.items.length < state.total && state.filters.sort !== 'random') void archive.loadItems(true);
    }, { rootMargin: '1200px 0px' });
    observer.observe(target);
    return () => observer.disconnect();
  }, [archive]);
  return <div ref={node} aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 h-px" />;
}
