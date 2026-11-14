// #/places: the places your saves mention, as a map with the list beside it (a map above a list on a phone).
//
// The rules this screen keeps:
//  - The list always works. The map is an extra: with no tile server chosen it is a plain paper sheet that makes
//    no request, with no coordinates at all there is no map, and if the tiles will not load the list is untouched.
//  - Tiles are off until the owner (or the operator, at build time) names a tile server: a tile server sees the
//    viewer's address and where they look. The map library is not even downloaded until then.
//  - Nothing is guessed. Each place says where its coordinates came from, and an area is never drawn as a spot.
//  - The chosen place lives in the address (#/places/<id>), so Back from a save returns to it.
import { Component, lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { cn } from 'cn';
import { useReducedMotion } from 'motion/react';
import { Layers, List, Map as MapIcon, Settings2 } from 'lucide-react';
import { useArchive, useArchiveState } from '@/app/archive-context';
import { FormError, Notice } from '@/components/field';
import { AsciiSpinner } from '@/components/fx/ascii';
import { Button } from '@/components/ui/button';
import { Segmented } from '@/components/ui/segmented';
import { rememberFocus, type FocusMemory } from '@/lib/focus';
import { FeatureGate, FeatureHeader, LockedCard, StateCard } from '../feature-kit';
import type { FeatureScreenProps } from '../screens';
import type { PlaceKind } from './api';
import { PlaceFilters } from './filters';
import { inBounds, type Bounds } from './geo';
import { useDebounced, useMediaQuery } from './hooks';
import type { MapFocus, MapPoint, TileStatus } from './map-types';
import { PlaceCard, PlacePeek } from './place-card';
import { TilesDialog } from './tiles-dialog';
import { PAGE_SIZE, usePlaces } from './use-places';
import { useTileSettings } from './use-tiles';
import PaperMap from './paper-map';

// The tiled map is a separate chunk (Leaflet and its stylesheet): it is fetched only when it is about to be drawn.
const TiledMap = lazy(() => import('./map'));

// On a phone the pane fills what is left under the filters and above the dock; beside the list it is as tall as the window allows.
const MAP_HEIGHT = 'max-lg:h-[clamp(20rem,calc(100dvh-27rem),40rem)] lg:h-[calc(100dvh-18rem)] lg:min-h-[30rem]';

function Waiting({ children }: { children: string }) {
  return <p role="status" className="flex items-center justify-center gap-2 py-24 text-sm text-ink-soft"><AsciiSpinner />{children}</p>;
}

/** Catches the map's chunk failing to load (offline, a bad deploy) so the list and the page carry on. */
class MapBoundary extends Component<{ onFail(): void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch() { this.props.onFail(); }
  render() { return this.state.failed ? null : this.props.children; }
}

export default function PlacesScreen({ demo, rest }: FeatureScreenProps) {
  useEffect(() => { document.title = `Places — Little Archive${demo ? ' demo' : ''}`; }, [demo]);
  return (
    <FeatureGate feature="places">
      <PlacesBody rest={rest} />
    </FeatureGate>
  );
}

function PlacesBody({ rest }: { rest: string }) {
  const archive = useArchive();
  const features = useArchiveState(state => state.features);
  const geocodingEnabled = Boolean(features?.places.geocoding?.enabled);
  const reduced = useReducedMotion();
  const wide = useMediaQuery('(min-width: 1024px)');
  const roomy = useMediaQuery('(min-width: 640px)');
  const tiles = useTileSettings();

  const [text, setText] = useState('');
  const q = useDebounced(text.trim(), 250);
  const [kind, setKind] = useState<PlaceKind | ''>('');
  const [withCoordinates, setWithCoordinates] = useState(false);
  const list = usePlaces({ q, kind, withCoordinates });
  const filtered = Boolean(q || kind || withCoordinates);

  const [view, setView] = useState<'map' | 'list'>('map');
  const [onlyInView, setOnlyInView] = useState(false);
  const [tiledView, setTiledView] = useState<Bounds | null>(null);
  const [paper, setPaper] = useState<{ key: string; focus: Bounds | null }>({ key: '', focus: null });
  const [plainFor, setPlainFor] = useState('');
  const [tileState, setTileState] = useState<{ url: string; status: TileStatus }>({ url: '', status: 'loading' });
  const [focus, setFocus] = useState<MapFocus | null>(null);
  const [tilesOpen, setTilesOpen] = useState(false);
  const [tilesKey, setTilesKey] = useState(0);
  const [opener, setOpener] = useState<FocusMemory | null>(null);
  const scrollTo = useRef('');

  const { places } = list;
  const points = useMemo<MapPoint[]>(
    () => places.flatMap(place => (place.coordinates ? [{ id: place.id, lat: place.coordinates.lat, lon: place.coordinates.lon, name: place.name, kind: place.kind, precision: place.coordinates.precision }] : [])),
    [places],
  );
  const hasCoordinates = points.length > 0;
  const hasAreas = points.some(point => point.precision === 'area');

  const tileUrl = tiles.config?.url ?? '';
  const tileStatus = tileState.url === tileUrl ? tileState.status : 'loading';
  // The tiled map is used while a server is chosen, unless the person fell back to the plain sheet for it, or the library could not load.
  const tiled = Boolean(tiles.config) && plainFor !== tileUrl && tileStatus !== 'unavailable';
  const showMap = hasCoordinates && (wide || view === 'map');
  const showList = !hasCoordinates || wide || view === 'list';
  const paperFocus = paper.key === list.key ? paper.focus : null;
  const mapBox = tiled ? tiledView : paperFocus;
  const narrowed = onlyInView && showMap && wide && mapBox !== null;
  const shown = narrowed ? places.filter(place => place.coordinates && inBounds(place.coordinates, mapBox)) : places;
  const selected = places.find(place => place.id === rest) ?? null;
  const selectedId = selected?.id ?? '';

  // A place chosen on the map is brought into view in the list, once its card has opened.
  useEffect(() => {
    if (!selectedId || scrollTo.current !== selectedId) return;
    scrollTo.current = '';
    document.getElementById(`place-${selectedId}`)?.scrollIntoView({ block: 'nearest', behavior: reduced ? 'auto' : 'smooth' });
  }, [selectedId, reduced, showList]);

  const choose = (id: string, from: 'list' | 'map') => {
    // Choosing the place that is already open puts it away.
    const next = from === 'list' && id === selectedId ? '' : id;
    archive.goScreen('places', next, { replace: true });
    if (!next) return;
    if (from === 'list') setFocus(current => ({ id: next, nonce: (current?.nonce ?? 0) + 1 }));
    else scrollTo.current = next;
  };

  const openTiles = () => {
    setOpener(rememberFocus());
    setTilesKey(value => value + 1);
    setTilesOpen(true);
  };

  const withoutCoordinates = places.length - points.length;
  const summary = [
    `${places.length.toLocaleString()}${places.length < list.total ? ` of ${list.total.toLocaleString()}` : ''} ${list.total === 1 ? 'place' : 'places'}`,
    hasCoordinates ? `${points.length.toLocaleString()} on the map` : '',
    withoutCoordinates > 0 && hasCoordinates ? `${withoutCoordinates.toLocaleString()} without coordinates` : '',
  ].filter(Boolean).join(' · ');

  const header = (
    <FeatureHeader
      whisper="where your saves took you"
      title="Places you kept"
      lede={roomy ? 'The spots your saves mention. A place goes on the map only when its position was stated by the save, looked up by a geocoder you switched on, or given by you.' : undefined}
      actions={wide ? (
        <Button onClick={openTiles}>
          <Layers />
          Map tiles
          <span className="label-mono">{tiles.config ? 'on' : 'off'}</span>
        </Button>
      ) : undefined}
    />
  );

  let body: ReactNode;
  if (list.locked) body = <LockedCard feature="places" />;
  else if (list.status === 'error') {
    body = (
      <div className="mx-auto flex max-w-xl flex-col items-start gap-3">
        <FormError message={list.error} />
        <Button onClick={list.reload}>Try again</Button>
      </div>
    );
  } else if (list.status === 'loading') body = <Waiting>Looking through your places…</Waiting>;
  else if (list.total === 0 && !filtered) {
    body = (
      <StateCard art="map" title="No places yet" actions={<Button variant="primary" onClick={() => archive.goView('all')}>Browse your saves</Button>}>
        Places come from your saves. Open a save and choose “Look for places”: pin lines such as 📍 Café Central, Vienna, map links, and a page’s own data are read by fixed rules. Nothing is guessed.
      </StateCard>
    );
  } else {
    body = (
      <div className={cn('grid items-start gap-0 lg:gap-6', hasCoordinates && 'lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]')}>
        <div className={cn('min-w-0', !hasCoordinates && 'mx-auto w-full max-w-2xl')}>
          <PlaceFilters
            q={text}
            onQ={setText}
            kind={kind}
            onKind={setKind}
            withCoordinates={withCoordinates}
            onWithCoordinates={setWithCoordinates}
            inView={hasCoordinates && wide ? { checked: onlyInView, onChange: setOnlyInView } : null}
            phone={!wide}
            tilesOn={Boolean(tiles.config)}
            onOpenTiles={openTiles}
          />
          <p role="status" className="label-mono mt-4 mb-3 flex flex-wrap items-center gap-x-2">
            <span className="num normal-case">{summary}{narrowed ? ' · in view' : ''}</span>
          </p>
          {hasCoordinates && !wide ? (
            <Segmented<'map' | 'list'>
              label="Show the map or the list"
              stretch
              className="mb-4"
              value={view}
              onValueChange={setView}
              options={[{ value: 'map', label: 'Map', icon: <MapIcon aria-hidden="true" />, count: points.length }, { value: 'list', label: 'List', icon: <List aria-hidden="true" />, count: places.length }]}
            />
          ) : null}
          {!hasCoordinates && places.length ? (
            <Notice className="mb-4" role="note">
              <strong className="font-semibold">None of these places has coordinates yet, so there is no map.</strong>
              <p className="mt-1 text-ink-soft">
                A place goes on the map when its position is known: the save states it (a map link, a page’s own data, or coordinates written next to the place), a geocoder looks it up, or you enter it.{' '}
                {geocodingEnabled ? 'This server has a geocoder: open a save and choose “Find coordinates”.' : 'This server has no geocoder, so nothing will be looked up, and nothing is guessed from a name.'}
              </p>
            </Notice>
          ) : null}
          {showList ? (
            <>
              {shown.length ? (
                <ul aria-busy={list.refreshing || undefined} className={cn('flex flex-col gap-2.5 transition-opacity duration-200', list.refreshing && 'opacity-60')}>
                  {shown.map(place => (
                    <PlaceCard
                      key={place.id}
                      place={place}
                      selected={place.id === selectedId}
                      geocodingEnabled={geocodingEnabled}
                      onSelect={() => choose(place.id, 'list')}
                      onShowOnMap={() => { setView('map'); setFocus(current => ({ id: place.id, nonce: (current?.nonce ?? 0) + 1 })); }}
                    />
                  ))}
                </ul>
              ) : (
                <div className="rounded-lg border border-dashed border-line-strong bg-card/50 px-5 py-8 text-center">
                  <p className="display text-xl text-ink">{narrowed ? 'Nothing in this part of the map' : withCoordinates && !q && !kind ? 'No place has coordinates yet' : 'No place matches'}</p>
                  <p className="mx-auto mt-1.5 max-w-xs text-sm text-ink-soft">
                    {narrowed ? 'Move or zoom the map, or turn off “Only what the map shows”.' : withCoordinates && !q && !kind ? 'A place needs a map link, written coordinates, a geocoder’s answer or your own entry before it can be placed.' : 'Try fewer words, or another kind of place.'}
                  </p>
                  <Button className="mt-4" size="sm" onClick={() => { if (narrowed) setOnlyInView(false); else { setText(''); setKind(''); setWithCoordinates(false); } }}>{narrowed ? 'Show everything' : 'Clear the filters'}</Button>
                </div>
              )}
              {places.length < list.total ? (
                <div className="mt-4 flex flex-col items-start gap-2">
                  <Button variant="soft" aria-busy={list.loadingMore || undefined} disabled={list.loadingMore} onClick={list.loadMore}>
                    {list.loadingMore ? <AsciiSpinner /> : null}
                    Load {Math.min(PAGE_SIZE, list.total - places.length)} more
                  </Button>
                  <span className="label-mono">the map shows what has been loaded</span>
                </div>
              ) : null}
            </>
          ) : null}
        </div>

        {showMap ? (
          <div className={cn('relative isolate flex min-w-0 flex-col overflow-hidden rounded-xl border border-line bg-card shadow-xs lg:sticky lg:top-4', MAP_HEIGHT)}>
            <section aria-label="Map" className="relative min-h-0 flex-1">
              {tiled && tiles.config ? (
                <MapBoundary onFail={() => setTileState({ url: tileUrl, status: 'unavailable' })}>
                  <Suspense fallback={<div className="absolute inset-0 grid place-items-center bg-card-2"><p role="status" className="flex items-center gap-2 text-sm text-ink-soft"><AsciiSpinner />Opening the map…</p></div>}>
                    <TiledMap
                      points={points}
                      selectedId={selectedId}
                      fitKey={list.key}
                      focus={focus}
                      tileUrl={tiles.config.url}
                      onSelect={id => choose(id, 'map')}
                      onView={setTiledView}
                      onStatus={status => setTileState({ url: tileUrl, status })}
                    />
                  </Suspense>
                </MapBoundary>
              ) : (
                <PaperMap points={points} selectedId={selectedId} focus={paperFocus} onSelect={id => choose(id, 'map')} onFocus={bounds => setPaper({ key: list.key, focus: bounds })} />
              )}
              {tiled && tileStatus === 'failed' ? (
                <div role="status" className="absolute inset-x-3 top-3 z-[600] rounded-lg border border-line bg-card p-3.5 pe-16 shadow-lg">
                  <p className="text-sm font-semibold text-ink">The map pictures did not load.</p>
                  <p className="mt-1 text-xs leading-relaxed text-ink-soft">
                    {tiles.config?.url.startsWith('http:')
                      ? <>This server’s content policy only lets a page load pictures over https, so <span className="num">{tiles.config.host}</span> is blocked. </>
                      : <><span className="num">{tiles.config?.host}</span> did not answer, or refused the request. Some tile servers refuse requests that carry no referrer, and Little Archive sends none. </>}
                    Your places are all still in the list.
                  </p>
                  <div className="mt-2.5 flex flex-wrap gap-2">
                    <Button size="sm" onClick={openTiles}><Settings2 />Map tile settings</Button>
                    <Button size="sm" variant="soft" onClick={() => setPlainFor(tileUrl)}>Use the plain map</Button>
                  </div>
                </div>
              ) : null}
            </section>
            {selected && !wide ? <PlacePeek place={selected} onClose={() => archive.goScreen('places', '', { replace: true })} onDetails={() => { scrollTo.current = selected.id; setView('list'); }} /> : null}
            <footer className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 border-t border-line bg-card px-4 py-2.5 text-xs text-ink-soft">
              {tiled && tiles.config ? (
                <>
                  <span dir="auto" className="min-w-0 [overflow-wrap:anywhere]">{tiles.config.attribution || `Map pictures from ${tiles.config.host}`}</span>
                  <span className="flex items-center gap-2">
                    {tileStatus === 'partial' ? <span className="label-mono !text-danger">some tiles missing</span> : null}
                    {hasAreas ? <span className="label-mono">dashed ring · an area</span> : null}
                    <button type="button" onClick={openTiles} className="hit-44 rounded-sm font-semibold text-sage underline-offset-4 hov:underline dark:text-sage-deep">Change tiles</button>
                  </span>
                </>
              ) : (
                <>
                  <span className="min-w-0 flex-1">
                    <span className="label-mono me-2">[ a plain sheet ]</span>
                    {tiles.config
                      ? tileStatus === 'unavailable'
                        ? 'The tiled map could not be loaded, so this is a plain sheet drawn by longitude and latitude. Reload the page to try again.'
                        : 'Drawn by longitude and latitude, without map pictures.'
                      : roomy
                        ? 'Drawn by longitude and latitude. Map pictures come from a tile server that would see your address and where you look, so they stay off until you choose one.'
                        : 'Drawn by longitude and latitude. No map pictures are requested.'}
                    {hasAreas ? ' A dashed ring is an area, not a spot.' : ''}
                  </span>
                  {tiles.config ? (
                    tileStatus === 'unavailable' ? null : <button type="button" onClick={() => setPlainFor('')} className="hit-44 rounded-sm font-semibold text-sage underline-offset-4 hov:underline dark:text-sage-deep">Use the tile map</button>
                  ) : (
                    <button type="button" onClick={openTiles} className="hit-44 rounded-sm font-semibold text-sage underline-offset-4 hov:underline dark:text-sage-deep">Set up map tiles</button>
                  )}
                </>
              )}
            </footer>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div data-seam="places" className="pb-10">
      {header}
      {body}
      <TilesDialog key={tilesKey} open={tilesOpen} onClose={() => setTilesOpen(false)} opener={opener} tiles={tiles} />
    </div>
  );
}
