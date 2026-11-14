"""Verifying a Google Play purchase: ask Google, with a service account, what became of the purchase token.

A purchase token proves nothing by itself, so the server never trusts one. It asks the Google Play Developer API
(`purchases.products.get`) and believes the answer. The caller reaches that API through `PlayClient`, an interface:
`GooglePlayClient` is the real one; tests use a stand-in.

Credentials come from a service account key file whose path is in the environment (`LA_GOOGLE_SERVICE_ACCOUNT_FILE`). The file is
read once at start-up and its private key is held only in this object, which never puts it in an error, a log line or a `repr`.
It is not in this repository and must not be put in one. The service account has to be invited to the Play Console with permission to
view financial data and manage orders, for the app; none of that was set up or tried when this was written.

Real-time developer notifications arrive as Google Cloud Pub/Sub push messages carrying a Google-signed OpenID token. `PushVerifier`
checks that token (signature against Google's published keys, issuer, audience and the configured service account's email). A
notification only says something changed, so what the server does with it is ask the API again (see service.py).

The request and response shapes follow Google's REST reference for `purchases.products` (ProductPurchase: purchaseState
0 purchased / 1 canceled / 2 pending, acknowledgementState 0 / 1, purchaseType 0 test, obfuscatedExternalAccountId) and the RTDN
reference (OneTimeProductNotification, VoidedPurchaseNotification, TestNotification). Exercised only against stand-ins.
"""
from __future__ import annotations

import base64
from dataclasses import dataclass
import hashlib
import json
from pathlib import Path
import re
import time
from urllib.parse import quote

import httpx

API = "https://androidpublisher.googleapis.com/androidpublisher/v3/applications"
SCOPE = "https://www.googleapis.com/auth/androidpublisher"
DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token"
CERTS_URL = "https://www.googleapis.com/oauth2/v3/certs"
ISSUERS = ("https://accounts.google.com", "accounts.google.com")
TOKEN_CHARS = re.compile(r"[A-Za-z0-9._\-]{1,2048}")


def account_tag(user_id):
    """What the app gives Google as the purchase's obfuscated account id: the account's id, hashed, so Google never holds it."""
    return hashlib.sha256(str(user_id).encode()).hexdigest()


def token_key(token):
    """What is stored in place of a purchase token. The token itself stays out of the database."""
    return hashlib.sha256(token.encode()).hexdigest()


class PlayError(Exception):
    """`kind`: not_found (Google does not know this token for this product), forbidden (the service account may not ask), unavailable (try later)."""

    def __init__(self, kind):
        super().__init__(kind)
        self.kind = kind


@dataclass(frozen=True)
class PlayPurchase:
    product_id: str
    state: str                  # purchased, canceled or pending
    order_id: str
    acknowledged: bool
    test: bool                  # bought by a licence tester, not paid for
    account_tag: str | None
    purchased_ms: int | None


class PlayClient:
    """What the service needs of Google Play. `GooglePlayClient` implements it; tests substitute their own."""

    def get_purchase(self, package, product_id, token) -> PlayPurchase:
        raise NotImplementedError

    def acknowledge(self, package, product_id, token) -> None:
        raise NotImplementedError


STATES = {0: "purchased", 1: "canceled", 2: "pending"}


