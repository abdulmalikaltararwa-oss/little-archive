// The paper map: what the places screen draws when no tile server has been chosen, or when the tiles will not
// load. Places are plotted by longitude and latitude on a plain graticule, like a page from an old atlas, with
// the coordinates written along its edge in the mono face. It makes no request of any kind. It has no coastlines
// and no streets, and says so; it only shows where the coordinates fall.
import { useMemo } from 'react';
import { cn } from 'cn';
import { Maximize2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { clusterPoints } from './cluster';
import { boundsOf, latSpan, lonSpan, type Bounds } from './geo';
import { useElementSize } from './hooks';
import type { MapPoint } from './map-types';
import { fitProjection, graticuleLabel, graticuleLines, graticuleStep } from './projection';

const CELL = 50;

interface Props {
  points: readonly MapPoint[];
  selectedId: string;
  /** A box the owner zoomed to by choosing a group of places, or null for all of them. */
  focus: Bounds | null;
  onSelect(id: string): void;
  onFocus(bounds: Bounds | null): void;
}

/** Five petals round a butter heart: the same flower as the tiled map's markers, flat. */
function Bloom({ selected, area }: { selected: boolean; area: boolean }) {
  const petals = [-90, -18, 54, 126, 198];
  return (
    // The outer group sets the size; the inner one is what pops when the place is chosen (a CSS animation would replace an SVG transform on the same element).
    <g transform="scale(1.45)">
      <g className={cn(selected && 'origin-center animate-pop [transform-box:fill-box]')}>
        {area ? <circle r={19} className={cn('stroke-[1.5] [stroke-dasharray:3.5_3]', selected ? 'fill-sage/20 stroke-sage' : 'fill-petal/25 stroke-petal-ink')} /> : null}
        {selected && !area ? <circle r={17} className="fill-sage/15 stroke-sage" strokeWidth={1.5} /> : null}
        {petals.map(angle => (
          <circle
            key={angle}
            cx={(Math.cos((angle * Math.PI) / 180) * 5.6).toFixed(2)}
            cy={(Math.sin((angle * Math.PI) / 180) * 5.6).toFixed(2)}
            r={4.7}
            className={cn('stroke-card', selected ? 'fill-sage' : 'fill-petal')}
            strokeWidth={1.3}
          />
        ))}
        <circle r={3.3} className="fill-butter stroke-card" strokeWidth={1} />
      </g>
    </g>
  );
}

function shorten(text: string, length = 26) {
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

export default function PaperMap({ points, selectedId, focus, onSelect, onFocus }: Props) {
  const [ref, size] = useElementSize<HTMLDivElement>();
  const everything = useMemo(() => boundsOf(points), [points]);
  const box = focus ?? everything;
  const ready = size.width > 120 && size.height > 120;
  const padding = Math.min(72, Math.round(size.width / 7));
  const view = useMemo(() => (box && ready ? fitProjection(box, size.width, size.height, padding) : null), [box, ready, size.width, size.height, padding]);

  const drawing = useMemo(() => {
    if (!view) return null;
    // Lines are at least about 110px apart on the sheet, so the graticule stays a quiet ruling and not a net.
    const step = graticuleStep(110 / view.scaleX, 1);
    // The sheet's longitudes run on past 180 where it crosses the antimeridian; the labels wrap them back.
    const lons = graticuleLines(view.visible.minLon, view.visible.maxLon, step);
    const lats = graticuleLines(Math.max(-90, view.visible.minLat), Math.min(90, view.visible.maxLat), step);
    const flat = points.map(point => ({ id: point.id, x: view.x(point.lon), y: view.y(point.lat) }));
    const groups = clusterPoints(flat, CELL, new Set(selectedId ? [selectedId] : []));
    // The selected place is drawn last, on top.
    groups.sort((a, b) => Number(a.ids.includes(selectedId)) - Number(b.ids.includes(selectedId)));
    return { step, lons, lats, groups };
  }, [view, points, selectedId]);

  const byId = useMemo(() => new Map(points.map(point => [point.id, point])), [points]);

  const zoomTo = (ids: string[]) => {
    const members = ids.map(id => byId.get(id)).filter((point): point is MapPoint => Boolean(point));
    const next = boundsOf(members);
    // Places on exactly the same spot cannot be pulled apart by zooming; the first one is chosen and the list has the rest.
    if (!next || (lonSpan(next) < 1e-5 && latSpan(next) < 1e-5)) onSelect(ids[0]!);
    else onFocus(next);
  };

  return (
    <div ref={ref} className="absolute inset-0 overflow-hidden bg-card shadow-[inset_0_0_90px_-40px_var(--butter)] dark:shadow-[inset_0_0_90px_-50px_var(--sage)]">
      {view && drawing ? (
        <svg
          role="img"
          aria-label={`A plain sheet with ${points.length} ${points.length === 1 ? 'place' : 'places'} plotted by longitude and latitude. The list beside it holds the same places.`}
          viewBox={`0 0 ${size.width} ${size.height}`}
          className="block size-full select-none"
        >
          {/* A sheet that reaches past a pole shows where the world ends: shaded beyond it, with the pole's own line. */}
          {view.y(90) > 1 ? <rect x={0} y={0} width={size.width} height={view.y(90)} className="fill-card-2" opacity={0.8} /> : null}
          {view.y(-90) < size.height - 1 ? <rect x={0} y={view.y(-90)} width={size.width} height={size.height - view.y(-90)} className="fill-card-2" opacity={0.8} /> : null}
          {view.y(90) > 1 ? <line x1={0} x2={size.width} y1={view.y(90)} y2={view.y(90)} className="stroke-ink-soft" strokeWidth={1} opacity={0.5} /> : null}
          {view.y(-90) < size.height - 1 ? <line x1={0} x2={size.width} y1={view.y(-90)} y2={view.y(-90)} className="stroke-ink-soft" strokeWidth={1} opacity={0.5} /> : null}
          {/* The ruling: dashed lines, a small cross where two meet, and the numbers along the edges. */}
          <g className="stroke-line-strong" strokeWidth={1} opacity={0.75}>
            {drawing.lons.map(lon => <line key={`lon${lon}`} x1={view.x(lon)} x2={view.x(lon)} y1={0} y2={size.height} strokeDasharray="2 6" />)}
            {drawing.lats.map(lat => <line key={`lat${lat}`} x1={0} x2={size.width} y1={view.y(lat)} y2={view.y(lat)} strokeDasharray="2 6" />)}
          </g>
          <g className="stroke-ink-soft" strokeWidth={1} opacity={0.55}>
            {drawing.lons.flatMap(lon => drawing.lats.map(lat => {
              const x = view.x(lon);
              const y = view.y(lat);
              return <path key={`x${lon}:${lat}`} d={`M${x - 4} ${y}H${x + 4}M${x} ${y - 4}V${y + 4}`} />;
            }))}
          </g>
          <g className="num fill-ink-soft" fontSize={10}>
            {/* A label that would run off the sheet's edge is left out; its line is still drawn. */}
            {drawing.lons.filter(lon => view.x(lon) > 34 && view.x(lon) < size.width - 34).map(lon => <text key={`tl${lon}`} x={view.x(lon)} y={22} textAnchor="middle">{graticuleLabel(lon, 'lon', drawing.step)}</text>)}
            {drawing.lats.filter(lat => view.y(lat) > 36 && view.y(lat) < size.height - 14).map(lat => <text key={`ta${lat}`} x={16} y={view.y(lat) - 6}>{graticuleLabel(lat, 'lat', drawing.step)}</text>)}
          </g>
          <rect x={7} y={7} width={size.width - 14} height={size.height - 14} rx={14} fill="none" className="stroke-line-strong" strokeWidth={1} />
          {/* North is up; the arrow is there so the sheet reads as a map and not a chart. */}
          <g transform={`translate(${size.width - 34} ${size.height - 36})`} className="fill-ink-soft" opacity={0.7}>
            <path d="M0 -13 L5 5 L0 1 L-5 5 Z" />
            <text className="num" y={-17} fontSize={10} textAnchor="middle">N</text>
          </g>

          {drawing.groups.map(group => {
            if (group.ids.length > 1) {
              return (
                <g key={group.key} transform={`translate(${group.x.toFixed(1)} ${group.y.toFixed(1)})`} className="cursor-pointer" onClick={() => zoomTo(group.ids)}>
                  <title>{`${group.ids.length} places close together. Choose to zoom in.`}</title>
                  <circle r={24} fill="transparent" />
                  <circle r={17} className="fill-card stroke-sage" strokeWidth={2} />
                  <text className="num fill-ink" fontSize={12} textAnchor="middle" dominantBaseline="central">{group.ids.length > 99 ? '99+' : group.ids.length}</text>
                </g>
              );
            }
            const point = byId.get(group.ids[0]!);
            if (!point) return null;
            const selected = point.id === selectedId;
            return (
              <g key={group.key} transform={`translate(${group.x.toFixed(1)} ${group.y.toFixed(1)})`} className="group cursor-pointer" onClick={() => onSelect(point.id)}>
                <title>{point.name}</title>
                <circle r={24} fill="transparent" />
                <Bloom selected={selected} area={point.precision === 'area'} />
                <text
                  y={34}
                  textAnchor="middle"
                  fontSize={13}
                  className={cn('display fill-ink [paint-order:stroke] stroke-card transition-opacity', selected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100')}
                  strokeWidth={4}
                  strokeLinejoin="round"
                >
                  {shorten(point.name)}
                </text>
              </g>
            );
          })}
        </svg>
      ) : null}
      {focus ? (
        <div className="absolute end-3 top-3 z-10">
          <Button variant="outline" size="sm" className="bg-card shadow-md" onClick={() => onFocus(null)}><Maximize2 />Show every place</Button>
        </div>
      ) : null}
    </div>
  );
}
