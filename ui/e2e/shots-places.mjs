// Takes the review screenshots of the places screen against a real server, and seeds that server first.
//
//   LA_UI_PASSWORD_FILE=<file with the owner password> node e2e/shots-places.mjs <base-url> <output-dir> [only]
//
// <base-url> is the dev server (or a build) whose /api reaches a throwaway library. The saves are created through
// the real API (captions with pin lines, map links and written coordinates, a page with schema.org data, an
// owner's edit) and their places are extracted by the real server's fixed rules. No AI provider and no geocoder
// is configured, so the pieces that need them are covered with route mocks that return the contract's shapes:
//   - geocoded places (source "geocoder", an area, an attribution), and "Find coordinates" with its answers
//   - a library with no places, with no coordinates, a locked account, a far-flung library across the antimeridian
// Map tiles are never fetched from anywhere: tile requests are answered here with generated placeholder pictures
// (and one run refuses them, to show the map failing honestly).
// `only` is a comma-separated list of shot-name prefixes to limit the run.
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { chromium } from '@playwright/test';

const [base = 'http://127.0.0.1:5192', out = 'shots-places', only = ''] = process.argv.slice(2);
const wanted = new Set(only.split(',').filter(Boolean));
const want = name => !wanted.size || [...wanted].some(prefix => name.startsWith(prefix));
const PASSWORD = (await readFile(process.env.LA_UI_PASSWORD_FILE, 'utf8')).trim();

const SIZES = {
  phone: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  desktop: { width: 1440, height: 900, deviceScaleFactor: 1 },
};
const TILE_KEY = 'little-archive-map-tiles';
const TILE_URL = 'http://127.0.0.1:5193/{z}/{x}/{y}.png';

await mkdir(out, { recursive: true });
const browser = await chromium.launch();
const problems = [];

/* -------------------------------------------------------------------------------------- placeholder tiles */

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = buffer => { let c = 0xffffffff; for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const head = Buffer.alloc(8); head.writeUInt32BE(data.length, 0); head.write(type, 4, 'latin1');
  const tail = Buffer.alloc(4); tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, tail]);
}
function png(size, rgb) {
  const header = Buffer.alloc(13); header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 2;
  const rows = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y += 1) { rows[y * (size * 3 + 1)] = 0; rgb.copy(rows, y * (size * 3 + 1) + 1, y * size * 3, (y + 1) * size * 3); }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
const hash = (x, y, seed) => { let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 2147483647)) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };
const smooth = t => t * t * (3 - 2 * t);
function vnoise(x, y, seed) {
  const ix = Math.floor(x), iy = Math.floor(y), fx = smooth(x - ix), fy = smooth(y - iy);
  const a = hash(ix, iy, seed), b = hash(ix + 1, iy, seed), c = hash(ix, iy + 1, seed), d = hash(ix + 1, iy + 1, seed);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}
