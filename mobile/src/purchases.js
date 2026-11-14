// The one-time unlock, from the phone's side. The interface sees this as `purchases` on the bridge (PurchaseBridge in
// ui/src/data/backend.ts); the store itself is a small native plugin per platform (StorePurchases: Swift and StoreKit 2 on iOS,
// Java and the Play Billing Library on Android), which this module drives and which has nothing else in it.
//
// What the plugin gives and takes, the same on both platforms:
//   product()            { available, price }              the unlock's localized price, from the store
//   buy({ accountTag })  { status: 'purchased'|'pending'|'cancelled', purchase? }
//   list({ sync })       { purchases: [Record] }           what the store account holds; `sync` asks the store to look again (Restore)
//   finish({ id, purchaseToken })                          Apple: finish the transaction. Google: acknowledge the purchase.
//   event 'purchaseUpdated'                                something changed outside a button press (an approval, a refund)
// A Record is { provider, product_id, state: 'purchased'|'pending'|'revoked', finished, account_tag, id, signed_transaction }
// for Apple and { …, purchase_token } for Google. `finished` is Apple's "transaction finished" and Google's "acknowledged".
//
// The order is the point. A store keeps a purchase open until the app says it was delivered (Apple re-offers an unfinished
// transaction at every start; Google refunds a purchase nobody acknowledged within three days). So nothing here finishes
// anything until the server has said yes (or, for a proof that can never work, no for good). Whatever could not be asked, because
// the phone was offline or the store's servers were not answering, is asked again at the next start, on resume and on any
// update the store sends. The server is the only thing that unlocks an account; this module only carries proofs to it.
export const PRODUCT_ID = 'unlock_full';
const HANDING_MS = 120_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const hex = bytes => [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');

/**
 * What the store binds a purchase to, so the server can tell whose it is. Apple takes the account's UUID (appAccountToken);
 * Google takes its SHA-256 as lowercase hex (obfuscated account id), so Google never holds the account's id itself.
 */
export async function accountTag(provider, accountId, subtle = globalThis.crypto?.subtle) {
  const id = String(accountId || '').toLowerCase();
  if (!UUID.test(id)) throw new Error('This account could not be identified. Sign in again and try once more.');
  if (provider === 'apple') return id;
  if (!subtle) throw new Error('This device cannot prepare a purchase. Update the system web view and try again.');
  return hex(await subtle.digest('SHA-256', new TextEncoder().encode(id)));
}

/** The transaction id inside a StoreKit 2 signed transaction. Read only to say which transaction to finish; the server checks the signature. */
export function transactionId(signedTransaction) {
  try {
    const payload = String(signedTransaction).split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const id = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(payload), char => char.charCodeAt(0)))).transactionId;
    return /^\d{1,20}$/.test(String(id)) ? String(id) : '';
  } catch { return ''; }
}

/** The proof the server takes (POST /api/purchases/apple or /google), from what the store handed over. */
export function proofOf(record) {
  if (record.provider === 'apple') return { provider: 'apple', signed_transaction: record.signed_transaction };
  return { provider: 'google', product_id: PRODUCT_ID, purchase_token: record.purchase_token };
}

const keyOf = record => (record.provider === 'apple' ? `apple:${record.id}` : `google:${record.purchase_token}`);
const keyOfProof = proof => (proof.provider === 'apple' ? `apple:${transactionId(proof.signed_transaction)}` : `google:${proof.purchase_token}`);

const sentence = (error, fallback) => (typeof error?.message === 'string' && error.message ? error.message : fallback);

/**
 * @param {object} options
 * @param {'apple'|'google'} options.provider
 * @param {object} options.plugin  the StorePurchases plugin
 * @param {(path: string, init?: object) => Promise<Response>} options.request  the app's transport (bearer token, /api paths only)
 * @param {{addListener(name: string, handler: Function): any}} [options.app]  @capacitor/app, for resume
 * @param {SubtleCrypto} [options.subtle]
 */
