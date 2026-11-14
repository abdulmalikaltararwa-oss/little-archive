// Asking a server what it is, before anything secret is sent to it. GET /api/discovery needs no credentials.
import { hostName, normalizeAddress } from './server-url.js';

export class AppError extends Error {
  constructor(message, { field = '', cause } = {}) { super(message, { cause }); this.name = 'AppError'; this.field = field; }
}

const decoder = new TextDecoder();
export function bodyText(reply) { return typeof reply.body === 'string' ? reply.body : decoder.decode(reply.body || new Uint8Array()); }
export function bodyJson(reply) { try { return JSON.parse(bodyText(reply)); } catch { return null; } }

/**
 * @param {Function} http  the native HTTP client
 * @param {string} address a normalized server address
 * @param {{supabaseUrl: string}} config  the one sign-in service this app trusts for hosted accounts
 * @returns {Promise<{mode: 'self-hosted'|'hosted', url: string, version: string, supabaseUrl?: string}>}
 */
export async function discover(http, address, config) {
  const name = hostName(address);
  let reply;
  try { reply = await http({ url: `${address}/api/discovery`, method: 'GET', headers: { Accept: 'application/json' } }); }
  catch (error) { throw new AppError(`Could not reach ${name}. Check the address and your connection.`, { field: 'server', cause: error }); }
  if (reply.status === 400 && /invalid host/i.test(bodyText(reply))) throw new AppError(`${name} refused the request because it does not recognise this address. On the server, set LA_PUBLIC_URL to the address you typed.`, { field: 'server' });
  if (reply.status === 401 || reply.status === 403) throw new AppError(`${name} asked for a sign-in before saying what it is. Something in front of the server (a proxy or a private network gate) is blocking the app.`, { field: 'server' });
  if (reply.status === 404) throw new AppError(`${name} does not look like a Little Archive server, or it is too old for the app. Update the server and try again.`, { field: 'server' });
  if (reply.status < 200 || reply.status >= 300) throw new AppError(`${name} answered with an error (${reply.status}). Try again in a moment.`, { field: 'server' });
  const info = bodyJson(reply);
  if (!info || typeof info !== 'object' || info.name !== 'little-archive') throw new AppError(`${name} is a web server, but not a Little Archive server.`, { field: 'server' });
  if (info.api !== 1) throw new AppError(`${name} speaks a version of the Little Archive API that this app does not understand. Update the app or the server.`, { field: 'server' });
  const version = typeof info.version === 'string' ? info.version : '';
  if (info.mode === 'hosted') {
    const advertised = info.auth?.supabase_url;
    let pinned;
    try { pinned = normalizeAddress(advertised); } catch { pinned = ''; }
    // The email and password go to the sign-in service this server names. The app only sends them to the one it was built for.
    if (!pinned || pinned !== normalizeAddress(config.supabaseUrl)) throw new AppError(`${name} uses a sign-in service that this app does not trust, so it will not send your email or password there.`, { field: 'server' });
    return { mode: 'hosted', url: address, version, supabaseUrl: pinned };
  }
  if (info.mode === 'self-hosted') {
    if (!info.auth?.methods?.includes('device-token') || info.auth.device_token_url !== '/api/auth/devices') throw new AppError(`${name} does not offer sign-in for the app. Update the server.`, { field: 'server' });
    return { mode: 'self-hosted', url: address, version };
  }
  throw new AppError(`${name} reported a kind of server that this app does not know.`, { field: 'server' });
}
