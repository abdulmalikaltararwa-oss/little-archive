import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PRODUCT_ID, accountTag, createPurchases, proofOf, transactionId } from '../src/purchases.js';

const USER = '3f2b8c1e-5d4a-4e6f-9a7b-0c1d2e3f4a5b';
const OTHER = '9a8b7c6d-1111-4222-8333-444455556666';
const sha = text => createHash('sha256').update(text).digest('hex');
const jws = transactionId => `${Buffer.from('{"alg":"ES256"}').toString('base64url')}.${Buffer.from(JSON.stringify({ transactionId, productId: PRODUCT_ID })).toString('base64url')}.c2ln`;

const apple = (id, extra = {}) => ({ provider: 'apple', product_id: PRODUCT_ID, id, signed_transaction: jws(id), account_tag: USER, state: 'purchased', finished: false, ...extra });
const google = (token, extra = {}) => ({ provider: 'google', product_id: PRODUCT_ID, purchase_token: token, account_tag: sha(USER), state: 'purchased', finished: false, ...extra });

/** The native plugin, scripted. `held` is what list() returns; every call is recorded in order. */
function fakePlugin({ held = [], product = { available: true, price: '$4.99' }, bought = { status: 'cancelled' } } = {}) {
  const calls = [];
  const handlers = {};
  const removed = [];
  const plugin = {
    held, bought, calls,
    product: async () => { if (product instanceof Error) throw product; return product; },
    buy: async options => { calls.push(['buy', options]); if (plugin.bought instanceof Error) throw plugin.bought; return plugin.bought; },
    list: async options => { calls.push(['list', options]); return { purchases: plugin.held }; },
    finish: async options => { calls.push(['finish', options]); return { finished: true }; },
    addListener: (name, handler) => { handlers[name] = handler; return Promise.resolve({ remove: () => removed.push(name) }); },
  };
  return { plugin, calls, handlers, removed };
}

/** The server, scripted: `routes` maps "METHOD path" to a [status, body] pair, a function of the request, or an Error to throw. */
function fakeServer(routes = {}) {
  const calls = [];
  const request = async (path, init = {}) => {
    const method = init.method || 'GET';
    calls.push({ method, path, body: init.body ? JSON.parse(init.body) : undefined });
    const route = routes[`${method} ${path}`];
    if (route === undefined) throw new Error(`unexpected ${method} ${path}`);
    const answer = typeof route === 'function' ? route(calls.length) : route;
    if (answer instanceof Error) throw answer;
    return new Response(JSON.stringify(answer[1]), { status: answer[0], headers: { 'content-type': 'application/json' } });
  };
  return { request, calls, purchases: () => calls.filter(call => call.path.startsWith('/api/purchases')) };
}

const account = [200, { user_id: USER }];
const unlocked = (provider, extra = {}) => [200, { unlocked: true, provider, product_id: PRODUCT_ID, status: 'active', restored: false, ...extra }];
const refused = (status, code) => [status, { detail: 'No.', code }];
const finishes = calls => calls.filter(call => call[0] === 'finish').map(call => call[1]);

function make(provider, { plugin: options, server: routes, now } = {}) {
  const store = fakePlugin(options);
  const server = fakeServer({ 'GET /api/account': account, ...routes });
  const purchases = createPurchases({ provider, plugin: store.plugin, request: server.request, app: { addListener: (name, handler) => store.plugin.addListener(`app:${name}`, handler) }, now });
  return { ...store, server, purchases, bridge: purchases.bridge };
}

test('the store binds a purchase to the account: Apple takes the UUID, Google its SHA-256 as lowercase hex (as the server checks it)', async () => {
  assert.equal(await accountTag('apple', USER.toUpperCase()), USER);
  assert.equal(await accountTag('google', USER), sha(USER));
  assert.equal(await accountTag('google', USER.toUpperCase()), sha(USER), 'the hash is of the lowercase id, which is what the server hashes');
  for (const bad of ['', 'not-a-uuid', null, undefined, `${USER}0`]) await assert.rejects(accountTag('apple', bad), /could not be identified/);
  await assert.rejects(accountTag('google', USER, null), /cannot prepare a purchase/);
});

test('the transaction to finish is named by the id inside the signed transaction; garbage names nothing', () => {
  assert.equal(transactionId(jws('2000000123456789')), '2000000123456789');
  assert.equal(transactionId(jws(77)), '77');
  for (const bad of ['', 'x', 'a.b.c', jws('../etc'), jws('')]) assert.equal(transactionId(bad), '');
});

test('the proof sent to the server carries only what the contract names', () => {
  assert.deepEqual(proofOf(apple('1')), { provider: 'apple', signed_transaction: jws('1') });
  assert.deepEqual(proofOf(google('tok')), { provider: 'google', product_id: 'unlock_full', purchase_token: 'tok' });
});

