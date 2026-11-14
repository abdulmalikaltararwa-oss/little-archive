// Adapted from Motion Primitives "Text Scramble" (MIT, https://motion-primitives.com/docs/text-scramble).
// Changes: no component is created during render, the settled text is what assistive technology reads from
// the first frame, the timer is cleared on unmount, the width is reserved so nothing shifts, and with
// reduced motion the text is simply there.
import { useEffect, useState } from 'react';
import { cn } from 'cn';
import { useReducedMotion } from 'motion/react';

const GLYPHS = '.:*+=-~^';

export function TextScramble({ children, duration = 0.7, speed = 0.045, className, trigger = true }: { children: string; duration?: number; speed?: number; className?: string; trigger?: boolean }) {
  const still = useReducedMotion();
  const [scrambled, setScrambled] = useState({ of: '', text: '' });
  const setShown = (text: string) => setScrambled({ of: children, text });
  const moving = trigger && !still;
  // Until the first scrambled frame for this exact text exists, the settled text is shown.
  const shown = moving && scrambled.of === children ? scrambled.text : children;

  useEffect(() => {
    if (!moving) return;
    const steps = Math.max(1, Math.round(duration / speed));
    let step = 0;
    const timer = setInterval(() => {
      const settled = Math.floor((step / steps) * children.length);
      let next = '';
      for (let index = 0; index < children.length; index++) {
        const char = children[index]!;
        next += char === ' ' || index < settled ? char : GLYPHS[Math.floor(Math.random() * GLYPHS.length)];
      }
      setShown(next);
      step += 1;
      if (step > steps) { clearInterval(timer); setShown(children); }
    }, speed * 1000);
    return () => clearInterval(timer);
    // setShown closes over `children`, which is already a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [children, duration, speed, moving]);

  return (
    <span className={cn('relative inline-block', className)}>
      <span className="invisible" aria-hidden="true">{children}</span>
      <span className="sr-only">{children}</span>
      <span className="absolute inset-0" aria-hidden="true">{shown}</span>
    </span>
  );
}
