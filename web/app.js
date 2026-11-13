import { PLATFORM_NAMES, STATUS_NAMES, safeURL, parseTags, buildItemPatch, formatDate, hostLabel, countLabel, createQuery, libraryScope, stableHue, errorMessage } from './utils.js';

const app = document.getElementById('app');
const IS_DEMO = document.documentElement.dataset.demo === 'true';
const ICON_URL = new URL('./icon.svg', import.meta.url).href;
const state = {
  authenticated: false, csrf: '', items: [], total: 0, stats: {}, collections: [], tags: [], settings: {},
  filters: { q: '', platform: '', collection_id: '', tag: '', status: '', favorite: false, needs_review: false, sort: 'recent' },
  view: 'all', selected: new Set(), selecting: false, loading: false, request: 0, theme: 'system', detail: null,
};
let dom = {};
let uid = 0;
const icons = {
  search: ['circle|cx=10.5|cy=10.5|r=6.5', 'path|d=M16 16l4 4'],
  grid: ['rect|x=3|y=3|width=7|height=7|rx=1.4', 'rect|x=14|y=3|width=7|height=7|rx=1.4', 'rect|x=3|y=14|width=7|height=7|rx=1.4', 'rect|x=14|y=14|width=7|height=7|rx=1.4'],
  heart: ['path|d=M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z'],
  bookmark: ['path|d=M6 3h12v18l-6-4-6 4V3Z'],
  clock: ['circle|cx=12|cy=12|r=9', 'path|d=M12 7v5l3 2'],
  check: ['path|d=M5 12l4 4L19 6'],
  checkcircle: ['circle|cx=12|cy=12|r=9', 'path|d=M8 12l3 3 5-6'],
  sparkles: ['path|d=m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z', 'path|d=M20 2v4m-2-2h4'],
  folder: ['path|d=M3 6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6Z'],
  plus: ['path|d=M12 5v14M5 12h14'],
  x: ['path|d=M6 6l12 12M18 6 6 18'],
  menu: ['path|d=M4 6h16M4 12h16M4 18h16'],
  arrow: ['path|d=M5 12h14m-5-5 5 5-5 5'],
  external: ['path|d=M14 3h7v7m0-7L10 14', 'path|d=M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5'],
  instagram: ['rect|x=3|y=3|width=18|height=18|rx=5', 'circle|cx=12|cy=12|r=4', 'circle|cx=17.5|cy=6.5|r=.7'],
  tiktok: ['path|d=M14 3v12.5a4.5 4.5 0 1 1-4.5-4.5M14 3c1 4 3 5 7 5v4c-3 0-5-1-7-3'],
  web: ['circle|cx=12|cy=12|r=9', 'path|d=M3 12h18M12 3c6 6 6 12 0 18-6-6-6-12 0-18Z'],
  settings: ['path|d=m9.5 3-.6 2.5-2.3 1L4 6l-2 3.5 2 1.7v2.6L2 15.5 4 19l2.6-.5 2.3 1 .6 2.5h5l.6-2.5 2.3-1 2.6.5 2-3.5-2-1.7v-2.6L22 9.5 20 6l-2.6.5-2.3-1L14.5 3Z', 'circle|cx=12|cy=12.5|r=3'],
  upload: ['path|d=M12 16V3m-5 5 5-5 5 5M4 15v5h16v-5'],
  download: ['path|d=M12 3v13m-5-5 5 5 5-5M4 17v4h16v-4'],
  link: ['path|d=M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-2 2M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l2-2'],
  shield: ['path|d=M12 3 3 7v6c0 5 9 9 9 9s9-4 9-9V7l-9-4Z', 'path|d=m8 12 3 3 5-6'],
  archive: ['rect|x=3|y=3|width=18|height=5|rx=1', 'path|d=M5 8v13h14V8M9 12h6'],
  activity: ['path|d=M3 12h4l3-8 4 16 3-8h4'],
  dots: ['circle|cx=5|cy=12|r=1', 'circle|cx=12|cy=12|r=1', 'circle|cx=19|cy=12|r=1'],
  trash: ['path|d=M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7'],
  edit: ['path|d=m16 3 5 5-12 12-6 1 1-6L16 3Zm-3 3 5 5'],
  image: ['rect|x=3|y=3|width=18|height=18|rx=2', 'circle|cx=8|cy=8|r=1.5', 'path|d=m21 15-6-6L3 21'],
  play: ['path|d=m8 4 13 8-13 8V4Z'],
  copy: ['rect|x=8|y=8|width=13|height=13|rx=2', 'path|d=M16 8V3H3v13h5'],
  logout: ['path|d=M9 3H4v18h5M13 7l5 5-5 5M8 12h13'],
  sun: ['circle|cx=12|cy=12|r=4', 'path|d=M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1 1m12 12 1 1M5 19l1-1M18 6l1-1'],
  moon: ['path|d=M21 13a9 9 0 1 1-10-10 7 7 0 0 0 10 10Z'],
  monitor: ['rect|x=3|y=3|width=18|height=13|rx=2', 'path|d=M8 21h8M12 16v5'],
  alert: ['path|d=m12 3 10 18H2L12 3Z', 'path|d=M12 9v5m0 3v.1'],
};

function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'value') node.value = value;
    else if (key === 'checked') node.checked = Boolean(value);
    else if (key === 'disabled') node.disabled = Boolean(value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat(Infinity)) if (child != null && child !== false) node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  return node;
}

function icon(name) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  for (const [key, value] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.7', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(key, value);
  for (const shape of icons[name] || icons.bookmark) {
    const [tag, ...attrs] = shape.split('|');
    const el = document.createElementNS(ns, tag);
    for (const attr of attrs) { const eq = attr.indexOf('='); el.setAttribute(attr.slice(0, eq), attr.slice(eq + 1)); }
    svg.append(el);
  }
  return svg;
}

function btn(label, iconName, onClick, className = '') {
  return h('button', { class: `btn ${className}`, type: 'button', onClick }, iconName && icon(iconName), label);
}

function iconBtn(label, iconName, onClick, className = '') {
  return h('button', { class: `icon-btn ${className}`, type: 'button', title: label, 'aria-label': label, onClick }, icon(iconName));
}

function field(label, input, help) {
  input.id ||= `field-${++uid}`;
  return h('div', { class: 'form-field' }, h('label', { for: input.id }, label), input, help && h('p', { class: 'field-help' }, help));
}

function optionSelect(options, selected, attrs = {}) {
  const select = h('select', attrs, options.map(([value, label]) => h('option', { value }, label)));
  select.value = selected ?? '';
  return select;
}

async function api(path, { method = 'GET', body, headers = {}, signal, raw = false } = {}) {
  const options = { method, credentials: 'same-origin', headers: { Accept: 'application/json', ...headers }, signal };
  if (body != null) {
    if (raw) options.body = body;
    else { options.body = JSON.stringify(body); options.headers['Content-Type'] = 'application/json'; }
  }
  if (!['GET', 'HEAD'].includes(method) && state.csrf) options.headers['X-CSRF-Token'] = state.csrf;
  let response;
  try { response = await fetch(`/api${path}`, options); }
  catch (error) { if (error.name === 'AbortError') throw error; throw new Error('Could not reach your archive. Check that the server is running and try again.'); }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && state.authenticated && path !== '/auth/login') { state.authenticated = false; state.csrf = ''; renderLogin('Your session expired. Sign in to continue.'); }
    const detail = Array.isArray(payload.detail) ? payload.detail.map(x => x.msg || 'Invalid field').join('. ') : payload.detail;
    throw new Error(typeof detail === 'string' ? detail : `Request failed (${response.status}). Please try again.`);
  }
  return payload;
}

function toast(message, error = false) {
  const node = h('div', { class: `toast${error ? ' error' : ''}`, role: error ? 'alert' : 'status' }, icon(error ? 'alert' : 'checkcircle'), h('span', {}, message));
  node.append(iconBtn('Dismiss notification', 'x', () => node.remove()));
  document.getElementById('toasts').append(node);
  window.setTimeout(() => node.remove(), error ? 10000 : 5000);
}

async function busy(button, operation) {
  if (button?.disabled) return;
  if (button) { button.disabled = true; button.setAttribute('aria-busy', 'true'); }
  try { return await operation(); }
  catch (error) { toast(errorMessage(error), true); }
  finally { if (button) { button.disabled = false; button.removeAttribute('aria-busy'); } }
}

function applyTheme(theme) {
  state.theme = theme;
  const dark = theme === 'dark' || (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.querySelector('meta[name="theme-color"]').content = dark ? '#202722' : '#F7F4EF';
  if (!IS_DEMO) try { localStorage.setItem('little-archive-theme', theme); } catch { /* Storage is optional for appearance. */ }
}
try { applyTheme(IS_DEMO ? 'system' : ['light', 'dark', 'system'].includes(localStorage.getItem('little-archive-theme')) ? localStorage.getItem('little-archive-theme') : 'system'); } catch { applyTheme('system'); }
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (state.theme === 'system') applyTheme('system'); });

function brand(small = false) {
  return h('div', { class: `brand${small ? ' brand-small' : ''}` }, h('img', { src: ICON_URL, alt: '', width: 35, height: 35 }), h('span', {}, 'little archive'));
}

function paperArt() {
  return h('div', { class: 'hero-art', 'aria-hidden': 'true' }, h('div', { class: 'hero-paper' }), h('div', { class: 'hero-flower' }), h('span', { class: 'hero-star' }, '✧'));
}