function fbm(x, y, seed, octaves) { let sum = 0, amp = 0.5, norm = 0; for (let o = 0; o < octaves; o += 1) { sum += vnoise(x, y, seed + o) * amp; norm += amp; x *= 2; y *= 2; amp /= 2; } return sum / norm; }
const mix = (a, b, t) => a.map((value, index) => Math.round(value + (b[index] - value) * t));
const WATER = [205, 223, 227], LAND = [241, 236, 222], PARK = [219, 230, 205], ROAD = [255, 253, 246], EDGE = [227, 220, 200];
const tileCache = new Map();
/** A map-looking picture for one tile. Land, water, parks and roads come from noise over the whole world, so tiles join up and every zoom is consistent. */
function tile(z, x, y) {
  const key = `${z}/${x}/${y}`;
  if (tileCache.has(key)) return tileCache.get(key);
  const N = 256, world = 2 ** z, rgb = Buffer.alloc(N * N * 3), cells = 12 * 2 ** (Math.min(z, 17) - 4);
  for (let py = 0; py < N; py += 1) for (let px = 0; px < N; px += 1) {
    const u = (x + px / N) / world, v = (y + py / N) / world;
    const land = fbm(u * 6 + 3, v * 6 + 3, 1, Math.min(9, 3 + z));
    let colour = land > 0.5 ? LAND : WATER;
    if (land > 0.5) {
      if (fbm(u * 14, v * 14, 40, 4) > 0.62) colour = PARK;
      const road = Math.abs(fbm(u * cells, v * cells, 90, 2) - 0.5);
      if (z >= 5 && road < 0.012) colour = ROAD; else if (z >= 5 && road < 0.017) colour = EDGE;
    } else colour = mix(WATER, [190, 211, 217], fbm(u * 30, v * 30, 70, 3));
    colour.forEach((value, index) => { rgb[(py * N + px) * 3 + index] = value; });
  }
  const picture = png(N, rgb);
  tileCache.set(key, picture);
  return picture;
}
const TILE_PATTERN = /(?:127\.0\.0\.1:5193|tiles\.example\.org)\/(\d+)\/(\d+)\/(\d+)\.png/;
const serveTiles = (context, { refuse = false } = {}) => context.route(TILE_PATTERN, route => {
  if (refuse) return route.abort('failed');
  const [, z, x, y] = TILE_PATTERN.exec(route.request().url());
  return route.fulfill({ contentType: 'image/png', body: tile(Number(z), Number(x), Number(y)) });
});

/* ------------------------------------------------------------------------------------------- the library */

async function api(page, method, apiPath, body) {
  return page.evaluate(async ([method, apiPath, body]) => {
    const me = await (await fetch('/api/auth/me')).json();
    const response = await fetch(`/api${apiPath}`, { method, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrf_token || '' }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json().catch(() => null) };
  }, [method, apiPath, body]);
}

const SAVES = [
  { url: 'https://www.instagram.com/p/Cvienna01/', creator: '@wienerwalks', title: 'Vienna in one long weekend', caption: 'Vienna in one long weekend\n📍 Café Central, Herrengasse 14, Vienna\n📍 Naschmarkt https://www.google.com/maps/place/Naschmarkt/@48.1986,16.3629,17z\nLocation: Prater 48.2166, 16.3959\n#vienna #weekend' },
  { url: 'https://www.tiktok.com/@kaffeeklatsch/video/7301000001', creator: '@kaffeeklatsch', title: 'Coffee houses worth the queue', caption: 'Coffee houses worth the queue ☕\n📍 Hotel Sacher, Philharmoniker Str. 4, Vienna 48.2038, 16.3698\n📍 Café Landtmann https://maps.apple.com/?ll=48.2121,16.3616&q=Caf%C3%A9+Landtmann\n📍 Café Sperl, Gumpendorfer Str. 11, Vienna' },
  { url: 'https://www.instagram.com/p/Cvienna02/', creator: '@baroquebeat', title: 'Palaces and gardens', caption: 'Palaces and gardens\nLocation: Schönbrunn Palace 48.1845, 16.3122\n📍 Belvedere https://www.openstreetmap.org/#map=17/48.1915/16.3808\n📍 Karlskirche 48.1983, 16.3719' },
  { url: 'https://www.instagram.com/p/Cprague001/', creator: '@praguepockets', title: 'Prague on a budget', caption: 'Prague on a budget\n📍 Café Louvre, Národní 22, Prague 50.0819, 14.4217\n📍 Charles Bridge https://www.google.com/maps/place/Charles+Bridge/@50.0865,14.4114,17z\n📍 Lokál Dlouhááá, Dlouhá 33, Prague' },
  { url: 'https://example.com/budapest-soaking-guide', creator: 'The Slow Atlas', title: 'Budapest, the soaking guide', caption: 'Budapest, the soaking guide\nLocation: Széchenyi Thermal Bath 47.5186, 19.0818\n📍 Szimpla Kert, Kazinczy utca 14, Budapest\n📍 Central Market Hall https://www.openstreetmap.org/#map=17/47.4871/19.0583' },
  { url: 'https://example.com/salzburg-in-a-day', creator: 'The Slow Atlas', title: 'Salzburg in a day', caption: 'A day in Salzburg, from the gardens to the old town.' },
];
const SALZBURG_PAGE = '<!doctype html><html><head><meta charset="utf-8"><title>Mirabell Gardens</title><script type="application/ld+json">{"@context":"https://schema.org","@type":"Park","name":"Mirabell Gardens","address":{"@type":"PostalAddress","streetAddress":"Mirabellplatz","addressLocality":"Salzburg","addressCountry":"Austria"},"geo":{"@type":"GeoCoordinates","latitude":"47.8055","longitude":"13.0420"}}</script></head><body><h1>Mirabell Gardens</h1></body></html>';

