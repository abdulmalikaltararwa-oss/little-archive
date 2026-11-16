"""Revoking a person's Sign in with Apple when their account is deleted.

App Store guideline 5.1.1(v) and Apple's technical note TN3194 expect an app that offers Sign in with Apple to revoke the person's
Apple tokens when they delete their account. Apple's revoke endpoint takes a refresh token (or an access token), and the only way
to get one is to trade the one-time authorization code that Apple's sheet hands the app, within five minutes, using a client
secret signed with the team's Sign in with Apple key. Supabase's identity-token sign-in never sees that code and keeps no Apple
token, so this server does it:

1. Right after an Apple sign-in the app posts the authorization code (`POST /api/account/apple-authorization`). The server trades
   it at `https://appleid.apple.com/auth/token` and keeps the refresh token, one per account (the newest), in `accounts.sqlite3`.
2. When the account's library is deleted (the delete route, a retried sign-in deletion, or a deletion finished at start-up), the
   token is taken out of the database and Apple is asked once to revoke it (`/auth/revoke`), before the Supabase sign-in is
   removed. Whatever Apple answers, the deletion goes on and the token is not kept: an unreachable Apple is a logged warning, not
   a reason to keep someone's data or their token.

Off unless the operator sets the four `LA_APPLE_SIGNIN_*` values. Off, the route answers `{"stored": false}`, nothing is sent to
Apple and deletion is exactly what it was.

The secrets. The private key comes from the environment or a file outside the source tree and is held in memory only. The
refresh token is kept in one table and nowhere else. Neither, nor the authorization code or a client secret, is ever logged, put
in an error, returned by a route or part of a `repr`; errors carry a short reason code. A refresh token is of no use without a
client secret signed by the key, so the database alone does not let anyone act as the app towards Apple.

The request shapes follow Apple's "Generate and validate tokens", "Revoke tokens" and "Creating a client secret" pages (form
fields `client_id`, `client_secret`, `code`, `grant_type=authorization_code`; `token`, `token_type_hint=refresh_token`; an ES256
JWT with `kid`, `iss` the team id, `sub` the client id, `aud` `https://appleid.apple.com`). Verified only against a stand-in in this
repository's tests; Apple has not been asked.
"""
from __future__ import annotations

from contextlib import contextmanager
import logging
from pathlib import Path
import re
import sqlite3
from threading import RLock
import time

import httpx

from .identity import valid_user_id

log = logging.getLogger("little_archive")

APPLE_ORIGIN = "https://appleid.apple.com"
SECRET_SECONDS = 300  # a client secret is made for one request; Apple allows up to six months
MAX_ANSWER_BYTES = 64 * 1024
CODE = re.compile(r"[A-Za-z0-9._~+/=-]{8,2048}")
SCHEMA = "CREATE TABLE IF NOT EXISTS apple_signin_tokens(user_id TEXT PRIMARY KEY, refresh_token TEXT NOT NULL, stored_at INTEGER NOT NULL);"


class AppleUnavailable(Exception):
    """Apple did not do what was asked. `reason` is a short code, safe to log and to return; it never holds what was sent or answered."""

    def __init__(self, reason):
        super().__init__(reason)
        self.reason = reason


def load_private_key(text):
    """The team's Sign in with Apple key (the `.p8` file's contents). Raises ValueError that names the setting and never the key."""
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    try:
        key = serialization.load_pem_private_key(text.replace("\\n", "\n").strip().encode() + b"\n", password=None)
    except Exception:
        key = None
    if not isinstance(key, ec.EllipticCurvePrivateKey) or key.curve.name != "secp256r1":
        raise ValueError("The Sign in with Apple key is not a P-256 private key in PEM form. Use the contents of the .p8 file from your Apple developer account "
                         "(LA_APPLE_SIGNIN_PRIVATE_KEY, or its path in LA_APPLE_SIGNIN_PRIVATE_KEY_FILE).") from None
    return key


class AppleSignInClient:
    """The two requests to Apple: trade an authorization code for a refresh token, and revoke a refresh token."""

    def __init__(self, team_id, key_id, client_id, private_key, *, base_url=APPLE_ORIGIN, transport=None, timeout=10.0, clock=time.time):
        self._team, self._kid, self._client_id = team_id, key_id, client_id
        self._key = load_private_key(private_key) if isinstance(private_key, str) else private_key  # private: nothing reads it back out
        self._base, self._transport, self._timeout, self._clock = base_url.rstrip("/"), transport, float(timeout), clock

    def __repr__(self):
        return f"AppleSignInClient(client_id={self._client_id!r}, key=<hidden>)"

    __str__ = __repr__

    def _client_secret(self):
        import jwt
        moment = int(self._clock())
        return jwt.encode({"iss": self._team, "iat": moment, "exp": moment + SECRET_SECONDS, "aud": APPLE_ORIGIN, "sub": self._client_id},
                          self._key, algorithm="ES256", headers={"kid": self._kid})

    def _post(self, path, fields):
        """One form POST to Apple: no redirects (one would carry the secrets elsewhere), no ambient proxies, a bounded answer."""
        timeout = httpx.Timeout(self._timeout, connect=min(5.0, self._timeout))
        try:
            with httpx.Client(transport=self._transport, timeout=timeout, follow_redirects=False, trust_env=False) as client:
                response = client.post(self._base + path, data={"client_id": self._client_id, "client_secret": self._client_secret(), **fields},
                                       headers={"Accept": "application/json"})
        except httpx.TimeoutException:
            raise AppleUnavailable("timeout") from None
        except (httpx.HTTPError, OSError):
            raise AppleUnavailable("unreachable") from None
        status = response.status_code
        if status == 200:
            return response
        if 300 <= status < 400:
            raise AppleUnavailable("redirected")  # never followed
        if status == 429 or status >= 500:
            raise AppleUnavailable("service_unavailable")
        # Apple's ErrorResponse: {"error": one of a fixed list}. Only the two that say whose fault it is are told apart.
        try:
            error = response.json().get("error") if len(response.content) <= MAX_ANSWER_BYTES else None
        except (ValueError, AttributeError):
            error = None
        if error == "invalid_client":
            raise AppleUnavailable("key_refused")    # the team id, key id, client id or key is wrong; an operator has to fix it
        if error == "invalid_grant":
            raise AppleUnavailable("grant_refused")  # the code was used, expired or made for another app; or the token is no longer valid
        raise AppleUnavailable("rejected")

    def exchange(self, code):
        """Trade the app's one-time authorization code for the person's refresh token. Raises AppleUnavailable."""
        response = self._post("/auth/token", {"code": code, "grant_type": "authorization_code"})
        try:
            token = response.json().get("refresh_token") if len(response.content) <= MAX_ANSWER_BYTES else None
        except (ValueError, AttributeError):
            token = None
        if not isinstance(token, str) or not 8 <= len(token) <= 4096 or any(c.isspace() for c in token):
            raise AppleUnavailable("no_refresh_token")
        return token

    def revoke(self, refresh_token):
        """Ask Apple to revoke the token and the authorization behind it. Apple answers 200 for a token that was already invalid. Raises AppleUnavailable."""
        self._post("/auth/revoke", {"token": refresh_token, "token_type_hint": "refresh_token"})


