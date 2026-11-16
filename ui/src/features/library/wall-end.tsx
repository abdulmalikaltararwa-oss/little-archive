// The true end of the wall: one line of real text saying that was everything, and the border garden under it.
// It is part of the page, after the last card, so it scrolls in with it and is never behind anything. It is not
// drawn while saves are loading or while there are more to load: it never promises an end that is not there.
import { useMemo } from 'react';
import { useArchive, useArchiveState } from '@/app/archive-context';
import { Whisper } from '@/components/field';
import { Garden } from '@/components/fx/ascii';
import { endLine, firstSaveMonth, wallEnded } from './words';

export function WallEnd() {
  const list = useArchiveState(state => state.list);
  const items = useArchiveState(state => state.items);
  const total = useArchiveState(state => state.total);
  const loadingMore = useArchiveState(state => state.loadingMore);
  const sort = useArchiveState(state => state.filters.sort);
  const ended = wallEnded({ list, count: items.length, total, loadingMore, sort });
  // "Your first save" is a claim about the whole library: every save is on the wall (nothing narrowed, nothing
  // archived out of sight) and the wall holds as many saves as the library does. The demo's saves are nobody's.
  const whole = useArchiveState(state => state.loc.view === 'all' && !state.loc.q && !state.loc.tag && !state.loc.platform && !state.stats.archived && state.stats.total === state.total);
  const mine = useArchive().backend.kind !== 'demo';
  const first = useMemo(() => (ended && whole && mine ? firstSaveMonth(items) : null), [ended, whole, mine, items]);
  if (!ended) return null;
  return (
    <div data-testid="wall-end" className="pt-2 text-center">
      <p><Whisper>{endLine(total, first)}</Whisper></p>
      <Garden bed="wall" className="mt-4" />
    </div>
  );
}
