// One place in the list: what it is called, what kind of place it is and where, and (once chosen) everything the
// interface knows about it, with where that knowledge came from. A card is a disclosure: its header is a button
// that chooses the place on the map, and the details open beneath it. Everything that came from a saved post
// (the name, the note, the quote, the address) is shown as text with dir="auto".
import { useEffect, useId, useRef, useState } from 'react';
import { stableHue } from '@web/utils.js';
import { cn } from 'cn';
import { ArrowRight, ChevronDown, MapPin, MapPinned, X } from 'lucide-react';
import { useArchive } from '@/app/archive-context';
import { Whisper } from '@/components/field';
import { Button } from '@/components/ui/button';
import type { PlaceRow } from './api';
import { formatCoordinates } from './geo';
import { coordinateStory, evidenceLabel, KIND_TONES, kindLabel, placeWhere, precisionWord, sourceLabel } from './labels';

const TONES = {
  petal: 'bg-petal-pale text-petal-ink',
  sky: 'bg-sky-pale text-sky-ink',
  sage: 'bg-sage-pale text-sage dark:text-sage-deep',
  butter: 'bg-butter-pale text-butter-ink',
  clay: 'bg-clay-pale text-clay-ink',
  lilac: 'bg-lilac-pale text-lilac-ink',
  plain: 'bg-card-3 text-ink-soft',
} as const;

/** The kind of place. The word is always there; the colour only groups kinds. */
export function KindChip({ kind, className }: { kind: string; className?: string }) {
  const tone = TONES[KIND_TONES[kind as keyof typeof KIND_TONES] ?? 'plain'];
  return <span className={cn('inline-flex h-6 items-center rounded-full px-2.5 text-xs font-medium whitespace-nowrap', tone, className)}>{kindLabel(kind)}</span>;
}

// The same six papers a save's text cover is set on, so a place without a picture still belongs to its save.
const PAPERS = [
  'bg-sage-pale text-sage dark:text-sage-deep',
  'bg-petal-pale text-petal-ink',
  'bg-butter-pale text-butter-ink',
  'bg-sky-pale text-sky-ink',
  'bg-clay-pale text-clay-ink',
  'bg-lilac-pale text-lilac-ink',
];

