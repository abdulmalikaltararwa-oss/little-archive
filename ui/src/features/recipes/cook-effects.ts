// The parts of cook mode that reach outside the page: keeping the screen awake, a short chime made in code
// (no audio file is shipped or fetched) and a buzz on phones. Each one is optional. Where the browser has no
// such thing, or refuses it, cook mode simply goes without and says nothing about it.
import { useEffect, useState, useSyncExternalStore } from 'react';

interface AudioWindow { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }

let context: AudioContext | null = null;

/**
 * Gets audio ready. Browsers only let a page make sound after the person has done something on it, so this
 * is called from the tap that starts a timer; the chime then plays on time whatever the tab is doing.
 */
export function primeAudio() {
  try {
    if (!context) {
      const scope = globalThis as unknown as AudioWindow;
      const Context = scope.AudioContext ?? scope.webkitAudioContext;
      if (!Context) return;
      context = new Context();
    }
    if (context.state === 'suspended') void context.resume().catch(() => {});
  } catch { /* No sound; the timer still shows and buzzes. */ }
}

/** Three short, soft notes. Generated here, so there is nothing to download. */
export function playChime() {
  try {
    if (!context) return;
    const audio = context;
    if (audio.state === 'suspended') void audio.resume().catch(() => {});
    const start = audio.currentTime + 0.02;
    [[880, 0], [1174.66, 0.22], [1318.51, 0.44]].forEach(([frequency = 880, offset = 0]) => {
      const oscillator = audio.createOscillator();
      const gain = audio.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, start + offset);
      gain.gain.exponentialRampToValueAtTime(0.22, start + offset + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + offset + 0.34);
      oscillator.connect(gain).connect(audio.destination);
      oscillator.start(start + offset);
      oscillator.stop(start + offset + 0.4);
    });
  } catch { /* Not worth interrupting the kitchen for. */ }
}

export function buzz() {
  try { navigator.vibrate?.([220, 120, 220, 120, 420]); } catch { /* Not every device can. */ }
}

/**
 * Holds the screen awake while `active`, and takes it again when the tab comes back to the front (the
 * browser lets go of it whenever the page is hidden). Returns whether it is held right now.
 */
export function useWakeLock(active: boolean): boolean {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (!active || typeof navigator === 'undefined' || !('wakeLock' in navigator)) return;
    let sentinel: WakeLockSentinel | null = null;
    let stopped = false;

    const acquire = () => {
      navigator.wakeLock.request('screen').then(
        next => {
          if (stopped) { void next.release(); return; }
          sentinel = next;
          setHeld(true);
          next.addEventListener('release', () => {
            if (sentinel === next) { sentinel = null; if (!stopped) setHeld(false); }
          });
        },
        () => { if (!stopped) setHeld(false); },
      );
    };
    const onVisible = () => { if (document.visibilityState === 'visible' && !sentinel) acquire(); };

    acquire();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stopped = true;
      document.removeEventListener('visibilitychange', onVisible);
      const current = sentinel;
      sentinel = null;
      void current?.release().catch(() => {});
    };
  }, [active]);
  return active && held;
}

const WIDE = '(min-width: 1024px)';

function subscribeWide(listener: () => void) {
  const query = matchMedia(WIDE);
  query.addEventListener('change', listener);
  return () => query.removeEventListener('change', listener);
}

/** Whether the screen is wide enough to show the ingredients beside the step instead of in a sheet. */
export function useWide(): boolean {
  return useSyncExternalStore(subscribeWide, () => matchMedia(WIDE).matches, () => false);
}
