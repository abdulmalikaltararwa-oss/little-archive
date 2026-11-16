// The frame around every screen: sidebar on a wide screen, a floating dock on a phone, the top bar, and the
// demo's banner. The dock replaces the buildless interface's hamburger: the four things a thumb reaches for
// (library, search, save, browse) are one tap away, with Save in the middle.
import { useRef, type ReactNode } from 'react';
import { cn } from 'cn';
import { FolderHeart, House, Plus, RotateCcw, Search, Settings, Sparkles, Upload } from 'lucide-react';
import { useArchive, useArchiveState } from '@/app/archive-context';
import { openDialog, type OpenDialog } from '@/app/ui-state';
import { Brand } from '@/components/brand';
import { Modal } from '@/components/modal';
import { Button } from '@/components/ui/button';
import { restoreFocus, VIEW_TITLE_ID } from '@/lib/focus';
import { NavContent } from './nav';

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

export function DemoBanner() {
  return (
    <div role="note" className="sticky top-0 z-40 flex min-h-11 items-center justify-center gap-3 border-b border-sage/15 bg-sage-pale px-4 py-1.5 pt-[calc(var(--safe-top)+0.375rem)] text-xs text-ink">
      <span className="flex min-w-0 items-center gap-2">
        <Sparkles className="size-3.5 shrink-0 text-sage dark:text-sage-deep" aria-hidden="true" />
        <span><strong className="font-semibold">Interactive demo</strong> <span className="text-ink-soft">· synthetic content<span className="max-sm:hidden"> · changes reset on reload</span></span></span>
      </span>
      <Button variant="ghost" size="sm" className="h-7 shrink-0 border border-sage/25 px-2.5 coarse:h-8" onClick={() => location.reload()}>
        <RotateCcw className="size-3" />
        Reset demo
      </Button>
    </div>
  );
}

/**
 * The bar is as tall as its content plus the status bar or notch it sits under, so the brand and the buttons keep their
 * 4rem (5rem on a wide screen). The demo's banner above it already pads for that inset, so with the banner the bar does not.
 */
function TopBar({ demo }: { demo: boolean }) {
  return (
    <header className={cn('flex items-center justify-between gap-3 px-4 sm:px-6 lg:px-10', demo ? 'h-16 lg:h-20' : 'h-[calc(4rem+var(--safe-top))] pt-[var(--safe-top)] lg:h-[calc(5rem+var(--safe-top))]')}>
      <div className="lg:hidden"><Brand small /></div>
      <p className="display hidden text-lg font-normal text-ink-soft lg:block">A little space for everything you love</p>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => openDialog({ kind: 'palette' })}
          aria-label="Search or jump to anything"
          aria-keyshortcuts={IS_MAC ? 'Meta+K' : 'Control+K'}
          className="hidden h-10.5 items-center gap-2.5 rounded-full border border-line bg-card/70 ps-3.5 pe-2 text-sm text-ink-soft transition-colors hov:border-line-strong hov:bg-card hov:text-ink lg:flex"
        >
          <Search className="size-4" aria-hidden="true" />
          <span>Jump to anything</span>
          <kbd aria-hidden="true" className="num rounded-full border border-line bg-card-2 px-2 py-0.5 text-2xs">{IS_MAC ? '⌘K' : 'Ctrl K'}</kbd>
        </button>
        <Button variant="outline" className="max-sm:size-10.5 max-sm:px-0" onClick={() => openDialog({ kind: 'import' })} aria-label="Import">
          <Upload />
          <span className="max-sm:hidden">Import</span>
        </Button>
        <Button variant="primary" className="max-lg:hidden" onClick={() => openDialog({ kind: 'save-link' })}>
          <Plus />
          Save a link
        </Button>
      </div>
    </header>
  );
}

