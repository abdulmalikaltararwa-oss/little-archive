"""Hosted-mode identity: verify Supabase Auth access tokens. No passwords here.

A token proves an account only if its signature, issuer, audience, expiry and
algorithm all check out against operator configuration. The key is always
chosen by this server from the token's algorithm family: the legacy shared
secret verifies HS256 only, and a published signing key verifies only the
asymmetric algorithm its own type implies. A token never selects its key
material, so an asymmetric public key cannot be replayed as an HMAC secret.
"""
from dataclasses import dataclass
import json
import re
from threading import Lock
import time


USER_ID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
ASYMMETRIC = {"ES256", "RS256"}
MAX_TOKEN_CHARS = 8192
MAX_JWKS_BYTES = 64 * 1024
MAX_KEYS = 16


class IdentityError(Exception):
    """The presented token does not prove an account. Details stay server-side."""


class IdentityUnavailable(Exception):
    """Signing keys could not be obtained; this is not evidence about the token."""


@dataclass(frozen=True)
class Identity:
    user_id: str
    issued_at: int
    expires_at: int


def valid_user_id(value):
    """A canonical lowercase UUID, safe to use as one path component."""
    if not isinstance(value, str) or not USER_ID.fullmatch(value) or value == "00000000-0000-0000-0000-000000000000":
        raise ValueError("Account identifiers are canonical lowercase UUIDs.")
    return value


def fetch_jwks(url):
    """One bounded GET to the configured project; no redirects or ambient proxies."""
    import httpx
    deadline = time.monotonic() + 8
    with httpx.Client(timeout=httpx.Timeout(5, connect=3), follow_redirects=False, trust_env=False) as client:
        with client.stream("GET", url, headers={"Accept": "application/json", "Accept-Encoding": "identity"}) as response:
            if response.status_code != 200:
                raise ValueError("The signing-key endpoint did not return its key set.")
            chunks, size = [], 0
            for chunk in response.iter_bytes():
                size += len(chunk)
                if size > MAX_JWKS_BYTES or time.monotonic() > deadline:
                    raise ValueError("The signing-key response exceeded its size or time limit.")
                chunks.append(chunk)
    return json.loads(b"".join(chunks))


def _public_keys(document):
    """Keep only well-formed public signature keys, each bound to one algorithm."""
    import jwt
    rows = document.get("keys") if isinstance(document, dict) else None
    if not isinstance(rows, list) or len(rows) > MAX_KEYS:
        raise ValueError("The signing-key response is not a bounded key set.")
    keys = {}
    for row in rows:
        if not isinstance(row, dict):
            continue
        kid = row.get("kid")
        if not isinstance(kid, str) or not kid or len(kid) > 200 or kid in keys:
            continue
        operations = row.get("key_ops", ["verify"])
        if row.get("use", "sig") != "sig" or not isinstance(operations, list) or "verify" not in operations:
            continue
        if row.get("kty") == "EC" and row.get("crv") == "P-256":
            algorithm, fields = "ES256", ("kty", "crv", "x", "y")
        elif row.get("kty") == "RSA":
            algorithm, fields = "RS256", ("kty", "n", "e")
        else:
            continue
        if row.get("alg", algorithm) != algorithm:
            continue
        try:
            # Copy public members only; private parameters are never loaded.
            key = jwt.PyJWK({name: row[name] for name in fields}, algorithm=algorithm).key
        except (KeyError, TypeError, ValueError, jwt.PyJWTError):
            continue
        if algorithm == "RS256" and key.key_size < 2048:
            continue
        keys[kid] = (algorithm, key)
    return keys