class GooglePlayClient(PlayClient):
    def __init__(self, credentials, *, transport=None, clock=time.time, timeout=10.0):
        email, key = credentials.get("client_email"), credentials.get("private_key")
        if not isinstance(email, str) or not email or not isinstance(key, str) or "PRIVATE KEY" not in key:
            raise ValueError("The Google service account file has no client_email and private_key.")
        uri = credentials.get("token_uri")
        # The token address comes from a file an operator provides; it may only be Google's own.
        self._uri = uri if isinstance(uri, str) and re.fullmatch(r"https://[a-z0-9.-]+\.googleapis\.com/[A-Za-z0-9/_-]*", uri) else DEFAULT_TOKEN_URI
        self._email, self._key, self._transport, self._clock, self._timeout = email, key, transport, clock, float(timeout)
        self._token, self._expires = None, 0.0

    def __repr__(self):
        return f"GooglePlayClient(service_account={self._email!r}, key=<hidden>)"

    __str__ = __repr__

    @classmethod
    def from_file(cls, path, **options):
        """Read the key file once. Its content never appears in an error."""
        try:
            raw = Path(path).read_bytes()
            if len(raw) > 64 * 1024:
                raise ValueError
            credentials = json.loads(raw)
            if not isinstance(credentials, dict) or credentials.get("type") not in (None, "service_account"):
                raise ValueError
            return cls(credentials, **options)
        except (OSError, ValueError, TypeError):
            raise ValueError("LA_GOOGLE_SERVICE_ACCOUNT_FILE is not a readable Google service account key file.") from None

    def _client(self):
        return httpx.Client(transport=self._transport, timeout=httpx.Timeout(self._timeout, connect=min(5.0, self._timeout)), follow_redirects=False, trust_env=False)

    def _access_token(self):
        now = self._clock()
        if self._token and now < self._expires - 60:
            return self._token
        import jwt
        assertion = jwt.encode({"iss": self._email, "scope": SCOPE, "aud": self._uri, "iat": int(now), "exp": int(now) + 3600}, self._key, algorithm="RS256")
        try:
            with self._client() as client:
                response = client.post(self._uri, data={"grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer", "assertion": assertion})
        except (httpx.HTTPError, OSError):
            raise PlayError("unavailable") from None
        if response.status_code in (400, 401, 403):
            raise PlayError("forbidden")  # the key is wrong, disabled or not allowed: an operator has to fix it
        if response.status_code != 200:
            raise PlayError("unavailable")
        try:
            body = response.json()
            self._token, self._expires = str(body["access_token"]), now + float(body.get("expires_in", 3600))
        except (ValueError, KeyError, TypeError):
            raise PlayError("unavailable") from None
        return self._token

    def _call(self, method, package, product_id, token, suffix=""):
        if not re.fullmatch(r"[A-Za-z0-9._]{1,200}", package) or not re.fullmatch(r"[A-Za-z0-9._\-]{1,100}", product_id) or not TOKEN_CHARS.fullmatch(token):
            raise PlayError("not_found")
        url = f"{API}/{quote(package, safe='')}/purchases/products/{quote(product_id, safe='')}/tokens/{quote(token, safe='')}{suffix}"
        try:
            with self._client() as client:
                response = client.request(method, url, headers={"Authorization": "Bearer " + self._access_token(), "Accept": "application/json"}, **({"json": {}} if method == "POST" else {}))
        except (httpx.HTTPError, OSError):
            raise PlayError("unavailable") from None
        if response.status_code in (400, 404, 410):
            raise PlayError("not_found")
        if response.status_code in (401, 403):
            self._token = None
            raise PlayError("forbidden")
        if response.status_code == 429 or response.status_code >= 500:
            raise PlayError("unavailable")
        if response.status_code != 200:
            raise PlayError("unavailable")
        return response

    def get_purchase(self, package, product_id, token):
        try:
            body = self._call("GET", package, product_id, token).json()
            state, ack, kind = STATES.get(body.get("purchaseState")), body.get("acknowledgementState"), body.get("purchaseType")
            if state is None or ack not in (0, 1) or not isinstance(body.get("orderId", ""), str):
                raise PlayError("unavailable")
            tag = body.get("obfuscatedExternalAccountId")
            when = body.get("purchaseTimeMillis")
            return PlayPurchase(product_id=str(body.get("productId") or product_id), state=state, order_id=str(body.get("orderId", ""))[:100], acknowledged=ack == 1,
                                test=kind == 0, account_tag=tag if isinstance(tag, str) and tag else None,
                                purchased_ms=int(when) if isinstance(when, (int, str)) and str(when).isdigit() else None)
        except (ValueError, AttributeError):
            raise PlayError("unavailable") from None

    def acknowledge(self, package, product_id, token):
        self._call("POST", package, product_id, token, ":acknowledge")


class PushVerifier:
    """Checks the OpenID token that Pub/Sub attaches to a push request: Google signed it, for this endpoint, as this service account."""

    def __init__(self, audience, service_account, keys=None):
        if not audience or not service_account:
            raise ValueError("Real-time notifications need LA_GOOGLE_RTDN_AUDIENCE and LA_GOOGLE_RTDN_SERVICE_ACCOUNT.")
        self.audience, self.service_account = audience, service_account
        if keys is None:
            from ..identity import JWKSCache
            keys = JWKSCache(CERTS_URL)
        self.keys = keys

    def verify(self, token):
        """True only for a valid, current token for this audience and service account. Raises nothing the caller must handle except IdentityUnavailable."""
        import jwt
        if not isinstance(token, str) or not 0 < len(token) <= 8192 or token.count(".") != 2:
            return False
        try:
            header = jwt.get_unverified_header(token)
            kid = header.get("kid")
            if header.get("alg") != "RS256" or not isinstance(kid, str):
                return False
            found = self.keys.key(kid)
            if found is None or found[0] != "RS256":
                return False
            claims = jwt.decode(token, found[1], algorithms=["RS256"], audience=self.audience, options={"require": ["exp", "iat", "aud", "iss"]}, leeway=30)
        except jwt.PyJWTError:
            return False
        return claims.get("iss") in ISSUERS and claims.get("email") == self.service_account and claims.get("email_verified") is True


def decode_push(body):
    """The Pub/Sub push envelope's message as a dict (`DeveloperNotification`), or None when it is not one."""
    try:
        message = body["message"]
        data = json.loads(base64.b64decode(message["data"], validate=True))
        if not isinstance(data, dict) or not isinstance(message.get("messageId", ""), str):
            return None
        data["_message_id"] = str(message.get("messageId", ""))[:100]
        return data
    except (KeyError, TypeError, ValueError, AttributeError):
        return None