test('the price is the store’s own, or nothing', async () => {
  assert.equal(await make('apple').bridge.price(), '$4.99');
  assert.equal(await make('apple', { plugin: { product: { available: false } } }).bridge.price(), null);
  assert.equal(await make('apple', { plugin: { product: new Error('offline') } }).bridge.price(), null);
});

test('buying: the sheet gets the account’s tag, a closed sheet is no purchase, a held one is pending, and a payment gives a proof', async () => {
  const a = make('apple', { plugin: { bought: { status: 'purchased', purchase: apple('11') } } });
  assert.deepEqual(await a.bridge.buy({ accountId: USER }), { provider: 'apple', signed_transaction: jws('11') });
  assert.deepEqual(a.calls, [['buy', { accountTag: USER }]]);

  const g = make('google', { plugin: { bought: { status: 'purchased', purchase: google('tok-1') } } });
  assert.deepEqual(await g.bridge.buy({ accountId: USER }), { provider: 'google', product_id: 'unlock_full', purchase_token: 'tok-1' });
  assert.deepEqual(g.calls, [['buy', { accountTag: sha(USER) }]]);

  assert.equal(await make('apple', { plugin: { bought: { status: 'cancelled' } } }).bridge.buy({ accountId: USER }), null);
  assert.equal(await make('apple', { plugin: { bought: { status: 'pending' } } }).bridge.buy({ accountId: USER }), 'pending');
  await assert.rejects(make('apple', { plugin: { bought: Object.assign(new Error('The App Store is not available right now.'), { code: 'UNAVAILABLE' }) } }).bridge.buy({ accountId: USER }), /App Store is not available/);
  await assert.rejects(make('apple', { plugin: { bought: { status: 'strange' } } }).bridge.buy({ accountId: USER }), /did not complete the purchase/);
  const none = make('apple');
  await assert.rejects(none.bridge.buy({ accountId: 'someone' }), /could not be identified/);
  assert.deepEqual(none.calls, [], 'the store is not opened for an account that cannot be named');
});

test('nothing is finished until the server has answered; then Apple finishes the transaction, and Google acknowledges only what the server did not', async () => {
  const a = make('apple', { plugin: { bought: { status: 'purchased', purchase: apple('21') } } });
  const proof = await a.bridge.buy({ accountId: USER });
  assert.deepEqual(finishes(a.calls), [], 'a proof in hand is not delivered');
  await a.bridge.settled(proof, { outcome: 'unlocked' });
  assert.deepEqual(finishes(a.calls), [{ id: '21' }]);
  await a.bridge.settled(proof, { outcome: 'refused' });
  assert.deepEqual(finishes(a.calls), [{ id: '21' }, { id: '21' }], 'a refusal for good is finished too, so Apple does not offer it at every start');

  const g = make('google');
  const token = { provider: 'google', product_id: 'unlock_full', purchase_token: 'tok-9' };
  await g.bridge.settled(token, { outcome: 'unlocked', acknowledged: true });
  await g.bridge.settled(token, { outcome: 'unlocked' });
  await g.bridge.settled(token, { outcome: 'refused' });
  assert.deepEqual(finishes(g.calls), [], 'the server already acknowledged it, or the purchase is not one to acknowledge');
  await g.bridge.settled(token, { outcome: 'unlocked', acknowledged: false });
  assert.deepEqual(finishes(g.calls), [{ purchaseToken: 'tok-9' }], 'only when the server could not');
});

test('restore asks the store to look again and offers only purchases that count', async () => {
  const held = [apple('1'), apple('2', { state: 'revoked' }), apple('3', { product_id: 'something_else' }), apple('4', { finished: true })];
  const a = make('apple', { plugin: { held } });
  assert.deepEqual(await a.bridge.restore(), [proofOf(held[0]), proofOf(held[3])]);
  assert.deepEqual(a.calls, [['list', { sync: true }]]);
  const g = make('google', { plugin: { held: [google('a'), google('b', { state: 'pending' })] } });
  assert.deepEqual(await g.bridge.restore(), [{ provider: 'google', product_id: 'unlock_full', purchase_token: 'a' }]);
  assert.deepEqual(await make('apple').bridge.restore(), []);
  const broken = make('apple');
  broken.plugin.list = async () => { throw Object.assign(new Error('Restore was cancelled.'), { code: 'CANCELLED' }); };
  await assert.rejects(broken.bridge.restore(), /Restore was cancelled/);
});

