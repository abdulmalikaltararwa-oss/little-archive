// Shared test doubles: a scripted native HTTP client and helpers for the answers it gives.
export const bytes = text => new TextEncoder().encode(text);
export const reply = (status, value, headers = {}) => ({ status, headers: { 'content-type': 'application/json', ...headers }, body: bytes(JSON.stringify(value)) });
export const text = (status, value) => ({ status, headers: { 'content-type': 'text/plain' }, body: bytes(value) });

/** `routes` maps "METHOD url" (or just "url") to a reply, a function of the request, or an Error to throw. */
export function fakeHttp(routes = {}) {
  const calls = [];
  const http = async request => {
    calls.push(request);
    const route = routes[`${request.method} ${request.url}`] ?? routes[request.url];
    if (route === undefined) throw new Error(`unexpected request ${request.method} ${request.url}`);
    const answer = typeof route === 'function' ? route(request, calls.length) : route;
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { http, calls };
}

export const CONFIG = {
  hostedServerUrl: 'https://app.little-archive.example',
  supabaseUrl: 'https://abcdefgh.supabase.co',
  supabasePublishableKey: 'sb_publishable_TESTKEYTESTKEYTESTKEYTESTKEY',
};

export const selfHostedInfo = { name: 'little-archive', version: '0.1.0', api: 1, mode: 'self-hosted', auth: { methods: ['password-session', 'device-token'], device_token_url: '/api/auth/devices' } };
export const hostedInfo = (supabaseUrl = CONFIG.supabaseUrl) => ({ name: 'little-archive', version: '0.1.0', api: 1, mode: 'hosted', auth: { methods: ['supabase-jwt'], supabase_url: supabaseUrl } });

/** An unsigned token whose payload the app can read (the app never verifies signatures; the server does). */
export function fakeJwt(claims) {
  const part = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'HS256', typ: 'JWT' })}.${part(claims)}.c2lnbmF0dXJl`;
}
