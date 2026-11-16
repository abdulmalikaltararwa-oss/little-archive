// The one place a request is made. It adds what every request needs (JSON, the CSRF token where the backend
// uses a cookie), turns every failure into a sentence a person can read, and reports a refused credential.
import type { Backend } from './backend';

export interface RequestOptions {
  method?: string;
  /** A JSON-serialisable value, or with `raw` a Blob/ArrayBuffer sent as it is. */
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  raw?: boolean;
}

export class ApiError extends Error {
  readonly status: number;
  /** The stable machine code some routes send beside `detail` (for example `unlock_required`). Switch on this, not on the words. */
  readonly code: string;
  /** Everything else the error body carried (`feature`, `retryable`, `missing`, …). */
  readonly extra: Record<string, unknown>;
  constructor(message: string, status: number, code = '', extra: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

/** True for the answer a hosted account gets from a feature it has not unlocked. */
export function isLocked(error: unknown): error is ApiError {
  return error instanceof ApiError && error.status === 402 && error.code === 'unlock_required';
}

/** The code of the server's refusal to send saved content to an AI service without the owner's permission. */
export const AI_PERMISSION_REQUIRED = 'ai_permission_required';

export const UNREACHABLE = 'Could not reach your archive. Check that the server is running and try again.';

export interface ClientHooks {
  /** True while the interface believes it is signed in. */
  isAuthenticated(): boolean;
  /** The server answered 401 to a signed-in request. `detail` is its sentence (it says so when a device's sign-in expired). */
  onUnauthorized(detail: string): void;
  /**
   * The server refused to send saved content to an AI service because the owner has not allowed it
   * (`ai_permission_required`). Resolves true once they have, and the request is then made once more.
   */
  onAiPermissionRequired?(): Promise<boolean>;
}

export interface Client {
  readonly backend: Backend;
  request<T>(path: string, options?: RequestOptions): Promise<T>;
  download(path: string, fallbackName: string): Promise<{ blob: Blob; filename: string }>;
  setCsrf(token: string): void;
}

function detailMessage(payload: unknown, status: number): string {
  const detail = (payload as { detail?: unknown } | null)?.detail;
  if (Array.isArray(detail)) return detail.map(entry => (entry as { msg?: string })?.msg || 'Invalid field').join('. ');
  return typeof detail === 'string' ? detail : `Request failed (${status}). Please try again.`;
}

export function createClient(backend: Backend, hooks: ClientHooks): Client {
  let csrf = '';

  async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    try {
      return await send<T>(path, options);
    } catch (error) {
      // The interface asks before an AI action, but its copy of the answer can be out of date (withdrawn on
      // another device). The server's refusal then becomes the same question, not an error, and one more try.
      if (!(error instanceof ApiError) || error.code !== AI_PERMISSION_REQUIRED || !(await hooks.onAiPermissionRequired?.())) throw error;
      return send<T>(path, options);
    }
  }

  async function send<T>(path: string, { method = 'GET', body, headers = {}, signal, raw = false }: RequestOptions = {}): Promise<T> {
    const init: RequestInit = { method, headers: { Accept: 'application/json', ...headers }, signal };
    const sent = init.headers as Record<string, string>;
    if (body != null) {
      if (raw) init.body = body as BodyInit;
      else {
        init.body = JSON.stringify(body);
        sent['Content-Type'] = 'application/json';
      }
    }
    if (backend.csrf && !['GET', 'HEAD'].includes(method) && csrf) sent['X-CSRF-Token'] = csrf;
    let response: Response;
    try {
      response = await backend.fetch(`/api${path}`, init);
    } catch (error) {
      if ((error as Error)?.name === 'AbortError') throw error;
      throw new ApiError(UNREACHABLE, 0);
    }
    const payload: unknown = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = detailMessage(payload, response.status);
      if (response.status === 401 && hooks.isAuthenticated() && path !== '/auth/login') hooks.onUnauthorized(message);
      const { detail: _detail, code, ...extra } = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
      // When waiting is the answer the server says for how long, in a header; keep it beside the body's own fields.
      const wait = Number(response.headers.get('Retry-After'));
      if (extra.retry_after == null && Number.isFinite(wait) && wait > 0) extra.retry_after = wait;
      throw new ApiError(message, response.status, typeof code === 'string' ? code : '', extra);
    }
    return payload as T;
  }

  async function download(path: string, fallbackName: string) {
    let response: Response;
    try {
      response = await backend.fetch(`/api${path}`);
    } catch {
      throw new ApiError(UNREACHABLE, 0);
    }
    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as { detail?: unknown };
      throw new ApiError(typeof payload.detail === 'string' ? payload.detail : 'The download could not be prepared. Please sign in and try again.', response.status);
    }
    const blob = await response.blob();
    const disposition = response.headers.get('Content-Disposition') || '';
    const filename = disposition.match(/filename="?([^";]+)"?/i)?.[1] || fallbackName;
    return { blob, filename };
  }

  return { backend, request, download, setCsrf: token => { csrf = token; } };
}
