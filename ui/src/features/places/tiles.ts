// Map tiles are somebody else's server, and asking for one tells that server the viewer's address and roughly
// where on the earth they are looking. So tiles are off until the owner (or the operator, at build time) names a
// tile server, and this file is the rule for what may be named: a web address template over https (plain http
// only for a tile server on this machine), with the three placeholders a raster tile layer fills in, and no
// credentials in it. Everything here is pure; the browser's storage is in tile-store.ts.

export interface TileSettingsValid {
  ok: true;
  /** The template, trimmed. */
  url: string;
  /** The part of the address that names the server, as written (it may still contain `{s}`). */
  host: string;
  /** Things that are allowed but worth saying out loud. */
  warnings: string[];
}

export type TileCheck = TileSettingsValid | { ok: false; message: string };

/** What the owner asked for and the browser keeps: no tiles at all, or one tile server. Nothing else is ever stored. */
export type StoredTiles = { mode: 'off' } | { mode: 'custom'; url: string; attribution: string };

/** A tile server in use, and who chose it. */
export interface TileConfig {
  url: string;
  host: string;
  /** Plain text. Shown on the map whenever tiles are. */
  attribution: string;
  source: 'owner' | 'operator';
}

export const MAX_TEMPLATE = 2048;
export const MAX_ATTRIBUTION = 300;

const KNOWN = new Set(['z', 'x', 'y', 's', 'r']);
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
// Parameter names that look like a secret. A template that has one is allowed (some providers need a key in
// the address) but the owner is told where it goes.
const SECRET_PARAMETER = /(^|[_-])(key|token|secret|apikey|api[_-]?key|access|auth|password)($|[_-])/i;

const fail = (message: string): TileCheck => ({ ok: false, message });

/** Checks a tile address template. Returns the cleaned template, or a sentence saying what is wrong with it. */
export function validateTileTemplate(input: string): TileCheck {
  const url = input.trim();
  if (!url) return fail('Enter the address of a tile server, such as https://tiles.example.org/{z}/{x}/{y}.png.');
  if (url.length > MAX_TEMPLATE) return fail('That address is too long.');
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f\u007f]/.test(url)) return fail('The address cannot contain spaces or line breaks.');

  // Leaflet throws when a `{name}` it does not know is left in a template, so only its own are accepted.
  const names = [...url.matchAll(/\{([^{}]*)\}/g)].map(match => match[1]!);
  const unknown = names.find(name => !KNOWN.has(name));
  if (unknown !== undefined) return fail(`{${unknown}} is not a placeholder a tile layer can fill in. Use {z}, {x} and {y}.`);
  if (/[{}]/.test(url.replace(/\{[^{}]*\}/g, ''))) return fail('There is a stray curly bracket in the address. Placeholders are written {z}, {x} and {y}.');
  for (const required of ['z', 'x', 'y']) {
    if (!names.includes(required)) return fail(`The address needs {z}, {x} and {y} in it, so each tile can be asked for by its place. {${required}} is missing.`);
  }

  const scheme = /^(https?):\/\//i.exec(url)?.[1]?.toLowerCase();
  if (!scheme) return fail('The address must start with https://.');
  const authority = /^https?:\/\/([^/?#]*)/i.exec(url)?.[1] ?? '';
  if (/\{[zxyr]\}/.test(authority)) return fail('{z}, {x} and {y} belong in the path after the server name, not in the name itself.');

  let parsed: URL;
  try {
    parsed = new URL(url.replace(/\{s\}/g, 'a').replace(/\{[zxy]\}/g, '0').replace(/\{r\}/g, ''));
  } catch {
    return fail('That is not a web address a browser can open.');
  }
  if (parsed.username || parsed.password) return fail('Leave the username and password out of the address. They would be stored here and sent with every tile.');
  if (parsed.protocol === 'http:' && !LOCAL_HOSTS.has(parsed.hostname)) return fail('Only https:// addresses can be used. Plain http:// is allowed only for a tile server on this machine (localhost or 127.0.0.1).');
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return fail('The address must start with https://.');
  if (!parsed.hostname) return fail('The address has no server name.');

  const warnings: string[] = [];
  for (const name of parsed.searchParams.keys()) {
    if (SECRET_PARAMETER.test(name)) {
      warnings.push(`“${name}” looks like a key. Whatever is in this address is kept in this browser and sent to the tile server with every picture, so use a key that is meant to be public.`);
      break;
    }
  }
  if (parsed.protocol === 'http:') {
    warnings.push('Your server’s content policy only lets a page load pictures over https, so a plain http tile server may show nothing once the interface is served by it.');
  }
  return { ok: true, url, host: authority, warnings };
}

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', middot: '·', mdash: '—', ndash: '–', hellip: '…' };

function entity(whole: string, body: string): string {
  const named = NAMED[body.toLowerCase()];
  if (named !== undefined) return named;
  const code = /^#x([0-9a-f]{1,6})$/i.exec(body) ? parseInt(body.slice(2), 16) : /^#(\d{1,7})$/.test(body) ? Number(body.slice(1)) : NaN;
  // Only printable characters are decoded; control characters stay as they were written.
  return Number.isInteger(code) && code >= 32 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) && !(code >= 0x7f && code <= 0x9f) ? String.fromCodePoint(code) : whole;
}

/**
 * Tile providers hand out their credit line as a snippet of HTML (`&copy; <a href="…">OpenStreetMap</a> contributors`).
 * It is shown as plain text, never as markup, so this keeps the words: tags are dropped, the common entities decoded.
 */
export function plainAttribution(input: string): string {
  return input
    .replace(/<[^>]*>/g, '')
    .replace(/&(#?[a-z0-9]+);/gi, entity)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_ATTRIBUTION);
}

/** What the operator built in, if it is a usable template. An unusable one is ignored rather than half-used. */
export function operatorTiles(env: { url?: string; attribution?: string }): TileConfig | null {
  const check = validateTileTemplate(String(env.url ?? ''));
  if (!check.ok) return null;
  return { url: check.url, host: check.host, attribution: plainAttribution(String(env.attribution ?? '')), source: 'operator' };
}

/** The tiles in use: the owner's choice if they made one (including "none"), else the operator's default, else none. */
export function resolveTiles(stored: StoredTiles | null, env: { url?: string; attribution?: string }): TileConfig | null {
  if (stored?.mode === 'off') return null;
  if (stored?.mode === 'custom') {
    const check = validateTileTemplate(stored.url);
    return check.ok ? { url: check.url, host: check.host, attribution: plainAttribution(stored.attribution), source: 'owner' } : null;
  }
  return operatorTiles(env);
}

/** What the browser's storage held, if it is a setting this version wrote and the template still passes. Anything else is no setting. */
export function parseStoredTiles(raw: string | null): StoredTiles | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as { v?: unknown; mode?: unknown; url?: unknown; attribution?: unknown } | null;
    if (!value || value.v !== 1) return null;
    if (value.mode === 'off') return { mode: 'off' };
    if (value.mode === 'custom' && typeof value.url === 'string') {
      const check = validateTileTemplate(value.url);
      if (!check.ok) return null;
      return { mode: 'custom', url: check.url, attribution: plainAttribution(typeof value.attribution === 'string' ? value.attribution : '') };
    }
  } catch {
    return null;
  }
  return null;
}

export const serializeStoredTiles = (value: StoredTiles): string => JSON.stringify({ v: 1, ...value });
