import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createBridge } from '../src/bridge.js';

const backend = readFileSync(new URL('../../ui/src/data/backend.ts', import.meta.url), 'utf8');

/** The members of an interface in ui/src/data/backend.ts, as { name: optional }. */
function members(name) {
  const body = backend.match(new RegExp(`export interface ${name} \\{\\n([\\s\\S]*?)\\n\\}`))?.[1];
  assert.ok(body, `${name} is in backend.ts`);
  const found = {};
  for (const line of body.split('\n')) {
    const match = line.match(/^ {2}(?:readonly )?(\w+)(\?)?\s*[:(]/);
    if (match) found[match[1]] = Boolean(match[2]);
  }
  return found;
}

const parts = (extra = {}) => ({
  platform: 'ios', mode: 'hosted', serverUrl: 'https://app.little-archive.example', initialShare: null,
  transport: { fetch: async () => new Response('{}'), localAsset: () => null, attachImage: () => {} },
  onShare: () => () => {}, saveFile: async () => {}, signedOut: async () => {},
  email: 'person@example.com', signOut: async () => {}, switchServer: async () => {},
  ...extra,
});
const purchases = { provider: 'apple', buy: async () => null, restore: async () => [] };

test('the bridge has exactly what the interface’s native backend reads (NativeBridge in ui/src/data/backend.ts)', () => {
  const wanted = members('NativeBridge');
  assert.ok(Object.keys(wanted).length >= 10, 'the interface was read');
  for (const mode of ['hosted', 'self-hosted']) {
    const bridge = createBridge(parts({ mode, purchases: mode === 'hosted' ? purchases : undefined }));
    for (const [name, optional] of Object.entries(wanted)) if (!optional) assert.ok(name in bridge, `${name} is required by the interface`);
    for (const name of Object.keys(bridge)) assert.ok(name in wanted, `${name} is not something the interface knows about`);
  }
  const account = createBridge(parts()).account;
  for (const name of Object.keys(members('DeviceAccount'))) assert.ok(name in account, `account.${name}`);
});

test('the purchase bridge has exactly what the unlock screen calls (PurchaseBridge in ui/src/data/backend.ts)', () => {
  const wanted = members('PurchaseBridge');
  for (const name of ['provider', 'buy', 'restore', 'price', 'settled', 'onUnlocked']) assert.ok(name in wanted, name);
  assert.deepEqual(Object.entries(wanted).filter(([, optional]) => !optional).map(([name]) => name).sort(), ['buy', 'provider', 'restore']);
});

test('a self-hosted server gets no purchases at all: nothing for sale, nothing gated', () => {
  assert.equal('purchases' in createBridge(parts({ mode: 'self-hosted' })), false);
  assert.throws(() => createBridge(parts({ mode: 'self-hosted', purchases })), /Only a hosted account/);
  assert.equal(createBridge(parts({ mode: 'hosted', purchases })).purchases, purchases);
  assert.throws(() => createBridge(parts({ mode: 'somewhere' })), /Unknown server mode/);
});

test('the bridge cannot be changed by the page, and carries no credential', () => {
  const bridge = createBridge(parts());
  assert.ok(Object.isFrozen(bridge) && Object.isFrozen(bridge.account));
  assert.throws(() => { 'use strict'; bridge.fetch = () => {}; }, TypeError);
  assert.doesNotMatch(JSON.stringify(Object.keys(bridge)), /token|bearer|credential|password/i);
  assert.equal(bridge.initialShare, null);
  assert.equal(bridge.account.email, 'person@example.com');
});
