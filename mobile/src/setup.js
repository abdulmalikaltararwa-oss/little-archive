// Connecting to a server and signing in. These are the steps behind the app's first-launch screens; the screens
// themselves are in ui.js. Each function either returns the record to keep in secure storage or throws an AppError whose
// message is fit to show.
import { AppError, bodyJson, discover } from './discovery.js';
import { createSupabase } from './supabase.js';
import { hostName, isLoopbackHost, normalizeAddress, parseServerAddress } from './server-url.js';

/** The server a person gets by choosing "Little Archive account". Fixed by app.config.json. */
export function hostedAddress(config) {
  const parsed = parseServerAddress(config.hostedServerUrl);
  if (!parsed.ok) throw new Error(`app.config.json: hostedServerUrl is not usable. ${parsed.message}`);
  return parsed.url;
}

/**
 * The common ways a typed address fails, said for someone setting up their own server. discover's own sentences are written for
 * the hosted service too, where talk of Wi-Fi and certificates would be out of place; anything not listed here keeps them.
 */
function ownServerProblem(error, address) {
  const name = hostName(address);
  let host = '';
  try { host = new URL(address).hostname; } catch { /* the name is enough */ }
  const words = {
    unreachable: isLoopbackHost(host)
      ? `Could not reach ${name}. On a phone, that address is the phone itself. Use your server's https:// address.`
      : `Could not reach ${name}. Check the address, that the server is running, and that this phone is on a network that can reach it: a server at home answers only on its own Wi-Fi unless you gave it a public address. The phone also refuses a certificate it does not trust, such as a self-signed one.`,
    'not-archive': `${name} answered, but not as a Little Archive server. Use the address you open Little Archive at in a browser, with its port if it has one. If that is the address, the server is older than this app needs: update it.`,
    'untrusted-service': `${name} runs in hosted mode: it signs people in with accounts, through a sign-in service that this app does not trust, so the app will not send your email or password there. A server of your own has to run in self-hosted mode to work with this app.`,
  }[error?.code];
  return words ? new AppError(words, { field: 'server', code: error.code, cause: error }) : error;
}

/** Step one for a server the person typed: is it a Little Archive server, and which kind? */
export async function checkServer({ http, config, input }) {
  const parsed = parseServerAddress(input);
  if (!parsed.ok) throw new AppError(parsed.code === 'not-encrypted' ? `${parsed.message} The self-hosting guide, linked below, covers this under "Reverse proxy".` : parsed.message, { field: 'server', code: parsed.code || '' });
  let found;
  try { found = await discover(http, parsed.url, config); } catch (error) { throw ownServerProblem(error, parsed.url); }
  return { ...found, insecure: parsed.insecure };
}

/**
 * Self-hosted sign-in. The owner password is sent once, to this server, and exchanged for a revocable device token.
 * Only the token is returned: the password is not kept anywhere.
 */
export async function signInSelfHosted({ http, address, password, deviceName }) {
  if (!password) throw new AppError('Enter your password.', { field: 'password' });
  let reply;
  try {
    reply = await http({ url: `${address}/api/auth/devices`, method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify({ password, name: String(deviceName).slice(0, 100) }) });
  } catch (error) { throw new AppError(`Could not reach ${hostName(address)}. Check your connection and try again.`, { cause: error }); }
  const body = bodyJson(reply) || {};
  if (reply.status === 401) throw new AppError('That password did not match. Use the owner password for this server.', { field: 'password' });
  if (reply.status === 429) throw new AppError('Too many attempts. Wait 15 minutes and try again.', { field: 'password' });
  if (reply.status === 404) throw new AppError('This server does not take a password. It may be a hosted service: go back and choose Little Archive account.');
  if (reply.status === 400 && typeof body.detail === 'string') throw new AppError(body.detail);
  if (reply.status !== 200 || typeof body.token !== 'string' || !body.token.startsWith('lad_')) throw new AppError('The server did not accept the sign-in. Try again, and check its logs if it keeps happening.');
  return { type: 'device', token: body.token, id: String(body.id || ''), name: String(body.name || deviceName) };
}

/** What the sign-in screen for a hosted account needs. */
export function hostedClient({ http, config, now }) {
  return createSupabase({ url: config.supabaseUrl, publishableKey: config.supabasePublishableKey, http, now });
}

export function serverRecord(found, credential) {
  return { v: 1, server: { kind: found.mode, url: normalizeAddress(found.url) }, credential };
}

/** A name the owner will recognise in the list of devices on their server. */
export function deviceName(platform) {
  return `Little Archive app (${{ ios: 'iPhone or iPad', android: 'Android' }[platform] || platform})`;
}
