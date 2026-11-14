import { describe, expect, it, vi } from 'vitest';
import type { Archive } from '@/data/archive';
import { ApiError } from '@/data/client';
import type { AskResponse } from './api';
import { answered, nothingSaved } from './fixtures';
import { createAskSession } from './session';

interface Call {
  path: string;
  body: Record<string, unknown>;
  signal: AbortSignal | undefined;
  resolve(value: AskResponse): void;
  reject(error: unknown): void;
}

/** A library whose server answers only when the test says so, so the order of events is the test's. */
function setup() {
  const calls: Call[] = [];
  const request = vi.fn((path: string, options: { body?: unknown; signal?: AbortSignal } = {}) => new Promise<AskResponse>((resolve, reject) => {
    options.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    calls.push({ path, body: options.body as Record<string, unknown>, signal: options.signal, resolve, reject });
  }));
  const session = createAskSession({ api: { request } } as unknown as Pick<Archive, 'api'>);
  const type = (text: string) => session.dispatch({ type: 'drafted', text });
  const settled = () => new Promise(resolve => setTimeout(resolve, 0));
  return { session, calls, request, type, settled };
}

describe('asking', () => {
  it('sends exactly the question and what is narrowed, to POST /api/ask', async () => {
    const { session, calls, type, settled } = setup();
    type('  What did I save about pasta?  ');
    session.dispatch({ type: 'narrowed', filters: { tag: 'pasta' } });
    expect(session.submit()).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe('/ask');
    expect(calls[0]!.body).toEqual({ question: 'What did I save about pasta?', tag: 'pasta' });
    expect(session.getState().entries[0]!.state.status).toBe('pending');
    calls[0]!.resolve(answered());
    await settled();
    expect(session.getState().entries[0]!.state).toMatchObject({ status: 'done' });
    expect(session.getState().activeId).toBe(session.getState().entries[0]!.id);
  });

  it('does not send a question the server would refuse', () => {
    const { session, calls, type } = setup();
    type('hi');
    expect(session.submit()).toBe(false);
    type('???');
    expect(session.submit()).toBe(false);
    type('a'.repeat(501));
    expect(session.submit()).toBe(false);
    expect(calls).toHaveLength(0);
    expect(session.getState().entries).toEqual([]);
  });

  it('cancels the old request when another question is asked, and never shows its answer', async () => {
    const { session, calls, type, settled } = setup();
    type('lemon pasta');
    session.submit();
    type('roses in spring');
    session.submit();
    expect(calls).toHaveLength(2);
    expect(calls[0]!.signal?.aborted).toBe(true);
    expect(calls[1]!.signal?.aborted).toBe(false);
    // The old one answers anyway, as a slow server might.
    calls[0]!.resolve(answered());
    calls[1]!.resolve(nothingSaved());
    await settled();
    const { entries } = session.getState();
    expect(entries.map(entry => entry.question)).toEqual(['roses in spring']);
    expect(entries[0]!.state).toMatchObject({ status: 'done', response: { mode: 'no_results' } });
  });

  it('stops a waiting question on request, and keeps what was typed', async () => {
    const { session, calls, type, settled } = setup();
    type('lemon pasta');
    session.submit();
    session.stop();
    await settled();
    expect(calls[0]!.signal?.aborted).toBe(true);
    expect(session.getState().entries).toEqual([]);
    expect(session.getState().draft).toBe('lemon pasta');
  });

  it('reports a real failure as an error on that question, with a way to try again', async () => {
    const { session, calls, type, settled } = setup();
    type('lemon pasta');
    session.submit();
    calls[0]!.reject(new ApiError('Could not reach your archive. Check that the server is running and try again.', 0));
    await settled();
    const [entry] = session.getState().entries;
    expect(entry!.state).toEqual({ status: 'error', message: 'Could not reach your archive. Check that the server is running and try again.', httpStatus: 0 });

    session.retry(entry!.id);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.body).toEqual({ question: 'lemon pasta' });
    expect(session.getState().entries[0]!.state.status).toBe('pending');
    calls[1]!.resolve(answered());
    await settled();
    expect(session.getState().entries[0]!.state.status).toBe('done');
  });

  it('keeps the status of a refused request (422, 503) for the error card', async () => {
    const { session, calls, type, settled } = setup();
    type('lemon pasta');
    session.submit();
    calls[0]!.reject(new ApiError('Ask a question in words.', 422));
    await settled();
    expect(session.getState().entries[0]!.state).toMatchObject({ status: 'error', httpStatus: 422 });
  });

  it('turns a 402 unlock_required into the locked answer, not an error', async () => {
    const { session, calls, type, settled } = setup();
    type('lemon pasta');
    session.submit();
    calls[0]!.reject(new ApiError('This comes with the full unlock.', 402, 'unlock_required', { feature: 'ask' }));
    await settled();
    expect(session.getState().entries[0]!.state).toEqual({ status: 'locked' });
    // A 402 with another code is just an error.
    type('another question');
    session.submit();
    calls[1]!.reject(new ApiError('Payment required.', 402, 'something_else'));
    await settled();
    expect(session.getState().entries[0]!.state).toMatchObject({ status: 'error', httpStatus: 402 });
  });

  it('asks a finished question again when its provider was down, replacing the earlier answer', async () => {
    const { session, calls, type, settled } = setup();
    type('lemon pasta');
    session.submit();
    calls[0]!.resolve(answered({ answered: false, answer: null, reason: 'ai_failed', mode: 'ranked_only' }));
    await settled();
    const [entry] = session.getState().entries;
    session.retry(entry!.id);
    expect(session.getState().entries[0]!.state.status).toBe('pending');
    calls[1]!.resolve(answered());
    await settled();
    expect(session.getState().entries).toHaveLength(1);
    expect(session.getState().entries[0]!.state).toMatchObject({ status: 'done', response: { answered: true } });
  });

  it('keeps an answer that is still on its way when an earlier question is reopened', async () => {
    const { session, calls, type, settled } = setup();
    type('first question');
    session.submit();
    calls[0]!.resolve(answered());
    await settled();
    const first = session.getState().entries[0]!.id;
    type('second question');
    session.submit();
    session.dispatch({ type: 'opened', id: first });
    expect(session.getState().activeId).toBe(first);
    expect(session.getState().draft).toBe('first question');
    calls[1]!.resolve(nothingSaved());
    await settled();
    // The second answer lands in the list without taking the screen away from the one being read.
    expect(session.getState().activeId).toBe(first);
    expect(session.getState().entries.map(entry => entry.state.status)).toEqual(['done', 'done']);
  });

  it('forgets everything on reset: questions, the draft, the narrowing, and a request on its way', () => {
    const { session, calls, type } = setup();
    type('lemon pasta');
    session.dispatch({ type: 'narrowed', filters: { platform: 'web' } });
    session.submit();
    session.reset();
    expect(calls[0]!.signal?.aborted).toBe(true);
    expect(session.getState()).toEqual({ entries: [], activeId: '', draft: '', filters: { platform: '', collection_id: '', tag: '' } });
  });

  it('tells a subscriber when something changed, and not when nothing did', () => {
    const { session, type } = setup();
    const listener = vi.fn();
    const off = session.subscribe(listener);
    type('lemon');
    type('lemon');
    expect(listener).toHaveBeenCalledTimes(1);
    off();
    type('lemon pasta');
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