/** The save's own picture, small. Where a save has none, a square of the same paper its cover is set on, with a pin. */
function PlaceThumb({ place }: { place: PlaceRow }) {
  const { backend } = useArchive();
  const source = backend.thumbnail(place.thumbnail_url);
  const image = useRef<HTMLImageElement>(null);
  const [failed, setFailed] = useState('');
  const key = place.thumbnail_url ?? '';
  const attach = source?.type === 'attach' ? source.attach : null;
  // Inside the phone app a thumbnail is fetched with the bearer token and shown from a blob URL.
  useEffect(() => {
    if (attach && image.current) attach(image.current);
    // The path identifies the picture; a new function for the same path must not fetch it again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const shown = source && failed !== key;
  return (
    <span aria-hidden="true" className={cn('grid size-14 shrink-0 place-items-center overflow-hidden rounded-sm', PAPERS[stableHue(place.item_title || place.item_id)])}>
      {shown ? (
        <img
          ref={image}
          src={source.type === 'url' ? source.src : undefined}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          draggable={false}
          onError={() => setFailed(key)}
          className="size-full object-cover"
        />
      ) : (
        <MapPin className="size-5" />
      )}
    </span>
  );
}

/** Where the coordinates came from and how sure the position is, in the terminal voice. Never more than the server said. */
function Coordinates({ place, geocodingEnabled }: { place: PlaceRow; geocodingEnabled: boolean }) {
  const coordinates = place.coordinates;
  if (!coordinates) {
    return (
      <div className="rounded-md bg-card-2 px-3.5 py-3">
        <Whisper>no coordinates yet</Whisper>
        <p className="mt-1.5 text-xs leading-relaxed text-ink-soft">
          Nothing in the save gives this place a position, so it is not on the map.{' '}
          {geocodingEnabled
            ? 'Open the save and choose “Find coordinates” to look them up. Only the place’s name, address, city and country are sent.'
            : 'This server has no geocoder, so none will be looked up. A map link or written coordinates in the save would place it.'}
        </p>
      </div>
    );
  }
  const story = coordinateStory(coordinates);
  return (
    <div className="rounded-md bg-card-2 px-3.5 py-3">
      <Whisper>{story.short} · {precisionWord(coordinates)}</Whisper>
      <p dir="ltr" className="num mt-1.5 text-sm text-ink">{formatCoordinates(coordinates, coordinates.precision)}</p>
      <p className="mt-1.5 text-xs leading-relaxed text-ink-soft">{story.long}{coordinates.precision === 'area' ? ` ${story.precision}` : ''}</p>
      {coordinates.display_name ? <p dir="auto" className="mt-1.5 text-xs leading-relaxed text-ink-soft">Matched to “{coordinates.display_name}”.</p> : null}
      {coordinates.attribution ? <p dir="auto" className="mt-1.5 text-xs leading-relaxed text-ink-soft">{coordinates.attribution}</p> : null}
    </div>
  );
}

/** The words the place was found in, and which field of the save they are from. */
function Evidence({ place }: { place: PlaceRow }) {
  const ai = place.origin === 'ai';
  if (!place.evidence.quote && !ai) return null;
  return (
    <figure className="m-0">
      <figcaption className="label-mono">{ai ? `${evidenceLabel(place.provenance?.evidence_level)} · found by a model` : `found in ${sourceLabel(place.evidence.source)}`}</figcaption>
      {place.evidence.quote ? <blockquote dir="auto" className="mt-1.5 border-s-2 border-sage/40 ps-3 text-sm leading-relaxed [overflow-wrap:anywhere] whitespace-pre-wrap text-ink">{place.evidence.quote}</blockquote> : null}
      {ai ? <p className="mt-1.5 text-xs leading-relaxed text-ink-soft">A model read this place out of the text. It can be wrong; check it against the save. A model never supplies coordinates.</p> : null}
    </figure>
  );
}

export interface PlaceCardProps {
  place: PlaceRow;
  selected: boolean;
  geocodingEnabled: boolean;
  /** Chooses the place (or, if it is already chosen, puts it away). */
  onSelect(): void;
  /** On a phone, where the list and the map are not side by side. */
  onShowOnMap?: () => void;
}

export function PlaceCard({ place, selected, geocodingEnabled, onSelect, onShowOnMap }: PlaceCardProps) {
  const archive = useArchive();
  const detailsId = useId();
  const where = placeWhere(place);
  return (
    <li id={`place-${place.id}`} className="scroll-mt-24">
      <article
        data-selected={selected || undefined}
        className={cn(
          'rounded-lg border bg-card transition-[border-color,box-shadow] duration-200',
          selected ? 'border-sage shadow-md ring-1 ring-sage/30' : 'border-line hov:border-line-strong hov:shadow-xs',
        )}
      >
        <button
          type="button"
          aria-expanded={selected}
          aria-controls={selected ? detailsId : undefined}
          onClick={onSelect}
          className="flex w-full items-start gap-3 rounded-lg p-3 text-start outline-offset-[-2px] active:scale-[0.995]"
        >
          <PlaceThumb place={place} />
          <span className="min-w-0 flex-1">
            <span dir="auto" className="display block text-lg leading-snug text-ink [overflow-wrap:anywhere]">{place.name}</span>
            {where ? <span dir="auto" className="mt-0.5 block text-sm text-ink-soft [overflow-wrap:anywhere]">{where}</span> : null}
            <span className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
              <KindChip kind={place.kind} />
              {place.coordinates ? (
                <span className="label-mono inline-flex items-center gap-1"><MapPinned className="size-3.5" aria-hidden="true" />on the map{place.coordinates.precision === 'area' ? ' · area' : ''}</span>
              ) : (
                <span className="label-mono">no coordinates</span>
              )}
            </span>
          </span>
          <ChevronDown aria-hidden="true" className={cn('mt-1 size-4 shrink-0 text-ink-soft transition-transform duration-200', selected && 'rotate-180')} />
        </button>

        {selected ? (
          <div id={detailsId} className="flex animate-in flex-col gap-4 border-t border-line px-3.5 pt-4 pb-3.5 duration-200 fade-in-0">
            {place.address ? <p dir="auto" className="text-sm text-ink [overflow-wrap:anywhere]">{place.address}</p> : null}
            {place.note ? (
              <div>
                <span className="label-mono">note</span>
                <p dir="auto" className="mt-1 text-sm leading-relaxed [overflow-wrap:anywhere] whitespace-pre-wrap text-ink">{place.note}</p>
              </div>
            ) : null}
            <Evidence place={place} />
            <Coordinates place={place} geocodingEnabled={geocodingEnabled} />
            <p className="text-xs leading-relaxed text-ink-soft">
              From the save <span dir="auto" className="font-medium text-ink [overflow-wrap:anywhere]">“{place.item_title || place.url}”</span>
            </p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="soft" onClick={() => void archive.openItem(place.item_id)}>Open the save<ArrowRight /></Button>
              {onShowOnMap && place.coordinates ? <Button size="sm" className="lg:hidden" onClick={onShowOnMap}><MapPinned />Show on the map</Button> : null}
            </div>
          </div>
        ) : null}
      </article>
    </li>
  );
}

/**
 * On a phone, the chosen place is a small tray under the map: the list is a tap away, not beside it. It sits in the
 * pane's own flow (the map gets shorter) rather than over the map, so it can never cover the place it is about.
 */
export function PlacePeek({ place, onClose, onDetails }: { place: PlaceRow; onClose(): void; onDetails(): void }) {
  const archive = useArchive();
  const where = placeWhere(place);
  return (
    <div role="group" aria-label={`Chosen place: ${place.name}`} className="shrink-0 animate-in border-t border-line bg-card p-3 duration-200 fade-in-0 lg:hidden">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p dir="auto" className="display text-lg leading-snug text-ink [overflow-wrap:anywhere]">{place.name}</p>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-ink-soft">
            <KindChip kind={place.kind} />
            {where ? <span dir="auto" className="[overflow-wrap:anywhere]">{where}</span> : null}
          </p>
        </div>
        <Button variant="ghost" size="icon" className="-me-1.5 -mt-1 shrink-0" aria-label="Put this place away" onClick={onClose}><X /></Button>
      </div>
      <div className="mt-2.5 flex flex-wrap gap-2">
        <Button size="sm" variant="soft" onClick={onDetails}>Details</Button>
        <Button size="sm" onClick={() => void archive.openItem(place.item_id)}>Open the save<ArrowRight /></Button>
      </div>
    </div>
  );
}