function DockButton({ label, onClick, active, children, primary }: { label: string; onClick(): void; active?: boolean; children: ReactNode; primary?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'relative grid place-items-center rounded-full transition-[transform,background-color,color] duration-200 ease-spring active:scale-90 [&_svg]:size-[1.35rem]',
        primary ? 'size-14 -translate-y-1.5 bg-sage text-on-sage shadow-[0_12px_22px_-10px_var(--sage)] ring-4 ring-paper [&_svg]:size-6' : 'size-12 text-on-island-soft',
        active && 'text-on-island after:absolute after:bottom-1.5 after:size-1 after:rounded-full after:bg-petal',
      )}
    >
      {children}
    </button>
  );
}

/** The phone's navigation. Hidden while a selection is being made: the bulk bar takes its place. */
function Dock({ hidden }: { hidden: boolean }) {
  const archive = useArchive();
  const home = useArchiveState(state => state.loc.screen === 'library' && state.loc.view === 'all');
  return (
    <nav
      aria-label="Quick actions"
      inert={hidden}
      className={cn(
        'fixed inset-x-0 bottom-[calc(var(--safe-bottom)+10px)] z-30 mx-auto flex h-[var(--dock)] w-fit items-center gap-1 rounded-full bg-island px-2.5 shadow-lg transition-[transform,opacity] duration-300 ease-out lg:hidden',
        hidden && 'pointer-events-none translate-y-24 opacity-0',
      )}
    >
      <DockButton label="Library" active={home} onClick={() => { archive.goView('all'); scrollTo({ top: 0 }); }}><House aria-hidden="true" /></DockButton>
      <DockButton label="Search" onClick={() => openDialog({ kind: 'palette' })}><Search aria-hidden="true" /></DockButton>
      <DockButton label="Save a link" primary onClick={() => openDialog({ kind: 'save-link' })}><Plus aria-hidden="true" strokeWidth={2.4} /></DockButton>
      <DockButton label="Open navigation" onClick={() => openDialog({ kind: 'browse' })}><FolderHeart aria-hidden="true" /></DockButton>
      <DockButton label="Settings & connections" onClick={() => openDialog({ kind: 'settings' })}><Settings aria-hidden="true" /></DockButton>
    </nav>
  );
}

/** The phone's navigation sheet: the sidebar's content in a dialog. */
export function BrowseSheet({ spec, close }: { spec: OpenDialog; close(): void }) {
  const left = useRef<'view' | 'dialog' | null>(null);
  return (
    <Modal
      open={spec.open}
      onClose={close}
      title="Browse your archive"
      bodyClassName="pb-8"
      closeFocus={() => {
        // A view chosen here announces itself: focus lands on its heading. A dialog opened from here keeps the
        // focus it took. Closing without choosing returns to the dock.
        if (left.current === 'view') document.getElementById(VIEW_TITLE_ID)?.focus({ preventScroll: true });
        else if (left.current !== 'dialog') restoreFocus(spec.opener);
      }}
    >
      <NavContent onNavigate={to => { left.current = to; close(); }} />
    </Modal>
  );
}

export function Shell({ children, demo }: { children: ReactNode; demo: boolean }) {
  const selecting = useArchiveState(state => state.selected.size > 0);
  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[var(--sidebar)_minmax(0,1fr)]">
      <aside aria-label="Library navigation" className="sticky top-0 hidden h-dvh flex-col gap-7 overflow-y-auto overscroll-contain border-e border-line bg-paper-deep/80 px-4 pt-7 pb-5 lg:flex">
        <div className="px-2"><Brand /></div>
        <NavContent />
      </aside>
      {/* Where a phone draws the page under its status bar, the page scrolls behind the clock. This strip is as tall
          as that inset and stays put, so nothing shows through. Where there is no inset it has no height. */}
      <div aria-hidden="true" className="pointer-events-none fixed inset-x-0 top-0 z-40 h-[var(--safe-top)] bg-paper" />
      <div className="min-w-0">
        {demo ? <DemoBanner /> : null}
        <TopBar demo={demo} />
        <main id="main" tabIndex={-1} className="mx-auto w-full max-w-[1800px] px-4 pb-[calc(var(--dock)+var(--safe-bottom)+40px)] outline-none sm:px-6 lg:px-10 lg:pb-14">
          {children}
        </main>
      </div>
      <Dock hidden={selecting} />
    </div>
  );
}
