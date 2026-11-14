// The tiled map: Leaflet 1.9.4 with raster tiles, in this one chunk. It is loaded only when the owner has named a
// tile server and a place has coordinates (screen.tsx lazy-loads this file, and this file loads the library
// itself on mount), so a library without tiles never downloads, parses or runs any of it.
//
// Leaflet shows tiles as <img> elements, which the server's content policy allows from https. Its default
// marker images, its attribution control (it would set HTML from the credit line) and its zoom control are not
// used: markers come from markers.ts, and the controls and credit are ordinary elements of the page.
import 'leaflet/dist/leaflet.css';
import './map.css';
import { useEffect, useRef, useState } from 'react';
import type * as Leaflet from 'leaflet';
import { Maximize2, Minus, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { clusterPoints } from './cluster';
import { clampLat, stripFor, wrapLon, type Bounds } from './geo';
import { clusterElement, pinElement } from './markers';
import type { MapPoint, TiledMapProps } from './map-types';

const MIN_ZOOM = 2;
const MAX_ZOOM = 18;
/** Markers are grouped on a grid this many pixels across, and not at all once the map is this close. */
const CLUSTER_CELL = 56;
const STREET_ZOOM = 16;

type Leaf = typeof Leaflet;

interface Live {
  L: Leaf;
  map: Leaflet.Map;
  markers: Leaflet.LayerGroup;
}

/** The library comes through whichever way the bundler exposes it: as named exports, or under `default`. */
function namespaceOf(mod: unknown): Leaf {
  const candidate = mod as Leaf & { default?: Leaf };
  return typeof candidate.map === 'function' ? candidate : (candidate.default as Leaf);
}

const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/** What the map shows now, as a box in the server's convention (a box over the antimeridian has minLon greater than maxLon). */
function viewOf(map: Leaflet.Map): Bounds {
  const box = map.getBounds();
  const minLat = clampLat(box.getSouth());
  const maxLat = clampLat(box.getNorth());
  if (box.getEast() - box.getWest() >= 360) return { minLon: -180, maxLon: 180, minLat, maxLat };
  return { minLon: wrapLon(box.getWest()), maxLon: wrapLon(box.getEast()), minLat, maxLat };
}

export default function PlacesMap(props: TiledMapProps) {
  const { points, selectedId, fitKey, focus, tileUrl } = props;
  const host = useRef<HTMLDivElement>(null);
  const live = useRef<Live | null>(null);
  // The callbacks and the newest points, read by Leaflet's event handlers, which are set up once.
  const latest = useRef(props);
  useEffect(() => { latest.current = props; });
  // The place the list just sent the map to, so the "nudge into view" does not fight the flight.
  const flown = useRef('');
  const [ready, setReady] = useState(false);
  const [zoom, setZoom] = useState(3);

  // Create the map once the library has arrived, and take it down with the component.
  useEffect(() => {
    const container = host.current;
    if (!container) return;
    let cancelled = false;
    let dispose = () => {};
    import('leaflet').then(
      mod => {
        if (cancelled) return;
        const L = namespaceOf(mod);
        const still = reducedMotion();
        const map = L.map(container, {
          zoomControl: false,
          attributionControl: false,
          minZoom: MIN_ZOOM,
          maxZoom: MAX_ZOOM,
          worldCopyJump: true,
          zoomAnimation: !still,
          fadeAnimation: !still,
          markerZoomAnimation: !still,
          inertia: !still,
        });
        const markers = L.layerGroup().addTo(map);
        map.on('zoomend', () => setZoom(map.getZoom()));
        map.on('moveend', () => latest.current.onView(viewOf(map)));
        // The pane changes size without the window doing so (a sticky column, a phone turning, a dialog): keep the tiles filled.
        const watch = new ResizeObserver(() => map.invalidateSize({ animate: false }));
        watch.observe(container);
        live.current = { L, map, markers };
        setReady(true);
        dispose = () => {
          watch.disconnect();
          map.remove();
          live.current = null;
        };
      },
      () => { if (!cancelled) latest.current.onStatus('unavailable'); },
    );
    return () => {
      cancelled = true;
      dispose();
    };
  }, []);

  // The tile layer follows the address. It reports how the server is answering, so the screen can say so.
  useEffect(() => {
    const state = live.current;
    if (!ready || !state) return;
    const { L, map } = state;
    const layer = L.tileLayer(tileUrl, { maxZoom: MAX_ZOOM, keepBuffer: 2 });
    let loaded = 0;
    let failed = 0;
    layer.on('loading', () => {
      loaded = 0;
      failed = 0;
      latest.current.onStatus('loading');
    });
    layer.on('tileload', () => { loaded += 1; });
    layer.on('tileerror', () => { failed += 1; });
    layer.on('load', () => latest.current.onStatus(failed === 0 ? 'ok' : loaded === 0 ? 'failed' : 'partial'));
    layer.addTo(map);
    return () => { layer.remove(); };
  }, [ready, tileUrl]);

  // Frame the places: the selected one when there is one (arriving from a link or from a save), else all of them.
  useEffect(() => {
    const state = live.current;
    if (!ready || !state) return;
    const { L, map } = state;
    const { points: current, selectedId: chosen } = latest.current;
    if (!current.length) return;
    const lon = stripFor(current);
    const picked = current.find(point => point.id === chosen);
    if (picked) map.setView([picked.lat, lon(picked.lon)], 13, { animate: false });
    else map.fitBounds(L.latLngBounds(current.map(point => [point.lat, lon(point.lon)] as [number, number])), { padding: [56, 56], maxZoom: 15, animate: false });
  }, [ready, fitKey]);

  // The list chose a place: go to it.
  const focusId = focus?.id ?? '';
  const focusNonce = focus?.nonce ?? 0;
  useEffect(() => {
    const state = live.current;
    if (!ready || !state || !focusId) return;
    const { L, map } = state;
    const { points: current } = latest.current;
    const picked = current.find(point => point.id === focusId);
    if (!picked) return;
    const target = L.latLng(picked.lat, stripFor(current)(picked.lon));
    const level = Math.max(map.getZoom(), 12);
    flown.current = picked.id;
    if (reducedMotion()) map.setView(target, level, { animate: false });
    else map.flyTo(target, level, { duration: 0.7 });
  }, [ready, focusId, focusNonce]);

  // A place chosen on the map itself stays where the person tapped, but is nudged into view if it sits at the edge
  // (under the controls or the tray a phone shows). One the list chose has just been flown to, so it is left alone.
  useEffect(() => {
    const state = live.current;
    if (!ready || !state || !selectedId) return;
    if (flown.current === selectedId) {
      flown.current = '';
      return;
    }
    const { points: current } = latest.current;
    const picked = current.find(point => point.id === selectedId);
    if (picked) state.map.panInside([picked.lat, stripFor(current)(picked.lon)], { padding: [72, 72], animate: !reducedMotion() });
  }, [ready, selectedId]);

  // Draw the markers: one per place, grouped where they would overlap, the selected one always on its own.
  useEffect(() => {
    const state = live.current;
    if (!ready || !state) return;
    const { L, map, markers } = state;
    markers.clearLayers();
    if (!points.length) return;
    const lon = stripFor(points);
    const byId = new Map<string, MapPoint>(points.map(point => [point.id, point]));
    const flat = points.map(point => {
      const at = map.project([point.lat, lon(point.lon)], zoom);
      return { id: point.id, x: at.x, y: at.y };
    });
    const groups = zoom >= STREET_ZOOM
      ? flat.map(point => ({ key: `p:${point.id}`, x: point.x, y: point.y, ids: [point.id] }))
      : clusterPoints(flat, CLUSTER_CELL, new Set(selectedId ? [selectedId] : []));

    for (const group of groups) {
      if (group.ids.length === 1) {
        const point = byId.get(group.ids[0]!);
        if (!point) continue;
        const drawn = pinElement({ selected: point.id === selectedId, area: point.precision === 'area' });
        const marker = L.marker([point.lat, lon(point.lon)], {
          icon: L.divIcon({ html: drawn.element, className: 'la-marker', iconSize: drawn.size, iconAnchor: drawn.anchor }),
          title: point.name,
          keyboard: false,
          riseOnHover: true,
          zIndexOffset: point.id === selectedId ? 1000 : 0,
        });
        marker.on('click', () => latest.current.onSelect(point.id));
        marker.addTo(markers);
      } else {
        const drawn = clusterElement(group.ids.length);
        const marker = L.marker(map.unproject([group.x, group.y], zoom), {
          icon: L.divIcon({ html: drawn.element, className: 'la-marker', iconSize: drawn.size, iconAnchor: drawn.anchor }),
          title: `${group.ids.length} places here. Zoom in to see them.`,
          keyboard: false,
        });
        marker.on('click', () => {
          const members = group.ids.map(id => byId.get(id)).filter((point): point is MapPoint => Boolean(point));
          map.fitBounds(L.latLngBounds(members.map(point => [point.lat, lon(point.lon)] as [number, number])), { padding: [56, 56], maxZoom: 17 });
        });
        marker.addTo(markers);
      }
    }
  }, [ready, points, selectedId, zoom]);

  const fitAll = () => {
    const state = live.current;
    if (!state || !points.length) return;
    const lon = stripFor(points);
    state.map.fitBounds(state.L.latLngBounds(points.map(point => [point.lat, lon(point.lon)] as [number, number])), { padding: [56, 56], maxZoom: 15 });
  };

  return (
    <div className="absolute inset-0">
      <div
        ref={host}
        className="la-map size-full"
        role="region"
        aria-label="Map of your saved places. The list beside it holds the same places and is the way to read and choose them with a keyboard."
      />
      <div className="absolute end-3 top-3 z-[500] flex flex-col gap-2">
        <Button variant="outline" size="icon" className="rounded-full bg-card shadow-md" aria-label="Zoom in" disabled={zoom >= MAX_ZOOM} onClick={() => live.current?.map.zoomIn()}><Plus /></Button>
        <Button variant="outline" size="icon" className="rounded-full bg-card shadow-md" aria-label="Zoom out" disabled={zoom <= MIN_ZOOM} onClick={() => live.current?.map.zoomOut()}><Minus /></Button>
        <Button variant="outline" size="icon" className="rounded-full bg-card shadow-md" aria-label="Show every place" title="Show every place" onClick={fitAll}><Maximize2 /></Button>
      </div>
    </div>
  );
}
