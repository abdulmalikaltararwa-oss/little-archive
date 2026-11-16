// Every dialog in the app is this one component: a Radix dialog (focus trap, Escape, aria) wearing Little
// Archive's paper. On a phone it is a sheet that rises from the bottom edge; on a wide screen a card in the
// middle, or (variant "panel") a drawer on the end edge.
import { useId, useRef, type ReactNode, type RefObject } from 'react';
import { cn } from 'cn';
import { X } from 'lucide-react';
import { Dialog } from 'radix-ui';
import { restoreFocus, type FocusMemory } from '@/lib/focus';
import { Button } from './ui/button';

export interface ModalProps {
  open: boolean;
  /** Called once the dialog may close. */
  onClose(): void;
  title: string;
  /** A sentence under the title; it is also the dialog's accessible description. */
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  variant?: 'dialog' | 'panel';
  /** Return false to keep the dialog open (unsaved edits, an import in flight). */
  canClose?: () => boolean | Promise<boolean>;
  /** What had focus before the dialog opened; focus returns there. */
  opener?: FocusMemory | Element | null;
  /** Decides where focus goes when the dialog closes, in place of returning to the opener. */
  closeFocus?: () => void;
  /** 'content' rests focus on the dialog itself, which keeps a phone's keyboard closed. */
  initialFocus?: 'content' | RefObject<HTMLElement | null>;
  /** Extra controls beside the close button. */
  headerExtra?: ReactNode;
  className?: string;
  bodyClassName?: string;
  /** Lets the page's own view transition reveal the panel instead of the slide. */
  quietEnter?: boolean;
  testId?: string;
}

const SIZES = { sm: 'sm:max-w-[440px]', md: 'sm:max-w-[580px]', lg: 'sm:max-w-[720px]' };

export function Modal({ open, onClose, title, description, children, footer, size = 'md', variant = 'dialog', canClose, opener, closeFocus, initialFocus, headerExtra, className, bodyClassName, quietEnter, testId }: ModalProps) {
  const descriptionId = useId();
  const closing = useRef(false);

  const attemptClose = async () => {
    if (closing.current) return;
    closing.current = true;
    try {
      if (!canClose || (await canClose())) onClose();
    } finally {
      closing.current = false;
    }
  };

  const panel = variant === 'panel';
  return (
    <Dialog.Root open={open} onOpenChange={next => { if (!next) void attemptClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay
          className={cn(
            'fixed inset-0 z-50 bg-scrim backdrop-blur-[3px] data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0',
            quietEnter && 'data-[state=open]:animate-none',
          )}
        />
        <Dialog.Content
          data-testid={testId}
          aria-describedby={description ? descriptionId : undefined}
          onOpenAutoFocus={event => {
            if (!initialFocus) return;
            event.preventDefault();
            if (initialFocus === 'content') (event.currentTarget as HTMLElement).focus({ preventScroll: true });
            else initialFocus.current?.focus({ preventScroll: true });
          }}
          onCloseAutoFocus={event => {
            event.preventDefault();
            if (closeFocus) closeFocus();
            else restoreFocus(opener ?? null);
          }}
          className={cn(
            'fixed z-50 flex flex-col bg-card text-ink shadow-lg outline-none focus-visible:outline-none',
            'duration-200 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0',
            panel
              ? [
                  'inset-y-0 end-0 h-dvh w-full border-s border-line sm:max-w-[540px] sm:rounded-s-xl',
                  'data-[state=closed]:slide-out-to-right-8 data-[state=open]:slide-in-from-right-8 max-sm:data-[state=closed]:slide-out-to-bottom-8 max-sm:data-[state=open]:slide-in-from-bottom-8',
                ]
              : [
                  // Phone: a sheet on the bottom edge, never taller than the room under the status bar (in the phone app
                  // the page is short while the keyboard is up; where there is no inset this is 94dvh). Wide: a centred card.
                  'inset-x-0 bottom-0 max-h-[min(94dvh,calc(100dvh-var(--safe-top)-8px))] w-full rounded-t-xl border border-line',
                  'max-sm:data-[state=closed]:slide-out-to-bottom-10 max-sm:data-[state=open]:slide-in-from-bottom-10',
                  'sm:inset-auto sm:top-1/2 sm:left-1/2 sm:max-h-[min(88dvh,860px)] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-xl sm:data-[state=closed]:zoom-out-95 sm:data-[state=open]:zoom-in-95',
                  SIZES[size],
                ],
            quietEnter && 'data-[state=open]:animate-none',
            className,
          )}
        >
          <header className={cn('flex shrink-0 items-start justify-between gap-4 px-5 pt-5 pb-3 sm:px-7 sm:pt-6', panel && 'pt-[calc(var(--safe-top)+0.9rem)] pb-2')}>
            <div className="min-w-0">
              <Dialog.Title className={cn('display text-ink', panel ? 'label-mono !font-mono !tracking-[0.08em]' : 'text-2xl')}>{title}</Dialog.Title>
              {description ? <Dialog.Description id={descriptionId} className="mt-1.5 text-sm text-ink-soft">{description}</Dialog.Description> : null}
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {headerExtra}
              <Button variant="ghost" size="icon" className="hit-44 -me-2 -mt-1" aria-label="Close dialog" title="Close dialog" onClick={() => void attemptClose()}>
                <X />
              </Button>
            </div>
          </header>
          <div className={cn('min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-6 sm:px-7', bodyClassName)}>{children}</div>
          {footer ? (
            <footer className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-line bg-card px-5 pt-3.5 pb-[calc(var(--safe-bottom)+0.9rem)] sm:rounded-b-xl sm:px-7 sm:pb-4">
              {footer}
            </footer>
          ) : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
