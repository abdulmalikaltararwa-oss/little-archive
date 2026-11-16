// The places section of a save's detail panel: the places this save mentions, what they rest on, and the few
// things the owner can do about them (look again, find coordinates, rename, remove, put the extraction back,
// see them on the map). It says nothing at all while the feature is not on this server, and a short locked line
// where the account has not unlocked it. The panel mounts it: <PlacesEntry item={item} />.
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { errorMessage } from '@web/utils.js';
import { Check, Compass, MapPinned, Pencil, ScanSearch, Trash2, Undo2, X } from 'lucide-react';
import { useArchive, useArchiveState, useBusy } from '@/app/archive-context';
import { confirm, toast } from '@/app/ui-state';
import { allowAi } from '@/features/ai-permission/gate';
import { Whisper } from '@/components/field';
import { AsciiSpinner } from '@/components/fx/ascii';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ApiError, isLocked } from '@/data/client';
import type { Item } from '@/data/types';
import { useFeature } from '../feature-kit';
import { placesApi, type ItemPlaces, type Place } from './api';
import { cleanName, removeFrom, renamed } from './edits';
import { formatCoordinates } from './geo';
import { coordinateStory, placeWhere, precisionWord } from './labels';
import { KindChip } from './place-card';
import { describeExtraction, describeGeocoding, type Report } from './reports';

interface Loaded {
  id: string;
  data: ItemPlaces | null;
  error: string;
  locked: boolean;
}

function Frame({ children, edited }: { children: ReactNode; edited?: boolean }) {
  return (
    <section aria-label="Places" className="mt-6 border-t border-line pt-5">
      <h3 className="mb-3 flex items-center justify-between gap-3">
        <Whisper>places</Whisper>
        {edited ? <span className="label-mono">edited by you</span> : null}
      </h3>
      {children}
    </section>
  );
}

function PlaceRow({ place, busy, editing, onEdit, onText, onCommit, onCancel, onRemove }: {
  place: Place;
  busy: boolean;
  editing: string | null;
  onEdit(): void;
  onText(value: string): void;
  onCommit(): void;
  onCancel(): void;
  onRemove(): void;
}) {
  const where = placeWhere(place);
  const coordinates = place.coordinates;
  return (
    <li className="rounded-md bg-card-2 px-3.5 py-3">
      {editing !== null ? (
        <form
          className="flex items-center gap-2"
          onSubmit={event => { event.preventDefault(); onCommit(); }}
          onKeyDown={event => { if (event.key === 'Escape') onCancel(); }}
        >
          <Input value={editing} onChange={event => onText(event.target.value)} aria-label={`New name for ${place.name}`} maxLength={200} dir="auto" autoFocus className="h-10" />
          <Button type="submit" variant="soft" size="icon" aria-label="Save the new name" disabled={busy}><Check /></Button>
          <Button variant="ghost" size="icon" aria-label="Cancel renaming" onClick={onCancel}><X /></Button>
        </form>
      ) : (
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <p dir="auto" className="text-sm font-semibold text-ink [overflow-wrap:anywhere]">{place.name}</p>
            <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-soft">
              <KindChip kind={place.kind} />
              {where ? <span dir="auto" className="[overflow-wrap:anywhere]">{where}</span> : null}
            </p>
            {coordinates ? (
              <p className="mt-1.5">
                <span dir="ltr" className="num block text-xs text-ink">{formatCoordinates(coordinates, coordinates.precision)}</span>
                <span className="label-mono">{coordinateStory(coordinates).short} · {precisionWord(coordinates)}</span>
              </p>
            ) : (
              <p className="label-mono mt-1.5">no coordinates</p>
            )}
          </div>
          <div className="-me-1.5 flex shrink-0">
            <Button variant="ghost" size="icon" aria-label={`Rename ${place.name}`} title="Rename" disabled={busy} onClick={onEdit}><Pencil /></Button>
            <Button variant="danger-ghost" size="icon" aria-label={`Remove ${place.name}`} title="Remove" disabled={busy} onClick={onRemove}><Trash2 /></Button>
          </div>
        </div>
      )}
    </li>
  );
}

