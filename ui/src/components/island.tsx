// The island: the one place the app says "done". A dark pill at the top of the screen that grows to fit its
// message and shrinks away. The size-morphing spring and the blur-out of leaving content are adapted from
// Cult UI "Dynamic Island" (MIT, https://www.cult-ui.com/docs/components/dynamic-island); the rest (queueing,
// tones, the bloom, live-region roles) is Little Archive's.
import { useEffect, useState } from 'react';
import { cn } from 'cn';
import { Check, TriangleAlert, X } from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useIsland, type IslandMessage } from '@/app/ui-state';
import { Bloom } from './brand';

const SPRING = { type: 'spring', stiffness: 400, damping: 30 } as const;

function Pill({ message }: { message: IslandMessage }) {
  const dismiss = useIsland(state => state.dismiss);
  const still = useReducedMotion();
  const saved = message.tone === 'saved';
  // A save first shows only the flower opening, then the pill widens to say what happened.
  const [wide, setWide] = useState(!saved || Boolean(still));
  useEffect(() => {
    if (wide) return;
    const timer = setTimeout(() => setWide(true), 520);
    return () => clearTimeout(timer);
  }, [wide]);
  const error = message.tone === 'error';

  return (
    <motion.div
      layout={!still}
      role={error ? 'alert' : 'status'}
      initial={still ? { opacity: 0 } : { opacity: 0, y: -18, scale: 0.8 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={still ? { opacity: 0 } : { opacity: 0, scale: 0.9, y: -10, filter: 'blur(8px)' }}
      transition={SPRING}
      style={{ borderRadius: 26 }}
      className={cn(
        'pointer-events-auto flex min-h-11 max-w-[min(560px,calc(100vw-24px))] items-center gap-2.5 overflow-hidden bg-island py-1.5 ps-2 pe-2 text-sm text-on-island shadow-lg',
        error && 'ring-2 ring-danger/70',
      )}
    >
      <motion.span layout={!still ? 'position' : false} className={cn('grid size-8 shrink-0 place-items-center rounded-full', error ? 'bg-danger text-card' : saved ? 'bg-on-island/10' : 'bg-sage text-on-sage dark:bg-sage-pale dark:text-sage')}>
        {error ? <TriangleAlert className="size-4" aria-hidden="true" /> : saved ? <Bloom size={24} /> : <Check className="size-4" aria-hidden="true" strokeWidth={2.4} />}
      </motion.span>
      {/* The words are in the document from the first frame, so they are announced even while the pill is still narrow. */}
      <motion.span
        layout={!still ? 'position' : false}
        initial={false}
        animate={wide ? { opacity: 1, width: 'auto' } : { opacity: 0, width: 0 }}
        transition={SPRING}
        className="min-w-0 overflow-hidden py-1 pe-1 leading-snug font-medium"
      >
        <span className={cn('block', !wide && 'whitespace-nowrap')}>{message.text}</span>
      </motion.span>
      {wide ? (
        <button
          type="button"
          onClick={() => dismiss(message.id)}
          aria-label="Dismiss notification"
          className="hit-44 grid size-7 shrink-0 place-items-center rounded-full text-on-island-soft transition-colors hov:bg-on-island/10 hov:text-on-island"
        >
          <X className="size-3.5" aria-hidden="true" />
        </button>
      ) : null}
    </motion.div>
  );
}

export function Island() {
  const messages = useIsland(state => state.messages);
  return (
    <div id="toasts" aria-live="polite" aria-atomic="false" className="pointer-events-none fixed inset-x-0 top-[calc(var(--safe-top)+10px)] z-[100] flex flex-col items-center gap-2 px-3">
      <AnimatePresence initial={false} mode="popLayout">
        {messages.map(message => <Pill key={message.id} message={message} />)}
      </AnimatePresence>
    </div>
  );
}