function renderLogin(message = '') {
  for (const dialog of document.querySelectorAll('dialog')) dialog.close();
  app.replaceChildren();
  const password = h('input', { type: 'password', name: 'password', autocomplete: 'current-password', required: true, placeholder: 'Your archive password' });
  const error = h('div', { class: 'form-error', role: 'alert', hidden: !message }, message);
  const submit = h('button', { class: 'btn primary', type: 'submit' }, 'Open my archive', icon('arrow'));
  const form = h('form', { onSubmit: async event => {
    event.preventDefault(); error.hidden = true; submit.disabled = true;
    try {
      const result = await api('/auth/login', { method: 'POST', body: { password: password.value } });
      password.value = ''; state.csrf = result.csrf_token; state.authenticated = true; await initializeLibrary();
    } catch (e) { error.textContent = errorMessage(e); error.hidden = false; password.focus(); }
    finally { submit.disabled = false; }
  } }, error, field('Password', password), submit);
  const story = h('section', { class: 'login-story', 'aria-label': 'About Little Archive' }, brand(), h('div', {}, h('div', { class: 'eyebrow' }, 'A home for your curious mind'), h('h1', {}, 'Good things,', h('br'), 'kept close.'), h('p', {}, 'Your saved posts, ideas, and little discoveries. Together in a space that belongs to you.'), paperArt()), h('div', { class: 'login-footer' }, icon('shield'), 'Open source. Self-hosted. Yours to keep.'));
  const panel = h('main', { class: 'login-panel', id: 'main' }, h('div', { class: 'login-box' }, h('div', { class: 'eyebrow' }, 'Welcome home'), h('h2', {}, 'Your archive awaits.'), h('p', {}, 'Sign in to pick up where your curiosity left off.'), form, h('p', { class: 'login-help' }, 'Use the owner password configured when this instance was installed. Need to reset it? Your server administrator can use the local password-reset command.')));
  app.append(h('div', { class: 'login-screen' }, story, panel));
  document.title = 'Little Archive — Welcome home';
}

async function initializeLibrary() {
  renderShell();
  try { await refreshMetadata(); await loadItems(); }
  catch (error) {
    if (state.authenticated) renderLoadError(error);
  }
}

function renderShell() {
  const sidebar = h('aside', { class: 'sidebar', id: 'sidebar', 'aria-label': 'Library navigation' });
  const shell = h('div', { class: 'app-shell' });
  const menu = iconBtn('Open navigation', 'menu', () => { shell.classList.toggle('menu-open'); menu.setAttribute('aria-expanded', String(shell.classList.contains('menu-open'))); }, 'mobile-menu');
  menu.setAttribute('aria-controls', 'sidebar'); menu.setAttribute('aria-expanded', 'false');
  const scrim = h('button', { class: 'mobile-scrim', 'aria-label': 'Close navigation', onClick: () => { shell.classList.remove('menu-open'); menu.setAttribute('aria-expanded', 'false'); } });
  const importButton = btn('Import', 'upload', openImport);
  const addButton = btn('Save a link', 'plus', openAdd, 'primary');
  const topbar = h('header', { class: 'topbar' }, menu, h('span', { class: 'topbar-label' }, 'A little space for everything you love'), h('div', { class: 'topbar-actions' }, importButton, addButton));
  const hero = h('section', { class: 'hero', 'aria-label': 'Your personal archive' }, h('div', { class: 'hero-copy' }, h('div', { class: 'eyebrow' }, 'Collect a little. Discover a lot.'), h('h1', {}, 'Good things, kept close.'), h('p', {}, 'The recipe. The idea. That thing you wanted to try. Find your little discoveries again.')), paperArt());
  const title = h('h2', {}, 'All saves');
  const count = h('span', {}, 'Opening your library…');
  const selectButton = btn('Select', 'checkcircle', () => { state.selecting = !(state.selecting || state.selected.size > 0); if (!state.selecting) state.selected.clear(); renderSelection(); }, 'ghost small');
  const organize = btn('Organize', 'sparkles', () => openOrganize(), 'soft small');
  organize.setAttribute('aria-label', 'Organize library');
  const heading = h('div', { class: 'library-heading' }, h('div', { class: 'library-title' }, title, count), h('div', { class: 'flex-wrap' }, organize, selectButton));
  const search = h('input', { type: 'search', placeholder: 'Find something you saved…', 'aria-label': 'Search titles, captions, tags, and notes', autocomplete: 'off', spellcheck: false });
  let searchTimer;
  search.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { state.filters.q = search.value.trim(); loadItems(); }, 250); });
  const tagSelect = optionSelect([['', 'All topics']], '', { 'aria-label': 'Filter by topic', onChange: e => { state.filters.tag = e.target.value; loadItems(); } });
  const sort = optionSelect([['recent', 'Recently added'], ['oldest', 'Oldest first'], ['title', 'Title A–Z'], ['random', 'Rediscover']], 'recent', { 'aria-label': 'Sort saves', onChange: e => { state.filters.sort = e.target.value; loadItems(); } });
  const filters = h('div', { class: 'filterbar' }, h('div', { class: 'search' }, icon('search'), search, h('kbd', { class: 'keyhint', 'aria-hidden': 'true' }, '⌘ K')), tagSelect, sort);
  const tabs = h('div', { class: 'source-tabs', 'aria-label': 'Filter by source' });
  const bulk = h('div', { class: 'bulkbar', hidden: true });
  const grid = h('div', { class: 'grid', 'aria-live': 'polite', 'aria-label': 'Saved items' });
  const more = h('div', { class: 'load-more' });
  const main = h('main', { class: 'main', id: 'main', tabindex: '-1' }, topbar, hero, heading, filters, tabs, bulk, grid, more, h('p', { class: 'footer-note' }, icon('shield'), 'Your collection. Your server. A little more peace of mind.'));
  shell.append(sidebar, scrim, main);
  if (IS_DEMO) app.replaceChildren(h('div', { class: 'demo-banner', role: 'note' }, h('span', {}, icon('sparkles'), h('strong', {}, 'Interactive demo'), ' · synthetic content · changes reset on reload'), btn('Reset demo', 'arrow', () => location.reload(), 'ghost small')), shell);
  else app.replaceChildren(shell);
  dom = { shell, sidebar, title, count, search, tagSelect, sort, tabs, bulk, grid, more, selectButton, menu };
  renderSidebar(); renderTabs();
}

async function refreshMetadata() {
  const [stats, collections, tags, settings] = await Promise.all([api('/stats'), api('/collections'), api('/tags'), api('/settings')]);
  state.stats = stats; state.collections = collections.collections || []; state.tags = tags.tags || []; state.settings = settings;
  if (!dom.sidebar?.isConnected) return;
  renderSidebar(); renderTabs();
  dom.tagSelect.replaceChildren(h('option', { value: '' }, 'All topics'), ...state.tags.map(tag => h('option', { value: tag.name }, `${tag.name} (${tag.count})`)));
  if (!state.tags.some(x => x.name === state.filters.tag)) state.filters.tag = '';
  dom.tagSelect.value = state.filters.tag;
}

function navButton(label, iconName, view, count, extra = {}) {
  return h('button', { class: `nav-button${state.view === view ? ' active' : ''}`, 'aria-current': state.view === view ? 'page' : null, onClick: () => setView(view, extra), type: 'button' }, icon(iconName), h('span', { class: 'nav-label' }, label), count != null && h('span', { class: 'nav-count' }, Number(count).toLocaleString()));
}

function renderSidebar() {
  if (!dom.sidebar) return;
  const primary = h('nav', { class: 'sidebar-section', 'aria-label': 'Library views' },
    h('div', { class: 'sidebar-heading' }, 'Your library'),
    navButton('All saves', 'grid', 'all', state.stats.total),
    navButton('Favorites', 'heart', 'favorites', state.stats.favorites, { favorite: true }),
    navButton('To revisit', 'clock', 'revisit', state.stats.to_revisit, { status: 'to_revisit' }),
    navButton('Needs review', 'sparkles', 'review', state.stats.needs_review, { needs_review: true }),
    navButton('Rediscover', 'bookmark', 'rediscover', null, { sort: 'random' }),
  );
  const collections = h('div', { class: 'sidebar-section' }, h('div', { class: 'sidebar-heading' }, 'Collections', iconBtn('Create a collection', 'plus', () => openCollection())));
  const locals = state.collections.filter(x => x.kind === 'local');
  if (!locals.length) collections.append(h('p', { class: 'small-text muted', }, ''));
  for (const collection of locals) {
    const button = h('button', { class: `nav-button${state.filters.collection_id === collection.id ? ' active' : ''}`, onClick: () => setView(`collection:${collection.id}`, { collection_id: collection.id }), type: 'button', title: collection.name }, h('span', { class: `collection-dot ${colorName(collection.color)}` }), h('span', { class: 'nav-label' }, collection.name), h('span', { class: 'nav-count' }, collection.count || 0));
    collections.append(h('div', { class: 'collection-row' }, button, iconBtn(`Edit ${collection.name}`, 'dots', () => openCollection(collection), 'collection-edit')));
  }
  if (!locals.length) collections.append(h('button', { class: 'nav-button', onClick: () => openCollection(), type: 'button' }, icon('plus'), 'Make your first collection'));
  const sources = h('div', { class: 'sidebar-section' }, h('div', { class: 'sidebar-heading' }, 'From your sources'));
  for (const platform of ['instagram', 'tiktok', 'web']) {
    sources.append(navButton(PLATFORM_NAMES[platform], platform, `platform:${platform}`, state.stats.platforms?.[platform] || 0, { platform }));
    for (const collection of state.collections.filter(x => x.kind === 'source' && x.platform === platform)) {
      sources.append(h('button', { class: `nav-button source-collection${state.filters.collection_id === collection.id ? ' active' : ''}`, onClick: () => setView(`collection:${collection.id}`, { collection_id: collection.id, platform }), title: `${collection.name} · original source collection`, type: 'button' }, icon('folder'), h('span', { class: 'nav-label' }, collection.name), h('span', { class: 'nav-count' }, collection.count || 0)));
    }
  }
  const bottom = h('div', { class: 'sidebar-bottom' }, navButton('Archived', 'archive', 'archived', state.stats.archived, { status: 'archived' }), h('button', { class: 'nav-button', type: 'button', onClick: () => openActivity() }, icon('activity'), 'Import activity'), h('button', { class: 'nav-button', type: 'button', onClick: openSettings }, icon('settings'), 'Settings & connections'), h('p', { class: 'sidebar-note' }, icon('shield'), h('span', {}, 'Self-hosted & open source', h('br'), 'A small place of your own.')));
  dom.sidebar.replaceChildren(brand(), primary, collections, sources, h('div', { class: 'sidebar-spacer' }), bottom);
}

