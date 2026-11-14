import test from 'node:test';
import assert from 'node:assert/strict';
import { EMULATOR_HOST, hostName, isDebugBuild, isLoopbackHost, normalizeAddress, parseServerAddress } from '../src/server-url.js';

const ok = input => { const result = parseServerAddress(input); assert.equal(result.ok, true, `${input}: ${result.message}`); return result; };
const refused = input => { const result = parseServerAddress(input); assert.equal(result.ok, false, `${input} was accepted as ${result.url}`); assert.ok(result.message); return result.message; };

test('a bare host is https; the origin and an optional path prefix are kept, a trailing slash is not', () => {
  assert.deepEqual(ok('archive.example.com'), { ok: true, url: 'https://archive.example.com', insecure: false });
  assert.equal(ok('  https://archive.example.com/  ').url, 'https://archive.example.com');
  assert.equal(ok('https://archive.example.com:8443/little/').url, 'https://archive.example.com:8443/little');
  assert.equal(ok('HTTPS://Archive.Example.COM').url, 'https://archive.example.com');
  assert.equal(ok('https://münchen.example/').url, 'https://xn--mnchen-3ya.example');
});

test('plain http is accepted only for this device itself, and says so', () => {
  assert.deepEqual(ok('http://localhost:8787'), { ok: true, url: 'http://localhost:8787', insecure: true });
  assert.equal(ok('http://127.0.0.1:8787').insecure, true);
  assert.equal(ok('http://[::1]:8787').url, 'http://[::1]:8787');
  assert.equal(ok('http://app.localhost:8787').insecure, true);
  // Typing only the host of this device means http, because nothing on a phone listens for https there.
  assert.equal(ok('localhost:8787').url, 'http://localhost:8787');
  for (const bad of ['http://archive.example.com', 'http://192.168.1.20:8787', 'http://10.0.0.5', 'http://nas.local:8787', 'http://169.254.1.1', 'http://localhost.example.com', 'http://127.0.0.1.example.com']) {
    assert.match(refused(bad), /not encrypted/, bad);
  }
});

test('anything that is not a plain web address of a server is refused with a reason', () => {
  assert.match(refused(''), /Enter the address/);
  assert.match(refused('   '), /Enter the address/);
  for (const bad of ['ftp://archive.example.com', 'javascript:alert(1)', 'file:///etc/passwd', 'capacitor://localhost', 'intent://x#Intent;end', 'data:text/html,x']) assert.match(refused(bad), /http:\/\/ or https:\/\//, bad);
  assert.match(refused('https://user:secret@archive.example.com'), /Leave the user name and password out/);
  assert.match(refused('https://archive.example.com/?x=1'), /without anything after/);
  assert.match(refused('https://archive.example.com/#top'), /without anything after/);
  for (const bad of ['https://arch ive.example.com', 'https://archive.example.com/\nnext', `https://${'a'.repeat(2100)}.example`, 'https://']) refused(bad);
});

test('loopback detection is exact: lookalike hosts are not this device', () => {
  for (const host of ['localhost', 'LOCALHOST', '127.0.0.1', '127.1.2.3', '[::1]', 'x.localhost']) assert.equal(isLoopbackHost(host), true, host);
  for (const host of ['localhost.evil.example', '127.0.0.1.evil.example', '10.0.2.20', 'notlocalhost', '', undefined, '[::2]', '192.168.0.1']) assert.equal(isLoopbackHost(host), false, String(host));
});

// The Android emulator's name for the computer is a development convenience: a release bundle must treat it as any other
// network address. The build defines __LA_DEBUG_BUILD__ (see scripts/build-web.mjs); here the global stands in for it.
function withDebugBuild(value, run) {
  const had = Object.prototype.hasOwnProperty.call(globalThis, '__LA_DEBUG_BUILD__'), before = globalThis.__LA_DEBUG_BUILD__;
  if (value === undefined) delete globalThis.__LA_DEBUG_BUILD__; else globalThis.__LA_DEBUG_BUILD__ = value;
  try { run(); } finally { if (had) globalThis.__LA_DEBUG_BUILD__ = before; else delete globalThis.__LA_DEBUG_BUILD__; }
}

test('10.0.2.2 is refused by default and by a release build, with the same reason as any other network address', () => {
  assert.equal(EMULATOR_HOST, '10.0.2.2');
  for (const flag of [undefined, false]) withDebugBuild(flag, () => {
    assert.equal(isDebugBuild(), false);
    assert.equal(isLoopbackHost('10.0.2.2'), false);
    assert.match(refused('http://10.0.2.2:8787'), /not encrypted/);
    assert.match(refused('10.0.2.2:8787'.replace(/^/, 'http://')), /not encrypted/);
    // https to it is an ordinary address and is not special either way.
    assert.equal(ok('https://10.0.2.2:8787').insecure, false);
  });
  // Only the real boolean true counts: nothing truthy-looking, nothing a page or a stored value could supply.
  for (const flag of ['true', 1, 'yes', {}, []]) withDebugBuild(flag, () => {
    assert.equal(isDebugBuild(), false, String(flag));
    assert.equal(isLoopbackHost('10.0.2.2'), false, String(flag));
  });
});

test('a debug build accepts exactly http://10.0.2.2 as this device, and nothing next to it', () => {
  withDebugBuild(true, () => {
    assert.equal(isDebugBuild(), true);
    assert.deepEqual(ok('http://10.0.2.2:8787'), { ok: true, url: 'http://10.0.2.2:8787', insecure: true });
    assert.equal(isLoopbackHost('10.0.2.2'), true);
    for (const host of ['10.0.2.20', '10.0.2.3', '10.0.2.2.evil.example', '10.0.0.2', '110.0.2.2', '192.168.0.1']) assert.equal(isLoopbackHost(host), false, host);
    for (const bad of ['http://10.0.2.3:8787', 'http://10.0.2.2.evil.example', 'http://192.168.1.20:8787']) assert.match(refused(bad), /not encrypted/, bad);
  });
});

test('normalizeAddress and hostName', () => {
  assert.equal(normalizeAddress('https://a.example/x/'), 'https://a.example/x');
  assert.equal(hostName('https://a.example:8443/x'), 'a.example:8443');
  assert.equal(hostName('not a url'), 'not a url');
});
