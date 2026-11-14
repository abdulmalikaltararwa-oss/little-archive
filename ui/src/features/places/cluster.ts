// Grouping markers that would sit on top of each other. A plain grid: each point goes into the square cell it
// falls in, and a cell with more than one point becomes one marker at their average. It works in whatever flat
// space the caller measures in (screen pixels at the current zoom for the tiled map, the sheet's own units for
// the paper map), so it needs no map library, and a place stays in the same cell while the map is only panned.

export interface Plotted {
  id: string;
  x: number;
  y: number;
}

export interface Cluster {
  /** Stable while the same members share a cell, so a marker is not rebuilt for nothing. */
  key: string;
  x: number;
  y: number;
  ids: string[];
}

/**
 * Groups `points` into cells of `cell` units. Points whose id is in `apart` (the selected place) are never
 * grouped: the one you are looking at must stay a marker of its own. The result is ordered by cell so it is
 * the same every time for the same input.
 */
export function clusterPoints(points: readonly Plotted[], cell: number, apart: ReadonlySet<string> = new Set()): Cluster[] {
  const size = Math.max(1, cell);
  const cells = new Map<string, Plotted[]>();
  const alone: Cluster[] = [];
  for (const point of points) {
    if (apart.has(point.id)) {
      alone.push({ key: `p:${point.id}`, x: point.x, y: point.y, ids: [point.id] });
      continue;
    }
    const key = `${Math.floor(point.x / size)}:${Math.floor(point.y / size)}`;
    const members = cells.get(key);
    if (members) members.push(point);
    else cells.set(key, [point]);
  }
  const grouped: Cluster[] = [];
  for (const [key, members] of cells) {
    const x = members.reduce((sum, member) => sum + member.x, 0) / members.length;
    const y = members.reduce((sum, member) => sum + member.y, 0) / members.length;
    const ids = members.map(member => member.id).sort();
    grouped.push(members.length === 1 ? { key: `p:${ids[0]}`, x, y, ids } : { key: `c:${key}`, x, y, ids });
  }
  return [...grouped, ...alone].sort((a, b) => a.y - b.y || a.x - b.x || a.key.localeCompare(b.key));
}