function colorName(color) {
  return ({ '#c9959c': 'blush', '#8ea8b7': 'blue', '#c4aa70': 'gold', blush: 'blush', blue: 'blue', gold: 'gold' })[String(color).toLowerCase()] || '';
}

function renderTabs() {
  if (!dom.tabs) return;
  dom.tabs.replaceChildren(...[['', 'Everything', 'grid'], ['instagram', 'Instagram', 'instagram'], ['tiktok', 'TikTok', 'tiktok'], ['web', 'Web links', 'web']].map(([value, label, iconName]) => {
    const n = value ? state.stats.platforms?.[value] || 0 : state.stats.total || 0;
    return h('button', { class: `tab${state.filters.platform === value ? ' active' : ''}`, 'aria-pressed': String(state.filters.platform === value), type: 'button', onClick: () => {
      state.filters.platform = value;
      if (state.view.startsWith('platform:')) state.view = value ? `platform:${value}` : 'all';
      renderTabs(); renderSidebar(); loadItems();
    } }, icon(iconName), label, h('span', { class: 'tab-count' }, n));
  }));
}

function setView(view, overrides = {}) {
  state.view = view; state.filters = { q: '', platform: '', collection_id: '', tag: '', status: '', favorite: false, needs_review: false, sort: 'recent', ...overrides };
  state.selected.clear(); state.selecting = false;
  dom.search.value = ''; dom.tagSelect.value = ''; dom.sort.value = state.filters.sort;
  dom.shell.classList.remove('menu-open'); dom.menu.setAttribute('aria-expanded', 'false');
  renderSidebar(); renderTabs(); loadItems();
}

function viewTitle() {
  if (state.filters.collection_id) return state.collections.find(x => x.id === state.filters.collection_id)?.name || 'Collection';
  return ({ all: 'All saves', favorites: 'Your favorites', revisit: 'A little later', review: 'Needs a little review', rediscover: 'Rediscover something good', archived: 'Archived saves' })[state.view] || `${PLATFORM_NAMES[state.filters.platform] || 'All'} saves`;
}

async function loadItems(append = false) {
  const request = ++state.request;
  state.loading = true;
  const offset = append ? state.items.length : 0;
  dom.title.textContent = viewTitle();
  document.title = `${viewTitle()} — Little Archive${IS_DEMO ? ' demo' : ''}`;
  if (!append) {
    state.selected.clear(); renderSelection();
    dom.grid.replaceChildren(...Array.from({ length: 8 }, () => h('div', { class: 'skeleton', 'aria-hidden': 'true' })));
    dom.count.textContent = 'Finding your saves…';
  }
  dom.more.replaceChildren(); dom.grid.setAttribute('aria-busy', 'true');
  try {
    const result = await api(`/items?${createQuery(state.filters, offset)}`);
    if (request !== state.request || !state.authenticated) return;
    state.items = append ? [...state.items, ...result.items] : result.items;
    state.total = result.total;
    renderItems();
  } catch (error) { if (request === state.request && state.authenticated) renderLoadError(error); }
  finally { if (request === state.request) { state.loading = false; dom.grid?.removeAttribute('aria-busy'); } }
}

function renderLoadError(error) {
  if (!dom.grid?.isConnected) return;
  dom.grid.replaceChildren(h('div', { class: 'empty-state' }, h('div', { class: 'empty-illustration' }, icon('alert')), h('h3', {}, 'A little interruption.'), h('p', {}, errorMessage(error)), btn('Try again', 'arrow', () => busy(null, async () => { await refreshMetadata(); await loadItems(); }), 'primary')));
  dom.count.textContent = 'Unable to load';
}

