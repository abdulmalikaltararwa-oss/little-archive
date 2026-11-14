// The canvas that hosts the flower field. Loaded lazily by the screens that show it, so the characters and
// the engine are not part of the first paint.
import { useEffect, useRef } from 'react';
import { cn } from 'cn';
import { useReducedMotion } from 'motion/react';
import { AsciiField, type FieldPalette } from './ascii-field-engine';

function readPalette(): FieldPalette {
  const style = getComputedStyle(document.documentElement);
  const token = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  return { petal: token('--petal', '#e9a3b0'), heart: token('--butter', '#f3ce6e'), sage: token('--sage', '#4b6f56'), ink: token('--ink-soft', '#5c665f') };
}

export interface AsciiFieldProps {
  className?: string;
  /** Where the mark sits across the width, 0 (start) to 1 (end). */
  anchor?: number;
  /** Character size in pixels. Left out, it follows the height of the box, so a small field is drawn finer. */
  fontSize?: number;
}

export default function AsciiFieldCanvas({ className, anchor = 0.5, fontSize }: AsciiFieldProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  const still = Boolean(useReducedMotion());

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const size = fontSize ?? Math.max(9, Math.min(12, Math.round(canvas.getBoundingClientRect().height / 27)));
    let field: AsciiField;
    try {
      field = new AsciiField(canvas, readPalette(), { anchor, fontSize: size, still, halfRate: matchMedia('(pointer: coarse)').matches });
    } catch { return; } // No 2D canvas: the hero simply has no drawing.
    let disposed = false;
    let seen = { width: 0, height: 0 };
    let first = true;
    const measure = () => {
      const box = canvas.getBoundingClientRect();
      const width = Math.round(box.width);
      const height = Math.round(box.height);
      if (width === seen.width && height === seen.height) return;
      seen = { width, height };
      field.resize(width, height, devicePixelRatio, { intro: first });
      first = false;
    };

    const observer = new ResizeObserver(measure);
    const visible = new IntersectionObserver(entries => {
      if (entries[0]?.isIntersecting) field.breathe();
      else field.pause();
    });
    // The mono face must be ready before the grid is measured, or the cells are the wrong width.
    const fonts = document.fonts?.load(`${size}px "DM Mono"`).catch(() => undefined) ?? Promise.resolve();
    void fonts.then(() => {
      if (disposed) return;
      measure();
      observer.observe(canvas);
      visible.observe(canvas);
    });

    // Listen on the parent so words laid over the field do not shield it from the pointer.
    const surface = canvas.parentElement ?? canvas;
    const stir = (event: PointerEvent) => {
      const box = canvas.getBoundingClientRect();
      field.stir(event.clientX - box.left, event.clientY - box.top, event.pointerType === 'touch' ? 56 : 44);
    };
    surface.addEventListener('pointermove', stir, { passive: true });
    surface.addEventListener('pointerdown', stir, { passive: true });

    const theme = new MutationObserver(() => { field.palette = readPalette(); field.redraw(); });
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    return () => {
      disposed = true;
      observer.disconnect();
      visible.disconnect();
      theme.disconnect();
      surface.removeEventListener('pointermove', stir);
      surface.removeEventListener('pointerdown', stir);
      field.destroy();
    };
  }, [anchor, fontSize, still]);

  return <canvas ref={ref} aria-hidden="true" className={cn('block size-full', className)} />;
}
