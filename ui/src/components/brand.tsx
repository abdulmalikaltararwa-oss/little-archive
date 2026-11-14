import { useId } from 'react';
import { cn } from 'cn';
import { motion, useReducedMotion } from 'motion/react';

// The petals of the mark, as drawn in web/icon.svg.
const PETALS: readonly [number, number][] = [[32, 23.6], [36.4, 26.8], [34.7, 32], [29.3, 32], [27.6, 26.8]];

/** The flower-bookmark mark. Drawn inline so it can take the theme's colours and move. */
export function Mark({ size = 36, className, title }: { size?: number; className?: string; title?: string }) {
  const gradient = useId();
  return (
    <svg viewBox="0 0 64 64" width={size} height={size} className={cn('shrink-0', className)} role={title ? 'img' : undefined} aria-label={title} aria-hidden={title ? undefined : true}>
      <defs>
        <linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#5E8468" />
          <stop offset="1" stopColor="#456650" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="20" fill={`url(#${gradient})`} />
      <path d="M20 28a12 12 0 0 1 24 0v21.5l-12-7-12 7Z" fill="#FCF7EC" stroke="#FCF7EC" strokeWidth="2.4" strokeLinejoin="round" />
      <g fill="#EBA9B5">
        {PETALS.map(([cx, cy]) => <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="3.7" />)}
      </g>
      <circle cx="32" cy="28.3" r="2.7" fill="#F3CE6E" />
    </svg>
  );
}

/** The flower alone, opening petal by petal. Used for the save moment and nowhere a person has to wait on it. */
export function Bloom({ size = 28, className, play = true }: { size?: number; className?: string; play?: boolean }) {
  const still = useReducedMotion() || !play;
  return (
    <svg viewBox="20 16 24 24" width={size} height={size} className={cn('shrink-0 overflow-visible', className)} aria-hidden="true">
      {PETALS.map(([cx, cy], index) => (
        <motion.circle
          key={`${cx}-${cy}`}
          cx={cx}
          cy={cy}
          r="3.9"
          fill="var(--petal)"
          style={{ transformOrigin: '32px 28.3px' }}
          initial={still ? false : { scale: 0, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ type: 'spring', stiffness: 420, damping: 16, delay: 0.08 + index * 0.055 }}
        />
      ))}
      <motion.circle
        cx="32"
        cy="28.3"
        r="2.9"
        fill="var(--butter)"
        style={{ transformOrigin: '32px 28.3px' }}
        initial={still ? false : { scale: 0 }}
        animate={{ scale: 1 }}
        transition={{ type: 'spring', stiffness: 500, damping: 14, delay: 0.02 }}
      />
    </svg>
  );
}

export function Brand({ small = false, className }: { small?: boolean; className?: string }) {
  return (
    <div className={cn('group/brand flex items-center gap-2.5 text-ink', className)}>
      <Mark size={small ? 30 : 38} className="-rotate-6 drop-shadow-[0_4px_6px_#2f3c3233] transition-transform duration-300 ease-spring group-hover/brand:rotate-6 group-hover/brand:scale-105" />
      <span className={cn('display leading-none', small ? 'text-lg' : 'text-[1.4rem]')}>little archive</span>
    </div>
  );
}