async function seed(page) {
  if (process.env.LA_RESEED) {
    const all = (await api(page, 'GET', '/items?limit=200')).body.items;
    for (const item of all) await api(page, 'DELETE', `/items/${item.id}`);
  }
  const existing = await api(page, 'GET', '/places?limit=1');
  if (existing.body?.total > 0) return;
  await api(page, 'POST', '/demo');
  const ids = [];
  for (const save of SAVES) {
    const created = await api(page, 'POST', '/items', save);
    if (created.status >= 300) throw new Error(`could not create ${save.title}: ${JSON.stringify(created.body)}`);
    ids.push(created.body.id);
  }
  await api(page, 'POST', `/items/${ids[5]}/page`, { html: SALZBURG_PAGE });
  for (const id of ids) {
    const extracted = await api(page, 'POST', `/items/${id}/places/extract`, { method: 'auto' });
    if (extracted.status >= 300) throw new Error(`could not extract: ${JSON.stringify(extracted.body)}`);
  }
  // An owner's edit: the first save's Café Central gets coordinates the owner typed, so "entered by you" is real.
  const first = (await api(page, 'GET', `/items/${ids[0]}/places`)).body;
  const edited = first.places.map(place => ({ id: place.id, name: place.name, kind: place.kind, ...(place.city ? { city: place.city } : {}), ...(place.address ? { address: place.address } : {}), ...(place.name === 'Café Central' ? { coordinates: { lat: 48.2104, lon: 16.3655 }, note: 'Go before nine to skip the queue.' } : place.coordinates ? { coordinates: { lat: place.coordinates.lat, lon: place.coordinates.lon } } : {}) }));
  const saved = await api(page, 'PUT', `/items/${ids[0]}/places`, { places: edited });
  if (saved.status >= 300) throw new Error(`could not save the edit: ${JSON.stringify(saved.body)}`);
}

/* --------------------------------------------------------------------------------------------- mocks */

const jsonRoute = (context, pattern, change) => context.route(pattern, async route => {
  const response = await route.fetch();
  const body = await response.json().catch(() => null);
  await route.fulfill({ response, json: change(body) ?? body });
});
const PLACES_LIST = /\/api\/places(\?.*)?$/;
const FEATURES = /\/api\/features$/;