function makeCover(item, detail = false) {
  const wrap = h('div', { class: detail ? 'detail-preview' : 'card-cover' });
  const thumbnail = safeURL(item.thumbnail_url, { local: true });
  const remote = state.settings.remote_previews ? safeURL(item.preview_url) : null;
  const url = thumbnail || remote;
  const fallback = () => {
    const cover = h('div', { class: `text-cover art-${stableHue(item.title || item.id)}`, 'aria-hidden': 'true' }, h('div', { class: 'cover-pattern' }), h('span', { class: 'cover-topline' }, PLATFORM_NAMES[item.platform] || 'A little discovery'), h('span', { class: 'cover-title', dir: 'auto' }, item.title || hostLabel(item.url)), h('span', { class: 'cover-mark' }, '✧'));
    wrap.replaceChildren(cover);
    if (!detail) wrap.append(h('span', { class: 'preview-label' }, 'Text preview'));
  };
  if (url) {
    const image = h('img', { src: url, alt: '', loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer' });
    image.addEventListener('error', fallback, { once: true }); wrap.append(image);
  } else fallback();
  if (item.content_type === 'video' && !detail) wrap.append(h('span', { class: 'media-badge', title: 'Video link' }, icon('play')));
  return wrap;
}

function renderItems() {
  dom.count.textContent = state.filters.sort === 'random' && state.items.length < state.total ? `${state.items.length} of ${countLabel(state.total, 'save')}` : countLabel(state.total, 'save');
  if (!state.items.length) {
    const libraryEmpty = !state.stats.total && !state.stats.archived;
    const clear = () => setView('all');
    dom.grid.replaceChildren(h('section', { class: 'empty-state' }, h('div', { class: 'empty-illustration' }, icon(libraryEmpty ? 'bookmark' : 'search')), h('h3', {}, libraryEmpty ? 'Every collection starts somewhere.' : 'Nothing here just yet.'), h('p', {}, libraryEmpty ? 'Save your first link, bring in an export, or explore with a small collection of clearly labeled demo saves.' : 'Try a different search or filter. Your next rediscovery might be one collection over.'), h('div', { class: 'empty-actions' }, libraryEmpty ? [btn('Save a link', 'plus', openAdd, 'primary'), btn('Import your saves', 'upload', openImport), btn('Try demo saves', 'sparkles', event => addDemo(event.currentTarget), 'ghost')] : [btn('Clear filters', 'x', clear, 'primary')])));
  } else dom.grid.replaceChildren(...state.items.map(renderCard));
  dom.more.replaceChildren();
  if (state.filters.sort === 'random' && state.items.length) dom.more.append(btn('Shuffle these discoveries', 'sparkles', event => busy(event.currentTarget, () => loadItems())));
  else if (state.items.length < state.total) dom.more.append(btn(`Load more · ${state.total - state.items.length} remaining`, 'plus', event => busy(event.currentTarget, () => loadItems(true))));
  renderSelection();
}

function renderCard(item) {
  const card = h('article', { class: `card${state.selected.has(item.id) ? ' selected' : ''}`, 'data-item-id': item.id });
  const source = h('span', { class: 'source-label' }, icon(item.platform), PLATFORM_NAMES[item.platform] || 'Web');
  const status = item.status === 'done' ? h('span', { class: 'source-label', title: 'Done', 'aria-label': 'Done' }, icon('check')) : item.status === 'to_revisit' ? h('span', { class: 'source-label', title: 'To revisit', 'aria-label': 'To revisit' }, icon('clock')) : null;
  const tags = h('div', { class: 'tags' }, (item.tags || []).slice(0, 2).map(tag => h('span', { class: 'tag', dir: 'auto' }, tag)), item.needs_review && h('span', { class: 'tag review' }, 'To review'));
  const body = h('div', { class: 'card-body' }, h('div', { class: 'card-meta' }, source, status), h('h3', { class: 'card-title', dir: 'auto' }, item.title || hostLabel(item.url)), h('div', { class: 'card-creator', dir: 'auto' }, item.creator || hostLabel(item.url)), tags);
  const open = h('button', { class: 'card-open', type: 'button', 'aria-label': `Open ${item.title || 'saved item'}`, onClick: () => openDetail(item.id) }, makeCover(item), body);
  const checkbox = h('input', { type: 'checkbox', class: 'card-select', checked: state.selected.has(item.id), 'aria-label': `Select ${item.title || 'saved item'}`, onChange: event => {
    if (event.target.checked && state.selected.size >= 200) { event.target.checked = false; toast('Select up to 200 saves, or use Organize to update every match.'); return; }
    event.target.checked ? state.selected.add(item.id) : state.selected.delete(item.id); renderSelection();
  } });
  const favorite = iconBtn(item.favorite ? 'Remove from favorites' : 'Add to favorites', 'heart', event => busy(event.currentTarget, async () => { await api(`/items/${item.id}`, { method: 'PATCH', body: { favorite: !item.favorite } }); await refreshLibrary(); }), 'card-favorite');
  favorite.setAttribute('aria-pressed', String(Boolean(item.favorite)));
  card.append(open, checkbox, favorite); return card;
}

function renderSelection() {
  if (!dom.grid) return;
  const count = state.selected.size;
  dom.grid.classList.toggle('selecting', state.selecting || count > 0);
  dom.selectButton.replaceChildren(icon('checkcircle'), state.selecting || count ? 'Cancel selection' : 'Select');
  dom.selectButton.setAttribute('aria-pressed', String(state.selecting || count > 0));
  dom.bulk.hidden = !count;
  for (const card of dom.grid.querySelectorAll('[data-item-id]')) { card.classList.toggle('selected', state.selected.has(card.dataset.itemId)); const c = card.querySelector('input[type=checkbox]'); if (c) c.checked = state.selected.has(card.dataset.itemId); }
  if (!count) { dom.bulk.replaceChildren(); return; }
  const action = optionSelect([['favorite', 'Add to favorites'], ['unfavorite', 'Remove from favorites'], ['tag', 'Add a topic'], ['collection', 'Add to a collection'], ['archive', 'Archive'], ['restore', 'Move to inbox']], 'favorite', { 'aria-label': 'Bulk action' });
  const all = btn('Select visible', null, () => { for (const item of state.items) { if (state.selected.size >= 200) break; state.selected.add(item.id); } renderSelection(); }, 'ghost small');
  const apply = btn('Apply', 'check', () => openBulkAction(action.value), 'primary small');
  dom.bulk.replaceChildren(h('span', {}, `${count} selected`), all, action, apply, iconBtn('Clear selection', 'x', () => { state.selected.clear(); state.selecting = false; renderSelection(); }));
}

async function refreshLibrary() { await refreshMetadata(); await loadItems(); }

function modal(title, { detail = false, canClose, onClose } = {}) {
  const heading = h('h2', { id: `dialog-title-${++uid}` }, title);
  const dialog = h('dialog', { class: detail ? 'detail-dialog' : '', 'aria-labelledby': heading.id });
  const body = h('div', { class: 'dialog-body' });
  const foot = h('div', { class: 'dialog-foot' });
  const close = () => { if (!canClose || canClose()) dialog.close(); };
  const head = h('div', { class: 'dialog-head' }, heading, iconBtn('Close dialog', 'x', close));
  dialog.append(head, body);
  dialog.addEventListener('cancel', e => { if (canClose && !canClose()) e.preventDefault(); });
  dialog.addEventListener('click', e => { if (e.target === dialog) { const r = dialog.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) close(); } });
  dialog.addEventListener('close', () => { onClose?.(); dialog.remove(); });
  document.body.append(dialog); dialog.showModal();
  return { dialog, head, body, foot, close, addFooter: (...children) => { foot.replaceChildren(...children); dialog.append(foot); } };
}

function formError(form) {
  const error = h('div', { class: 'form-error', role: 'alert', hidden: true });
  form.prepend(error);
  return { show: e => { error.textContent = errorMessage(e); error.hidden = false; }, clear: () => { error.hidden = true; } };
}

function collectionChecklist(selected = []) {
  const list = h('div', { class: 'check-list' });
  const locals = state.collections.filter(x => x.kind === 'local');
  for (const collection of locals) {
    const checkbox = h('input', { type: 'checkbox', value: collection.id, checked: selected.includes(collection.id) });
    list.append(h('label', { class: 'check-row' }, checkbox, h('span', { dir: 'auto' }, collection.name)));
  }
  if (!locals.length) list.append(h('p', { class: 'field-help' }, 'Create a local collection from the sidebar to organize your saves.'));
  return { element: list, values: () => [...list.querySelectorAll('input:checked')].map(x => x.value) };
}

function openAdd() {
  const m = modal('Save a little discovery');
  const url = h('input', { type: 'url', required: true, placeholder: 'https://…', autocomplete: 'url' });
  const title = h('input', { type: 'text', maxlength: 500, placeholder: 'Give it a name you’ll remember', dir: 'auto' });
  const notes = h('textarea', { placeholder: 'What caught your eye?', maxlength: 20000, dir: 'auto' });
  const tags = h('input', { type: 'text', placeholder: 'design, weekend ideas, food', dir: 'auto' });
  const collections = collectionChecklist();
  const form = h('form', {}, h('p', { class: 'dialog-description' }, 'Keep a post, article, video, or any link worth coming back to.'), field('Link', url), field('Title', title), field('Your notes', notes), field('Topics', tags, 'Separate topics with commas.'), h('div', { class: 'form-field' }, h('span', { class: 'field-label' }, 'Collections'), collections.element));
  const error = formError(form);
  const save = h('button', { class: 'btn primary', type: 'submit' }, icon('bookmark'), 'Save to archive');
  form.append(h('div', { class: 'flex-wrap' }, btn('Cancel', null, m.close), save));
  form.addEventListener('submit', async e => {
    e.preventDefault(); error.clear(); save.disabled = true;
    try {
      if (!safeURL(url.value)) throw new Error('Enter a complete HTTP or HTTPS link.');
      const item = await api('/items', { method: 'POST', body: { url: url.value.trim(), title: title.value.trim(), notes: notes.value, tags: parseTags(tags.value), collection_ids: collections.values() } });
      m.close(); await refreshLibrary(); toast('A little discovery, safely kept.'); openDetail(item.id);
    } catch (e) { error.show(e); } finally { save.disabled = false; }
  });
  m.body.append(form); url.focus();
}

function openCollection(collection = null) {
  const m = modal(collection ? 'Edit collection' : 'Make a collection');
  const name = h('input', { type: 'text', value: collection?.name || '', required: true, maxlength: 200, placeholder: 'A place for your next obsession', dir: 'auto' });
  const colorChoices = [['#94a98b', 'Sage'], ['#c9959c', 'Blush'], ['#8ea8b7', 'Sky'], ['#c4aa70', 'Honey']];
  if (collection?.color && !colorChoices.some(([value]) => value.toLowerCase() === collection.color.toLowerCase())) colorChoices.push([collection.color, 'Current color']);
  const color = optionSelect(colorChoices, collection?.color || '#94a98b');
  const form = h('form', {}, field('Name', name), field('Color', color), h('p', { class: 'field-help' }, 'Local collections organize your archive independently of your original source collections.'));
  const error = formError(form);
  const save = h('button', { class: 'btn primary', type: 'submit' }, collection ? 'Save changes' : 'Create collection');
  const actions = h('div', { class: 'flex-wrap mt-12' }, btn('Cancel', null, m.close), save);
  if (collection) actions.prepend(btn('Delete', 'trash', () => confirmAction('Delete this collection?', `“${collection.name}” will be removed from this archive. Its saved items will remain.`, async () => { await api(`/collections/${collection.id}`, { method: 'DELETE' }); m.close(); if (state.filters.collection_id === collection.id) setView('all'); await refreshLibrary(); toast('Collection removed. Your saves are still here.'); }, true), 'danger'));
  form.append(actions);
  form.addEventListener('submit', async e => {
    e.preventDefault(); error.clear(); save.disabled = true;
    try { await api(collection ? `/collections/${collection.id}` : '/collections', { method: collection ? 'PATCH' : 'POST', body: { name: name.value.trim(), color: color.value } }); m.close(); await refreshLibrary(); toast(collection ? 'Collection updated.' : 'Your new collection is ready.'); }
    catch (e) { error.show(e); } finally { save.disabled = false; }
  });
  m.body.append(form); name.focus();
}

function confirmAction(title, message, action, danger = false) {
  const m = modal(title);
  m.body.append(h('p', { class: 'dialog-description mb-0' }, message));
  const confirm = btn(danger ? 'Delete' : 'Continue', danger ? 'trash' : 'check', event => busy(event.currentTarget, async () => { await action(); m.close(); }), danger ? 'danger' : 'primary');
  m.addFooter(btn('Cancel', null, m.close), confirm);
}

function openBulkAction(action) {
  const ids = [...state.selected].slice(0, 200);
  if (!ids.length) return;
  const commit = async value => {
    const result = await api('/items/bulk', { method: 'POST', body: { ids, action, ...(value ? { value } : {}) } });
    state.selected.clear(); state.selecting = false; await refreshLibrary(); toast(`${countLabel(result.updated, 'save')} updated.`);
  };
  if (!['tag', 'collection'].includes(action)) return busy(null, () => commit());
  const m = modal(action === 'tag' ? 'Add a topic to your selection' : 'Collect your selection');
  const input = action === 'tag' ? h('input', { type: 'text', required: true, maxlength: 80, placeholder: 'e.g. Weekend ideas', dir: 'auto' }) : optionSelect(state.collections.filter(x => x.kind === 'local').map(x => [x.id, x.name]), null);
  if (action === 'collection' && !state.collections.some(x => x.kind === 'local')) { m.body.append(h('p', { class: 'dialog-description' }, 'Create a local collection first, then add your selection to it.')); m.addFooter(btn('Close', null, m.close)); return; }
  const form = h('form', {}, field(action === 'tag' ? 'Topic' : 'Collection', input));
  const error = formError(form);
  const save = h('button', { class: 'btn primary', type: 'submit' }, `Update ${ids.length} saves`);
  form.append(save); m.body.append(form);
  form.addEventListener('submit', async event => { event.preventDefault(); error.clear(); save.disabled = true; try { await commit(input.value.trim()); m.close(); } catch (e) { error.show(e); } finally { save.disabled = false; } });
}

function openOrganize() {
  const m = modal('Organize your library');
  const viewFilters = { ...state.filters };
  const scope = optionSelect([['all', 'Whole active library'], ['view', 'Current view'], ['review', 'Needs review']], 'all');
  const scopeSummary = h('p', { class: 'field-help', role: 'status' });
  const currentScope = () => libraryScope(viewFilters, scope.value);
  const updateSummary = () => {
    const count = scope.value === 'all' ? state.stats.total : scope.value === 'review' ? state.stats.needs_review : state.total;
    scopeSummary.textContent = `${countLabel(count, 'save')} in this scope. Every matching page is included, even if you have not loaded it.`;
  };
  scope.addEventListener('change', updateSummary); updateSummary();
  m.body.append(h('p', { class: 'dialog-description' }, 'Keep your original collections, then add topics and local collections that make the saves useful to you.'), field('Organization scope', scope), scopeSummary);
  const feedback = h('p', { class: 'organize-result', role: 'status', hidden: true });
  const updateMatches = async (action, value) => {
    const result = await api('/items/bulk', { method: 'POST', body: { filters: currentScope(), action, value } });
    await refreshLibrary(); updateSummary();
    feedback.textContent = `${countLabel(result.updated, 'save')} updated. Original source collections are preserved.`;
    feedback.hidden = false;
  };
  const topic = h('input', { type: 'text', required: true, maxlength: 80, placeholder: 'e.g. Recipes to try', dir: 'auto' });
  const topicForm = h('form', { class: 'setting-section' }, h('h3', {}, 'Add a topic'), field('Topic to add', topic));
  const topicError = formError(topicForm);
  const addTopic = h('button', { class: 'btn soft', type: 'submit' }, icon('plus'), 'Add topic to matching saves');
  topicForm.append(addTopic);
  topicForm.addEventListener('submit', async event => {
    event.preventDefault(); topicError.clear(); addTopic.disabled = true;
    try { if (!topic.value.trim()) throw new Error('Enter a topic.'); await updateMatches('tag', topic.value.trim()); }
    catch (error) { topicError.show(error); } finally { addTopic.disabled = false; }
  });
  const locals = state.collections.filter(collection => collection.kind === 'local');
  const collection = optionSelect([['', 'Choose a local collection'], ...locals.map(c => [c.id, c.name])], ''); collection.required = true;
  const collectionForm = h('form', { class: 'setting-section' }, h('h3', {}, 'Collect matching saves'), field('Local collection to add', collection));
  const collectionError = formError(collectionForm);
  const addCollection = h('button', { class: 'btn soft', type: 'submit', disabled: !locals.length }, icon('folder'), 'Add matches to collection');
  collectionForm.append(addCollection);
  if (!locals.length) collectionForm.append(h('p', { class: 'field-help mt-12' }, 'Make a local collection first.'), btn('Create a collection', 'plus', () => { m.close(); openCollection(); }, 'ghost small'));
  collectionForm.addEventListener('submit', async event => {
    event.preventDefault(); collectionError.clear(); addCollection.disabled = true;
    try { if (!collection.value) throw new Error('Choose a local collection.'); await updateMatches('collection', collection.value); }
    catch (error) { collectionError.show(error); } finally { addCollection.disabled = !locals.length; }
  });
  const ai = h('section', { class: 'setting-section' }, h('h3', {}, 'Let local AI suggest topics'), h('p', {}, 'Queue the complete scope. Suggestions use available titles, captions, notes, and collection names. You review them before they change your organization.'));
  const queue = btn('Queue topic suggestions', 'sparkles', event => busy(event.currentTarget, async () => {
    const result = await api('/ai/jobs', { method: 'POST', body: { filters: currentScope() } });
    toast(`${result.queued} queued · ${result.unchanged} already current · ${result.matched} matched.`);
    m.close(); openActivity('ai');
  }), 'primary');
  if (IS_DEMO || !state.settings.ai_enabled) {
    queue.disabled = true;
    ai.append(h('p', { class: 'field-help' }, IS_DEMO ? 'Local AI is unavailable in the synthetic demo. Manual topics and collections work in memory.' : 'Local AI is not configured. Manual topics and collections work now; your server can optionally connect a local Ollama model.'));
  }
  ai.append(h('div', { class: 'flex-wrap mt-12' }, queue, btn('View job progress', 'activity', () => { m.close(); openActivity('ai'); }, 'small')));
  m.body.append(topicForm, collectionForm, feedback, ai);
  m.addFooter(btn('Review matching saves', 'checkcircle', event => busy(event.currentTarget, async () => { const filters = currentScope(); m.close(); await openReview(filters); }), 'soft'), btn('Done', 'check', m.close, 'primary'));
}

async function openReview(filters = {}) {
  const result = await api(`/items?${createQuery({ ...filters, needs_review: true, sort: 'oldest' }, 0, 1)}`);
  if (result.items.length) await openDetail(result.items[0].id, { reviewFilters: filters });
  else toast('You are caught up. No saves in this scope need review.');
}

async function openDetail(id, { reviewFilters } = {}) {
  if (state.detail) state.detail.close();
  let dirty = false;
  const confirmDiscard = () => !dirty || window.confirm('Discard your unsaved changes?');
  const m = modal('A closer look', { detail: true, canClose: confirmDiscard, onClose: () => { if (state.detail === m.dialog) state.detail = null; } });
  m.confirmDiscard = confirmDiscard;
  m.reviewFilters = reviewFilters || libraryScope(state.filters, 'view');
  state.detail = m.dialog;
  m.body.append(h('p', { class: 'loading-line' }, 'Opening your save…'));
  try { const item = await api(`/items/${id}`); if (m.dialog.open) renderDetail(m, item, value => { dirty = value; }); }
  catch (e) { m.body.replaceChildren(h('div', { class: 'form-error', role: 'alert' }, errorMessage(e))); }
}

function renderDetail(m, item, setDirty) {
  m.body.replaceChildren(); setDirty(false);
  const originalURL = safeURL(item.url);
  const openOriginal = IS_DEMO ? h('span', { class: 'pill-note' }, 'Illustrative source link') : originalURL ? h('a', { href: originalURL, target: '_blank', rel: 'noopener noreferrer', class: 'btn small' }, 'Open original', icon('external')) : null;
  const favorite = iconBtn(item.favorite ? 'Remove from favorites' : 'Add to favorites', 'heart', event => busy(event.currentTarget, async () => {
    const updated = await api(`/items/${item.id}`, { method: 'PATCH', body: { favorite: !item.favorite } });
    item.favorite = updated.favorite;
    const label = item.favorite ? 'Remove from favorites' : 'Add to favorites';
    favorite.setAttribute('aria-pressed', String(item.favorite)); favorite.setAttribute('aria-label', label); favorite.title = label;
    await refreshLibrary();
  }));
  favorite.setAttribute('aria-pressed', String(Boolean(item.favorite)));
  m.body.append(makeCover(item, true), h('div', { class: 'detail-source-row' }, h('span', { class: 'source-label' }, icon(item.platform), PLATFORM_NAMES[item.platform] || 'Web', item.creator ? ` · ${item.creator}` : ''), favorite), h('h2', { class: 'detail-title', dir: 'auto' }, item.title || hostLabel(item.url)), h('div', { class: 'detail-actions' }, openOriginal, btn('Copy link', 'copy', event => busy(event.currentTarget, () => copyText(item.url)))));
  const sourceCollections = (item.collections || []).filter(x => x.kind === 'source');
  if (sourceCollections.length) m.body.append(h('section', { class: 'detail-section mt-12' }, h('h3', {}, 'Original collections'), h('div', { class: 'tags' }, sourceCollections.map(c => h('span', { class: 'tag source', dir: 'auto' }, icon('folder'), c.name))), h('p', { class: 'field-help mt-12' }, 'Kept exactly as imported from the source.')));
  if (item.ai && item.needs_review) {
    const ai = item.ai;
    m.body.append(h('section', { class: 'ai-card', 'aria-label': 'AI suggestion' }, h('h3', {}, icon('sparkles'), 'A little help organizing'), h('p', { dir: 'auto' }, ai.summary || ai.suggested_title), h('div', { class: 'tags' }, (ai.topics || []).map(x => h('span', { class: 'tag' }, x))), h('p', { class: 'field-help' }, `Based on ${String(ai.evidence_level || 'available text').replaceAll('-', ' ')}. Review suggestions before accepting.`), h('div', { class: 'flex-wrap' }, btn('Accept suggestions', 'check', event => busy(event.currentTarget, async () => { if (!m.confirmDiscard()) return; const updated = await api(`/items/${item.id}/ai/accept`, { method: 'POST' }); renderDetail(m, updated, setDirty); await refreshLibrary(); toast('Suggestions accepted.'); }), 'primary small'), btn('Dismiss', 'x', event => busy(event.currentTarget, async () => { if (!m.confirmDiscard()) return; const updated = await api(`/items/${item.id}/ai/dismiss`, { method: 'POST' }); renderDetail(m, updated, setDirty); await refreshLibrary(); toast('Suggestion dismissed.'); }), 'ghost small'))));
  }
  const title = h('input', { type: 'text', value: item.title || '', maxlength: 500, dir: 'auto' });
  const summary = h('textarea', { value: item.summary || '', maxlength: 4000, rows: 3, placeholder: 'A short reminder of what this is about…', dir: 'auto' });
  const notes = h('textarea', { value: item.notes || '', maxlength: 20000, placeholder: 'Why did you save this? What would you like to try?', dir: 'auto' });
  const tags = h('input', { type: 'text', value: (item.tags || []).join(', '), placeholder: 'Separate topics with commas', dir: 'auto' });
  const status = optionSelect(Object.entries(STATUS_NAMES), item.status || 'inbox');
  const review = h('input', { type: 'checkbox', checked: item.needs_review });
  const checklist = collectionChecklist((item.collections || []).filter(x => x.kind === 'local').map(x => x.id));
  const form = h('form', { class: 'detail-section' }, field('Title', title), field('Summary', summary), field('Your notes', notes), field('Topics', tags, IS_DEMO ? 'Separate topics with commas. Demo edits reset on reload.' : 'Separate topics with commas. Your edits are kept on refresh.'), field('Progress', status), h('label', { class: 'check-row' }, review, 'Keep in Needs review'), h('div', { class: 'form-field' }, h('span', { class: 'field-label' }, 'Local collections'), checklist.element));
  const error = formError(form);
  const save = h('button', { class: 'btn primary w-full', type: 'submit' }, icon('check'), 'Save changes');
  form.append(save); form.addEventListener('input', () => setDirty(true));
  form.addEventListener('submit', async event => {
    event.preventDefault(); error.clear(); save.disabled = true;
    try {
      const patch = buildItemPatch(item, { title: title.value.trim(), summary: summary.value, notes: notes.value, tags: parseTags(tags.value), status: status.value, needs_review: review.checked, collection_ids: checklist.values() });
      if (!Object.keys(patch).length) { setDirty(false); toast('Everything is already saved.'); return; }
      const updated = await api(`/items/${item.id}`, { method: 'PATCH', body: patch });
      setDirty(false); renderDetail(m, updated, setDirty); await refreshLibrary(); toast('Your changes are saved.');
    } catch (e) { error.show(e); } finally { save.disabled = false; }
  });
  m.body.append(form);
  const thumbnailInput = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', class: 'sr-only', 'aria-label': 'Upload a local preview image' });
  const upload = btn(item.thumbnail_url ? 'Replace local preview' : 'Add a local preview', 'image', () => thumbnailInput.click(), 'small');
  if (IS_DEMO) { upload.disabled = true; upload.title = 'Local image uploads are available in your own instance.'; }
  thumbnailInput.addEventListener('change', async () => {
    const file = thumbnailInput.files?.[0]; if (!file) return;
    await busy(upload, async () => {
      if (!m.confirmDiscard()) return;
      if (file.size > 8 * 1024 * 1024) throw new Error('Choose a PNG, JPEG, or WebP smaller than 8 MiB.');
      const updated = await api(`/items/${item.id}/thumbnail`, { method: 'POST', body: file, raw: true, headers: { 'Content-Type': file.type || 'application/octet-stream' } });
      renderDetail(m, updated, setDirty); await refreshLibrary(); toast('Local preview added.');
    });
  });
  const tools = h('section', { class: 'detail-section' }, h('h3', {}, 'A few useful extras'), h('div', { class: 'flex-wrap' }, upload, thumbnailInput));
  if (item.thumbnail_url) tools.lastChild.append(btn('Remove preview', 'x', event => busy(event.currentTarget, async () => { if (!m.confirmDiscard()) return; const updated = await api(`/items/${item.id}/thumbnail`, { method: 'DELETE' }); renderDetail(m, updated, setDirty); await refreshLibrary(); }), 'ghost small'));
  const aiButton = btn('Suggest topics with local AI', 'sparkles', event => busy(event.currentTarget, async () => { const result = await api('/ai/jobs', { method: 'POST', body: { ids: [item.id] } }); toast(`${result.queued} classification job queued. Check activity, then reopen this save to review.`); }), 'small');
  if (!state.settings.ai_enabled) { aiButton.disabled = true; aiButton.title = 'Configure a local Ollama model on your server to enable suggestions.'; }
  tools.append(h('div', { class: 'mt-12' }, aiButton), h('p', { class: 'field-help mt-12' }, IS_DEMO ? 'This isolated demo does not upload files or run AI. Install your own instance to use these features.' : state.settings.ai_enabled ? 'AI works from available text. A video cover is not a full video analysis.' : 'Optional local AI is not configured. Your library works without it.'));
  m.body.append(tools);
  const evidence = h('details', { class: 'detail-section' }, h('summary', {}, 'Source text & evidence'));
  if (item.caption) evidence.append(h('div', { class: 'evidence' }, h('span', { class: 'evidence-label' }, 'Caption'), h('p', { dir: 'auto' }, item.caption)));
  for (const ev of item.evidence || []) { if (ev.kind === 'caption' && ev.text === item.caption) continue; evidence.append(h('div', { class: 'evidence' }, h('span', { class: 'evidence-label' }, String(ev.kind).replaceAll('_', ' ')), h('p', { dir: 'auto' }, ev.text))); }
  if (!item.caption && !(item.evidence || []).length) evidence.append(h('p', { class: 'field-help mt-12' }, 'This save currently has link-only evidence. Add your own notes or import more source text.'));
  m.body.append(evidence, h('dl', { class: 'detail-meta detail-section' }, h('div', {}, h('dt', {}, 'Added to archive'), h('dd', {}, formatDate(item.created_at))), h('div', {}, h('dt', {}, 'Saved on source'), h('dd', {}, formatDate(item.saved_at))), h('div', {}, h('dt', {}, 'Last observed'), h('dd', {}, formatDate(item.last_seen_at))), h('div', {}, h('dt', {}, 'Content type'), h('dd', {}, item.content_type || 'link'))));
  m.body.append(h('section', { class: 'detail-section' }, h('h3', {}, 'Keep reviewing'), h('p', { class: 'field-help' }, 'Move through every save needing review in this scope, including unloaded pages.'), btn(item.needs_review ? 'Mark reviewed & next' : 'Next save to review', 'arrow', event => busy(event.currentTarget, async () => {
    if (!m.confirmDiscard()) return;
    if (item.needs_review) await api(`/items/${item.id}`, { method: 'PATCH', body: { needs_review: false } });
    setDirty(false); m.close(); await refreshLibrary(); await openReview(m.reviewFilters);
  }), 'soft')));
  m.body.append(btn('Delete from this archive', 'trash', () => confirmAction('Delete this saved item?', 'Its local notes, topics, and memberships will be deleted. Your save on the original platform is unaffected.', async () => { await api(`/items/${item.id}`, { method: 'DELETE' }); setDirty(false); m.close(); await refreshLibrary(); toast('Item deleted from your archive.'); }, true), 'ghost danger small'));
}

function openImport() {
  let importing = false;
  const m = modal('Bring your saves home', { canClose: () => { if (importing) toast('Please wait for this import to finish.'); return !importing; } });
  if (IS_DEMO) {
    m.body.append(h('div', { class: 'notice' }, h('strong', {}, 'You are exploring synthetic content.'), h('p', {}, 'Real file imports and browser connections are available in a self-hosted instance. This public demo has no backend, account, or social connection and does not read your files.')), h('h3', {}, 'What you can explore here'), h('p', { class: 'dialog-description' }, 'Try searching, filtering, editing notes, favoriting saves, and making collections. You can also add a link as an in-memory demo record. Everything resets when you reload.'));
    m.addFooter(btn('Save a demo link', 'plus', () => { m.close(); openAdd(); }, 'soft'), btn('Keep exploring', 'arrow', m.close, 'primary'));
    return;
  }
  const input = h('input', { type: 'file', accept: '.json,.csv,.html,.htm,.zip,.txt', required: true, 'aria-label': 'Choose an export file' });
  const result = h('div', { hidden: true });
  const form = h('form', {}, h('p', { class: 'dialog-description' }, 'Import an account export, bookmarks, or a previous Little Archive export. Files are processed by your own server.'), h('div', { class: 'upload-box' }, icon('upload'), h('h3', {}, 'A fresh start for your saved things'), h('p', {}, 'JSON, CSV, bookmarks HTML, or ZIP · up to 16 MiB'), input), h('p', { class: 'field-help mt-12' }, 'Supported archive sections are read selectively. Missing collections or unavailable media are reported, not invented.'));
  const error = formError(form);
  const submit = h('button', { class: 'btn primary mt-12', type: 'submit' }, icon('upload'), 'Import file');
  const progress = h('div', { class: 'import-progress', role: 'status', hidden: true }, h('progress', { 'aria-label': 'Import progress' }), h('p', {}, 'Uploading and processing your file. Keep this window open until your results are ready.'));
  form.append(submit, progress, result);
  form.addEventListener('submit', async event => {
    event.preventDefault(); error.clear(); const file = input.files?.[0]; if (!file) return;
    importing = true; submit.disabled = true; input.disabled = true; result.hidden = true; progress.hidden = false;
    submit.replaceChildren(icon('upload'), 'Importing…');
    try {
      if (file.size > 16 * 1024 * 1024) throw new Error('This file exceeds 16 MiB. Use a smaller export or split it into supported saved-content sections.');
      const data = await api(`/imports/file?filename=${encodeURIComponent(file.name)}`, { method: 'POST', body: file, raw: true, headers: { 'Content-Type': 'application/octet-stream' } });
      result.className = 'import-result'; result.replaceChildren(h('h3', {}, 'Your import is ready'), h('p', {}, `${data.created} new · ${data.updated} updated · ${data.skipped} skipped`), h('p', {}, data.coverage === 'enumeration_exhausted' ? 'The supplied file was processed. This does not establish a complete platform archive.' : 'Coverage is partial. Your existing saves have been preserved.'), (data.errors || []).length ? h('details', {}, h('summary', {}, `${data.errors.length} import notes`), h('ul', {}, data.errors.slice(0, 30).map(x => h('li', {}, String(x))))) : null);
      result.append(btn('Organize your library', 'sparkles', () => { m.close(); openOrganize(); }, 'soft small'));
      result.hidden = false; await refreshLibrary(); toast(`${countLabel(data.created, 'new save')} added.`);
    } catch (e) { error.show(e); } finally { importing = false; submit.disabled = false; input.disabled = false; progress.hidden = true; submit.replaceChildren(icon('upload'), 'Import file'); }
  });
  m.body.append(form, h('section', { class: 'setting-section' }, h('h3', {}, 'Import from your browser'), h('p', {}, 'The companion extension can collect the saved or collection view you open on Instagram or TikTok. Browser adapters are experimental and report their observed coverage.'), btn('Set up a connection', 'link', () => { m.close(); openSettings('connections'); }, 'soft')));
}

async function downloadFile(path, fallbackName, button) {
  await busy(button, async () => {
    const response = await fetch(`/api${path}`, { credentials: 'same-origin' });
    if (!response.ok) { const data = await response.json().catch(() => ({})); throw new Error(typeof data.detail === 'string' ? data.detail : 'The download could not be prepared. Please sign in and try again.'); }
    const blob = await response.blob();
    const disposition = response.headers.get('Content-Disposition') || '';
    const filename = disposition.match(/filename="?([^";]+)"?/i)?.[1] || fallbackName;
    const url = URL.createObjectURL(blob);
    const link = h('a', { href: url, download: filename }); document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000);
    toast('Your download is ready.');
  });
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast('Copied to clipboard.'); }
  catch {
    const m = modal('Copy this text'); const box = h('textarea', { readonly: true, class: 'w-full', value: text });
    m.body.append(h('p', { class: 'dialog-description' }, 'Clipboard access is unavailable here. Select and copy the text below.'), box); box.focus(); box.select(); m.addFooter(btn('Done', null, m.close));
  }
}

