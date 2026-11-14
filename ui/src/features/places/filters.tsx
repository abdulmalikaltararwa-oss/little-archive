// The filters above the list: words (name, city, country, address), a kind, and "with coordinates only". They
// change the query sent to GET /api/places, so the map and the list always show the same places. On a phone the
// search stays in view and the rest sits behind a "Filters" button, so the map is the first thing on the screen.
import { useId, useState } from 'react';
import { cn } from 'cn';
import { Layers, Search, SlidersHorizontal, X } from 'lucide-react';
import { Pick } from '@/components/pick';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { PLACE_KINDS, type PlaceKind } from './api';
import { KIND_LABELS } from './labels';

type KindChoice = PlaceKind | 'all';

const KIND_OPTIONS = [{ value: 'all' as KindChoice, label: 'All kinds of place' }, ...PLACE_KINDS.map(kind => ({ value: kind as KindChoice, label: KIND_LABELS[kind] }))];

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange(value: boolean): void }) {
  const id = useId();
  return (
    <div className="flex min-h-11 items-center justify-between gap-4">
      <label htmlFor={id} className="min-w-0 text-sm text-ink">{label}</label>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

export interface PlaceFiltersProps {
  q: string;
  onQ(value: string): void;
  kind: PlaceKind | '';
  onKind(value: PlaceKind | ''): void;
  withCoordinates: boolean;
  onWithCoordinates(value: boolean): void;
  /** Present where a map is beside the list: narrows the list to what the map is showing. */
  inView?: { checked: boolean; onChange(value: boolean): void } | null;
  /** On a phone the filters fold away and the map tiles button joins the search. */
  phone: boolean;
  tilesOn: boolean;
  onOpenTiles(): void;
}

export function PlaceFilters({ q, onQ, kind, onKind, withCoordinates, onWithCoordinates, inView, phone, tilesOn, onOpenTiles }: PlaceFiltersProps) {
  const searchId = useId();
  const panelId = useId();
  const [open, setOpen] = useState(false);
  const active = (kind ? 1 : 0) + (withCoordinates ? 1 : 0);

  const search = (
    <div className="relative min-w-0 flex-1">
      <Search className="pointer-events-none absolute start-4 top-1/2 size-4 -translate-y-1/2 text-ink-soft" aria-hidden="true" />
      <input
        id={searchId}
        type="search"
        value={q}
        onChange={event => onQ(event.target.value)}
        placeholder="Search your places…"
        aria-label="Search places by name, city, region, country or address"
        autoComplete="off"
        spellCheck={false}
        dir="auto"
        maxLength={200}
        className="h-11 w-full rounded-full border border-line-strong bg-card ps-11 pe-11 text-base text-ink shadow-xs outline-none transition-[border-color,box-shadow] placeholder:text-ink-soft/80 focus-visible:border-sage focus-visible:ring-4 focus-visible:ring-sage/15 dark:bg-card-2 [&::-webkit-search-cancel-button]:appearance-none"
      />
      {q ? (
        <button type="button" aria-label="Clear the search" onClick={() => onQ('')} className="hit-44 absolute end-2.5 top-1/2 grid size-7 -translate-y-1/2 place-items-center rounded-full text-ink-soft hov:bg-card-2 hov:text-ink">
          <X className="size-4" aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );

  const controls = (
    <>
      <Pick<KindChoice> label="Kind of place" value={kind || 'all'} options={KIND_OPTIONS} onChange={value => onKind(value === 'all' ? '' : value)} />
      <div className="flex flex-col divide-y divide-line px-1">
        <Toggle label="With coordinates only" checked={withCoordinates} onChange={onWithCoordinates} />
        {inView ? <Toggle label="Only what the map shows" checked={inView.checked} onChange={inView.onChange} /> : null}
      </div>
    </>
  );

  if (!phone) return <div className="flex flex-col gap-2.5">{search}{controls}</div>;
  return (
    <div>
      <div className="flex items-center gap-2">
        {search}
        <Button variant="outline" size="icon" className="relative size-11 rounded-full" aria-label={active ? `Filters, ${active} on` : 'Filters'} aria-expanded={open} aria-controls={panelId} onClick={() => setOpen(value => !value)}>
          <SlidersHorizontal />
          {active ? <span aria-hidden="true" className="num absolute -end-0.5 -top-0.5 grid size-4.5 place-items-center rounded-full bg-sage text-2xs text-on-sage">{active}</span> : null}
        </Button>
        <Button variant="outline" size="icon" className="relative size-11 rounded-full" aria-label={`Map tiles, ${tilesOn ? 'on' : 'off'}`} onClick={onOpenTiles}>
          <Layers />
          <span aria-hidden="true" className={cn('absolute end-1 top-1 size-2 rounded-full ring-2 ring-card', tilesOn ? 'bg-sage' : 'bg-line-strong')} />
        </Button>
      </div>
      {open ? <div id={panelId} className="mt-2.5 flex flex-col gap-2.5">{controls}</div> : null}
    </div>
  );
}
