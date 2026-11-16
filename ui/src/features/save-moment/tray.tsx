// The tray that answers a save: it says the link was kept and offers a few places to file it while the reason
// for saving is still in mind. Untouched, it leaves after five seconds; a touch or a key keeps it until Done.
// A link that was already in the library gets a different tray, which says when and where the first copy is.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { errorMessage } from '@web/utils.js';
import { cn } from 'cn';
import { Bookmark, Check, Clock, Ellipsis, Folder, Undo2 } from 'lucide-react';
import { useArchive, useArchiveState } from '@/app/archive-context';
import { openDialog, toast, useConfirm, useDialogs } from '@/app/ui-state';
import type { Collection, Item, Status } from '@/data/types';
import { Bloom } from '@/components/brand';
import { recoverFocus } from '@/lib/focus';
import { SAVE_TRAY_ID, useSaveMoment, type SaveMoment } from './store';
import { alreadyLine, filedHeadline, localIds, revisitHeadline, savedLine, suggestCollections, TRAY_MS, type TrayChange } from './words';

function Chip({ on, pressed, onClick, label, disabled, children }: { on?: boolean; pressed?: boolean; onClick(): void; label?: string; disabled?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      aria-label={label}
      aria-disabled={disabled || undefined}
      onClick={() => { if (!disabled) onClick(); }}
      className={cn(
        'inline-flex min-h-11 max-w-full min-w-11 items-center justify-center gap-1.5 rounded-full px-4 text-sm font-semibold transition-colors [&_svg]:size-4 [&_svg]:shrink-0',
        on ? 'bg-petal text-[#27302a]' : 'bg-on-island/[0.14] text-on-island hov:bg-on-island/[0.22]',
      )}
    >
      {children}
    </button>
  );
}

