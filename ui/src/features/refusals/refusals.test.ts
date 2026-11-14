import { describe, expect, it } from 'vitest';
import { ApiError } from '@/data/client';
import { deletionWords } from '../dialogs/words';
import { buy, restore, settle, unlockView } from '../unlock/purchase';
import { describeRefusal, isRefusal, monthEnd, skippedWhy, whenText } from './refusals';

const refused = (status: number, code: string, extra: Record<string, unknown> = {}) => new ApiError('The server’s own sentence.', status, code, extra);

describe('a refusal', () => {
  it.each([
    [402, 'unlock_required', { feature: 'recipes' }, 'unlock', 'unlock'],
    [429, 'deep_reads_exhausted', { limit: { scope: 'monthly', period: '2026-11', used: 5, limit: 5 } }, 'allowance', 'wait'],
    [429, 'suggestions_daily_limit', { limit: { used: 20, limit: 20, resets_at: '2026-11-15T00:00:00Z' } }, 'allowance', 'wait'],
    [429, 'suggestions_monthly_limit', {}, 'allowance', 'wait'],
    [429, 'suggestions_attempts_limit', {}, 'allowance', 'wait'],
    [429, 'feature_calls_daily_limit', {}, 'allowance', 'wait'],
    [429, 'feature_calls_monthly_limit', {}, 'allowance', 'wait'],
    [429, 'feature_calls_attempts_limit', {}, 'allowance', 'wait'],
    [507, 'storage_full', {}, 'storage', 'none'],
    [429, 'rate_limited', { scope: 'account', retry_after: 12 }, 'busy', 'wait'],
    [429, 'too_many_concurrent', { retry_after: 30 }, 'busy', 'wait'],
    [429, 'auth_rate_limited', { retry_after: 600 }, 'busy', 'wait'],
    [503, 'server_busy', { retry_after: 5 }, 'busy', 'wait'],
    [503, 'purchases_unavailable', { provider: 'apple', reason: 'unavailable', retry_after: 30 }, 'purchase', 'wait'],
    [400, 'purchase_invalid', {}, 'purchase', 'none'],
    [400, 'purchase_wrong_app', {}, 'purchase', 'none'],
    [400, 'purchase_wrong_product', {}, 'purchase', 'none'],
    [400, 'purchase_wrong_environment', {}, 'purchase', 'none'],
    [409, 'purchase_bound_elsewhere', {}, 'purchase', 'none'],
    [409, 'purchase_revoked', {}, 'purchase', 'none'],
  ] as const)('%i %s is explained', (status, code, extra, kind, action) => {
    const refusal = describeRefusal(refused(status, code, extra));
    expect(refusal).toMatchObject({ code, kind, action });
    expect(refusal!.title.length).toBeGreaterThan(5);
    expect(refusal!.body.length).toBeGreaterThan(20);
  });

  it('leaves ordinary errors alone', () => {
    expect(describeRefusal(new ApiError('Not found', 404))).toBeNull();
    expect(describeRefusal(new ApiError('Nope', 409, 'bad_state'))).toBeNull();
    expect(describeRefusal(new Error('boom'))).toBeNull();
    expect(isRefusal(refused(503, 'server_busy'))).toBe(true);
  });

  it('names what the unlock opens, and carries usage and times', () => {
    expect(describeRefusal(refused(402, 'unlock_required', { feature: 'ask' }))!.body).toMatch(/Asking your archive/);
    expect(describeRefusal(refused(402, 'unlock_required', { feature: 'something_new' }))!.body).toMatch(/single payment/);
    const daily = describeRefusal(refused(429, 'suggestions_daily_limit', { limit: { used: 20, limit: 20, resets_at: '2026-11-15T00:00:00Z' } }))!;
    expect(daily.usage).toEqual({ used: 20, limit: 20 });
    expect(daily.resetsAt?.toISOString()).toBe('2026-11-15T00:00:00.000Z');
    expect(describeRefusal(refused(429, 'deep_reads_exhausted', { limit: { period: '2026-12' } }))!.resetsAt?.toISOString()).toBe('2027-01-01T00:00:00.000Z');
    expect(describeRefusal(refused(429, 'rate_limited', { retry_after: 11.2 }))!.retryAfter).toBe(12);
    expect(monthEnd('nonsense')).toBeNull();
  });

  it('says when it opens again in words', () => {
    const now = Date.UTC(2026, 10, 14, 21, 0, 0);
    expect(whenText({ resetsAt: new Date(now + 3 * 3600_000), retryAfter: null }, now, 'en-US')).toMatch(/^Opens again in 3 hours, (at|on) /);
    expect(whenText({ resetsAt: new Date(now + 40 * 60_000), retryAfter: null }, now, 'en-US')).toMatch(/in 40 minutes/);
    expect(whenText({ resetsAt: new Date(now + 5 * 86400_000), retryAfter: null }, now, 'en-US')).toMatch(/in 5 days, on /);
    expect(whenText({ resetsAt: new Date(now - 1000), retryAfter: null }, now)).toBe('It should be open again now.');
    expect(whenText({ resetsAt: null, retryAfter: 30 }, now)).toBe('Try again in 30 seconds.');
    expect(whenText({ resetsAt: null, retryAfter: null }, now)).toBe('');
  });

  it('says why part of a request was left for later', () => {
    expect(skippedWhy('daily')).toMatch(/today/);
    expect(skippedWhy('monthly')).toMatch(/month/);
    expect(skippedWhy('attempts')).toMatch(/tries/);
    expect(skippedWhy('not_included')).toMatch(/not included/);
  });
});

