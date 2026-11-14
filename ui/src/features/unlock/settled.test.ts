// The order a purchase is delivered in: the store hands over a proof, the server answers, and only then is the
// store told. These tests use a store that records what it was told, and a server that answers as scripted.
import { describe, expect, it, vi } from 'vitest';
import type { PurchaseAnswer, PurchaseBridge } from '@/data/backend';
import { ApiError } from '@/data/client';
import type { PurchaseResult, StoreProof } from '@/data/types';
import { buy, restore, settle } from './purchase';

const apple: StoreProof = { provider: 'apple', signed_transaction: 'j'.repeat(40) };
const google: StoreProof = { provider: 'google', product_id: 'unlock_full', purchase_token: 'tok' };
const accepted = (provider: 'apple' | 'google', extra: Partial<PurchaseResult> = {}): PurchaseResult => ({ unlocked: true, provider, product_id: 'unlock_full', status: 'active', restored: false, ...extra });
const refusal = (status: number, code: string) => new ApiError('The server’s sentence.', status, code);

function store(proofs: { buy?: StoreProof | null | 'pending'; restore?: StoreProof[] } = {}) {
  const told: { proof: StoreProof; answer: PurchaseAnswer }[] = [];
  const bridge: PurchaseBridge = {
    provider: 'apple',
    buy: async () => proofs.buy ?? null,
    restore: async () => proofs.restore ?? [],
    settled: async (proof, answer) => { told.push({ proof, answer }); },
  };
  return { bridge, told };
}

describe('telling the store', () => {
  it('waits for the server, and tells the store it unlocked, with whether Google was already acknowledged', async () => {
    const { bridge, told } = store();
    let answered = false;
    const submit = async () => { expect(told).toEqual([]); answered = true; return accepted('google', { acknowledged: false }); };
    expect(await settle(google, submit, bridge)).toEqual({ kind: 'unlocked', restored: false });
    expect(answered).toBe(true);
    expect(told).toEqual([{ proof: google, answer: { outcome: 'unlocked', acknowledged: false } }]);
  });

  it('tells the store a proof was refused for good, so Apple does not offer it at every start', async () => {
    for (const [status, code] of [[400, 'purchase_invalid'], [400, 'purchase_wrong_environment'], [409, 'purchase_bound_elsewhere'], [409, 'purchase_revoked']] as const) {
      const { bridge, told } = store();
      const outcome = await settle(apple, async () => { throw refusal(status, code); }, bridge);
      expect(outcome.kind).toBe('refused');
      expect(told).toEqual([{ proof: apple, answer: { outcome: 'refused' } }]);
    }
  });

  it('tells the store nothing when the server could not be asked or has not decided, so the purchase stays open', async () => {
    const { bridge, told } = store();
    expect((await settle(apple, async () => { throw refusal(503, 'purchases_unavailable'); }, bridge)).kind).toBe('refused');
    expect((await settle(apple, async () => { throw new Error('Could not reach your archive.'); }, bridge)).kind).toBe('failed');
    expect((await settle(google, async () => ({ unlocked: false, provider: 'google', product_id: 'unlock_full', status: 'pending', restored: false }), bridge)).kind).toBe('pending');
    expect(told).toEqual([]);
  });

  it('keeps the unlock when the store cannot be told', async () => {
    const bridge: PurchaseBridge = { provider: 'apple', buy: async () => apple, restore: async () => [], settled: vi.fn(async () => { throw new Error('The store is busy.'); }) };
    expect(await settle(apple, async () => accepted('apple'), bridge)).toEqual({ kind: 'unlocked', restored: false });
    expect(bridge.settled).toHaveBeenCalledOnce();
  });

  it('works with a store that has no way to be told', async () => {
    expect(await settle(apple, async () => accepted('apple'), { provider: 'apple', buy: async () => null, restore: async () => [] })).toEqual({ kind: 'unlocked', restored: false });
  });
});

describe('buying and restoring through the store', () => {
  it('turns a purchase the store is holding back into waiting, and sends nothing', async () => {
    const { bridge, told } = store({ buy: 'pending' });
    const submit = vi.fn(async () => accepted('apple'));
    expect(await buy(bridge, 'user-1', submit)).toEqual({ kind: 'waiting' });
    expect(submit).not.toHaveBeenCalled();
    expect(told).toEqual([]);
  });

  it('tells the store about each proof it restores, and stops at the first one the server accepts', async () => {
    const second: StoreProof = { provider: 'apple', signed_transaction: 'k'.repeat(40) };
    const { bridge, told } = store({ restore: [apple, second] });
    const submit = vi.fn(async (proof: StoreProof) => { if (proof === apple) throw refusal(409, 'purchase_revoked'); return accepted('apple', { restored: true }); });
    expect(await restore(bridge, submit)).toEqual({ kind: 'unlocked', restored: true });
    expect(told).toEqual([{ proof: apple, answer: { outcome: 'refused' } }, { proof: second, answer: { outcome: 'unlocked', acknowledged: undefined } }]);
  });
});
