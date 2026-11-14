import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBackend, type NativeBridge } from './backend';
import { createBrowserBackend } from './backends/browser';
import { createDemoBackend } from './backends/demo';
import { createNativeBackend } from './backends/native';

const ASSET = `/api/assets/${'a'.repeat(64)}`;

function bridge(extra: Partial<NativeBridge> = {}): NativeBridge {
  return {
    platform: 'ios', mode: 'hosted', serverUrl: 'https://archive.example.com', initialShare: { url: 'https://example.com/a' },
    fetch: vi.fn(async () => new Response('{}')),
    localAsset: vi.fn((value: unknown) => (value === ASSET ? ASSET : null)),
    attachImage: vi.fn(),
    onShare: vi.fn(() => () => {}),
    saveFile: vi.fn(async () => {}),
    signedOut: vi.fn(),
    account: { email: 'owner@example.com', signOut: vi.fn(), switchServer: vi.fn() },
    ...extra,
  };
}

afterEach(() => {
  delete document.documentElement.dataset.demo;
  Reflect.deleteProperty(globalThis, '__littleArchiveNative');
});

describe('the browser backend', () => {
  it('reaches only the library API, on the page’s own origin, with the cookie', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}'));
    const backend = createBrowserBackend({ fetchImpl, origin: 'https://archive.example.com' });
    await backend.fetch('/api/stats', { method: 'GET' });
    expect(fetchImpl).toHaveBeenCalledWith('/api/stats', { method: 'GET', credentials: 'same-origin' });
    await expect(backend.fetch('https://evil.example/api/stats')).rejects.toThrow('Only the library API');
    await expect(backend.fetch('//evil.example/api/')).rejects.toThrow();
    expect(backend).toMatchObject({ kind: 'browser', csrf: true, passwordLogin: true, serverUrl: 'https://archive.example.com', purchases: null });
  });

  it('shows a stored thumbnail only from its own origin', () => {
    const backend = createBrowserBackend({ fetchImpl: vi.fn(), origin: location.origin });
    expect(backend.thumbnail(ASSET)).toEqual({ type: 'url', src: `${location.origin}${ASSET}` });
    expect(backend.thumbnail('https://cdn.example.com/a.png')).toBeNull();
    expect(backend.thumbnail('javascript:alert(1)')).toBeNull();
    expect(backend.thumbnail(null)).toBeNull();
  });
});

describe('the native backend', () => {
  it('sends requests through the app’s transport and never holds a credential', async () => {
    const native = bridge();
    const backend = createNativeBackend(native);
    await backend.fetch('/api/stats', { method: 'GET' });
    expect(native.fetch).toHaveBeenCalledWith('/api/stats', { method: 'GET' });
    expect(backend).toMatchObject({ kind: 'native', mode: 'hosted', csrf: false, passwordLogin: false, serverUrl: 'https://archive.example.com', initialShare: { url: 'https://example.com/a' } });
    expect(JSON.stringify(backend)).not.toMatch(/token|bearer/i);
  });

  it('attaches a thumbnail to its image instead of giving it an address', () => {
    const native = bridge();
    const backend = createNativeBackend(native);
    const source = backend.thumbnail(ASSET);
    expect(source?.type).toBe('attach');
    const image = document.createElement('img');
    if (source?.type === 'attach') source.attach(image);
    expect(native.attachImage).toHaveBeenCalledWith(image, ASSET);
    expect(backend.thumbnail('https://elsewhere.example/a.png')).toBeNull();
  });

  it('hands a refused credential, a download and the share inbox to the app', async () => {
    const native = bridge();
    const backend = createNativeBackend(native);
    expect(backend.signedOut('Your sign-in ended.')).toBe(true);
    expect(native.signedOut).toHaveBeenCalledWith('Your sign-in ended.');
    await expect(backend.saveFile(new Blob(['x']), 'export.json')).resolves.toBe('shared');
    const listener = vi.fn();
    expect(typeof backend.onShare(listener)).toBe('function');
    expect(native.onShare).toHaveBeenCalledWith(listener);
  });

  it('has a store only when the app provides one', () => {
    expect(createNativeBackend(bridge()).purchases).toBeNull();
    const purchases = { provider: 'apple' as const, buy: vi.fn(), restore: vi.fn() };
    expect(createNativeBackend(bridge({ purchases })).purchases).toBe(purchases);
  });
});

describe('the demo backend', () => {
  it('answers from memory and remembers nothing', async () => {
    const real = vi.spyOn(globalThis, 'fetch');
    const backend = createDemoBackend();
    const me = await (await backend.fetch('/api/auth/me')).json();
    expect(me).toMatchObject({ authenticated: true, demo: true });
    const list = await (await backend.fetch('/api/items?limit=5&offset=0')).json();
    expect(list.items).toHaveLength(5);
    expect(list.total).toBeGreaterThan(5);
    expect(real).not.toHaveBeenCalled();
    expect(backend).toMatchObject({ kind: 'demo', remembers: false, real: false, passwordLogin: false, purchases: null });
    real.mockRestore();
  });

  it('refuses anything that is not the library API, and a cancelled request', async () => {
    const backend = createDemoBackend({ fixtures: [] });
    await expect(backend.fetch('https://example.com/')).rejects.toThrow('disabled in this isolated demo');
    const controller = new AbortController();
    controller.abort();
    await expect(backend.fetch('/api/stats', { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('says plainly what it cannot do', async () => {
    const backend = createDemoBackend({ fixtures: [] });
    expect((await backend.fetch('/api/backup')).status).toBe(501);
    expect((await backend.fetch('/api/features')).status).toBe(404);
  });
});

describe('choosing a backend', () => {
  it('uses the browser backend on an ordinary page', async () => {
    expect((await createBackend()).kind).toBe('browser');
  });

  it('uses the app’s bridge when the shell has set one', async () => {
    Object.defineProperty(globalThis, '__littleArchiveNative', { value: bridge(), configurable: true });
    expect((await createBackend()).kind).toBe('native');
  });

  it('uses the demo on the demo page, and there never looks at a bridge', async () => {
    document.documentElement.dataset.demo = 'true';
    Object.defineProperty(globalThis, '__littleArchiveNative', { value: bridge(), configurable: true });
    expect((await createBackend()).kind).toBe('demo');
  });
});
