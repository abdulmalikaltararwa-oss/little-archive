// The markers on the tiled map, drawn as DOM nodes and styled by map.css with the product's tokens: a small
// pressed flower on a stem for a place, the same flower inside a dashed ring for a place whose position is only
// an area, and a paper chip with a count for several that share a spot. Leaflet's own marker images are not
// used. Nothing here takes a string of HTML: the pieces are built node by node, and a count is set as text.
const SVG = 'http://www.w3.org/2000/svg';

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attributes: Record<string, string | number> = {}, children: SVGElement[] = []): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG, tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value));
  for (const child of children) node.appendChild(child);
  return node;
}

/** Five petals round a butter heart, centred on (cx, cy). */
function bloom(cx: number, cy: number, scale: number): SVGGElement {
  const petals = [-90, -18, 54, 126, 198].map(angle => {
    const radians = (angle * Math.PI) / 180;
    return svg('circle', { class: 'petal', cx: (cx + Math.cos(radians) * 5.6 * scale).toFixed(2), cy: (cy + Math.sin(radians) * 5.6 * scale).toFixed(2), r: (4.7 * scale).toFixed(2) });
  });
  return svg('g', {}, [...petals, svg('circle', { class: 'heart', cx, cy, r: (3.3 * scale).toFixed(2) })]);
}

export interface PinOptions {
  selected: boolean;
  /** The position is the middle of an area, not a spot: the flower sits in a dashed ring and has no stem. */
  area: boolean;
}

export interface Drawn {
  element: HTMLElement;
  /** Width and height in px, and where on it the coordinate is. */
  size: [number, number];
  anchor: [number, number];
}

/** A place. The selected one is larger and drawn in sage. */
export function pinElement({ selected, area }: PinOptions): Drawn {
  const root = document.createElement('div');
  root.className = ['la-pin', selected ? 'is-selected' : '', area ? 'is-area' : ''].filter(Boolean).join(' ');
  if (area) {
    const picture = svg('svg', { viewBox: '0 0 44 44', width: 44, height: 44, 'aria-hidden': 'true', focusable: 'false' }, [
      svg('circle', { class: 'ring', cx: 22, cy: 22, r: 19 }),
      bloom(22, 22, 1),
    ]);
    root.appendChild(picture);
    return { element: root, size: [44, 44], anchor: [22, 22] };
  }
  const picture = svg('svg', { viewBox: '0 0 34 42', width: 34, height: 42, 'aria-hidden': 'true', focusable: 'false' }, [
    svg('ellipse', { class: 'ground', cx: 17, cy: 39.5, rx: 5, ry: 1.8 }),
    svg('path', { class: 'stem', d: 'M17 20 C17 27 16 32 17 39' }),
    svg('path', { class: 'leaf', d: 'M17 31 C21 30 24 27.5 25 25 C21 24.5 18.5 27 17 31 Z' }),
    bloom(17, 13, 1.15),
  ]);
  root.appendChild(picture);
  return { element: root, size: [34, 42], anchor: [17, 39.5] };
}

/** Several places in one spot: a round paper chip with how many. The count is set as text. */
export function clusterElement(count: number): Drawn {
  const root = document.createElement('div');
  const side = count < 10 ? 38 : count < 100 ? 44 : 52;
  root.className = 'la-cluster';
  root.style.width = `${side}px`;
  root.style.height = `${side}px`;
  const number = document.createElement('span');
  number.textContent = count > 999 ? '999+' : String(count);
  root.appendChild(number);
  return { element: root, size: [side, side], anchor: [side / 2, side / 2] };
}
