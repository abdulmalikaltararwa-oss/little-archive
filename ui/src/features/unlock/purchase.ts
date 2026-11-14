// The unlock, as rules. Two things are decided here and tested: which face of the unlock screen an account
// sees, and what a purchase attempt came to. The store sheet is the app's (Backend.purchases); the server
// alone decides whether an account is unlocked. Nothing in the interface can set it.
import { errorMessage } from '@web/utils.js';
import type { PurchaseAnswer, PurchaseBridge } from '@/data/backend';
import { ApiError } from '@/data/client';
import type { PurchaseResult, StoreProof } from '@/data/types';
import { isRefusal } from '../refusals/refusals';

export type UnlockView =
  /** Not known yet. */
  | 'loading'
  /** A self-hosted server: nothing is ever gated and nothing is for sale. */
  | 'self-hosted'
  /** A hosted account that has the unlock. */
  | 'unlocked'
  /** A hosted account, locked, inside the app: the store sheet can be opened here. */
  | 'buy-here'
  /** A hosted account, locked, without a store (a browser, or an app build with no purchase sheet yet). */
  | 'buy-in-app';

export function unlockView({ mode, unlocked, known, hasStore }: { mode: 'self-hosted' | 'hosted'; unlocked: boolean | null; known: boolean; hasStore: boolean }): UnlockView {
  if (mode === 'self-hosted') return 'self-hosted';
  if (!known || unlocked === null) return 'loading';
  if (unlocked) return 'unlocked';
  return hasStore ? 'buy-here' : 'buy-in-app';
}

export type PurchaseOutcome =
  | { kind: 'unlocked'; restored: boolean }
  /** Google has not completed the payment yet; the same proof can be sent again later. */
  | { kind: 'pending'; proof: StoreProof }
  /** The sheet was closed without buying. */
  | { kind: 'cancelled' }
  /** The store is holding the purchase back (Ask to Buy, a payment that has not cleared). Nothing to send yet; the app is told when it completes. */
  | { kind: 'waiting' }
  | { kind: 'nothing-to-restore' }
  /** The server refused the proof with a known code (see refusals.ts). */
  | { kind: 'refused'; error: ApiError }
  | { kind: 'failed'; message: string };

type Submit = (proof: StoreProof) => Promise<PurchaseResult>;

/** The refusals that will not change by asking again: the proof is not this account's unlock, or the store took it back. */
const final = (error: ApiError) => (error.status === 400 || error.status === 409) && error.code.startsWith('purchase_');

/** Tells the store what the server said. A store that cannot be told leaves the purchase open, and the app offers it again at the next start. */
async function tell(store: PurchaseBridge | undefined, proof: StoreProof, answer: PurchaseAnswer) {
  try { await store?.settled?.(proof, answer); } catch { /* The server's answer stands whether or not the store could be told. */ }
}

/** Hands one proof to the server, reads its answer, and, once the server has answered, tells the store (when there is one). */
export async function settle(proof: StoreProof, submit: Submit, store?: PurchaseBridge): Promise<PurchaseOutcome> {
  try {
    const result = await submit(proof);
    if (result.unlocked) {
      await tell(store, proof, { outcome: 'unlocked', acknowledged: result.acknowledged });
      return { kind: 'unlocked', restored: Boolean(result.restored) };
    }
    return result.status === 'pending' ? { kind: 'pending', proof } : { kind: 'failed', message: 'The store answered, but the account is not unlocked. Try restoring the purchase.' };
  } catch (error) {
    if (!isRefusal(error)) return { kind: 'failed', message: errorMessage(error) };
    if (final(error)) await tell(store, proof, { outcome: 'refused' });
    return { kind: 'refused', error };
  }
}

export async function buy(store: PurchaseBridge, accountId: string, submit: Submit): Promise<PurchaseOutcome> {
  let proof: StoreProof | null | 'pending';
  try {
    proof = await store.buy({ accountId });
  } catch (error) {
    return { kind: 'failed', message: errorMessage(error) };
  }
  if (proof === 'pending') return { kind: 'waiting' };
  return proof ? settle(proof, submit, store) : { kind: 'cancelled' };
}

/** Tries every purchase the store account holds. The first one the server accepts wins; otherwise the most useful refusal is kept. */
export async function restore(store: PurchaseBridge, submit: Submit): Promise<PurchaseOutcome> {
  let proofs: StoreProof[];
  try {
    proofs = await store.restore();
  } catch (error) {
    return { kind: 'failed', message: errorMessage(error) };
  }
  if (!proofs.length) return { kind: 'nothing-to-restore' };
  let fallback: PurchaseOutcome = { kind: 'nothing-to-restore' };
  for (const proof of proofs) {
    const outcome = await settle(proof, submit, store);
    if (outcome.kind === 'unlocked') return outcome;
    // A pending payment is more useful to report than a refusal of an older receipt.
    if (outcome.kind === 'pending' || fallback.kind !== 'pending') fallback = outcome;
  }
  return fallback;
}

export const VIA: Record<string, string> = { apple: 'the App Store', google: 'Google Play', manual: 'the service’s operator', owner: 'your own server' };
