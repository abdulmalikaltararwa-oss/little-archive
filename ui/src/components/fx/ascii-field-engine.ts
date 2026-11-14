// The flower field: a grid of mono characters that arrives as noise, settles into the Little Archive mark
// (a flower on a bookmark) among a few small flowers, and ripples where the pointer passes.
//
// It is a 2D canvas and nothing else: no WebGL, no library. It draws only while something is unsettled.
// Once the field is still the animation frame loop stops, so an idle page costs nothing. The scene is a
// pure function of the grid size (buildScene), which is what the unit test checks.

export const EMPTY = 0;
export const GROUND = 1;
export const STEM = 2;
export const PAPER = 3;
export const EDGE = 4;
export const PETAL = 5;
export const HEART = 6;

export interface Scene {
  cols: number;
  rows: number;
  kind: Uint8Array;
  glyph: string[];
  /** The cell at the middle of the flower, where settling starts. */
  focus: { col: number; row: number };
}

// The mark's geometry, in the 64-unit box of web/icon.svg.
const HEART_AT = { u: 32, v: 28.3 };
// The petals are drawn further apart than in the mark, so that at character size they read as five and not as one blob.
const FLOWER_SCALE = 1.7;
const PETALS: readonly [number, number][] = [[32, 23.6], [36.4, 26.8], [34.7, 32], [29.3, 32], [27.6, 26.8]];
const PETAL_R = 4.4;
const HEART_R = 3.3;
const BOOKMARK = { left: 20, right: 44, top: 16, shoulder: 28, notch: 42.5, bottom: 49.5 };

function insideBookmark(u: number, v: number): boolean {
  const dx = Math.abs(u - 32);
  if (dx > 12 || v < BOOKMARK.top || v > BOOKMARK.bottom) return false;
  if (v < BOOKMARK.shoulder) return dx * dx + (v - BOOKMARK.shoulder) ** 2 <= 144;
  return v <= BOOKMARK.notch + (7 / 12) * dx;
}

/** A small deterministic hash in [0, 1): the field looks the same on every visit and in every test. */
export function noise(a: number, b: number, seed = 7): number {
  let h = (a * 374761393 + b * 668265263 + seed * 1442695041) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  h ^= h >>> 16;
  return ((h >>> 0) % 100000) / 100000;
}

/**
 * Lays the scene out for a grid. `cellW`/`cellH` are the size of one character cell in pixels, which is how
 * round things stay round. `anchor` is where the mark's centre sits across the width (0 to 1).
 */
export function buildScene(cols: number, rows: number, cellW: number, cellH: number, anchor = 0.5): Scene {
  const count = Math.max(0, cols * rows);
  const kind = new Uint8Array(count);
  const glyph = new Array<string>(count).fill('');
  const width = cols * cellW;
  const height = rows * cellH;
  // The mark fills most of the box's height, but never more than its width: in a narrow strip it shrinks to fit.
  const scale = Math.min((0.82 * height) / (BOOKMARK.bottom - BOOKMARK.top), (0.92 * width) / 27);
  const centreX = width * anchor;
  const centreV = (BOOKMARK.top + BOOKMARK.bottom) / 2;
  const toU = (col: number) => 32 + ((col + 0.5) * cellW - centreX) / scale;
  const toV = (row: number) => centreV + ((row + 0.5) * cellH - height / 2) / scale;
  const paper = (col: number, row: number) => col >= 0 && row >= 0 && col < cols && row < rows && insideBookmark(toU(col), toV(row));

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const index = row * cols + col;
      const u = toU(col);
      const v = toV(row);
      const heart = Math.hypot(u - HEART_AT.u, v - HEART_AT.v) / HEART_R;
      if (heart <= 1) { kind[index] = HEART; glyph[index] = heart < 0.6 ? '#' : '*'; continue; }
      let nearest = Infinity;
      for (const [pu, pv] of PETALS) {
        const cu = HEART_AT.u + (pu - HEART_AT.u) * FLOWER_SCALE;
        const cv = HEART_AT.v + (pv - HEART_AT.v) * FLOWER_SCALE;
        nearest = Math.min(nearest, Math.hypot(u - cu, v - cv) / PETAL_R);
      }
      if (nearest <= 1) { kind[index] = PETAL; glyph[index] = nearest < 0.62 ? '@' : 'o'; continue; }
      if (insideBookmark(u, v)) {
        const open = [!paper(col - 1, row), !paper(col + 1, row), !paper(col, row - 1), !paper(col, row + 1)];
        if (open[0] || open[1]) { kind[index] = EDGE; glyph[index] = open[2] ? '.' : '|'; }
        else if (open[2]) { kind[index] = EDGE; glyph[index] = '-'; }
        else if (open[3]) { kind[index] = EDGE; glyph[index] = u < 32 ? '/' : '\\'; }
        else { kind[index] = PAPER; glyph[index] = noise(col, row) < 0.5 ? ':' : '.'; }
        continue;
      }
      const speck = noise(col, row);
      if (speck < 0.03) { kind[index] = GROUND; glyph[index] = '·'; }
      else if (speck < 0.042) { kind[index] = GROUND; glyph[index] = "'"; }
      else if (speck < 0.05) { kind[index] = GROUND; glyph[index] = ','; }
    }
  }

  // A few small flowers in the grass, kept clear of the mark and of each other.
  const markCol = Math.round(centreX / cellW);
  const markHalf = Math.ceil((13 * scale) / cellW) + 3;
  const wanted = Math.min(14, Math.max(0, Math.round(count / 210)));
  const placed: [number, number][] = [];
  for (let attempt = 0; attempt < wanted * 14 && placed.length < wanted; attempt++) {
    const col = 2 + Math.floor(noise(attempt, 11) * Math.max(1, cols - 4));
    const row = 1 + Math.floor(noise(attempt, 23) * Math.max(1, rows - 4));
    if (Math.abs(col - markCol) < markHalf) continue;
    if (placed.some(([c, r]) => Math.abs(c - col) < 6 && Math.abs(r - row) < 4)) continue;
    placed.push([col, row]);
    const put = (dc: number, dr: number, value: string, type: number) => {
      const c = col + dc;
      const r = row + dr;
      if (c < 0 || r < 0 || c >= cols || r >= rows) return;
      kind[r * cols + c] = type;
      glyph[r * cols + c] = value;
    };
    put(-1, 0, '(', PETAL); put(0, 0, '@', HEART); put(1, 0, ')', PETAL);
    put(0, 1, '|', STEM);
    put(-1, 2, '\\', STEM); put(0, 2, '|', STEM); put(1, 2, '/', STEM);
  }

  const focusRow = Math.max(0, Math.min(rows - 1, Math.round((height / 2 + (HEART_AT.v - centreV) * scale) / cellH - 0.5)));
  return { cols, rows, kind, glyph, focus: { col: Math.max(0, Math.min(cols - 1, markCol)), row: focusRow } };
}