export function createPurchases({ provider, plugin, request, app, subtle, now = Date.now }) {
  const listeners = new Set();
  // Proofs the interface has in hand right now; the background pass leaves them alone for a couple of minutes, which is long
  // enough for the server to answer and short enough that one the interface gave up on is picked up again without a restart.
  const handing = new Map();
  const inHand = key => (handing.get(key) ?? 0) > now();
  const hold = key => handing.set(key, now() + HANDING_MS);
  const refusedThisSession = new Set(); // the server said no for good; asking again at every resume would only repeat the answer
  let busy = 0;                         // a buy or restore is on screen
  let pass = null;
  let account = '';
  let stop = () => {};

  async function whoAmI() {
    if (account) return account;
    try {
      const response = await request('/api/account', { headers: { Accept: 'application/json' } });
      if (response.ok) account = String((await response.json())?.user_id || '').toLowerCase();
    } catch { /* offline: the background pass tries again later */ }
    return account;
  }

  /** The server's answer to a proof, as one of: 'unlocked', 'pending', 'refused' (for good), 'later' (could not be asked, or has not decided). */
  async function ask(record) {
    const proof = proofOf(record);
    let response;
    try {
      response = await request(`/api/purchases/${provider}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(proof.provider === 'apple' ? { signed_transaction: proof.signed_transaction } : { product_id: proof.product_id, purchase_token: proof.purchase_token }) });
    } catch { return { kind: 'later' }; }
    const body = await response.json().catch(() => ({}));
    if (response.status === 200 && body.unlocked === true) return { kind: 'unlocked', acknowledged: body.acknowledged };
    if (response.status === 202) return { kind: 'pending' };
    if ((response.status === 400 || response.status === 409) && String(body.code || '').startsWith('purchase_')) return { kind: 'refused' };
    return { kind: 'later' };
  }

  /** Apple: finish the transaction. Google: acknowledge, unless the server already did. Called only after the server has answered. */
  async function deliver(record, answer) {
    if (record.provider === 'apple') await plugin.finish({ id: record.id });
    else if (answer.outcome === 'unlocked' && answer.acknowledged === false) await plugin.finish({ purchaseToken: record.purchase_token });
  }

  /**
   * One look at what the store holds that has not been delivered, with nothing on screen: a purchase left from the last start,
   * an Ask to Buy that was approved, a payment that cleared. A purchase made by another Little Archive account is left alone,
   * because the server gives a purchase to the first account that presents it.
   */
  async function look() {
    if (busy) return;
    let held;
    try { held = (await plugin.list({ sync: false })).purchases; } catch { return; }
    const open = (Array.isArray(held) ? held : []).filter(record => record?.product_id === PRODUCT_ID && !record.finished && !inHand(keyOf(record)) && !refusedThisSession.has(keyOf(record)));
    let unlocked = false;
    for (const record of open) {
      if (record.state === 'pending') continue; // not paid yet; the store says when it is
      if (record.state === 'revoked') { await plugin.finish({ id: record.id }).catch(() => {}); continue; } // Apple took it back before it was delivered
      const who = await whoAmI();
      if (!who) return;
      if (record.account_tag && record.account_tag.toLowerCase() !== await accountTag(provider, who, subtle)) continue;
      const answer = await ask(record);
      if (answer.kind === 'unlocked') {
        try { await deliver(record, { outcome: 'unlocked', acknowledged: answer.acknowledged }); } catch { /* offered again at the next start; the unlock stands */ }
        unlocked = true;
      } else if (answer.kind === 'refused') {
        refusedThisSession.add(keyOf(record));
        try { await deliver(record, { outcome: 'refused' }); } catch { /* as above */ }
      }
    }
    if (unlocked) for (const listener of [...listeners]) { try { listener(); } catch { /* one listener must not stop the rest */ } }
  }

  // One pass at a time, and a pass that fails for any reason is simply tried again on the next trigger.
  const reconcile = () => (pass ||= look().catch(() => {}).finally(() => { pass = null; }));

  const bridge = {
    provider,

    async price() {
      try {
        const found = await plugin.product();
        return found?.available && found.price ? String(found.price) : null;
      } catch { return null; }
    },

    async buy({ accountId }) {
      const tag = await accountTag(provider, accountId, subtle);
      busy += 1;
      try {
        const answer = await plugin.buy({ accountTag: tag }).catch(error => { throw new Error(sentence(error, 'The store could not be reached. Try again in a moment.')); });
        if (answer.status === 'cancelled') return null;
        if (answer.status === 'pending') return 'pending';
        if (answer.status !== 'purchased' || !answer.purchase) throw new Error('The store did not complete the purchase. Nothing was charged that it did not confirm.');
        const proof = proofOf(answer.purchase);
        hold(keyOfProof(proof));
        return proof;
      } finally { busy -= 1; }
    },

    async restore() {
      busy += 1;
      try {
        const { purchases } = await plugin.list({ sync: true }).catch(error => { throw new Error(sentence(error, 'The store could not be reached. Try again in a moment.')); });
        const proofs = (Array.isArray(purchases) ? purchases : []).filter(record => record?.product_id === PRODUCT_ID && record.state === 'purchased').map(proofOf);
        for (const proof of proofs) hold(keyOfProof(proof));
        return proofs;
      } finally { busy -= 1; }
    },

    async settled(proof, answer) {
      const key = keyOfProof(proof);
      try {
        if (proof.provider === 'apple') await plugin.finish({ id: transactionId(proof.signed_transaction) });
        else if (answer.outcome === 'unlocked' && answer.acknowledged === false) await plugin.finish({ purchaseToken: proof.purchase_token });
      } finally { handing.delete(key); }
    },

    onUnlocked(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };

  return {
    /** What the interface gets: only the PurchaseBridge. */
    bridge: Object.freeze(bridge),
    /** Listens for what the store says outside a button press and for the app coming back, and looks once now. */
    start() {
      const handles = [plugin.addListener('purchaseUpdated', () => { void reconcile(); }), app?.addListener('resume', () => { void reconcile(); })];
      stop = () => { for (const handle of handles) Promise.resolve(handle).then(found => found?.remove?.(), () => {}); };
      return reconcile();
    },
    stop: () => stop(),
    reconcile,
  };
}