test('at the start, a purchase left unfinished is sent to the server and finished once it says yes; the interface is told', async () => {
  const t = make('apple', { plugin: { held: [apple('31')] }, server: { 'POST /api/purchases/apple': unlocked('apple') } });
  let told = 0;
  t.bridge.onUnlocked(() => { told += 1; });
  await t.purchases.reconcile();
  assert.deepEqual(t.server.purchases(), [{ method: 'POST', path: '/api/purchases/apple', body: { signed_transaction: jws('31') } }]);
  assert.deepEqual(finishes(t.calls), [{ id: '31' }]);
  assert.equal(told, 1);
  assert.deepEqual(t.calls[0], ['list', { sync: false }], 'looking does not ask the store to sync, which can open a sign-in');
});

test('a server that cannot be reached or has not decided leaves the purchase open, and the next pass tries again', async () => {
  let answer = new Error('offline');
  const t = make('apple', { plugin: { held: [apple('41')] }, server: { 'POST /api/purchases/apple': () => answer } });
  let told = 0;
  t.bridge.onUnlocked(() => { told += 1; });
  await t.purchases.reconcile();
  assert.deepEqual([finishes(t.calls), told], [[], 0], 'offline');
  answer = refused(503, 'purchases_unavailable');
  await t.purchases.reconcile();
  assert.deepEqual([finishes(t.calls), told], [[], 0], 'the store’s servers are not answering');
  answer = [429, { detail: 'Slow down.', code: 'rate_limited' }];
  await t.purchases.reconcile();
  assert.deepEqual([finishes(t.calls), told], [[], 0], 'rate limited');
  answer = unlocked('apple', { restored: true });
  await t.purchases.reconcile();
  assert.deepEqual([finishes(t.calls), told], [[{ id: '41' }], 1]);
  assert.equal(t.server.purchases().length, 4);
});

test('a refusal for good finishes Apple’s transaction, leaves Google’s alone, and is not asked again this session', async () => {
  const a = make('apple', { plugin: { held: [apple('51')] }, server: { 'POST /api/purchases/apple': refused(409, 'purchase_revoked') } });
  await a.purchases.reconcile();
  await a.purchases.reconcile();
  assert.deepEqual(finishes(a.calls), [{ id: '51' }]);
  assert.equal(a.server.purchases().length, 1, 'asked once');

  const g = make('google', { plugin: { held: [google('tok-5')] }, server: { 'POST /api/purchases/google': refused(400, 'purchase_invalid') } });
  await g.purchases.reconcile();
  await g.purchases.reconcile();
  assert.deepEqual(finishes(g.calls), [], 'an unacknowledged purchase nobody can use is refunded by Google after three days');
  assert.equal(g.server.purchases().length, 1);
});

test('Google: the server acknowledges when it can; the app does so only when the server says it could not, and not for a payment still pending', async () => {
  const body = acknowledged => ({ 'POST /api/purchases/google': unlocked('google', { acknowledged }) });
  const done = make('google', { plugin: { held: [google('a')] }, server: body(true) });
  await done.purchases.reconcile();
  assert.deepEqual(finishes(done.calls), [], 'acknowledged by the server: not acknowledged twice');
  const not = make('google', { plugin: { held: [google('b')] }, server: body(false) });
  await not.purchases.reconcile();
  assert.deepEqual(finishes(not.calls), [{ purchaseToken: 'b' }]);
  assert.deepEqual(not.server.purchases()[0].body, { product_id: 'unlock_full', purchase_token: 'b' });
  const pending = make('google', { plugin: { held: [google('c')] }, server: { 'POST /api/purchases/google': [202, { unlocked: false, provider: 'google', product_id: PRODUCT_ID, status: 'pending', restored: false }] } });
  let told = 0;
  pending.bridge.onUnlocked(() => { told += 1; });
  await pending.purchases.reconcile();
  assert.deepEqual([finishes(pending.calls), told], [[], 0]);
});

test('what is not for this account, not paid yet, already delivered or not the unlock is left alone', async () => {
  const held = [
    apple('61', { account_tag: OTHER }),          // bought while another account was signed in on this phone
    apple('62', { state: 'pending' }),             // Ask to Buy, not approved yet
    apple('63', { finished: true }),               // delivered already
    apple('64', { product_id: 'something_else' }), // not ours
    google('x', { account_tag: sha(OTHER) }),
  ];
  const t = make('apple', { plugin: { held } });
  await t.purchases.reconcile();
  assert.deepEqual(t.server.purchases(), []);
  assert.deepEqual(finishes(t.calls), []);
  const mine = make('apple', { plugin: { held: [apple('65', { account_tag: '' })] }, server: { 'POST /api/purchases/apple': unlocked('apple') } });
  await mine.purchases.reconcile();
  assert.equal(mine.server.purchases().length, 1, 'a purchase bound to no account is taken to be this account’s');
});