function openSettings(section = '') {
  const m = modal('Make yourself at home');
  m.body.append(h('p', { class: 'dialog-description' }, 'A few preferences for your own little corner of the internet.'));
  if (IS_DEMO) m.body.append(h('div', { class: 'notice' }, h('strong', {}, 'Isolated interactive demo'), h('p', {}, 'All content and changes live in memory in this page. No account, server, credentials, imports, AI service, or external media are connected. Reloading resets the demo. Exports contain only the demo records currently in memory.')));
  const themes = h('div', { class: 'theme-options' });
  for (const [value, label, iconName] of [['light', 'Light', 'sun'], ['dark', 'Dark', 'moon'], ['system', 'System', 'monitor']]) {
    const button = btn(label, iconName, () => { applyTheme(value); for (const b of themes.children) b.setAttribute('aria-pressed', String(b.dataset.theme === value)); }, 'small');
    button.dataset.theme = value; button.setAttribute('aria-pressed', String(state.theme === value)); themes.append(button);
  }
  m.body.append(h('section', { class: 'setting-section' }, h('h3', {}, 'A light that feels right'), h('p', {}, IS_DEMO ? 'Appearance resets with the rest of the demo on reload.' : 'Appearance is remembered in this browser.'), themes));
  const previews = h('input', { type: 'checkbox', checked: state.settings.remote_previews, id: `preview-setting-${++uid}` });
  if (IS_DEMO) previews.disabled = true;
  previews.addEventListener('change', async () => {
    const desired = previews.checked;
    if (desired && !window.confirm('Enable remote previews? Your browser will contact the original media hosts and share the usual network information, such as your IP address. Local uploaded previews do not need this setting.')) { previews.checked = false; return; }
    previews.disabled = true;
    try { state.settings = await api('/settings', { method: 'PATCH', body: { remote_previews: desired } }); renderItems(); toast(desired ? 'Remote previews enabled.' : 'Remote previews disabled.'); }
    catch (e) { previews.checked = !desired; toast(errorMessage(e), true); } finally { previews.disabled = false; }
  });
  m.body.append(h('section', { class: 'setting-section' }, h('h3', {}, 'Previews & privacy'), h('div', { class: 'setting-row' }, h('label', { for: previews.id }, 'Load remote image previews'), previews), h('p', { class: 'mt-12' }, IS_DEMO ? 'External media requests are disabled in this demo. Every preview is original decorative text artwork.' : 'Off by default. When enabled, your browser contacts the original media host. Local image uploads stay with your instance.')));
  const connectionSection = h('section', { class: 'setting-section', id: 'settings-connections' }, h('h3', {}, 'Connect your browser'), h('p', {}, 'Create an import-only token, then enter it and this server address in the companion extension. Tokens can import records but cannot read your library or change your notes.'), h('div', { class: 'notice' }, h('strong', {}, 'Server address'), h('p', {}, location.origin)), h('p', {}, 'Install the extension from the extension folder in the project repository. In Chrome, open Extensions, enable Developer mode, and choose Load unpacked.'));
  const tokenName = h('input', { type: 'text', placeholder: 'e.g. My laptop', maxlength: 80, required: true });
  const tokenForm = h('form', {}, field('Connection name', tokenName));
  const tokenError = formError(tokenForm);
  const tokenCreate = h('button', { class: 'btn soft', type: 'submit' }, icon('plus'), 'Create import token');
  if (IS_DEMO) { tokenCreate.disabled = true; tokenName.disabled = true; }
  const tokenResult = h('div', { hidden: true });
  const tokens = h('div', {});
  const refreshTokens = async () => {
    const result = await api('/extension/tokens');
    tokens.replaceChildren(...(result.tokens || []).map(token => h('div', { class: 'token-row' }, h('div', {}, h('strong', {}, token.name), h('p', {}, token.last_used_at ? `Last used ${formatDate(token.last_used_at)}` : `Created ${formatDate(token.created_at)} · not used yet`)), btn('Revoke', 'x', () => confirmAction('Revoke this connection?', 'This browser connection will no longer be able to import. Existing saved items remain in your archive.', async () => { await api(`/extension/tokens/${token.id}`, { method: 'DELETE' }); await refreshTokens(); toast('Connection revoked.'); }), 'ghost small'))));
    if (!(result.tokens || []).length) tokens.append(h('p', { class: 'field-help mt-12' }, 'No browser connections yet.'));
  };
  tokenForm.append(tokenCreate, tokenResult);
  tokenForm.addEventListener('submit', async event => {
    event.preventDefault(); tokenError.clear(); tokenCreate.disabled = true;
    try {
      const result = await api('/extension/tokens', { method: 'POST', body: { name: tokenName.value.trim() } });
      tokenResult.className = 'token-result';
      const box = h('textarea', { readonly: true, value: result.token, 'aria-label': 'New import token' });
      tokenResult.replaceChildren(h('p', {}, 'Copy this token now. It is only shown once. Keep it private.'), box, btn('Copy token', 'copy', () => copyText(result.token), 'small'), btn('Hide token', 'x', () => { box.value = ''; tokenResult.replaceChildren(); tokenResult.hidden = true; }, 'ghost small'));
      tokenResult.hidden = false; tokenName.value = ''; await refreshTokens();
    } catch (e) { tokenError.show(e); } finally { tokenCreate.disabled = false; }
  });
  connectionSection.append(tokenForm, tokens);
  if (IS_DEMO) connectionSection.replaceChildren(h('h3', {}, 'Connect your browser'), h('p', {}, 'Browser connections require your own self-hosted instance. This public demo creates no credentials and cannot import from a real account.'));
  m.body.append(connectionSection);
  refreshTokens().catch(e => tokens.append(h('div', { class: 'form-error' }, errorMessage(e))));
  m.body.append(h('section', { class: 'setting-section' }, h('h3', {}, 'Optional local AI'), h('p', {}, IS_DEMO ? 'No AI runs in this demo. A self-hosted instance can use an operator-configured local Ollama model to suggest topics from available text.' : state.settings.ai_enabled ? `Configured model: ${state.settings.ai_model || 'local model'}. Suggestions are created from the available text and are yours to review.` : 'No model is configured. To enable suggestions, set your Ollama URL and model in the server environment and restart the instance.'), h('p', {}, 'A text model cannot watch a video. Imported captions, titles, and image alternative text remain distinct evidence.'), btn('View classification jobs', 'activity', () => { m.close(); openActivity('ai'); }, 'small')));
  const exports = h('section', { class: 'setting-section' }, h('h3', {}, 'Your data, ready to go'), h('p', {}, 'JSON preserves your organization and notes. CSV is useful for spreadsheets; HTML works with bookmark managers.'), h('div', { class: 'flex-wrap' }, ...[['json', 'JSON'], ['csv', 'CSV'], ['html', 'Bookmarks HTML']].map(([format, label]) => btn(label, 'download', event => downloadFile(`/export?format=${format}`, `little-archive.${format}`, event.currentTarget), 'small'))), h('div', { class: 'mt-12' }, btn('Download full backup', 'archive', event => downloadFile('/backup', 'little-archive-backup.zip', event.currentTarget))), h('p', { class: 'mt-12' }, 'Backups include a database snapshot and local assets. Restore with the offline server command so pending work and library identity can be handled safely.'));
  if (IS_DEMO) {
    exports.children[1].textContent = 'These downloads contain the synthetic demo records and any in-memory edits you made. They are not a backup of a real account.';
    const backupButton = exports.querySelector('.mt-12 button');
    backupButton.disabled = true; backupButton.title = 'Full backups require a self-hosted server.';
    exports.lastChild.textContent = 'A full database-and-assets backup is available in your own instance. This public demo has no database or server to back up.';
  }
  m.body.append(exports, h('section', { class: 'setting-section' }, h('h3', {}, 'Take a little look around'), h('p', {}, 'Add clearly labeled synthetic demo saves to explore the interface. This does not connect a real social account.'), btn('Add demo collection', 'sparkles', event => addDemo(event.currentTarget), 'small')));
  m.body.append(h('section', { class: 'setting-section' }, h('h3', {}, 'Little Archive'), h('p', {}, 'Development toward 1.0 · Open source under the MIT license. Check import activity for observed coverage.'), IS_DEMO ? btn('Reset demo', 'arrow', () => location.reload(), 'ghost') : btn('Sign out', 'logout', event => busy(event.currentTarget, async () => { await api('/auth/logout', { method: 'POST' }); m.close(); state.authenticated = false; state.csrf = ''; state.items = []; renderLogin(); }), 'ghost')));
  m.addFooter(btn('Done', 'check', m.close, 'primary'));
  if (section === 'connections') setTimeout(() => connectionSection.scrollIntoView({ block: 'start', behavior: 'smooth' }), 50);
}

