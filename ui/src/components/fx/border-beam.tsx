// Adapted from Magic UI "Border Beam" (MIT, https://magicui.design/docs/components/border-beam).
// Changes: colours default to the theme's petal and butter, and with reduced motion the beam does not travel
// (a still, tinted border remains). It marks something the AI suggested and is never the only mark: the
// evidence label sits beside it in words.
import type { CSSProperties } from 'react';
import { cn } from 'cn';
import { motion, useReducedMotion, type MotionStyle } from 'motion/react';

interface BorderBeamProps {
  size?: number;
  duration?: number;
  delay?: number;
  colorFrom?: string;
  colorTo?: string;
  className?: string;
  borderWidth?: number;
}

export function BorderBeam({ className, size = 90, delay = 0, duration = 7, colorFrom = 'var(--petal)', colorTo = 'var(--butter)', borderWidth = 1.5 }: BorderBeamProps) {
  const still = useReducedMotion();
  if (still) {
    return <div aria-hidden="true" className="pointer-events-none absolute inset-0 rounded-[inherit] border-[1.5px] border-petal/60" />;
  }
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 rounded-[inherit] border-(length:--border-beam-width) border-transparent mask-[linear-gradient(transparent,transparent),linear-gradient(#000,#000)] mask-intersect [mask-clip:padding-box,border-box]"
      style={{ '--border-beam-width': `${borderWidth}px` } as CSSProperties}
    >
      <motion.div
        className={cn('absolute aspect-square bg-linear-to-l from-(--color-from) via-(--color-to) to-transparent', className)}
        style={{ width: size, offsetPath: `rect(0 auto auto 0 round ${size}px)`, '--color-from': colorFrom, '--color-to': colorTo } as MotionStyle}
        initial={{ offsetDistance: '0%' }}
        animate={{ offsetDistance: ['0%', '100%'] }}
        transition={{ repeat: Infinity, ease: 'linear', duration, delay: -delay }}
      />
    </div>
  );
}
