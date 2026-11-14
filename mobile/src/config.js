// app.config.json is the one place the hosted service is named. It holds public values only.
import { normalizeAddress, parseServerAddress } from './server-url.js';

const PUBLISHABLE = /^sb_publishable_[A-Za-z0-9_-]{20,}$/;
// What a secret would look like if one ended up in an app: a Supabase secret key, a JWT (the legacy anon and service keys are
// JWTs), a private key, an API key. Written so that this pattern does not match its own text in a bundle.
export const SECRET_LOOKING = /sb_secret_[A-Za-z0-9_-]{8,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\bsk[-_][A-Za-z0-9]{16,}/;

/** Returns the config normalised, or throws with the reason. Used by the build and again when the app starts. */
export function validateConfig(config) {
  const fail = message => { throw new Error(`app.config.json: ${message}`); };
  if (!config || typeof config !== 'object' || Array.isArray(config)) fail('it must be an object.');
  const allowed = new Set(['hostedServerUrl', 'supabaseUrl', 'supabasePublishableKey']);
  for (const key of Object.keys(config)) if (!allowed.has(key)) fail(`unknown setting "${key}". Only public values belong here.`);
  if (SECRET_LOOKING.test(JSON.stringify(config)) || /service_role|secret/i.test(JSON.stringify(config))) fail('a value looks like a secret key. Only the Supabase publishable key may be in the app.');
  const hosted = parseServerAddress(config.hostedServerUrl);
  if (!hosted.ok) fail(`hostedServerUrl: ${hosted.message}`);
  const supabase = parseServerAddress(config.supabaseUrl);
  if (!supabase.ok) fail(`supabaseUrl: ${supabase.message}`);
  if (typeof config.supabasePublishableKey !== 'string' || !PUBLISHABLE.test(config.supabasePublishableKey)) fail('supabasePublishableKey must be a publishable key (sb_publishable_…).');
  return { hostedServerUrl: hosted.url, supabaseUrl: normalizeAddress(supabase.url), supabasePublishableKey: config.supabasePublishableKey };
}
