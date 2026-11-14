// Adapted from Magic UI "Number Ticker" (MIT, https://magicui.design/docs/components/number-ticker).
// Changes: the number is formatted for the reader's locale, the real value is always present for assistive
// technology (the moving digits are hidden from it), a changed value counts from the previous one instead
// of from zero, and with reduced motion the final value is simply shown.
import { useEffect, useRef, type ComponentPropsWithoutRef } from 'react';
import { cn } from 'cn';
import { useInView, useMotionValue, useReducedMotion, useSpring } from 'motion/react';

interface NumberTickerProps extends ComponentPropsWithoutRef<'span'> {
  value: number;
  delay?: number;
}

const format = (value: number) => Math.round(value).toLocaleString();

export function NumberTicker({ value, delay = 0, className, ...props }: NumberTickerProps) {
  const ref = useRef<HTMLSpanElement>(null);
  const still = useReducedMotion();
  const motionValue = useMotionValue(0);
  const spring = useSpring(motionValue, { damping: 46, stiffness: 180 });
  const inView = useInView(ref, { once: true, margin: '0px' });

  useEffect(() => {
    if (still) return;
    if (!inView) return;
    const timer = setTimeout(() => motionValue.set(value), delay * 1000);
    return () => clearTimeout(timer);
  }, [motionValue, inView, delay, value, still]);

  useEffect(() => {
    if (still) return;
    return spring.on('change', latest => {
      if (ref.current) ref.current.textContent = format(latest);
    });
  }, [spring, still]);

  return (
    <span className={cn('num inline-block', className)} {...props}>
      <span className="sr-only">{format(value)}</span>
      <span ref={ref} aria-hidden="true">{still ? format(value) : format(0)}</span>
    </span>
  );
}
