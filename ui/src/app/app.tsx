import { useEffect } from 'react';
import { MotionConfig } from 'motion/react';
import { useStore } from 'zustand';
import { ConfirmHost } from '@/components/confirm';
import { AiPermissionHost } from '@/features/ai-permission/host';
import { Island } from '@/components/island';
import type { Archive } from '@/data/archive';
import { BootScreen, LoginScreen } from '@/features/auth/screens';
import { DetailPanel } from '@/features/detail/detail-panel';
import { DialogHost } from '@/features/dialogs/host';
import { LibraryScreen, SEARCH_INPUT_ID } from '@/features/library/library-screen';
import { clearRecent } from '@/features/palette/recent';
import { SaveTray } from '@/features/save-moment/tray';
import { FeatureScreen } from '@/features/screens';
import { Shell } from '@/features/shell/shell';
import { cspNonce } from '@/lib/nonce';
import { ArchiveProvider } from './archive-context';
import { openDialog, useConfirm, useDialogs } from './ui-state';

function isTyping(target: EventTarget | null) {
  const node = target as HTMLElement | null;
  return Boolean(node && (node.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(node.tagName)));
}

export function App({ archive }: { archive: Archive }) {
  const phase = useStore(archive.store, state => state.phase);
  const bootError = useStore(archive.store, state => state.bootError);
  const screen = useStore(archive.store, state => state.loc.screen);
  const rest = useStore(archive.store, state => state.loc.rest);
  const share = useStore(archive.store, state => state.pendingShare);
  const demo = archive.backend.kind === 'demo';

  // A link shared from the phone's share sheet only opens the ordinary save dialog, prefilled. It waits
  // through sign-in, and saving stays an explicit tap.
  useEffect(() => {
    if (phase !== 'ready' || !share) return;
    const pending = archive.takeShare();
    if (pending) openDialog({ kind: 'save-link', share: pending });
  }, [archive, phase, share]);

  // Signing out (or a session that ended) leaves nothing open behind the sign-in screen.
  useEffect(() => {
    if (phase !== 'signed-out') return;
    useDialogs.getState().closeAll();
    useConfirm.getState().settle(false);
    // The searches made here belong to whoever was signed in.
    clearRecent(archive.backend.remembers);
  }, [archive, phase]);

  useEffect(() => {
    const focusSearch = () => {
      // Only the wall has the search box; a feature screen and the review queue do not.
      const { screen, view } = archive.store.getState().loc;
      if (screen !== 'library' || view === 'review') archive.goView('all');
      requestAnimationFrame(() => {
        const input = document.getElementById(SEARCH_INPUT_ID) as HTMLInputElement | null;
        input?.focus();
        input?.select();
      });
    };
    const onKey = (event: KeyboardEvent) => {
      if (archive.store.getState().phase !== 'ready') return;
      const key = event.key.toLowerCase();
      const command = event.metaKey || event.ctrlKey;
      const dialogs = useDialogs.getState();
      const covered = dialogs.stack.some(entry => entry.open) || Boolean(useConfirm.getState().request) || Boolean(archive.store.getState().loc.item);
      if (command && key === 'k') {
        event.preventDefault();
        const palette = dialogs.stack.find(entry => entry.kind === 'palette' && entry.open);
        if (palette) dialogs.close(palette.id);
        else if (!covered) openDialog({ kind: 'palette' });
        return;
      }
      if (covered) return;
      if ((command && key === 'f') || (key === '/' && !command && !event.altKey && !isTyping(event.target))) {
        event.preventDefault();
        focusSearch();
      }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [archive]);

  return (
    <ArchiveProvider archive={archive}>
      <MotionConfig reducedMotion="user" nonce={cspNonce()}>
        <a href="#main" className="fixed start-3 -top-20 z-[200] rounded-md border-2 border-sage bg-card px-4 py-3 text-sm font-semibold text-ink focus:top-3">Skip to content</a>
        {phase === 'booting' ? <BootScreen /> : null}
        {phase === 'boot-error' ? <BootScreen error={bootError} onRetry={() => void archive.boot()} /> : null}
        {phase === 'signed-out' ? <LoginScreen /> : null}
        {phase === 'ready' ? (
          <>
            <Shell demo={demo}>{screen === 'library' ? <LibraryScreen demo={demo} /> : <FeatureScreen screen={screen} demo={demo} rest={rest} />}</Shell>
            <DetailPanel />
            <DialogHost />
            <SaveTray />
          </>
        ) : null}
        <AiPermissionHost />
        <ConfirmHost />
        <Island />
      </MotionConfig>
    </ArchiveProvider>
  );
}