function Tray({ moment, close }: { moment: SaveMoment; close(): void }) {
  const archive = useArchive();
  const [item, setItem] = useState<Item>(moment.item);
  const [last, setLast] = useState<TrayChange | null>(null);
  const [busy, setBusy] = useState(false);
  // Only a fresh save counts down, and only until it is touched.
  const [counting, setCounting] = useState(!moment.already);
  const box = useRef<HTMLElement>(null);
  // What "to revisit" goes back to when it is untapped here.
  const restStatus = useRef<Status>(moment.item.status === 'to_revisit' ? 'inbox' : moment.item.status);

  // The chips are chosen once, so they do not change places while a finger is on its way to one.
  const [all] = useState<Collection[]>(() => archive.store.getState().collections);
  const chips = useMemo(() => suggestCollections(all, moment.item), [all, moment.item]);
  const more = all.some(collection => collection.kind === 'local' && !chips.includes(collection));

  /** Leaves by the person's own choice (or the clock). Focus that was in the tray goes to the page, never to nothing. */
  const leave = () => {
    const inside = Boolean(box.current?.contains(document.activeElement));
    close();
    if (inside) setTimeout(recoverFocus);
  };
  const leaveRef = useRef(leave);
  useEffect(() => { leaveRef.current = leave; });

  useEffect(() => {
    if (!counting) return;
    const timer = setTimeout(() => leaveRef.current(), TRAY_MS);
    return () => clearTimeout(timer);
  }, [counting]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') leaveRef.current(); };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);

  // The tray belongs to the page it appeared on. A dialog, a question, an opened save or another view takes its place.
  const covered = useDialogs(state => state.stack.some(entry => entry.open));
  const asking = useConfirm(state => Boolean(state.request));
  const where = useArchiveState(state => `${state.loc.screen}|${state.loc.view}|${state.loc.item}`);
  const startedAt = useRef(where);
  useEffect(() => {
    if (covered || asking || where !== startedAt.current) close();
  }, [covered, asking, where, close]);

  const change = async (body: Record<string, unknown>, next: TrayChange | null) => {
    if (busy) return;
    setBusy(true);
    try {
      const updated = await archive.api.patchItem(item.id, body);
      setItem(updated);
      setLast(next);
      void archive.refreshEditedItem(updated);
    } catch (error) {
      toast(errorMessage(error), { error: true });
    } finally {
      setBusy(false);
    }
  };

  const filed = localIds(item);
  const toggleCollection = (collection: Collection) => {
    const on = !filed.includes(collection.id);
    void change({ collection_ids: on ? [...filed, collection.id] : filed.filter(id => id !== collection.id) }, { headline: filedHeadline(collection.name, on), undo: { collection_ids: filed } });
  };
  const revisit = item.status === 'to_revisit';
  const toggleRevisit = () => void change({ status: revisit ? restStatus.current : 'to_revisit' }, { headline: revisitHeadline(!revisit), undo: { status: item.status } });
  const open = () => { close(); void archive.openItem(item.id); };

  const headline = last?.headline ?? (moment.already ? 'You already kept this.' : 'Kept in your archive.');

  return (
    <section
      ref={box}
      id={SAVE_TRAY_ID}
      tabIndex={-1}
      aria-label={moment.already ? 'Already saved' : 'Just saved'}
      data-busy={busy || undefined}
      onPointerDown={() => setCounting(false)}
      onKeyDown={() => setCounting(false)}
      // A screen reader moves to a chip without a touch or a key. Focus placed on the tray itself (when the save form
      // closes) is not the person acting, so it does not stop the clock.
      onFocus={event => { if (event.target !== event.currentTarget) setCounting(false); }}
      className={cn(
        'fixed inset-x-2.5 bottom-[calc(var(--dock)+var(--safe-bottom)+18px)] z-40 mx-auto grid max-w-[440px] grid-cols-[minmax(0,1fr)] gap-3 rounded-[28px] bg-island p-3.5 text-on-island shadow-lg outline-none',
        'duration-300 animate-in fade-in-0 slide-in-from-bottom-4 motion-reduce:animate-none lg:inset-x-auto lg:end-6 lg:bottom-6 lg:w-[420px]',
      )}
    >
      <div className={cn('flex gap-3', moment.already && !last ? 'items-start' : 'items-center')}>
        {/* A fresh save opens the flower, as saving always has; after a change, or for a repeat, a plain mark. */}
        {moment.already
          ? <Bookmark aria-hidden="true" className={cn('size-5 shrink-0', !last && 'mt-0.5')} />
          : last ? <Check aria-hidden="true" className="size-5 shrink-0" /> : <Bloom size={22} className="-mx-px" />}
        <div role="status" className="min-w-0 flex-1">
          <p className="font-semibold">{headline}</p>
          {moment.already
            ? <p dir="auto" className="text-xs leading-relaxed text-on-island-soft">{alreadyLine(moment.item, moment.carried)}</p>
            : <p dir="auto" className="truncate text-xs text-on-island-soft">{savedLine(item)}</p>}
        </div>
        {/* One button beside the words: Undo after a change, Done before one. Done then moves to the end of the chips. */}
        {last ? <Chip onClick={() => void change(last.undo, null)} disabled={busy}><Undo2 aria-hidden="true" />Undo</Chip> : moment.already ? null : <Chip onClick={leave}>Done</Chip>}
      </div>

      <div>
        {moment.already || last || !chips.length ? null : <p className="label-mono mb-2 !text-on-island-soft">File it in</p>}
        <div className="flex flex-wrap gap-2">
          {moment.already ? <Chip on onClick={open}>Open it</Chip> : null}
          {moment.already ? null : chips.map(collection => {
            const on = filed.includes(collection.id);
            return (
              <Chip key={collection.id} on={on} pressed={on} disabled={busy} onClick={() => toggleCollection(collection)}>
                {on ? <Check aria-hidden="true" /> : <Folder aria-hidden="true" />}
                <span dir="auto" className="truncate">{collection.name}</span>
              </Chip>
            );
          })}
          <Chip on={revisit} pressed={revisit} disabled={busy} onClick={toggleRevisit}>
            {revisit ? <Check aria-hidden="true" /> : <Clock aria-hidden="true" />}
            {moment.already ? 'Mark to revisit' : 'To revisit'}
          </Chip>
          {!moment.already && more ? <Chip label="Another collection" onClick={() => openDialog({ kind: 'bulk', action: 'collection', ids: [item.id] })}><Ellipsis aria-hidden="true" /></Chip> : null}
          {moment.already ? null : <Chip onClick={open}>Open it</Chip>}
          {moment.already || last ? <Chip onClick={leave}>Done</Chip> : null}
        </div>
      </div>

      {/* How long the tray stays. The line's five seconds are TRAY_MS (styles/index.css). Decoration: the clock is in code. */}
      {counting ? (
        <div aria-hidden="true" data-testid="save-tray-countdown" className="h-[3px] overflow-hidden rounded-full bg-on-island/[0.18]">
          <i className="block h-full origin-left animate-tray-countdown bg-petal motion-reduce:hidden rtl:origin-right" />
        </div>
      ) : null}
    </section>
  );
}

/** Mounted once beside the dialogs. Shows nothing until a link is saved. */
export function SaveTray() {
  const moment = useSaveMoment(state => state.moment);
  const close = useSaveMoment(state => state.close);
  // Signing out takes the page away; the tray does not wait behind the sign-in screen.
  useEffect(() => close, [close]);
  return moment ? <Tray key={moment.id} moment={moment} close={close} /> : null;
}