export function PlacesEntry({ item, allowLeave }: { item: Item; /** Asked before leaving for the map, so unsaved edits in the panel are not dropped silently. */ allowLeave?: () => Promise<boolean> | boolean }) {
  const archive = useArchive();
  const state = useFeature('places');
  const aiHosted = useArchiveState(snapshot => Boolean(snapshot.settings.ai_hosted));
  const api = useMemo(() => placesApi(archive.api), [archive]);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [report, setReport] = useState<(Report & { id: string }) | null>(null);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [lookBusy, runLook] = useBusy();
  const [geocodeBusy, runGeocode] = useBusy();
  const [editBusy, runEdit] = useBusy();

  useEffect(() => {
    if (state !== 'available') return;
    let stale = false;
    api.ofItem(item.id).then(
      data => { if (!stale) setLoaded({ id: item.id, data, error: '', locked: false }); },
      error => { if (!stale) setLoaded({ id: item.id, data: null, error: errorMessage(error), locked: isLocked(error) }); },
    );
    return () => { stale = true; };
  }, [api, item.id, state]);

  if (state === 'loading' || state === 'unavailable') return null;

  const current = loaded && loaded.id === item.id ? loaded : null;
  if (state === 'locked' || current?.locked) {
    return (
      <Frame>
        <p className="text-xs leading-relaxed text-ink-soft">
          Places are part of the one-time unlock. Your saves, search and export stay free.{' '}
          <Button variant="link" className="text-xs" onClick={() => archive.goScreen('unlock')}>About the unlock</Button>
        </p>
      </Frame>
    );
  }

  const data = current?.data ?? null;
  const places = data?.places ?? [];
  const mine = report && report.id === item.id ? report : null;
  const rename = editing && places.some(place => place.id === editing.id) ? editing : null;
  const geocoding = data?.available.geocoding;
  const lacking = places.filter(place => !place.coordinates);

  const apply = (next: ItemPlaces) => setLoaded({ id: item.id, data: next, error: '', locked: false });
  // Any call may answer 402 (a hosted account that has not unlocked places): that becomes the locked line, not an error.
  const guarded = async (operation: () => Promise<void>) => {
    try {
      await operation();
    } catch (error) {
      if (isLocked(error)) setLoaded({ id: item.id, data: null, error: '', locked: true });
      else throw error;
    }
  };

  const look = async () => {
    if (!(await allowAi(archive, 'places'))) return;
    await runLook(() => guarded(async () => {
      const result = await api.extract(item.id, { method: 'auto' });
      apply(result);
      setReport({ id: item.id, ...describeExtraction(result) });
    }));
  };

  const find = () => runGeocode(() => guarded(async () => {
    try {
      const result = await api.geocode(item.id, lacking.slice(0, 5).map(place => place.id));
      apply(result);
      setReport({ id: item.id, ...describeGeocoding(result.geocoding, geocoding?.attribution) });
    } catch (error) {
      // The two answers a person should read in place, not as a passing message.
      if (error instanceof ApiError && error.code === 'geocoder_not_configured') setReport({ id: item.id, tone: 'note', lines: ['This server has no geocoder set up, so no coordinates can be looked up.'] });
      else if (error instanceof ApiError && error.code === 'geocoder_failed') setReport({ id: item.id, tone: 'error', lines: [`The geocoder could not be reached.${error.extra.retryable ? ' Nothing was changed; try again in a little while.' : ' Nothing was changed.'}`] });
      else throw error;
    }
  }));

  const commitRename = () => runEdit(() => guarded(async () => {
    if (!rename || !data) return;
    const body = renamed(data.places, rename.id, rename.text);
    if (!body) { toast('A place needs a name.', { error: true }); return; }
    apply(await api.save(item.id, body));
    setEditing(null);
    toast(`Renamed to “${cleanName(rename.text)}”.`);
  }));

  const remove = async (place: Place) => {
    if (!data) return;
    // A place the extraction found can be brought back with "Discard my edits"; one the owner made cannot, so that asks first.
    const recoverable = Boolean(data.extracted?.some(entry => entry.id === place.id));
    if (!recoverable && !(await confirm({ title: 'Remove this place?', message: `“${place.name}” was not found by the app, so it cannot be brought back once it is removed.`, confirmLabel: 'Remove', danger: true }))) return;
    await runEdit(() => guarded(async () => {
      apply(await api.save(item.id, removeFrom(data.places, place.id)));
      toast(recoverable ? 'Place removed. “Discard my edits” brings it back.' : 'Place removed.');
    }));
  };

  const discard = () => confirm({
    title: 'Discard your edits to these places?',
    message: 'Your renames and removals go, and the places found from the save show again.',
    confirmLabel: 'Discard my edits',
    action: async () => {
      try {
        apply(await api.discardEdits(item.id));
        setReport(null);
        setEditing(null);
        toast('Your edits are discarded.');
      } catch (error) {
        if (isLocked(error)) setLoaded({ id: item.id, data: null, error: '', locked: true });
        else throw error;
      }
    },
  });

  const showOnMap = async () => {
    if (allowLeave && !(await allowLeave())) return;
    archive.goScreen('places', (places.find(place => place.coordinates) ?? places[0])?.id ?? '');
  };

  const lookHelp = !data
    ? ''
    : data.available.ai
      ? aiHosted
        ? 'Reads the page’s data and the pin lines and map links in the text first. If those find nothing, the caption and creator are sent to a hosted AI service.'
        : 'Reads the page’s data and the pin lines and map links in the text first. If those find nothing, your local AI model reads the text.'
      : 'Reads the page’s data and the pin lines and map links in the text. No AI is set up on this server, and nothing is guessed.';

  return (
    <Frame edited={data?.edited}>
      {!data && !current ? <p role="status" className="flex items-center gap-2 text-xs text-ink-soft"><AsciiSpinner />Looking at this save’s places…</p> : null}
      {current?.error ? <p role="alert" className="rounded-md border border-danger/30 bg-danger-pale px-3.5 py-2.5 text-sm text-danger">{current.error}</p> : null}

      {data ? (
        places.length ? (
          <ul className="flex flex-col gap-2">
            {places.map(place => (
              <PlaceRow
                key={place.id}
                place={place}
                busy={editBusy}
                editing={rename?.id === place.id ? rename.text : null}
                onEdit={() => setEditing({ id: place.id, text: place.name })}
                onText={text => setEditing({ id: place.id, text })}
                onCommit={() => void commitRename()}
                onCancel={() => setEditing(null)}
                onRemove={() => void remove(place)}
              />
            ))}
          </ul>
        ) : (
          <p className="text-xs leading-relaxed text-ink-soft">No places in this save yet. “Look for places” reads the page’s data and any pin lines or map links in the text.</p>
        )
      ) : null}

      {data ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" aria-busy={lookBusy || undefined} disabled={lookBusy} onClick={() => void look()}>{lookBusy ? <AsciiSpinner /> : <ScanSearch />}Look for places</Button>
          {geocoding?.enabled ? (
            <Button size="sm" aria-busy={geocodeBusy || undefined} disabled={geocodeBusy || !lacking.length} title={lacking.length ? undefined : 'Every place here already has coordinates.'} onClick={() => void find()}>
              {geocodeBusy ? <AsciiSpinner /> : <Compass />}Find coordinates
            </Button>
          ) : null}
          {places.length ? <Button size="sm" variant="ghost" onClick={() => void showOnMap()}><MapPinned />Show on the map</Button> : null}
          {data.edited ? <Button size="sm" variant="ghost" onClick={() => void discard()}><Undo2 />Discard my edits</Button> : null}
        </div>
      ) : null}

      {mine ? (
        <div role="status" className={mine.tone === 'error' ? 'mt-3 rounded-md border border-danger/30 bg-danger-pale px-3.5 py-2.5 text-xs leading-relaxed text-danger' : 'mt-3 rounded-md bg-sage-pale px-3.5 py-2.5 text-xs leading-relaxed text-ink'}>
          {mine.lines.map(line => <p key={line} dir="auto">{line}</p>)}
        </div>
      ) : null}

      {data ? <p className="mt-3 text-xs leading-relaxed text-ink-soft">{lookHelp}</p> : null}
      {geocoding?.enabled ? (
        <p className="mt-2 text-xs leading-relaxed text-ink-soft">
          Finding coordinates sends only each place’s name, address, city and country to the geocoder your server uses, at most five at a time.
          {geocoding.attribution ? ` ${geocoding.attribution}` : ''}
        </p>
      ) : null}
    </Frame>
  );
}
