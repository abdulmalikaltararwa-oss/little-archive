// The app's HTTP client: Capacitor's native one (URLSession on iOS, HttpURLConnection on Android), called explicitly.
//
// Why native and not the web view's fetch: a native request is not a cross-origin browser request, so the server needs no
// CORS allowance for the app's origins (capacitor://localhost, https://localhost) and the password-login origin check on
// the server stays exactly as strict as it is. It also carries no Origin header and does not use the web view's cookies.
//
// Capacitor's own option to patch window.fetch is left off (capacitor.config.json). Only code that calls this function can
// reach the network, and the web view's content security policy (connect-src 'self') blocks everything else.

const CHUNK = 0x8000;

export function toBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(binary);
}

export function fromBase64(text) {
  const binary = atob(text); // atob ignores the line breaks Android adds
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

const lower = headers => Object.fromEntries(Object.entries(headers || {}).filter(([name]) => name).map(([name, value]) => [name.toLowerCase(), String(value)]));

/**
 * @param {{request(options: object): Promise<{status: number, headers: object, data: any}>}} CapacitorHttp
 * @returns {(request: {url: string, method: string, headers?: object, body?: string|Uint8Array}) => Promise<{status: number, headers: object, body: Uint8Array}>}
 */
export function createNativeHttp(CapacitorHttp, { connectTimeout = 30_000 } = {}) {
  const encoder = new TextEncoder();
  return async function http({ url, method = 'GET', headers = {}, body }) {
    const options = {
      url, method,
      headers: { ...headers },
      // A 3xx is returned as it is, never followed: a credential must not travel to a second address.
      disableRedirects: true,
      connectTimeout,
      // Answers that are not JSON come back base64 encoded, whatever they hold.
      responseType: 'blob',
    };
    if (body !== undefined) {
      // The native clients only send a body when a content type is set.
      const hasType = Object.keys(options.headers).some(name => name.toLowerCase() === 'content-type');
      if (typeof body === 'string') {
        if (!hasType) options.headers['Content-Type'] = 'text/plain; charset=utf-8';
        options.data = body;
      } else {
        if (!hasType) options.headers['Content-Type'] = 'application/octet-stream';
        options.data = toBase64(body);
        options.dataType = 'file'; // the native side decodes the base64 back to bytes
      }
    }
    const reply = await CapacitorHttp.request(options);
    const headersOut = lower(reply.headers);
    const json = /json/i.test(headersOut['content-type'] || '');
    const data = reply.data;
    let bytes;
    if (data == null || data === '') bytes = new Uint8Array();
    else if (typeof data === 'object') bytes = encoder.encode(JSON.stringify(data)); // a JSON answer arrives already parsed
    else if (!json && reply.status < 400) bytes = fromBase64(String(data));
    else bytes = encoder.encode(String(data)); // text (an error page from a proxy, say)
    return { status: reply.status, headers: headersOut, body: bytes };
  };
}