describe('the unlock', () => {
  it('shows the right face to each account', () => {
    expect(unlockView({ mode: 'self-hosted', unlocked: true, known: true, hasStore: false })).toBe('self-hosted');
    expect(unlockView({ mode: 'self-hosted', unlocked: null, known: false, hasStore: true })).toBe('self-hosted');
    expect(unlockView({ mode: 'hosted', unlocked: null, known: false, hasStore: true })).toBe('loading');
    expect(unlockView({ mode: 'hosted', unlocked: true, known: true, hasStore: true })).toBe('unlocked');
    expect(unlockView({ mode: 'hosted', unlocked: false, known: true, hasStore: true })).toBe('buy-here');
    expect(unlockView({ mode: 'hosted', unlocked: false, known: true, hasStore: false })).toBe('buy-in-app');
  });

  const apple = { provider: 'apple' as const, signed_transaction: 'x'.repeat(40) };
  const google = { provider: 'google' as const, product_id: 'unlock', purchase_token: 'tok' };
  const ok = async () => ({ unlocked: true, provider: 'apple' as const, product_id: 'unlock', status: 'active' as const, restored: false });

  it('unlocks only on the server’s word', async () => {
    expect(await settle(apple, ok)).toEqual({ kind: 'unlocked', restored: false });
    expect(await settle(google, async () => ({ unlocked: false, provider: 'google', product_id: 'unlock', status: 'pending', restored: false }))).toEqual({ kind: 'pending', proof: google });
    const bound = refused(409, 'purchase_bound_elsewhere');
    expect(await settle(apple, async () => { throw bound; })).toEqual({ kind: 'refused', error: bound });
    expect(await settle(apple, async () => { throw new Error('Could not reach your archive.'); })).toEqual({ kind: 'failed', message: 'Could not reach your archive.' });
  });

  it('binds a purchase to the account and treats a closed sheet as no purchase', async () => {
    const calls: unknown[] = [];
    const store = { provider: 'apple' as const, buy: async (options: { accountId: string }) => { calls.push(options); return apple; }, restore: async () => [] };
    expect(await buy(store, 'user-1', ok)).toEqual({ kind: 'unlocked', restored: false });
    expect(calls).toEqual([{ accountId: 'user-1' }]);
    expect(await buy({ ...store, buy: async () => null }, 'user-1', ok)).toEqual({ kind: 'cancelled' });
    expect(await buy({ ...store, buy: async () => { throw new Error('The store is not available.'); } }, 'user-1', ok)).toEqual({ kind: 'failed', message: 'The store is not available.' });
  });

  it('restores the first purchase the server accepts', async () => {
    const store = { provider: 'google' as const, buy: async () => null, restore: async () => [apple, google] };
    const revoked = refused(409, 'purchase_revoked');
    const submit = async (proof: typeof apple | typeof google) => {
      if (proof.provider === 'apple') throw revoked;
      return { unlocked: true, provider: 'google' as const, product_id: 'unlock', status: 'active' as const, restored: true };
    };
    expect(await restore(store, submit)).toEqual({ kind: 'unlocked', restored: true });
    expect(await restore({ ...store, restore: async () => [] }, submit)).toEqual({ kind: 'nothing-to-restore' });
    expect(await restore({ ...store, restore: async () => [apple] }, submit)).toEqual({ kind: 'refused', error: revoked });
  });
});

describe('deleting an account', () => {
  it('says which of the three things happened to the sign-in', () => {
    expect(deletionWords({ deleted: true, auth_user_deleted: true })).toMatchObject({ title: 'Your account is deleted' });
    expect(deletionWords({ deleted: true, auth_user_deleted: false, auth_deletion: 'pending', detail: 'We will finish removing your sign-in shortly.' }).body).toBe('We will finish removing your sign-in shortly.');
    expect(deletionWords({ deleted: true, auth_user_deleted: false, auth_deletion: 'pending' }).body).toMatch(/keeps trying/);
    const stays = deletionWords({ deleted: true, auth_user_deleted: false, auth_deletion: 'not_configured' });
    expect(stays.title).toBe('Your library is deleted');
    expect(stays.body).toMatch(/still registered/);
  });
});