class JWKSCache:
    """Published signing keys, refreshed on expiry and when an unknown key id appears.

    `ttl` is how long a key set is used without asking again. An unknown key id
    (rotation) triggers an early refresh, at most once per `min_refresh` seconds so
    arbitrary key ids cannot drive outbound requests. If the endpoint is
    unreachable, the last key set is honoured for `stale` seconds, then refused.
    """

    def __init__(self, url, fetch=fetch_jwks, ttl=600, min_refresh=30, stale=3600, clock=time.monotonic):
        self.url, self.fetch, self.ttl, self.min_refresh, self.stale, self.clock = url, fetch, ttl, min_refresh, stale, clock
        self._keys, self._fetched, self._attempted = {}, None, None
        self._lock, self._refreshing = Lock(), Lock()  # state, and at most one fetch at a time

    def _due(self, kid):
        moment = self.clock()
        fresh = self._fetched is not None and moment - self._fetched < self.ttl
        return not (fresh and kid in self._keys) and (self._attempted is None or moment - self._attempted >= self.min_refresh)

    def key(self, kid):
        with self._lock:
            due, cold = self._due(kid), self._fetched is None
        # The request is made outside the state lock: while one caller refreshes,
        # others keep verifying against the keys already held. Only a server with
        # no keys at all waits for the fetch in flight.
        if (due or cold) and self._refreshing.acquire(blocking=cold):
            try:
                with self._lock:
                    due = self._due(kid)
                    if due:
                        self._attempted = self.clock()
                if due:
                    try:
                        keys = _public_keys(self.fetch(self.url))
                    except Exception:
                        keys = None  # Keep the previous key set; staleness is judged below.
                    if keys is not None:
                        with self._lock:
                            self._keys, self._fetched = keys, self.clock()
            finally:
                self._refreshing.release()
        with self._lock:
            if self._fetched is None or self.clock() - self._fetched >= self.stale:
                raise IdentityUnavailable("Signing keys are unavailable.")
            return self._keys.get(kid)


class SupabaseVerifier:
    def __init__(self, *, issuer, audience, jwks=None, secret="", leeway=10):
        if not issuer or not audience or (jwks is None and not secret):
            raise ValueError("Hosted identity needs an issuer, an audience, and signing keys or the legacy secret.")
        self.issuer, self.audience, self.jwks, self.leeway = issuer, audience, jwks, leeway
        self.secret = secret.encode() if isinstance(secret, str) else secret

    @classmethod
    def from_config(cls, config, fetch=fetch_jwks):
        return cls(issuer=config.supabase_issuer, audience=config.supabase_jwt_audience,
                   jwks=JWKSCache(config.supabase_jwks_url, fetch=fetch), secret=config.supabase_jwt_secret)

    def verify(self, token):
        import jwt
        if not isinstance(token, str) or not token or len(token) > MAX_TOKEN_CHARS or token.count(".") != 2:
            raise IdentityError("Malformed token.")
        try:
            header = jwt.get_unverified_header(token)
        except jwt.PyJWTError as exc:
            raise IdentityError("Malformed token.") from exc
        algorithm = header.get("alg")
        if not isinstance(algorithm, str):
            raise IdentityError("Unsupported algorithm.")
        if algorithm == "HS256":
            if not self.secret:
                raise IdentityError("Shared-secret tokens are not enabled.")
            key = self.secret
        elif algorithm in ASYMMETRIC:
            kid = header.get("kid")
            if self.jwks is None or not isinstance(kid, str) or not kid or len(kid) > 200:
                raise IdentityError("Unknown signing key.")
            found = self.jwks.key(kid)
            if found is None or found[0] != algorithm:
                raise IdentityError("Unknown signing key.")
            key = found[1]
        else:
            raise IdentityError("Unsupported algorithm.")
        try:
            claims = jwt.decode(
                token, key, algorithms=[algorithm], audience=self.audience, issuer=self.issuer, leeway=self.leeway,
                options={"require": ["exp", "iat", "sub", "aud", "iss"], "strict_aud": True, "enforce_minimum_key_length": True},
            )
        except jwt.PyJWTError as exc:
            raise IdentityError("Token rejected.") from exc
        try:
            user_id = valid_user_id(claims["sub"])
        except ValueError as exc:
            raise IdentityError("Token subject is not an account.") from exc
        # API keys and anonymous sign-ins are signed by the same project but are not accounts.
        if claims.get("role") != "authenticated" or claims.get("is_anonymous", False) is not False:
            raise IdentityError("Token is not for a signed-in account.")
        if any(not isinstance(claims[name], int) or isinstance(claims[name], bool) for name in ("iat", "exp")):
            raise IdentityError("Token times are not whole seconds.")
        return Identity(user_id=user_id, issued_at=claims["iat"], expires_at=claims["exp"])