export interface FieldPalette {
  petal: string;
  heart: string;
  sage: string;
  ink: string;
}

const SCRAMBLE = ".:+*~^'`-";
const ALPHA: Record<number, number> = { [GROUND]: 0.42, [STEM]: 0.8, [PAPER]: 0.34, [EDGE]: 0.78, [PETAL]: 1, [HEART]: 1 };

export class AsciiField {
  private readonly ctx: CanvasRenderingContext2D;
  private scene: Scene = buildScene(0, 0, 1, 1);
  private settleAt = new Float64Array(0);
  private width = 0;
  private height = 0;
  private cellW = 7.2;
  private cellH = 14;
  private frame = 0;
  private twinkle: ReturnType<typeof setInterval> | undefined;
  private skip = false;
  private destroyed = false;
  readonly canvas: HTMLCanvasElement;
  readonly options: { fontSize: number; font: string; anchor: number; still: boolean; halfRate: boolean };
  palette: FieldPalette;

  constructor(canvas: HTMLCanvasElement, palette: FieldPalette, options: Partial<AsciiField['options']> = {}) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('A 2D canvas is not available.');
    this.canvas = canvas;
    this.ctx = ctx;
    this.palette = palette;
    this.options = { fontSize: 12, font: '"DM Mono", ui-monospace, Menlo, Consolas, monospace', anchor: 0.5, still: false, halfRate: false, ...options };
  }

  /** Sizes the grid to the canvas box. Call on mount and whenever the box changes. */
  resize(width: number, height: number, dpr = 1, { intro = false }: { intro?: boolean } = {}) {
    if (this.destroyed || width < 8 || height < 8) return;
    const ratio = Math.min(2, Math.max(1, dpr));
    this.width = width;
    this.height = height;
    this.canvas.width = Math.round(width * ratio);
    this.canvas.height = Math.round(height * ratio);
    this.ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    this.ctx.font = `${this.options.fontSize}px ${this.options.font}`;
    this.cellW = Math.max(4, this.ctx.measureText('M').width);
    this.cellH = Math.round(this.options.fontSize * 1.22);
    const cols = Math.floor(width / this.cellW);
    const rows = Math.floor(height / this.cellH);
    this.scene = buildScene(cols, rows, this.cellW, this.cellH, this.options.anchor);
    this.settleAt = new Float64Array(cols * rows);
    if (intro && !this.options.still) this.intro();
    else this.draw(performance.now());
  }

  /** Everything starts as noise and settles outward from the flower's heart. */
  intro() {
    const { cols, rows, focus, kind } = this.scene;
    const now = performance.now();
    const far = Math.hypot(Math.max(focus.col, cols - focus.col) * this.cellW, Math.max(focus.row, rows - focus.row) * this.cellH) || 1;
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const index = row * cols + col;
        if (kind[index] === EMPTY && noise(col, row, 3) > 0.3) continue;
        const distance = Math.hypot((col - focus.col) * this.cellW, (row - focus.row) * this.cellH) / far;
        this.settleAt[index] = now + 220 + distance * 1250 + noise(col, row, 5) * 260;
      }
    }
    this.run();
  }

  /** The pointer stirs the cells around it; they settle again a moment later. Coordinates are canvas-relative. */
  stir(x: number, y: number, radius = 44) {
    if (this.options.still || this.destroyed) return;
    const { cols, rows } = this.scene;
    const now = performance.now();
    const c0 = Math.max(0, Math.floor((x - radius) / this.cellW));
    const c1 = Math.min(cols - 1, Math.ceil((x + radius) / this.cellW));
    const r0 = Math.max(0, Math.floor((y - radius) / this.cellH));
    const r1 = Math.min(rows - 1, Math.ceil((y + radius) / this.cellH));
    for (let row = r0; row <= r1; row++) {
      for (let col = c0; col <= c1; col++) {
        const distance = Math.hypot((col + 0.5) * this.cellW - x, (row + 0.5) * this.cellH - y);
        if (distance > radius) continue;
        const index = row * cols + col;
        if (this.scene.kind[index] === EMPTY && noise(col, row, 9) > 0.45) continue;
        this.settleAt[index] = Math.max(this.settleAt[index]!, now + 180 + (1 - distance / radius) * 420 + noise(col, row, 4) * 200);
      }
    }
    this.run();
  }

  /** A petal or two flickers now and then, so a still field is not a dead one. */
  breathe(everyMs = 2800) {
    if (this.options.still) return;
    clearInterval(this.twinkle);
    this.twinkle = setInterval(() => {
      if (document.hidden || this.destroyed) return;
      const { cols, rows, kind } = this.scene;
      if (!cols || !rows) return;
      const now = performance.now();
      for (let pick = 0; pick < 3; pick++) {
        const col = Math.floor(Math.random() * cols);
        const row = Math.floor(Math.random() * rows);
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -2; dc <= 2; dc++) {
            const c = col + dc;
            const r = row + dr;
            if (c < 0 || r < 0 || c >= cols || r >= rows) continue;
            const index = r * cols + c;
            if (kind[index] !== EMPTY) this.settleAt[index] = now + 240 + Math.random() * 260;
          }
        }
      }
      this.run();
    }, everyMs);
  }

  pause() {
    clearInterval(this.twinkle);
    this.twinkle = undefined;
    cancelAnimationFrame(this.frame);
    this.frame = 0;
  }

  private run() {
    if (this.frame || this.destroyed) return;
    const step = (now: number) => {
      this.frame = 0;
      if (this.destroyed) return;
      this.skip = this.options.halfRate ? !this.skip : false;
      const busy = this.skip ? true : this.draw(now);
      if (busy) this.frame = requestAnimationFrame(step);
    };
    this.frame = requestAnimationFrame(step);
  }

  /** Draws one frame. Returns true while any cell is still unsettled. */
  draw(now: number): boolean {
    const { ctx, scene, cellW, cellH, settleAt } = this;
    const { cols, rows, kind, glyph } = scene;
    ctx.clearRect(0, 0, this.width, this.height);
    if (!cols || !rows) return false;
    ctx.font = `${this.options.fontSize}px ${this.options.font}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const offsetX = (this.width - cols * cellW) / 2;
    const offsetY = (this.height - rows * cellH) / 2;
    const tick = Math.floor(now / 70);
    let busy = false;

    const colours: Record<number, string> = { [GROUND]: this.palette.ink, [STEM]: this.palette.sage, [PAPER]: this.palette.sage, [EDGE]: this.palette.sage, [PETAL]: this.palette.petal, [HEART]: this.palette.heart };
    for (const type of [GROUND, PAPER, EDGE, STEM, PETAL, HEART]) {
      ctx.fillStyle = colours[type]!;
      ctx.globalAlpha = ALPHA[type]!;
      for (let index = 0; index < kind.length; index++) {
        if (kind[index] !== type || settleAt[index]! > now) continue;
        ctx.fillText(glyph[index]!, offsetX + ((index % cols) + 0.5) * cellW, offsetY + (Math.floor(index / cols) + 0.5) * cellH);
      }
    }

    ctx.fillStyle = this.palette.sage;
    for (let index = 0; index < kind.length; index++) {
      const until = settleAt[index]!;
      if (until <= now) continue;
      busy = true;
      const col = index % cols;
      const row = Math.floor(index / cols);
      const left = until - now;
      ctx.globalAlpha = Math.min(0.9, 0.25 + left / 900);
      ctx.fillStyle = kind[index] === PETAL || kind[index] === HEART ? this.palette.petal : this.palette.sage;
      ctx.fillText(SCRAMBLE[(Math.floor(noise(col, row, 2) * 97) + tick) % SCRAMBLE.length]!, offsetX + (col + 0.5) * cellW, offsetY + (row + 0.5) * cellH);
    }
    ctx.globalAlpha = 1;
    return busy;
  }

  redraw() {
    if (!this.frame) this.draw(performance.now());
  }

  destroy() {
    this.destroyed = true;
    this.pause();
  }
}