def client_from_config(config):
    """The client for the configured key, or None when Sign in with Apple revocation is not configured."""
    if not config.apple_signin_configured:
        return None
    text = config.apple_signin_private_key
    if config.apple_signin_private_key_file:
        try:
            text = Path(config.apple_signin_private_key_file).read_text(encoding="utf-8")
        except (OSError, UnicodeError):
            raise ValueError("LA_APPLE_SIGNIN_PRIVATE_KEY_FILE could not be read. It must be the .p8 file from your Apple developer account.") from None
    return AppleSignInClient(config.apple_signin_team_id, config.apple_signin_key_id, config.apple_signin_client_id, text)


class AppleSignIn:
    """What the server holds for accounts that signed in with Apple: one refresh token each, until the account is deleted."""

    def __init__(self, path, client=None):
        self.path, self.client, self._lock = path, client, RLock()
        with self._transaction() as c:
            c.executescript(SCHEMA)

    @property
    def enabled(self):
        return self.client is not None

    @contextmanager
    def _transaction(self):
        with self._lock:
            conn = sqlite3.connect(self.path, timeout=15)
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA busy_timeout=15000")
            conn.execute("PRAGMA secure_delete=ON")  # a token that was taken out leaves no row remnant
            try:
                with conn:
                    yield conn
            finally:
                conn.close()

    def keep(self, user_id, code):
        """Trade the code and keep the refresh token for this account, replacing an earlier one. Raises AppleUnavailable."""
        user_id = valid_user_id(user_id)
        if not isinstance(code, str) or not CODE.fullmatch(code):
            raise AppleUnavailable("grant_refused")  # not something Apple's sheet gives out, so Apple is not asked
        token = self.client.exchange(code)
        with self._transaction() as c:
            c.execute("INSERT INTO apple_signin_tokens(user_id,refresh_token,stored_at) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET refresh_token=excluded.refresh_token,stored_at=excluded.stored_at",
                      (user_id, token, int(time.time())))

    def _take(self, user_id):
        with self._transaction() as c:
            c.execute("BEGIN IMMEDIATE")
            row = c.execute("SELECT refresh_token FROM apple_signin_tokens WHERE user_id=?", (user_id,)).fetchone()
            c.execute("DELETE FROM apple_signin_tokens WHERE user_id=?", (user_id,))
        return row[0] if row else None

    def forget(self, user_id):
        """The account is being deleted: revoke its Sign in with Apple, once, and keep nothing. Never raises and never delays a deletion for long.

        The token leaves the database before Apple is asked, so no outcome (a crash included) can leave it behind.
        """
        try:
            token = self._take(user_id)
        except Exception:
            log.warning("A deleted account's Sign in with Apple record could not be read, so Apple was not asked to revoke it.")
            raise  # the library's deletion notes the failure and repeats this step at the next start
        if token is None:
            return
        if self.client is None:
            log.warning("A deleted account had signed in with Apple, but Sign in with Apple revocation is no longer configured (LA_APPLE_SIGNIN_*), so Apple was not asked to revoke it.")
            return
        try:
            self.client.revoke(token)
        except AppleUnavailable as problem:
            if problem.reason == "key_refused":
                log.error("Apple refused the Sign in with Apple key, so a deleted account's Apple sign-in was not revoked. Check LA_APPLE_SIGNIN_TEAM_ID, LA_APPLE_SIGNIN_KEY_ID, LA_APPLE_SIGNIN_CLIENT_ID and the key.")
            elif problem.reason != "grant_refused":  # a token Apple no longer honours is already revoked
                log.warning("Apple could not be asked to revoke a deleted account's Sign in with Apple (%s). The account is deleted all the same; the person can end it themselves under Settings, Apple Account, Sign in with Apple.", problem.reason)
        except Exception:
            log.warning("Revoking a deleted account's Sign in with Apple failed unexpectedly. The account is deleted all the same.")

    def count(self):
        """How many accounts have a token kept. For tests and operators; never the tokens."""
        with self._transaction() as c:
            return c.execute("SELECT COUNT(*) FROM apple_signin_tokens").fetchone()[0]
