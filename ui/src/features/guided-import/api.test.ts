import { describe, expect, it, vi } from 'vitest';
import { guidedApi } from './api';

/** A request function that records what it was asked, and answers with an empty object. */
function recorder() {
  const request = vi.fn(async (_path: string, _options?: Record<string, unknown>) => ({}));
  return { request, api: guidedApi(request as never) };
}

describe('the calls match the contract’s routes', () => {
  it('asks for the guides and the earlier imports', async () => {
    const { api, request } = recorder();
    await api.guides();
    await api.list();
    await api.list(5);
    expect(request.mock.calls.map(call => call[0])).toEqual(['/imports/guides', '/imports/archives?limit=20', '/imports/archives?limit=5']);
  });

  it('declares a file with exactly the fields the contract names', async () => {
    const { api, request } = recorder();
    await api.start({ platform: 'instagram', filename: 'export.zip', size_bytes: 123, source_account: 'me' });
    expect(request).toHaveBeenCalledWith('/imports/archives', { method: 'POST', body: { platform: 'instagram', filename: 'export.zip', size_bytes: 123, source_account: 'me' } });
  });

  it('sends a piece as raw bytes, with the piece’s checksum when it has one', async () => {
    const { api, request } = recorder();
    const bytes = new ArrayBuffer(4);
    await api.putChunk('abc', 3, bytes, { sha256: 'f'.repeat(64) });
    await api.putChunk('abc', 4, bytes);
    const [first, second] = request.mock.calls;
    expect(first![0]).toBe('/imports/archives/abc/chunks/3');
    expect(first![1]).toMatchObject({ method: 'PUT', raw: true, body: bytes, headers: { 'Content-Type': 'application/octet-stream', 'X-Chunk-SHA256': 'f'.repeat(64) } });
    expect(second![1]?.headers).toEqual({ 'Content-Type': 'application/octet-stream' });
  });

  it('walks one import through its states with the contract’s verbs', async () => {
    const { api, request } = recorder();
    await api.get('abc');
    await api.finish('abc');
    await api.preview('abc');
    await api.cancel('abc');
    expect(request.mock.calls.map(call => [call[1]?.method ?? 'GET', call[0]])).toEqual([
      ['GET', '/imports/archives/abc'],
      ['POST', '/imports/archives/abc/finish'],
      ['GET', '/imports/archives/abc/preview'],
      ['DELETE', '/imports/archives/abc'],
    ]);
  });

  it('confirms with the preview’s digest, and continues with none', async () => {
    const { api, request } = recorder();
    await api.commit('abc', 'd'.repeat(64));
    await api.commit('abc');
    const calls = request.mock.calls;
    expect(calls[0]![1]?.body).toEqual({ digest: 'd'.repeat(64) });
    expect(calls[1]![1]?.body).toEqual({});
  });

  it('keeps an import’s address safe whatever its id says', async () => {
    const { api, request } = recorder();
    await api.get('../x?y=1');
    expect(request.mock.calls[0]![0]).toBe('/imports/archives/..%2Fx%3Fy%3D1');
  });
});
