// Small hooks the places screen shares: a debounced value, an element's size, and a media query. None of them
// sets state while an effect runs; each answer arrives from a timer, an observer or a subscription.
import { useEffect, useState, useSyncExternalStore } from 'react';

/** A value that follows `value` after it has been still for `delay` ms. */
export function useDebounced<T>(value: T, delay = 250): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return settled;
}

/** The size of an element, kept current by a ResizeObserver. Attach `ref` to the element. */
export function useElementSize<T extends HTMLElement>() {
  const [node, setNode] = useState<T | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    if (!node) return;
    const observer = new ResizeObserver(entries => {
      const box = entries[0]?.contentRect;
      if (box) setSize(previous => (previous.width === Math.round(box.width) && previous.height === Math.round(box.height) ? previous : { width: Math.round(box.width), height: Math.round(box.height) }));
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [node]);
  return [setNode, size] as const;
}

/** Whether a CSS media query matches now, and again whenever it changes. */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    notify => {
      const list = matchMedia(query);
      list.addEventListener('change', notify);
      return () => list.removeEventListener('change', notify);
    },
    () => matchMedia(query).matches,
    () => false,
  );
}
