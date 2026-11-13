/** Explicit opt-in only: CI inference must stay on the runner's loopback host. */
export function localModelEnvironment(environment) {
  const supplied = environment.LA_E2E_OLLAMA_URL || '';
  const model = environment.LA_E2E_OLLAMA_MODEL || '';
  if (!supplied && !model) return { LA_OLLAMA_URL: '', LA_OLLAMA_MODEL: '' };
  if (!supplied || !model) throw new Error('Set both LA_E2E_OLLAMA_URL and LA_E2E_OLLAMA_MODEL for the real-model browser test.');
  let url;
  try { url = new URL(supplied); } catch { throw new Error('The E2E model URL must be a loopback HTTP(S) origin.'); }
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('The E2E model URL must be a loopback HTTP(S) origin without credentials or a path.');
  }
  return { LA_OLLAMA_URL: url.origin, LA_OLLAMA_MODEL: model };
}