const GEOCODER = { enabled: true, attribution: 'Place lookups use OpenStreetMap data, © OpenStreetMap contributors (ODbL 1.0).' };
const withGeocoder = context => jsonRoute(context, FEATURES, body => ({ ...body, places: { ...body.places, geocoding: GEOCODER } }));
/** Makes three places look as if the geocoder found them, and adds a district whose position is only an area. */
const withGeocoded = context => jsonRoute(context, PLACES_LIST, body => {
  const named = new Map();
  const places = body.places.map((place, index) => {
    if (place.coordinates && index % 4 === 1) {
      return { ...place, coordinates: { ...place.coordinates, source: 'geocoder', detail: 'nominatim', provider: 'nominatim.openstreetmap.org', precision: 'point', display_name: `${place.name}, ${place.city || 'Vienna'}, Austria`, attribution: 'Data © OpenStreetMap contributors, ODbL 1.0' } };
    }
    return place;
  });
  const sample = places.find(place => place.coordinates) ?? places[0];
  named.set('area', { ...sample, id: 'ffffffffffff', name: 'Wachau Valley', kind: 'region', city: null, region: 'Lower Austria', country: 'Austria', address: null, note: 'Wine and apricots along the Danube.', evidence: { source: 'caption', quote: 'a day in the Wachau Valley' }, origin: 'rules', coordinates: { lat: 48.3708, lon: 15.4, source: 'geocoder', detail: 'nominatim', provider: 'nominatim.openstreetmap.org', precision: 'area', display_name: 'Wachau, Lower Austria, Austria', attribution: 'Data © OpenStreetMap contributors, ODbL 1.0' } });
  return { ...body, places: [...places, named.get('area')], total: body.total + 1 };
});
const withoutCoordinates = context => jsonRoute(context, PLACES_LIST, body => ({ ...body, places: body.places.map(place => ({ ...place, coordinates: null })) }));
const withNoPlaces = context => jsonRoute(context, PLACES_LIST, () => ({ places: [], total: 0, limit: 200, offset: 0, bbox: null }));
const locked = context => jsonRoute(context, FEATURES, body => ({ ...body, unlocked: false, mode: 'hosted', places: { ...body.places, locked: true } }));
/** Places on both sides of the antimeridian and across the world, to see the paper map and the clusters at that scale. */
const worldwide = context => jsonRoute(context, PLACES_LIST, body => {
  const far = [['Fushimi Inari Taisha', 'attraction', 'Kyoto', 'Japan', 34.9671, 135.7727], ['Nishiki Market', 'market', 'Kyoto', 'Japan', 35.005, 135.7646], ['Time Out Market', 'market', 'Lisbon', 'Portugal', 38.7066, -9.1456], ['Brooklyn Bridge Park', 'park', 'New York', 'United States', 40.7003, -73.9967],
    ['Waiheke Island', 'region', 'Auckland', 'New Zealand', -36.8, 175.1], ['Taveuni', 'region', null, 'Fiji', -16.85, -179.95], ['Savusavu Bay', 'beach', null, 'Fiji', -16.78, 179.33]];
  const template = body.places[0];
  const extra = far.map(([name, kind, city, country, lat, lon], index) => ({ ...template, id: `e0000000000${index}`, name, kind, city, region: null, country, address: null, note: null, coordinates: { lat, lon, source: 'source', detail: 'maps_link', provider: '', precision: 'point' }, evidence: { source: 'caption', quote: `📍 ${name}` } }));
  return { ...body, places: [...body.places, ...extra], total: body.total + extra.length };
});

/* ------------------------------------------------------------------------------------------- sessions */

let storageState;
async function signedIn() {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.goto(new URL('/', base).href);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Open my archive' }).click();
  await page.getByRole('heading', { name: 'All saves' }).waitFor();
  await seed(page);
  storageState = await context.storageState();
  await context.close();
}

async function open(size, scheme, { tiles = false, refuse = false, tileUrl = TILE_URL, mocks = [], url = '/#/places', reducedMotion = 'no-preference' } = {}) {
  const spec = SIZES[size];
  const context = await browser.newContext({ storageState, viewport: { width: spec.width, height: spec.height }, deviceScaleFactor: spec.deviceScaleFactor, isMobile: spec.isMobile, hasTouch: spec.hasTouch, colorScheme: scheme, reducedMotion });
  if (tiles) {
    await context.addInitScript(([key, value]) => localStorage.setItem(key, value), [TILE_KEY, JSON.stringify({ v: 1, mode: 'custom', url: tileUrl, attribution: '© Placeholder tiles, generated for this review' })]);
    await serveTiles(context, { refuse });
  }
  for (const mock of mocks) await mock(context);
  const page = await context.newPage();
  page.on('pageerror', error => problems.push(`${size}/${scheme} pageerror: ${error.message}`));
  page.on('console', message => {
    if (message.type() === 'error' && !/ws:\/\/|WebSocket|Failed to load resource/.test(message.text())) problems.push(`${size}/${scheme} console: ${message.text().slice(0, 300)}`);
  });
  await page.goto(new URL(url, base).href);
  return { context, page };
}

