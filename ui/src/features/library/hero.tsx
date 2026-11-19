// The top of the home view: the line the product is known by, the library's numbers counting up, and the
// flower field settling into the mark. It appears only on "All saves" with nothing narrowed; a working view
// (a search, a collection) starts straight at its heading.
import { lazy, Suspense, useState } from 'react';
import { useArchive, useArchiveState } from '@/app/archive-context';
import { NumberTicker } from '@/components/fx/number-ticker';

const AsciiFieldCanvas = lazy(() => import('@/components/fx/ascii-field'));

function Stat({ value, label, onClick, delay }: { value: number; label: string; onClick(): void; delay: number }) {
  return (
    <button type="button" onClick={onClick} className="group/stat flex items-baseline gap-1.5 rounded-full bg-card/70 py-1 ps-3 pe-3.5 text-sm text-ink-soft ring-1 ring-line backdrop-blur-sm transition-[background-color,transform] duration-200 hov:-translate-y-px hov:bg-card">
      <NumberTicker value={value} delay={delay} className="text-base font-medium text-ink" />
      <span>{label}</span>
    </button>
  );
}

export function Hero() {
  const archive = useArchive();
  const stats = useArchiveState(state => state.stats);
  // On a phone the mark sits in the middle of its narrow strip; on a wide screen it leans toward the end edge.
  const [wide] = useState(() => matchMedia('(min-width: 640px)').matches);
  return (
    <section aria-label="Your personal archive" className="hero-paper relative isolate mb-8 min-h-[196px] overflow-hidden rounded-2xl border border-sage/15 max-sm:flex max-sm:items-center sm:min-h-[232px]">
      <div className="absolute inset-y-0 end-0 w-[44%] [mask-image:linear-gradient(to_left,black_70%,transparent)] sm:w-[60%] sm:[mask-image:linear-gradient(to_left,black_52%,transparent)] rtl:[mask-image:linear-gradient(to_right,black_52%,transparent)]">
        <Suspense fallback={null}>
          <AsciiFieldCanvas anchor={wide ? 0.64 : 0.5} />
        </Suspense>
      </div>
      <div className="relative z-[1] flex max-w-[60%] flex-col items-start p-5 sm:max-w-[34rem] sm:p-10">
        <p className="display text-[2rem] leading-[1.05] text-ink sm:text-5xl">Good things, kept close.</p>
        <div className="mt-5 flex flex-wrap gap-2 max-sm:hidden">
          <Stat value={stats.total} label={stats.total === 1 ? 'save' : 'saves'} delay={0.15} onClick={() => archive.goView('all')} />
          <Stat value={stats.favorites} label="loved" delay={0.25} onClick={() => archive.goView('favorites')} />
          <Stat value={stats.to_revisit} label="to revisit" delay={0.35} onClick={() => archive.goView('revisit')} />
          {stats.needs_review ? <Stat value={stats.needs_review} label="to review" delay={0.45} onClick={() => archive.goView('review')} /> : null}
        </div>
      </div>
    </section>
  );
}