function addDemo(button) {
  return busy(button, async () => { const result = await api('/demo', { method: 'POST' }); await refreshLibrary(); toast(result.created ? `${result.created} synthetic demo saves added. Enjoy exploring.` : 'Your demo saves are already here.'); });
}

function openActivity(initial = 'imports') {
  const m = modal('A little activity', { onClose: () => { if (state.authenticated) refreshLibrary().catch(error => toast(errorMessage(error), true)); } });
  let active = initial === 'ai' ? 'ai' : 'imports';
  let offset = 0;
  let timer;
  let refreshSequence = 0;
  const tabs = h('div', { class: 'activity-tabs' });
  const content = h('div', {});
  const refresh = async () => {
    const refreshId = ++refreshSequence;
    const kind = active;
    clearTimeout(timer); content.setAttribute('aria-busy', 'true');
    try {
      const result = await api(kind === 'ai' ? `/ai/jobs?limit=25&offset=${offset}` : '/imports');
      if (!m.dialog.open || refreshId !== refreshSequence || kind !== active) return;
      const rows = kind === 'ai' ? result.jobs || [] : result.imports || [];
      content.replaceChildren();
      let running = false;
      if (kind === 'ai') {
        const counts = result.counts || { queued: 0, running: 0, completed: 0, failed: 0, cancelled: 0 };
        const total = Number(result.total) || 0;
        running = counts.queued + counts.running > 0;
        const summary = h('section', { class: 'job-summary', 'aria-label': 'Classification progress', role: 'status' }, h('h3', {}, 'All classification jobs'), h('div', { class: 'job-counts' }, ...[['queued', 'Queued'], ['running', 'Running'], ['completed', 'Completed'], ['failed', 'Failed'], ['cancelled', 'Cancelled']].map(([key, label]) => h('span', {}, h('strong', {}, String(counts[key] || 0)), label))));
        if (total) summary.append(h('progress', { max: total, value: counts.completed + counts.failed + counts.cancelled, 'aria-label': 'Classification jobs finished' }), h('p', { class: 'field-help' }, `${total} jobs in total. ${running ? 'Progress refreshes automatically.' : 'No jobs are running.'}`));
        if (running) summary.append(btn('Cancel pending jobs', 'x', () => confirmAction('Cancel pending classification?', 'Queued and running jobs will be cancelled. Existing saves and accepted topics stay in your library. Cancelled jobs can be retried.', async () => { const result = await api('/ai/jobs/cancel', { method: 'POST' }); toast(`${result.cancelled} jobs cancelled.`); await refresh(); }), 'ghost small'));
        summary.append(btn('Review your saves', 'checkcircle', event => busy(event.currentTarget, async () => { m.close(); await openReview(); }), 'soft small'));
        content.append(summary);
      } else {
        running = rows.some(row => row.status === 'running');
        content.append(h('p', { class: 'field-help' }, running ? 'An import is running. Counts refresh automatically as batches arrive.' : 'Showing the most recent imports. Coverage describes only the supplied file or observed source view.'));
      }
      if (!rows.length) content.append(h('p', { class: 'dialog-description' }, kind === 'ai' ? 'No classification jobs yet. Use Organize to queue your library or a filtered view.' : 'No imports yet. Bring in an export file or use the companion extension.'));
      for (const row of rows) {
        const top = h('div', { class: 'activity-top' }, h('strong', { dir: 'auto' }, kind === 'ai' ? row.title || 'Local classification' : `${PLATFORM_NAMES[row.source] || row.source || 'File'} import`), h('span', { class: `status-pill ${row.status}` }, row.status || 'unknown'));
        const item = h('article', { class: 'activity-row' }, top, h('p', {}, formatDate(row.started_at || row.created_at)));
        if (kind === 'ai') {
          if (row.error) item.append(h('p', { class: 'form-error' }, row.error));
          const actions = h('div', { class: 'flex-wrap' });
          if (row.item_id) actions.append(btn('Open save', 'arrow', () => { m.close(); openDetail(row.item_id); }, 'ghost small'));
          if (['failed', 'cancelled'].includes(row.status)) {
            const retry = btn('Retry with current text', 'arrow', event => busy(event.currentTarget, async () => { const result = await api(`/ai/jobs/${row.id}/retry`, { method: 'POST' }); toast(result.queued ? 'Fresh suggestions queued.' : 'A matching job is already current.'); await refresh(); }), 'soft small');
            retry.disabled = IS_DEMO || !state.settings.ai_enabled; actions.append(retry);
          }
          item.append(actions);
        } else {
          item.append(h('p', {}, `${row.created || 0} new · ${row.updated || 0} updated · ${row.skipped || 0} skipped`), h('p', {}, `Coverage: ${String(row.coverage || 'partial').replaceAll('_', ' ')}`));
          if (row.source_account && row.source_account !== 'default') item.append(h('p', { dir: 'auto' }, `Source account: ${row.source_account}`));
          if (row.error) item.append(h('p', { class: 'form-error' }, row.error));
        }
        content.append(item);
      }
      if (kind === 'ai' && result.total > 25) {
        const previous = btn('Previous jobs', 'arrow', () => { offset = Math.max(0, offset - 25); refresh(); }, 'small'); previous.disabled = offset === 0;
        const next = btn('Next jobs', 'arrow', () => { offset += 25; refresh(); }, 'small'); next.disabled = offset + rows.length >= result.total;
        content.append(h('div', { class: 'activity-pagination' }, h('p', { class: 'field-help' }, `${offset + 1}–${offset + rows.length} of ${result.total} jobs`), h('div', { class: 'flex-wrap' }, previous, next)));
      }
      if (running) timer = setTimeout(refresh, 3000);
    } catch (e) { if (refreshId === refreshSequence) content.replaceChildren(h('div', { class: 'form-error', role: 'alert' }, errorMessage(e))); }
    finally { if (refreshId === refreshSequence) content.removeAttribute('aria-busy'); }
  };
  const renderTabs = () => {
    tabs.replaceChildren(...[['imports', 'Imports', 'upload'], ['ai', 'AI jobs', 'sparkles']].map(([value, label, name]) => {
      const button = btn(label, name, () => { active = value; offset = 0; clearTimeout(timer); renderTabs(); refresh(); }, active === value ? 'soft small' : 'ghost small'); button.setAttribute('aria-pressed', String(active === value)); return button;
    }));
  };
  renderTabs(); m.body.append(h('p', { class: 'dialog-description' }, 'See what arrived, what changed, and anything that needs another look.'), tabs, content);
  if (IS_DEMO) m.body.prepend(h('div', { class: 'notice' }, 'This public demo does not run real imports or AI jobs. These activity lists are empty by design.'));
  m.addFooter(btn('Refresh', 'activity', event => busy(event.currentTarget, refresh)), btn('Done', 'check', m.close, 'primary'));
  m.dialog.addEventListener('close', () => { clearTimeout(timer); refreshSequence++; }, { once: true }); refresh();
}

document.addEventListener('keydown', event => {
  if ((event.metaKey || event.ctrlKey) && ['k', 'f'].includes(event.key.toLowerCase()) && state.authenticated && !document.querySelector('dialog[open]')) {
    event.preventDefault(); dom.search?.focus(); dom.search?.select();
  }
  if (event.key === 'Escape') { dom.shell?.classList.remove('menu-open'); dom.menu?.setAttribute('aria-expanded', 'false'); }
});

async function boot() {
  try {
    const result = await api('/auth/me'); state.authenticated = result.authenticated; state.csrf = result.csrf_token || '';
    if (state.authenticated) await initializeLibrary(); else renderLogin();
  } catch (error) {
    app.replaceChildren(h('main', { class: 'boot-screen', id: 'main' }, h('img', { src: ICON_URL, width: 48, height: 48, alt: '' }), h('h1', {}, 'Your archive is taking a moment.'), h('p', {}, errorMessage(error)), btn('Try again', 'arrow', boot, 'primary')));
  }
}

boot();
