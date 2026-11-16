// One save as a line in the list. A finger can swipe it: towards the end of the line uncovers Done and File,
// towards the start uncovers Delete. The ··· button holds the same actions for a mouse, a keyboard and a screen
// reader, so nothing here needs the gesture. Vertical moves are left to the page (touch-action: pan-y), a mouse
// never swipes (so it can still select text and click), and a swipe never also opens the save.
import { memo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { hostLabel, PLATFORM_NAMES } from '@web/utils.js';
import { cn } from 'cn';
import { Check, Ellipsis, FolderPlus, Heart, HeartOff, RotateCcw, Sparkles, Trash2 } from 'lucide-react';
import { useArchive, useBusy } from '@/app/archive-context';
import { openDialog, toast } from '@/app/ui-state';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import type { Item } from '@/data/types';
import { recoverFocus } from '@/lib/focus';
import { Cover } from './cover';
import { deleteWithUndo } from './held-deletes';
import type { Tile } from './masonry';
import { dragOffset, intent, lineSign, restOffset, settleSide, type Side } from './swipe';

interface RowProps {
  item: Item;
  tile: Tile;
  index: number;
  total: number;
  selected: boolean;
  selecting: boolean;
  remotePreviews: boolean;
  /** Which side of this row is open. Only one row is open at a time; the list keeps which. */
  side: Side;
  onSide(id: string, side: Side): void;
}

const UNDER = 'flex h-full w-[76px] flex-col items-center justify-center gap-1 text-xs font-semibold outline-none focus-visible:underline';

export const SaveRow = memo(function SaveRow({ item, tile, index, total, selected, selecting, remotePreviews, side, onSide }: RowProps) {
  const archive = useArchive();
  const [pending, run] = useBusy();
  const title = item.title || hostLabel(item.url);
  const name = item.title || 'saved item';
  const done = item.status === 'done';
  const slider = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointer: number; x: number; y: number; sign: 1 | -1; base: number; offset: number; active: boolean } | null>(null);
  // Set by a swipe, read by the click that some browsers send after it.
  const swiped = useRef(false);
  const [menu, setMenu] = useState(false);
  const touched = useRef(false);

  const patch = (change: Record<string, unknown>, said: string) => run(async () => {
    onSide(item.id, '');
    const updated = await archive.api.patchItem(item.id, change);
    await archive.refreshEditedItem(updated);
    toast(said);
    // The row may have just left this view; focus moves to one that is still there.
    requestAnimationFrame(recoverFocus);
  });
  const toggleDone = () => void patch({ status: done ? 'inbox' : 'done' }, done ? 'Marked as not done.' : 'Marked as done.');
  const toggleFavorite = () => void patch({ favorite: !item.favorite }, item.favorite ? 'Removed from favorites.' : 'Added to favorites.');
  const file = () => { onSide(item.id, ''); openDialog({ kind: 'bulk', action: 'collection', ids: [item.id] }); };
  const remove = () => { onSide(item.id, ''); deleteWithUndo(archive, item); requestAnimationFrame(recoverFocus); };

  const down = (event: ReactPointerEvent<HTMLElement>) => {
    swiped.current = false;
    if (event.pointerType === 'mouse' || !event.isPrimary || selecting) return;
    drag.current = { pointer: event.pointerId, x: event.clientX, y: event.clientY, sign: lineSign(getComputedStyle(event.currentTarget).direction), base: restOffset(side), offset: restOffset(side), active: false };
  };
  const move = (event: ReactPointerEvent<HTMLElement>) => {
    const state = drag.current;
    const node = slider.current;
    if (!state || !node || event.pointerId !== state.pointer) return;
    const dx = event.clientX - state.x;
    if (!state.active) {
      const kind = intent(dx, event.clientY - state.y);
      if (kind === 'scroll') drag.current = null;
      if (kind !== 'swipe') return;
      state.active = true;
      swiped.current = true;
      // Keeps the moves coming if the finger leaves the row. A pointer the browser does not know cannot be captured.
      try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* The row still follows while the finger is on it. */ }
      node.style.transition = 'none';
    }
    state.offset = dragOffset(state.base + dx * state.sign);
    node.style.transform = `translateX(${state.offset * state.sign}px)`;
  };
  const up = (event: ReactPointerEvent<HTMLElement>, cancelled = false) => {
    const state = drag.current;
    if (!state || event.pointerId !== state.pointer) return;
    drag.current = null;
    if (!state.active) return;
    const node = slider.current;
    if (node) { node.style.transition = ''; node.style.transform = ''; }
    // The browser took the gesture back (the page scrolled): the row goes back to where it was.
    onSide(item.id, cancelled ? side : settleSide(state.offset));
  };

  return (
    <article
      data-item-id={item.id}
      data-swipe={side || undefined}
      aria-posinset={index + 1}
      aria-setsize={total}
      aria-labelledby={`save-${item.id}`}
      style={{ top: tile.y, height: tile.height }}
      className={cn('group/row absolute inset-x-0 touch-pan-y overflow-hidden bg-card-2 [contain:layout_style]', index > 0 && 'border-t border-line')}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={event => up(event)}
      onPointerCancel={event => up(event, true)}
      onClickCapture={event => {
        // A swipe is not a tap, and a tap on an open row closes it instead of opening the save.
        const onRow = slider.current?.contains(event.target as Node);
        if (swiped.current || (side && onRow)) {
          event.preventDefault();
          event.stopPropagation();
          if (!swiped.current) onSide(item.id, '');
          swiped.current = false;
        }
      }}
    >
      {/* Under the row. Nothing here can be reached until its side is open; the menu on the row has the same actions. */}
      <div inert={side !== 'start'} className="absolute inset-y-0 start-0 flex">
        <button type="button" className={cn(UNDER, 'bg-sage-pale text-sage dark:text-sage-deep')} onClick={toggleDone}>
          {done ? <RotateCcw className="size-4.5" aria-hidden="true" /> : <Check className="size-4.5" aria-hidden="true" />}
          {done ? 'Not done' : 'Done'}
        </button>
        <button type="button" className={cn(UNDER, 'bg-sky-pale text-sky-ink')} onClick={file}>
          <FolderPlus className="size-4.5" aria-hidden="true" />
          File
        </button>
      </div>
      <div inert={side !== 'end'} className="absolute inset-y-0 end-0 flex">
        <button type="button" className={cn(UNDER, 'bg-danger-pale text-danger')} onClick={remove}>
          <Trash2 className="size-4.5" aria-hidden="true" />
          Delete
        </button>
      </div>

      <div
        ref={slider}
        data-row-slider
        className={cn(
          'relative flex h-full items-center gap-3 bg-card ps-2 pe-1 transition-transform duration-300 ease-out',
          side === 'start' && 'translate-x-[152px] rtl:-translate-x-[152px]',
          side === 'end' && '-translate-x-[76px] rtl:translate-x-[76px]',
          selected && 'bg-sage-pale/60',
        )}
      >
        {selecting ? (
          <label className="relative z-[2] -me-1.5 grid size-11 shrink-0 place-items-center">
            <input
              type="checkbox"
              data-card-control="select"
              checked={selected}
              aria-label={`Select ${name}`}
              onChange={event => {
                if (!archive.select(item.id, event.target.checked)) toast('Select up to 200 saves, or use Organize to update every match.');
              }}
              className="peer size-5 cursor-pointer appearance-none rounded-[7px] border-[1.5px] border-line-strong bg-card shadow-xs transition-colors checked:border-sage checked:bg-sage"
            />
            <Check className="pointer-events-none absolute size-3.5 text-on-sage opacity-0 peer-checked:opacity-100" strokeWidth={3.4} aria-hidden="true" />
          </label>
        ) : null}
        <span className="size-12 shrink-0 overflow-hidden rounded-[12px]">
          <Cover item={item} remotePreviews={remotePreviews} mini />
        </span>
        <div className="min-w-0 flex-1">
          <h3 id={`save-${item.id}`} dir="auto" className="truncate text-sm leading-snug font-semibold text-ink">
            <button
              type="button"
              data-card-control="open"
              aria-label={`Open ${name}`}
              onClick={() => void archive.openItem(item.id)}
              className="rounded-sm text-start outline-none after:absolute after:inset-0 focus-visible:after:outline-[2.5px] focus-visible:after:-outline-offset-2 focus-visible:after:outline-sage"
            >
              {title}
            </button>
          </h3>
          <p dir="auto" className="mt-0.5 truncate text-xs text-ink-soft">{PLATFORM_NAMES[item.platform] || 'Web'} · {item.creator || hostLabel(item.url)}</p>
        </div>
        <span className="flex shrink-0 items-center gap-1.5 text-ink-soft">
          {item.needs_review ? <Sparkles className="size-3.5 text-petal-ink" role="img" aria-label="To review" /> : null}
          {item.favorite ? <Heart className="size-3.5 fill-current text-petal-ink" role="img" aria-label="Favorite" /> : null}
          {done ? <Check className="size-3.5" role="img" aria-label="Done" /> : null}
        </span>
        <DropdownMenu open={menu} onOpenChange={setMenu}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              data-card-control="menu"
              // A menu opens when a mouse button goes down. A finger going down may be the start of a scroll or a
              // swipe, so for a finger it opens on the tap instead.
              onPointerDown={event => { touched.current = event.pointerType !== 'mouse'; if (touched.current) event.preventDefault(); }}
              onClick={() => { if (touched.current) { touched.current = false; setMenu(true); } }}
              aria-label={`Actions for ${name}`}
              aria-busy={pending || undefined}
              className="relative z-[2] grid size-11 shrink-0 place-items-center rounded-full text-ink-soft outline-none hov:bg-card-2 hov:text-ink focus-visible:outline-[2.5px] focus-visible:-outline-offset-4 focus-visible:outline-sage data-[state=open]:bg-card-2 data-[state=open]:text-ink"
            >
              <Ellipsis className="size-5" aria-hidden="true" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-56">
            <DropdownMenuItem onSelect={toggleDone}>{done ? <RotateCcw aria-hidden="true" /> : <Check aria-hidden="true" />}{done ? 'Mark as not done' : 'Mark as done'}</DropdownMenuItem>
            <DropdownMenuItem onSelect={file}><FolderPlus aria-hidden="true" />File in a collection…</DropdownMenuItem>
            <DropdownMenuItem onSelect={toggleFavorite}>{item.favorite ? <HeartOff aria-hidden="true" /> : <Heart aria-hidden="true" />}{item.favorite ? 'Remove from favorites' : 'Add to favorites'}</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={remove}><Trash2 aria-hidden="true" />Delete</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </article>
  );
});
