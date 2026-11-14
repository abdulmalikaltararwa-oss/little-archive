// The app's one yes/no question. An alert dialog: focus starts on the safe answer, Escape means no.
import { useState } from 'react';
import { cn } from 'cn';
import { Check, Trash2 } from 'lucide-react';
import { AlertDialog } from 'radix-ui';
import { useBusy } from '@/app/archive-context';
import { useConfirm } from '@/app/ui-state';
import { restoreFocus } from '@/lib/focus';
import { Button } from './ui/button';

export function ConfirmHost() {
  const request = useConfirm(state => state.request);
  const settle = useConfirm(state => state.settle);
  const [pending, run] = useBusy();
  // The last question is kept so the dialog can finish closing with its words still in place.
  const [last, setLast] = useState(request);
  if (request && request !== last) setLast(request);
  const shown = request ?? last;

  return (
    <AlertDialog.Root open={Boolean(request)} onOpenChange={open => { if (!open && !pending) settle(false); }}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 z-[60] bg-scrim backdrop-blur-[3px] data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <AlertDialog.Content
          onCloseAutoFocus={event => { event.preventDefault(); restoreFocus(shown?.opener ?? null, { strict: true }); }}
          className={cn(
            'fixed inset-x-0 bottom-0 z-[60] w-full rounded-t-xl border border-line bg-card p-6 pb-[calc(var(--safe-bottom)+1.25rem)] shadow-lg outline-none',
            'duration-200 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0 max-sm:data-[state=open]:slide-in-from-bottom-10',
            'sm:inset-auto sm:top-1/2 sm:left-1/2 sm:max-w-[420px] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-xl sm:pb-6 sm:data-[state=open]:zoom-in-95',
          )}
        >
          <AlertDialog.Title className="display text-xl text-ink">{shown?.title}</AlertDialog.Title>
          <AlertDialog.Description className="mt-2 text-sm leading-relaxed text-ink-soft">{shown?.message}</AlertDialog.Description>
          <div className="mt-6 flex flex-wrap justify-end gap-2">
            <AlertDialog.Cancel asChild>
              <Button variant="outline" disabled={pending}>{shown?.cancelLabel ?? 'Cancel'}</Button>
            </AlertDialog.Cancel>
            <Button
              variant={shown?.danger ? 'danger' : 'primary'}
              aria-busy={pending || undefined}
              disabled={pending}
              onClick={() => {
                if (!request) return;
                if (!request.action) { settle(true); return; }
                void run(async () => { await request.action?.(); settle(true); });
              }}
            >
              {shown?.danger ? <Trash2 /> : <Check />}
              {shown?.confirmLabel ?? (shown?.danger ? 'Delete' : 'Continue')}
            </Button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
