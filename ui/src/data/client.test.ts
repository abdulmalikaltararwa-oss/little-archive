import { describe, expect, it, vi } from 'vitest';
import type { Backend } from './backend';
import { ApiError, createClient, isLocked, UNREACHABLE } from './client';

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

function setup(answer: (path: string, init: RequestInit) => Response | Promise<Response>, { csrf = true, authenticated = true } = {}) {
  const calls: { path: string; init: RequestInit }[] = [];
  const backend = {
    kind: 'browser', csrf,
    fetch: vi.fn(async (path: string, init: RequestInit = {}) => { calls.push({ path, init }); return answer(path, init); }),
  } as unknown as Backend;
  const onUnauthorized = vi.fn();
  const client = createClient(backend, { isAuthenticated: () => authenticated, onUnauthorized });
  const headers = (index = 0) => calls[index]!.init.headers as Record<string, string>;
  return { client, calls, headers, onUnauthorized };
}

describe('the client', () => {
  it('sends JSON under /api and returns the parsed answer', async () => {
    const { client, calls, headers } = setup(() => json({ ok: true }));
    await expect(client.request('/items', { method: 'POST', body: { url: 'https://example.com' } })).resolves.toEqual({ ok: true });
    expect(calls[0]!.path).toBe('/api/items');
    expect(calls[0]!.init.body).toBe('{"url":"https://example.com"}');
    expect(headers()).toMatchObject({ Accept: 'application/json', 'Content-Type': 'application/json' });
  });

  it('adds the CSRF token to writes only, and only where the backend uses a cookie', async () => {
    const cookie = setup(() => json({}));
    cookie.client.setCsrf('token-1');
    await cookie.client.request('/stats');
    await cookie.client.request('/items/1', { method: 'PATCH', body: {} });
    expect(cookie.headers(0)['X-CSRF-Token']).toBeUndefined();
    expect(cookie.headers(1)['X-CSRF-Token']).toBe('token-1');

    const bearer = setup(() => json({}), { csrf: false });
    bearer.client.setCsrf('token-1');
    await bearer.client.request('/items/1', { method: 'PATCH', body: {} });
    expect(bearer.headers(0)['X-CSRF-Token']).toBeUndefined();
  });

  it('sends a raw body untouched', async () => {
    const { client, calls, headers } = setup(() => json({}));
    const file = new Blob(['zip']);
    await client.request('/imports/file?filename=a.zip', { method: 'POST', body: file, raw: true, headers: { 'Content-Type': 'application/octet-stream' } });
    expect(calls[0]!.init.body).toBe(file);
    expect(headers()['Content-Type']).toBe('application/octet-stream');
  });

  it('turns every failure into a sentence', async () => {
    await expect(setup(() => json({ detail: 'Use a complete link.' }, 400)).client.request('/x')).rejects.toThrow('Use a complete link.');
    await expect(setup(() => json({ detail: [{ msg: 'Field required' }, {}] }, 422)).client.request('/x')).rejects.toThrow('Field required. Invalid field');
    await expect(setup(() => new Response('<html>', { status: 502 })).client.request('/x')).rejects.toThrow('Request failed (502). Please try again.');
    await expect(setup(() => { throw new TypeError('failed to fetch'); }).client.request('/x')).rejects.toThrow(UNREACHABLE);
  });

  it('lets a cancelled request stay cancelled', async () => {
    const { client } = setup(() => { throw new DOMException('aborted', 'AbortError'); });
    await expect(client.request('/x')).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('keeps the stable code, the extra fields and how long to wait', async () => {
    const { client } = setup(() => json({ detail: 'Today’s suggestions are used.', code: 'suggestions_daily_limit', limit: { used: 20, limit: 20 } }, 429, { 'Retry-After': '120' }));
    const error: ApiError = await client.request('/ai/jobs', { method: 'POST', body: {} }).then(() => { throw new Error('expected a refusal'); }, caught => caught as ApiError);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 429, code: 'suggestions_daily_limit', extra: { limit: { used: 20, limit: 20 }, retry_after: 120 } });
    expect(error.extra).not.toHaveProperty('detail');
  });

  it('turns the server’s "AI sharing is not allowed" into the question, then makes the request once more', async () => {
    const refusal = () => json({ detail: 'Sending saves to an AI service has not been allowed for this library.', code: 'ai_permission_required' }, 403);
    const client = (answers: Response[], allowed: boolean) => {
      const ask = vi.fn(async () => allowed);
      const fetch = vi.fn(async () => answers.shift()!);
      const backend = { kind: 'browser', csrf: false, fetch } as unknown as Backend;
      return { ask, fetch, client: createClient(backend, { isAuthenticated: () => true, onUnauthorized: vi.fn(), onAiPermissionRequired: ask }) };
    };

    const yes = client([refusal(), json({ queued: 1 })], true);
    await expect(yes.client.request('/ai/jobs', { method: 'POST', body: { ids: ['a'] } })).resolves.toEqual({ queued: 1 });
    expect(yes.ask).toHaveBeenCalledTimes(1);
    expect(yes.fetch).toHaveBeenCalledTimes(2);

    // "Not now": nothing more is requested, and the server's own sentence is what is shown.
    const no = client([refusal(), json({ queued: 1 })], false);
    await expect(no.client.request('/ask', { method: 'POST', body: {} })).rejects.toMatchObject({ status: 403, code: 'ai_permission_required', message: 'Sending saves to an AI service has not been allowed for this library.' });
    expect(no.fetch).toHaveBeenCalledTimes(1);

    // A server that still refuses after a yes is asked once, never in a loop.
    const stuck = client([refusal(), refusal(), json({})], true);
    await expect(stuck.client.request('/ask', { method: 'POST', body: {} })).rejects.toMatchObject({ code: 'ai_permission_required' });
    expect(stuck.ask).toHaveBeenCalledTimes(1);
    expect(stuck.fetch).toHaveBeenCalledTimes(2);

    // Without the hook the refusal is passed on as it is, and another refusal never asks.
    const { client: plain, calls } = setup(refusal);
    await expect(plain.request('/ask', { method: 'POST', body: {} })).rejects.toMatchObject({ code: 'ai_permission_required' });
    expect(calls).toHaveLength(1);
    const other = client([json({ detail: 'Part of the unlock.', code: 'unlock_required' }, 402)], true);
    await expect(other.client.request('/ask', { method: 'POST', body: {} })).rejects.toMatchObject({ code: 'unlock_required' });
    expect(other.ask).not.toHaveBeenCalled();
  });

  it('recognises the locked answer by status and code together', async () => {
    const locked = await setup(() => json({ detail: 'Part of the unlock.', code: 'unlock_required', feature: 'ask' }, 402)).client.request('/ask').catch(caught => caught);
    expect(isLocked(locked)).toBe(true);
    expect(isLocked(new ApiError('x', 402))).toBe(false);
    expect(isLocked(new Error('x'))).toBe(false);
  });

  it('reports a refused credential once signed in, with the server’s sentence, but not a wrong password', async () => {
    const signedIn = setup(() => json({ detail: 'This device token has expired.' }, 401));
    await expect(signedIn.client.request('/stats')).rejects.toThrow();
    expect(signedIn.onUnauthorized).toHaveBeenCalledWith('This device token has expired.');

    const login = setup(() => json({ detail: 'Wrong password.' }, 401));
    await expect(login.client.request('/auth/login', { method: 'POST', body: {} })).rejects.toThrow('Wrong password.');
    expect(login.onUnauthorized).not.toHaveBeenCalled();

    const signedOut = setup(() => json({}, 401), { authenticated: false });
    await expect(signedOut.client.request('/stats')).rejects.toThrow();
    expect(signedOut.onUnauthorized).not.toHaveBeenCalled();
  });

  it('names a download from the server’s header, or falls back', async () => {
    const named = setup(() => new Response('{}', { headers: { 'Content-Disposition': 'attachment; filename="little-archive-2026.json"' } }));
    expect((await named.client.download('/export?format=json', 'fallback.json')).filename).toBe('little-archive-2026.json');
    const plain = setup(() => new Response('{}'));
    expect((await plain.client.download('/export?format=json', 'fallback.json')).filename).toBe('fallback.json');
    await expect(setup(() => json({ detail: 'Sign in first.' }, 401)).client.download('/backup', 'b.zip')).rejects.toThrow('Sign in first.');
  });
});