test('Apple took a purchase back before it was delivered: it is finished without troubling the server', async () => {
  const t = make('apple', { plugin: { held: [apple('71', { state: 'revoked' })] } });
  await t.purchases.reconcile();
  assert.deepEqual(finishes(t.calls), [{ id: '71' }]);
  assert.deepEqual(t.server.purchases(), []);
});

test('the account is asked for once, and when it cannot be asked nothing is sent', async () => {
  const t = make('apple', { plugin: { held: [apple('81'), apple('82')] }, server: { 'POST /api/purchases/apple': unlocked('apple') } });
  await t.purchases.reconcile();
  assert.equal(t.server.calls.filter(call => call.path === '/api/account').length, 1);
  assert.equal(t.server.purchases().length, 2);
  const offline = make('apple', { plugin: { held: [apple('83')] }, server: { 'GET /api/account': new Error('offline') } });
  await offline.purchases.reconcile();
  assert.deepEqual(offline.server.purchases(), []);
});

test('while the interface has the store’s sheet or a proof in hand, the background pass leaves it alone; a proof it dropped is picked up after a while', async () => {
  let clock = 1_000;
  const t = make('apple', { plugin: { held: [apple('91')], bought: { status: 'purchased', purchase: apple('91') } }, server: { 'POST /api/purchases/apple': unlocked('apple') }, now: () => clock });
  let release;
  t.plugin.buy = () => new Promise(resolve => { release = () => resolve({ status: 'purchased', purchase: apple('91') }); });
  const buying = t.bridge.buy({ accountId: USER });
  await new Promise(resolve => setImmediate(resolve));
  await t.purchases.reconcile();
  assert.deepEqual(t.calls.filter(call => call[0] === 'list'), [], 'the sheet is open');
  release();
  const proof = await buying;
  await t.purchases.reconcile();
  assert.deepEqual(t.server.purchases(), [], 'the proof is in the interface’s hands');
  clock += 130_000;
  await t.purchases.reconcile();
  assert.equal(t.server.purchases().length, 1, 'the interface never settled it, so it is delivered now');
  assert.deepEqual(finishes(t.calls), [{ id: '91' }]);
  await t.bridge.settled(proof, { outcome: 'unlocked' });
});

test('start listens for the store’s updates and for the app coming back, looks once now, and stop lets go', async () => {
  const t = make('apple', { plugin: { held: [] }, server: { 'POST /api/purchases/apple': unlocked('apple') } });
  const later = async () => { await new Promise(resolve => setImmediate(resolve)); };
  await t.purchases.start();
  assert.deepEqual(t.calls, [['list', { sync: false }]], 'one look at the start');
  assert.equal(typeof t.handlers.purchaseUpdated, 'function');
  assert.equal(typeof t.handlers['app:resume'], 'function');

  t.plugin.held = [apple('101')];                // an Ask to Buy was approved while the app was open
  t.handlers.purchaseUpdated(); await later();
  assert.deepEqual(finishes(t.calls), [{ id: '101' }], 'an update from the store makes it look again');

  t.plugin.held = [apple('102')];                // something arrived while the app was in the background
  t.handlers['app:resume'](); await later();
  assert.deepEqual(finishes(t.calls), [{ id: '101' }, { id: '102' }], 'so does the app coming back');

  t.purchases.stop(); await later();
  assert.deepEqual(t.removed.sort(), ['app:resume', 'purchaseUpdated']);
});

test('passes do not overlap: two triggers at once are one look', async () => {
  const t = make('apple', { plugin: { held: [] } });
  await Promise.all([t.purchases.reconcile(), t.purchases.reconcile(), t.purchases.reconcile()]);
  assert.equal(t.calls.filter(call => call[0] === 'list').length, 1);
  await t.purchases.reconcile();
  assert.equal(t.calls.filter(call => call[0] === 'list').length, 2);
});

test('a store that cannot be listed, or a listener that throws, never breaks the pass', async () => {
  const t = make('apple', { plugin: { held: [apple('111')] }, server: { 'POST /api/purchases/apple': unlocked('apple') } });
  t.plugin.list = async () => { throw new Error('StoreKit is unavailable'); };
  await t.purchases.reconcile();
  t.plugin.list = async () => ({ purchases: [apple('111')] });
  let reached = 0;
  t.bridge.onUnlocked(() => { throw new Error('a listener bug'); });
  t.bridge.onUnlocked(() => { reached += 1; });
  await t.purchases.reconcile();
  assert.equal(reached, 1);
});

test('the interface gets a PurchaseBridge and nothing more: no way to reconcile, no token, nothing it could use to unlock itself', () => {
  const { bridge } = make('google');
  assert.deepEqual(Object.keys(bridge).sort(), ['buy', 'onUnlocked', 'price', 'provider', 'restore', 'settled']);
  assert.equal(bridge.provider, 'google');
  assert.ok(Object.isFrozen(bridge));
});
