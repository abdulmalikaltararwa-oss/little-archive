// The token the transport sends, and how it is kept fresh.
//
// A self-hosted device token does not expire: it is used until the owner revokes it. A hosted account's access token is
// short-lived, so it is exchanged for a new one shortly before it runs out, or once after the server refuses it. Only one
// exchange runs at a time, and the new tokens are written to secure storage before they are used (Supabase rotates the
// refresh token, so losing the new one would end the session).

/**
 * @param {object} options
 * @param {{server: object, credential: object|null}} options.record  what was loaded from the store
 * @param {object} options.store
 * @param {ReturnType<import('./supabase.js').createSupabase>} [options.supabase]  for a hosted account
 */
export function createCredentials({ record, store, supabase, now = Date.now, skewMs = 60_000 }) {
  let current = record.credential;
  let inFlight = null;

  async function exchange() {
    // Failing to reach the service throws; that is not a sign-out.
    const session = await supabase.refresh(current.refreshToken);
    if (!session) {
      // The refresh token was refused: this device's session is over.
      current = null;
      await store.signOut();
      return null;
    }
    current = session;
    await store.save({ ...record, credential: session });
    return session.accessToken;
  }

  function refreshOnce() {
    inFlight ||= exchange().finally(() => { inFlight = null; });
    return inFlight;
  }

  return {
    get kind() { return current?.type ?? null; },
    get email() { return current?.email || ''; },
    get accessToken() { return current?.type === 'supabase' ? current.accessToken : null; },
    async get() {
      if (!current) return null;
      if (current.type === 'device') return current.token;
      if (inFlight) return inFlight;
      return current.expiresAt - now() < skewMs ? refreshOnce() : current.accessToken;
    },
    /** Used once after a 401. `failed` is the token that was refused; if another request already replaced it, that one is used. */
    async refresh(failed) {
      if (current?.type !== 'supabase') return null;
      if (inFlight) return inFlight;
      if (failed && current.accessToken !== failed) return current.accessToken;
      return refreshOnce();
    },
    /** For the device token's own sign-out call. */
    get deviceToken() { return current?.type === 'device' ? current.token : null; },
    clear() { current = null; },
  };
}
