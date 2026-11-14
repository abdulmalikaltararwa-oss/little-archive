// What a person may type as "my own server", and what the app is willing to send credentials to.
//
// Sign-in sends the owner password (or an email and password) and every later request sends a bearer token, so the
// address has to be one that protects them: https, or plain http only to this device itself (a server you are
// developing on). A server on your home network that has no certificate is not accepted; put it behind https
// (see docs/phone.md and docs/mobile-app.md).

// 10.0.2.2 is how the Android emulator names the computer it runs on.
const LOOPBACK = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\]|10\.0\.2\.2)$/i;

export function isLoopbackHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  return LOOPBACK.test(host) || host.endsWith('.localhost');
}

/** The address as a bare origin plus optional path prefix, with no trailing slash. */
export function normalizeAddress(value) {
  const url = new URL(value);
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

/**
 * @returns {{ok: true, url: string, insecure: boolean} | {ok: false, message: string}}
 */
export function parseServerAddress(input) {
  const text = String(input ?? '').trim();
  if (!text) return { ok: false, message: 'Enter the address of your server, for example https://archive.example.com.' };
  if (text.length > 2048 || /[\s\u0000-\u001f\u007f]/u.test(text)) return { ok: false, message: 'That does not look like a web address. Check it for spaces or stray characters.' };
  // `scheme://` or a scheme followed by anything but a port number (so javascript:… and data:… are caught, localhost:8787 is a host).
  const scheme = /^([a-z][a-z0-9+.-]*):(?:\/\/|(?!\d))/i.exec(text)?.[1]?.toLowerCase();
  if (scheme && !['http', 'https'].includes(scheme)) return { ok: false, message: 'Little Archive servers use http:// or https:// addresses.' };
  // A bare host defaults to https, except this device itself, which can only be reached over http.
  const bareHost = /^(\[[^\]]+\]|[^/:?#]+)/.exec(text)?.[1] ?? '';
  const guess = !scheme && isLoopbackHost(bareHost) ? 'http' : 'https';
  let url;
  try { url = new URL(scheme ? text : `${guess}://${text}`); }
  catch { return { ok: false, message: 'That does not look like a web address. Try something like https://archive.example.com.' }; }
  if (!url.hostname) return { ok: false, message: 'That address has no host name.' };
  if (url.username || url.password) return { ok: false, message: 'Leave the user name and password out of the address. You will be asked for your password next.' };
  if (url.search || url.hash) return { ok: false, message: 'Enter just the address of the server, without anything after a ? or #.' };
  const insecure = url.protocol === 'http:';
  if (insecure && !isLoopbackHost(url.hostname)) return { ok: false, message: 'This address is not encrypted, so your password and library could be read on the way. Use an https:// address.' };
  return { ok: true, url: normalizeAddress(url.href), insecure };
}

/** A short name for showing the server in a sentence. */
export function hostName(address) {
  try { return new URL(address).host; } catch { return String(address); }
}
