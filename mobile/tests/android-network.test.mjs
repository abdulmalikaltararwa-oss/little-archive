import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EMULATOR_HOST } from '../src/server-url.js';

// The address check in the app (src/server-url.js) and what Android itself allows must say the same thing, or a person
// is shown a screen that the platform then breaks. These read the two network security configs as shipped.
const res = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../android/app/src');
const release = readFileSync(path.join(res, 'main/res/xml/network_security_config.xml'), 'utf8');
const debug = readFileSync(path.join(res, 'debug/res/xml/network_security_config.xml'), 'utf8');
const manifest = readFileSync(path.join(res, 'main/AndroidManifest.xml'), 'utf8');
const strip = xml => xml.replace(/<!--[\s\S]*?-->/g, '');
const cleartextHosts = xml => [...strip(xml).matchAll(/<domain-config cleartextTrafficPermitted="true">\s*((?:<domain [^>]*>[^<]*<\/domain>\s*)+)<\/domain-config>/g)]
  .flatMap(match => [...match[1].matchAll(/<domain includeSubdomains="(true|false)">([^<]+)<\/domain>/g)].map(domain => ({ host: domain[2], subdomains: domain[1] === 'true' })));

test('release builds permit no cleartext traffic to any host, so the emulator address is not in them', () => {
  const xml = strip(release);
  assert.match(xml, /<base-config cleartextTrafficPermitted="false">/);
  assert.doesNotMatch(xml, /domain-config|<domain /, 'no cleartext exception of any kind');
  assert.doesNotMatch(xml, /10\.0\.2\.2/);
  assert.doesNotMatch(strip(manifest), /usesCleartextTraffic="true"/);
  assert.match(strip(manifest), /android:networkSecurityConfig="@xml\/network_security_config"/);
});

test('debug builds permit cleartext to this device and to the emulator host, and to nothing else', () => {
  assert.match(strip(debug), /<base-config cleartextTrafficPermitted="false">/);
  const hosts = cleartextHosts(debug);
  assert.deepEqual(hosts.map(entry => entry.host).sort(), ['10.0.2.2', '127.0.0.1', 'localhost']);
  assert.ok(hosts.every(entry => entry.subdomains === false), 'no subdomain wildcards');
  assert.ok(hosts.some(entry => entry.host === EMULATOR_HOST), 'the host the app calls the emulator host is the one Android allows');
  assert.doesNotMatch(strip(debug), /trust-anchors>\s*<certificates src="user"/, 'no user-installed certificate authorities');
});