const settle = (page, ms = 900) => page.waitForTimeout(ms);
const shot = (page, name, options = {}) => page.screenshot({ path: path.join(out, `${name}.png`), ...options });
const listReady = page => page.getByRole('status').filter({ hasText: /places?\b/ }).first().waitFor();

await signedIn();

for (const size of Object.keys(SIZES)) {
  for (const scheme of ['light', 'dark']) {
    const tag = `${size}-${scheme}`;
    const phone = size === 'phone';

    // The plain paper map: no tile server chosen, so nothing is requested and the sheet is drawn by hand.
    if (want(`paper-${tag}`) || want(`selected-paper-${tag}`)) {
      const { context, page } = await open(size, scheme);
      await listReady(page);
      await settle(page, 1200);
      if (want(`paper-${tag}`)) await shot(page, `paper-${tag}`);
      if (want(`selected-paper-${tag}`)) {
        await (phone ? page.getByRole('radio', { name: 'List' }).click() : Promise.resolve());
        await page.getByRole('button', { name: /Naschmarkt/ }).first().click();
        if (phone) { await page.getByRole('radio', { name: 'Map' }).click(); }
        await settle(page, 900);
        await shot(page, `selected-paper-${tag}`);
      }
      await context.close();
    }

    // The tiled map, with placeholder tiles from this script.
    if (want(`tiles-${tag}`) || want(`selected-tiles-${tag}`) || want(`list-${tag}`)) {
      const { context, page } = await open(size, scheme, { tiles: true });
      await listReady(page);
      await settle(page, 2200);
      if (want(`tiles-${tag}`)) await shot(page, `tiles-${tag}`);
      if (want(`selected-tiles-${tag}`)) {
        if (phone) await page.getByRole('radio', { name: 'List' }).click();
        await page.getByRole('button', { name: /Schönbrunn/ }).first().click();
        if (phone) await page.getByRole('button', { name: 'Show on the map' }).click();
        await settle(page, 2600);
        await shot(page, `selected-tiles-${tag}`);
      }
      if (want(`list-${tag}`) && phone) {
        await page.getByRole('radio', { name: 'List' }).click();
        await page.getByRole('button', { name: /Café Central/ }).first().click();
        await settle(page, 600);
        await shot(page, `list-${tag}`);
      }
      await context.close();
    }

    // Geocoder results and an area, on the tiled map.
    if (want(`geocoded-${tag}`)) {
      const { context, page } = await open(size, scheme, { tiles: true, mocks: [withGeocoder, withGeocoded] });
      await listReady(page);
      if (phone) await page.getByRole('radio', { name: 'List' }).click();
      await page.getByRole('button', { name: /Wachau Valley/ }).first().click();
      if (phone) await page.getByRole('button', { name: 'Show on the map' }).click();
      await settle(page, 2600);
      await shot(page, `geocoded-${tag}`);
      if (phone) { await page.getByRole('button', { name: 'Details' }).click(); await settle(page, 700); await shot(page, `geocoded-list-${tag}`); }
      await context.close();
    }

    // The tile settings, and the question asked before a new tile server is contacted.
    if (want(`tilesettings-${tag}`)) {
      const { context, page } = await open(size, scheme);
      await listReady(page);
      await page.getByRole('button', { name: /Map tiles/ }).click();
      await settle(page, 700);
      await shot(page, `tilesettings-${tag}`);
      await page.getByLabel('Tile address').fill('http://tiles.example.org/{z}/{x}');
      await page.getByRole('button', { name: 'Use these tiles' }).click();
      await settle(page, 500);
      await shot(page, `tilesettings-invalid-${tag}`);
      await page.getByLabel('Tile address').fill('https://tiles.example.org/{z}/{x}/{y}.png');
      await page.getByLabel('Credit line').fill('© OpenStreetMap contributors');
      await page.getByRole('button', { name: 'Use these tiles' }).click();
      await settle(page, 700);
      await shot(page, `tilesettings-confirm-${tag}`);
      await context.close();
    }

    if (scheme === 'light') {
      if (want(`failed-${tag}`)) {
        const { context, page } = await open(size, scheme, { tiles: true, refuse: true, tileUrl: 'https://tiles.example.org/{z}/{x}/{y}.png' });
        await listReady(page);
        await settle(page, 2500);
        await shot(page, `failed-${tag}`);
        await context.close();
      }
      if (want(`nocoordinates-${tag}`)) {
        const { context, page } = await open(size, scheme, { mocks: [withoutCoordinates, withGeocoder] });
        await listReady(page);
        await settle(page, 900);
        await shot(page, `nocoordinates-${tag}`);
        await context.close();
      }
      if (want(`empty-${tag}`)) {
        const { context, page } = await open(size, scheme, { mocks: [withNoPlaces] });
        await page.getByRole('heading', { name: 'No places yet' }).waitFor();
        await settle(page, 700);
        await shot(page, `empty-${tag}`);
        await context.close();
      }
      if (want(`locked-${tag}`)) {
        const { context, page } = await open(size, scheme, { mocks: [locked] });
        await page.getByRole('heading', { name: /locked for now/ }).waitFor();
        await settle(page, 600);
        await shot(page, `locked-${tag}`);
        await context.close();
      }
      if (want(`world-${tag}`)) {
        const { context, page } = await open(size, scheme, { mocks: [worldwide] });
        await listReady(page);
        await settle(page, 1200);
        await shot(page, `world-paper-${tag}`);
        await context.close();
        const tiled = await open(size, scheme, { tiles: true, mocks: [worldwide] });
        await listReady(tiled.page);
        await settle(tiled.page, 2400);
        await shot(tiled.page, `world-tiles-${tag}`);
        await tiled.context.close();
      }
    }

    // The section of the detail panel, on its own.
    if (want(`entry-${tag}`)) {
      const { context, page } = await open(size, scheme, { url: '/' });
      const everything = (await api(page, 'GET', '/places?limit=200')).body.places;
      const id = everything.find(place => place.name === 'Café Central').item_id;
      const second = everything.find(place => place.name === 'Charles Bridge').item_id;
      await context.close();
      for (const [name, itemId, mocks] of [['edited', id, [withGeocoder]], ['plain', second, []]]) {
        const entry = await open(size, scheme, { url: `/e2e/places-harness.html?item=${itemId}`, mocks });
        await entry.page.getByRole('region', { name: 'Places' }).waitFor();
        await settle(entry.page, 900);
        await shot(entry.page, `entry-${name}-${tag}`, { fullPage: true });
        if (name === 'edited') {
          await entry.page.getByRole('button', { name: 'Look for places' }).click();
          await settle(entry.page, 1200);
          await shot(entry.page, `entry-looked-${tag}`, { fullPage: true });
          await entry.page.getByRole('button', { name: /^Rename/ }).first().click();
          await settle(entry.page, 400);
          await shot(entry.page, `entry-rename-${tag}`, { fullPage: true });
        }
        await entry.context.close();
      }
    }
  }
}

await browser.close();
if (problems.length) {
  console.log(`\n${problems.length} problem(s):`);
  for (const problem of new Set(problems)) console.log(' -', problem);
  process.exitCode = 1;
} else console.log('no page errors');
