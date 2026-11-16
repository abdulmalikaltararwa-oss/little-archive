#!/usr/bin/env python3
"""A small local stand-in for Supabase Auth, so the app's hosted flow can be tried on this computer.

Development only. It is not Supabase and secures nothing: accounts live in memory, and it signs access tokens with a
secret that you choose when you start it. Use it with a hosted-mode Little Archive server that trusts the same secret:

    export STUB_JWT_SECRET="$(python3 -c 'import secrets; print(secrets.token_urlsafe(48))')"
    export STUB_PUBLISHABLE_KEY="the sb_publishable_... value from app.config.json"
    export STUB_SECRET_KEY="sb_secret_$(python3 -c 'import secrets; print(secrets.token_urlsafe(24))')"
    python3 mobile/dev/stub_supabase.py --port 8853 &

    LA_MODE=hosted LA_SUPABASE_URL=http://127.0.0.1:8853 LA_SUPABASE_JWT_SECRET="$STUB_JWT_SECRET" \\
    LA_SUPABASE_SERVICE_KEY="$STUB_SECRET_KEY" \\
    LA_PUBLIC_URL=http://localhost:8852 LA_DATA_DIR=/tmp/la-hosted \\
    python -m uvicorn server.app:create_app --factory --port 8852

(The server refuses to start in hosted mode without LA_SUPABASE_SERVICE_KEY, so that deleting an account can delete its sign-in; the
stand-in makes up a key for that and removes the user when the server asks.)

Build the app against both with a development config (see docs/mobile-app.md). Settings, all optional:

    STUB_EXPIRES_IN    seconds an access token lives (default 3600; use 90 to watch refreshing)
    STUB_CONFIRM=1     sign-up answers "check your email" without a session, like a project that confirms emails

For "Continue with Google" and "Continue with Apple" (see docs/mobile-app.md):

    STUB_PROVIDERS_OFF     comma list of providers the project has not switched on (google, apple): answered as Supabase does
    STUB_GOOGLE_MODE       ask (default: a page with Continue and Cancel), approve, or deny: what the stand-in "Google" does
    STUB_GOOGLE_EMAIL      the email the stand-in Google account has (default google.reader@example.test)
    STUB_REDIRECT_ALLOW    comma list of redirect URLs the project allows (default littlearchive://auth-callback); any other
                           redirect_to falls back to STUB_SITE_URL (default http://localhost:3000), as the real project does
    STUB_APPLE_CLIENT_IDS  comma list of bundle ids the Apple settings accept (default app.littlearchive.mobile)
    STUB_CODE_TTL          seconds a PKCE code lasts (default 300, Supabase's five minutes)

For a forgotten password (see docs/mobile-app.md):

    STUB_OTP_TTL           seconds an emailed link lasts (default 3600)
    STUB_MAIL_GAP          seconds before the same address can be sent another link (default 60, Supabase's)

No email is sent. What would have been sent is listed at http://127.0.0.1:<port>/stand-in-mail (a page of links; open it in the
simulator's browser and tap one). That page exists only here: the real service has nothing like it.

Routes: signup, token (password, refresh_token, pkce and id_token grants), settings, authorize (with a stand-in Google), recover,
verify (the emailed link), user (PUT, a new password), logout, an empty key set, and the admin call that deletes a user
(`DELETE /auth/v1/admin/users/<id>`, which needs the secret key in the `apikey` header). The routes the real service answers to a
browser (authorize, verify and the stand-in's own pages) need no key; the others require the publishable key in the `apikey`
header, as the real service does.

A reset link follows the real server's source (internal/api/recover.go, verify.go, user.go, mail.go): an unknown address is
answered like a known one (200, an empty object) and nothing is sent; a known one asked again too soon is a 429; with a code
challenge the link's token starts with `pkce_` and the link redirects with `?code=`, without one it redirects with a session in the
fragment; a link that is too old or was already opened redirects with `error_code=otp_expired`; and the code of a PKCE link is
measured from when the link was asked for, not from when it was opened (models/flow_state.go), so STUB_CODE_TTL covers both.

The id_token grant takes an Apple identity token such as `apple_token` below makes. It reads the claims and does NOT check the
signature: only the real service can check Apple's.
"""
import argparse
import base64
import hashlib
import hmac
import json
import os
import re
import sys
import time
from html import escape
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlencode, urlsplit
from uuid import uuid4

USERS = {}      # key -> {"id", "password", "email"}: the key is the email of a password account, "google:<sub>" or "apple:<sub>" otherwise
REFRESH = {}    # refresh token -> key
FLOWS = {}      # state -> {"redirect", "challenge", "method", "prompt"}: a browser sign-in that has started
CODES = {}      # auth code -> {"key", "challenge", "method", "made"}: one that Google approved and that waits to be traded
OTPS = {}       # the token of an emailed link -> {"key", "challenge", "method", "made"}: a reset link that has not been opened
MAILS = []      # {"to", "link"}: what would have been emailed, newest last (see /stand-in-mail)


def b64(data):
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def sha256_hex(text):
    return hashlib.sha256(text.encode()).hexdigest()


def apple_token(nonce_hash, sub="001234.stand.in", audience="app.littlearchive.mobile", email=None):
    """An unsigned stand-in for the identity token Apple's sheet returns. `nonce_hash` is what the app gave Apple (lower case hex)."""
    claims = {"iss": "https://appleid.apple.com", "aud": audience, "sub": sub, "iat": int(time.time()), "exp": int(time.time()) + 600, "nonce": nonce_hash, "nonce_supported": True}
    if email is not None:
        claims.update({"email": email, "email_verified": "true"})
    return f"{b64(json.dumps({'alg': 'none'}).encode())}.{b64(json.dumps(claims).encode())}.{b64(b'stand-in')}"


def token_claims(token):
    try:
        part = token.split(".")[1]
        return json.loads(base64.urlsafe_b64decode(part + "=" * (-len(part) % 4)))
    except (IndexError, ValueError):
        return None


def access_token(secret, issuer, user_id, email, lifetime):
    now = int(time.time())
    header = b64(json.dumps({"alg": "HS256", "typ": "JWT"}).encode())
    claims = {"iss": issuer, "aud": "authenticated", "sub": user_id, "role": "authenticated", "email": email, "is_anonymous": False, "iat": now, "exp": now + lifetime}
    payload = b64(json.dumps(claims).encode())
    signature = b64(hmac.new(secret.encode(), f"{header}.{payload}".encode(), hashlib.sha256).digest())
    return f"{header}.{payload}.{signature}"


class Handler(BaseHTTPRequestHandler):
    secret = ""
    issuer = ""
    publishable = ""
    secret_key = ""
    lifetime = 3600
    confirm = False
    providers_off = set()
    google_mode = "ask"
    google_email = "google.reader@example.test"
    redirect_allow = {"littlearchive://auth-callback"}
    site_url = "http://localhost:3000"
    apple_client_ids = {"app.littlearchive.mobile"}
    code_ttl = 300
    otp_ttl = 3600
    mail_gap = 60

    def log_message(self, *args):
        pass

    def send(self, status, body=None):
        data = b"" if body is None else json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def session(self, key):
        user = USERS[key]
        email = user.get("email", key)
        refresh = "r-" + uuid4().hex
        REFRESH[refresh] = key
        token = access_token(self.secret, self.issuer, user["id"], email, self.lifetime)
        return {"access_token": token, "token_type": "bearer", "expires_in": self.lifetime, "expires_at": int(time.time()) + self.lifetime, "refresh_token": refresh, "user": {"id": user["id"], "email": email}}

    def identity(self, key, email):
        """The account behind a Google or Apple identity, made the first time it is seen. `email` may be empty (Apple can withhold it)."""
        USERS.setdefault(key, {"id": str(uuid4()), "password": None, "email": email})
        return key

    def redirect(self, location):
        """A 302 with the small HTML body the real service sends with it (Go's http.Redirect writes one for a GET)."""
        data = f'<a href="{escape(location)}">Found</a>.\n\n'.encode()
        self.send_response(302)
        self.send_header("Location", location)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def page(self, html):
        data = html.encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def authorised(self):
        if self.headers.get("apikey") != self.publishable:
            self.send(401, {"code": 401, "error_code": "no_authorization", "msg": "No API key found in request"})
            return False
        return True

    def bearer(self):
        """The account an access token of this stand-in belongs to (its key in USERS), or None after answering 401."""
        header = self.headers.get("Authorization", "")
        token = header[7:] if header.lower().startswith("bearer ") else ""
        parts = token.split(".")
        claims = token_claims(token) if len(parts) == 3 else None
        signed = claims is not None and hmac.compare_digest(parts[2], b64(hmac.new(self.secret.encode(), f"{parts[0]}.{parts[1]}".encode(), hashlib.sha256).digest()))
        if not token:
            self.send(401, {"code": 401, "error_code": "no_authorization", "msg": "This endpoint requires a Bearer token"})
            return None
        if not signed or claims.get("exp", 0) < time.time():
            self.send(403, {"code": 403, "error_code": "bad_jwt", "msg": "invalid JWT: unable to parse or verify signature, or token is expired"})
            return None
        for key, user in USERS.items():
            if user["id"] == claims.get("sub"):
                return key
        self.send(403, {"code": 403, "error_code": "user_not_found", "msg": "User from sub claim in JWT does not exist"})
        return None

    def do_PUT(self):
        """PUT /auth/v1/user: the signed-in account changes its own password (internal/api/user.go)."""
        if urlsplit(self.path).path != "/auth/v1/user":
            return self.send(404, {"msg": "not found"})
        if not self.authorised():
            return
        length = int(self.headers.get("Content-Length") or 0)
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except ValueError:
            return self.send(400, {"code": 400, "error_code": "bad_json", "msg": "Could not parse request body as JSON"})
        key = self.bearer()
        if key is None:
            return
        user = USERS[key]
        if "password" in body:
            password = str(body["password"])
            if len(password) < 8:
                return self.send(422, {"code": 422, "error_code": "weak_password", "msg": "Password should be at least 8 characters."})
            if user["password"] is not None and user["password"] == password:
                return self.send(422, {"code": 422, "error_code": "same_password", "msg": "New password should be different from the old password."})
            user["password"] = password
        self.send(200, {"id": user["id"], "email": user.get("email", key)})

    def recover(self, query, body):
        """POST /auth/v1/recover: email a reset link (internal/api/recover.go). The answer never says whether the address has an account."""
        email = str(body.get("email", "")).strip().lower()
        challenge, method = str(body.get("code_challenge") or ""), str(body.get("code_challenge_method") or "")
        if "@" not in email:
            return self.send(400, {"code": 400, "error_code": "validation_failed", "msg": "Unable to validate email address: invalid format"})
        if bool(challenge) != bool(method):
            return self.send(400, {"code": 400, "error_code": "validation_failed", "msg": "PKCE flow requires code_challenge_method and code_challenge"})
        if challenge and (not 43 <= len(challenge) <= 128 or not re.fullmatch(r"[A-Za-z0-9._~-]+", challenge) or method.lower() not in ("s256", "plain")):
            return self.send(400, {"code": 400, "error_code": "validation_failed", "msg": "code challenge has to be between 43 and 128 characters"})
        # Any account with this address, however it signs in: the real server looks the user up by email alone.
        key = next((name for name, user in USERS.items() if user.get("email", name) == email), None)
        if key is None:
            return self.send(200, {})
        user = USERS[key]
        wait = self.mail_gap - (time.time() - user.get("recovery_sent", 0))
        if wait > 0:
            return self.send(429, {"code": 429, "error_code": "over_email_send_rate_limit", "msg": f"For security purposes, you can only request this after {int(wait) + 1} seconds."})
        for token in [token for token, otp in OTPS.items() if otp["key"] == key]:
            del OTPS[token]  # an account has one reset token at a time: a new link ends the old one
        token = ("pkce_" if challenge else "") + uuid4().hex
        OTPS[token] = {"key": key, "challenge": challenge, "method": method.lower(), "made": time.time()}
        user["recovery_sent"] = time.time()
        wanted = query.get("redirect_to", [""])[0]
        redirect = wanted if wanted in self.redirect_allow else self.site_url
        link = f"http://{self.headers.get('Host', '127.0.0.1')}/auth/v1/verify?{urlencode({'token': token, 'type': 'recovery', 'redirect_to': redirect})}"
        MAILS.append({"to": email, "link": link})
        self.send(200, {})

    def verify(self, query):
        """GET /auth/v1/verify, which the emailed link opens in a browser with no key (internal/api/verify.go)."""
        token, kind = query.get("token", [""])[0], query.get("type", [""])[0]
        if not token:
            return self.send(400, {"code": 400, "error_code": "validation_failed", "msg": "Verify requires a token or a token hash"})
        if kind != "recovery":
            return self.send(400, {"code": 400, "error_code": "validation_failed", "msg": "Unsupported verification type"})
        wanted = query.get("redirect_to", [""])[0]
        target = urlsplit(wanted if wanted in self.redirect_allow else self.site_url)
        base = f"{target.scheme}://{target.netloc}{target.path}"
        pkce = token.startswith("pkce_")
        otp = OTPS.pop(token, None)  # a link is good once
        if otp is None or otp["key"] not in USERS or time.time() - otp["made"] > self.otp_ttl:
            problem = urlencode({"error": "access_denied", "error_code": "otp_expired", "error_description": "Email link is invalid or has expired"})
            # The error is always in the fragment, and in the query as well for a PKCE link (prepErrorRedirectURL).
            return self.redirect(f"{base}?{problem}#{problem}" if pkce else f"{base}#{problem}")
        if pkce:
            code = uuid4().hex
            # Measured from when the link was asked for: the flow state was made then (models/flow_state.go, IsExpired).
            CODES[code] = {"key": otp["key"], "challenge": otp["challenge"], "method": otp["method"], "made": otp["made"]}
            return self.redirect(f"{base}?{urlencode({'code': code})}")
        session = self.session(otp["key"])
        fragment = urlencode({"access_token": session["access_token"], "expires_in": session["expires_in"], "refresh_token": session["refresh_token"], "token_type": "bearer", "type": "recovery"})
        self.redirect(f"{base}#{fragment}")

    def do_DELETE(self):
        match = re.fullmatch(r"/auth/v1/admin/users/([0-9a-f-]{36})", urlsplit(self.path).path)
        if not match:
            return self.send(404, {"msg": "not found"})
        if not self.secret_key or self.headers.get("apikey") != self.secret_key:
            return self.send(401, {"code": 401, "error_code": "no_authorization", "msg": "This endpoint requires a valid secret key"})
        length = int(self.headers.get("Content-Length") or 0)
        self.rfile.read(length)
        for key, user in list(USERS.items()):
            if user["id"] == match.group(1):
                del USERS[key]
                for refresh in [r for r, owner in REFRESH.items() if owner == key]:
                    del REFRESH[refresh]
                return self.send(200, {"id": user["id"], "email": user.get("email", key)})
        self.send(404, {"code": 404, "error_code": "user_not_found", "msg": "User not found"})

    def finish_google(self, state, approved):
        """The stand-in Google has answered: send the browser back to the app's address (or to the site URL, if that was not allowed)."""
        flow = FLOWS.pop(state, None)
        if flow is None:
            return self.send(400, {"code": 400, "error_code": "bad_oauth_state", "msg": "OAuth state is invalid"})
        target = urlsplit(flow["redirect"])
        base = f"{target.scheme}://{target.netloc}{target.path}"
        if not approved:
            problem = urlencode({"error": "access_denied", "error_code": "unexpected_failure", "error_description": "The user denied access"})
            return self.redirect(f"{base}?{problem}#{problem}")
        key = self.identity("google:stand-in-google-user", self.google_email)
        code = uuid4().hex
        CODES[code] = {"key": key, "challenge": flow["challenge"], "method": flow["method"], "made": time.time()}
        self.redirect(f"{base}?{urlencode({'code': code})}")

    def authorize(self, query):
        """GET /auth/v1/authorize, which a browser calls with no key. Answers as Supabase's server does (internal/api/external.go)."""
        provider = query.get("provider", [""])[0].lower()
        challenge = query.get("code_challenge", [""])[0]
        method = query.get("code_challenge_method", [""])[0]
        if provider not in ("google", "apple"):
            return self.send(400, {"code": 400, "error_code": "validation_failed", "msg": f"Unsupported provider: Provider {provider} could not be found"})
        if provider in self.providers_off:
            return self.send(400, {"code": 400, "error_code": "validation_failed", "msg": "Unsupported provider: provider is not enabled"})
        if provider == "apple":
            return self.send(400, {"code": 400, "error_code": "validation_failed", "msg": "Unsupported provider: missing OAuth secret"})
        if bool(challenge) != bool(method):
            return self.send(400, {"code": 400, "error_code": "validation_failed", "msg": "PKCE flow requires code_challenge_method and code_challenge"})
        if challenge:
            if not 43 <= len(challenge) <= 128 or not re.fullmatch(r"[A-Za-z0-9._~-]+", challenge):
                return self.send(400, {"code": 400, "error_code": "validation_failed", "msg": "code challenge has to be between 43 and 128 characters"})
            if method.lower() not in ("s256", "plain"):
                return self.send(400, {"code": 400, "error_code": "validation_failed", "msg": "Invalid code_challenge_method"})
        # redirect_to must be on the allow-list; if it is not, the project falls back to its Site URL (which is why that setting matters).
        wanted = query.get("redirect_to", [""])[0]
        redirect = wanted if wanted in self.redirect_allow else self.site_url
        state = uuid4().hex
        # Query parameters the project does not own (prompt=select_account) are passed on to the provider, so the stand-in Google sees them.
        FLOWS[state] = {"redirect": redirect, "challenge": challenge, "method": method.lower(), "prompt": query.get("prompt", [""])[0]}
        if not challenge:
            return self.redirect(f"https://accounts.google.test/o/oauth2/v2/auth?state={state}")
        if self.google_mode == "approve":
            return self.finish_google(state, True)
        if self.google_mode == "deny":
            return self.finish_google(state, False)
        self.redirect(f"/stand-in-google?{urlencode({'state': state})}")

    def do_GET(self):
        url = urlsplit(self.path)
        query = parse_qs(url.query)
        if url.path == "/auth/v1/.well-known/jwks.json":
            return self.send(200, {"keys": []})
        if url.path == "/auth/v1/settings":
            # What the project has switched on (internal/api/settings.go). The auth server asks for no sign-in here; the key is
            # what the hosted gateway in front of it wants on every /auth/v1 route that is not opened by a browser.
            if not self.authorised():
                return
            external = {name: name not in self.providers_off for name in ("apple", "google", "email")}
            return self.send(200, {"external": external, "disable_signup": False, "mailer_autoconfirm": not self.confirm})
        if url.path == "/auth/v1/authorize":
            return self.authorize(query)
        if url.path == "/auth/v1/verify":
            return self.verify(query)
        if url.path == "/stand-in-mail":
            # Development only: what would have been emailed, newest first. `?to=` narrows it to one address.
            to = query.get("to", [""])[0].strip().lower()
            mails = [mail for mail in reversed(MAILS) if not to or mail["to"] == to]
            rows = "".join(f"<li>To {escape(mail['to'])}: <a href='{escape(mail['link'])}' style='font-size:22px'>Reset your password</a></li>" for mail in mails)
            return self.page(
                "<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'><title>Stand-in mail</title>"
                "<body style='font:17px system-ui;margin:2rem'><h1>Stand-in mail</h1><p>Development only. Nothing was sent; these are the links an email would carry.</p>"
                f"<ul>{rows}</ul>" + ("" if mails else "<p>No mail.</p>"))
        if url.path == "/stand-in-google":
            state = escape(query.get("state", [""])[0])
            chooser = "<h2>Choose an account</h2>" if FLOWS.get(query.get("state", [""])[0], {}).get("prompt") == "select_account" else ""
            return self.page(
                "<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'><title>Stand-in Google</title>"
                "<body style='font:17px system-ui;margin:2rem'><h1>Stand-in Google</h1><p>Development only. No real Google account is involved.</p>"
                f"{chooser}"
                f"<p><a href='/stand-in-google/approve?state={state}' style='font-size:22px'>Continue as {escape(self.google_email)}</a></p>"
                f"<p><a href='/stand-in-google/deny?state={state}' style='font-size:22px'>Cancel</a></p>")
        if url.path in ("/stand-in-google/approve", "/stand-in-google/deny"):
            return self.finish_google(query.get("state", [""])[0], url.path.endswith("/approve"))
        self.send(404, {"msg": "not found"})

    def id_token_grant(self, body):
        """POST /auth/v1/token?grant_type=id_token: what the app sends after the native Apple sheet (internal/api/token_oidc.go)."""
        if body.get("provider") != "apple":
            return self.send(400, {"code": 400, "error_code": "validation_failed", "msg": "Custom OIDC provider not allowed"})
        claims = token_claims(str(body.get("id_token", "")))
        if claims is None:
            return self.send(400, {"code": 400, "error_code": "validation_failed", "msg": "Unable to detect issuer in ID token for Apple provider"})
        if "apple" in self.providers_off:
            return self.send(400, {"code": 400, "error_code": "provider_disabled", "msg": 'Provider (issuer "https://appleid.apple.com") is not enabled'})
        if claims.get("iss") != "https://appleid.apple.com":
            return self.send(400, {"code": 400, "error_code": "validation_failed", "msg": "Detected ID token issuer is not an Apple ID token issuer"})
        audience = claims.get("aud")
        if audience not in self.apple_client_ids:
            return self.send(400, {"error": "invalid request", "error_description": f"Unacceptable audience in id_token: [{audience}]"})
        nonce, claimed = str(body.get("nonce", "")), claims.get("nonce", "")
        if bool(nonce) != bool(claimed):
            return self.send(400, {"error": "invalid request", "error_description": "Passed nonce and nonce in id_token should either both exist or not."})
        if nonce and sha256_hex(nonce) != claimed:
            return self.send(400, {"error": "invalid request", "error_description": "Nonces mismatch"})
        # The project makes the account from what the token says. Apple may leave the email out.
        key = self.identity(f"apple:{claims.get('sub', '')}", str(claims.get("email", "")))
        self.send(200, self.session(key))

    def pkce_grant(self, body):
        """POST /auth/v1/token?grant_type=pkce: the code that came back, and the verifier that only this app has (internal/api/token.go)."""
        code, verifier = str(body.get("auth_code", "")), str(body.get("code_verifier", ""))
        if not code or not verifier:
            return self.send(400, {"code": 400, "error_code": "validation_failed", "msg": "invalid request: both auth code and code verifier should be non-empty"})
        found = CODES.get(code)
        if found is None:
            return self.send(404, {"code": 404, "error_code": "flow_state_not_found", "msg": "invalid flow state, no valid flow state found"})
        if time.time() - found["made"] > self.code_ttl:
            del CODES[code]
            return self.send(422, {"code": 422, "error_code": "flow_state_expired", "msg": "invalid flow state, flow state has expired"})
        proof = b64(hashlib.sha256(verifier.encode()).digest()) if found["method"] == "s256" else verifier
        if not hmac.compare_digest(proof, found["challenge"]):
            return self.send(400, {"code": 400, "error_code": "bad_code_verifier", "msg": "code challenge does not match previously saved code verifier"})
        del CODES[code]  # a code is good once
        self.send(200, self.session(found["key"]))

    def do_POST(self):
        url = urlsplit(self.path)
        if not self.authorised():
            return
        length = int(self.headers.get("Content-Length") or 0)
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except ValueError:
            return self.send(400, {"code": 400, "error_code": "bad_json", "msg": "Could not parse request body as JSON"})
        email = str(body.get("email", "")).strip().lower()
        password = str(body.get("password", ""))
        if url.path == "/auth/v1/signup":
            if "@" not in email:
                return self.send(422, {"code": 422, "error_code": "validation_failed", "msg": "Unable to validate email address: invalid format"})
            if len(password) < 8:
                return self.send(422, {"code": 422, "error_code": "weak_password", "msg": "Password should be at least 8 characters."})
            if email in USERS:
                return self.send(422, {"code": 422, "error_code": "user_already_exists", "msg": "User already registered"})
            USERS[email] = {"id": str(uuid4()), "password": password, "email": email}
            if self.confirm:
                return self.send(200, {"id": USERS[email]["id"], "email": email, "confirmation_sent_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())})
            return self.send(200, self.session(email))
        if url.path == "/auth/v1/token":
            grant = parse_qs(url.query).get("grant_type", [""])[0]
            if grant == "password":
                # By address, whatever the account was made with: one made by Google can be given a password by a reset link.
                key = next((name for name, user in USERS.items() if user.get("email", name) == email), None) if email else None
                if key is None or USERS[key]["password"] is None or USERS[key]["password"] != password:
                    return self.send(400, {"code": 400, "error_code": "invalid_credentials", "msg": "Invalid login credentials"})
                return self.send(200, self.session(key))
            if grant == "refresh_token":
                owner = REFRESH.pop(str(body.get("refresh_token", "")), None)
                if owner is None:
                    return self.send(400, {"error": "invalid_grant", "error_description": "Invalid Refresh Token: Refresh Token Not Found"})
                return self.send(200, self.session(owner))
            if grant == "pkce":
                return self.pkce_grant(body)
            if grant == "id_token":
                return self.id_token_grant(body)
            return self.send(400, {"code": 400, "error_code": "validation_failed", "msg": "unsupported grant type"})
        if url.path == "/auth/v1/recover":
            return self.recover(parse_qs(url.query), body)
        if url.path == "/auth/v1/logout":
            for refresh in [r for r, e in REFRESH.items()]:
                del REFRESH[refresh]
            return self.send(204)
        self.send(404, {"msg": "not found"})


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--port", type=int, default=8853)
    args = parser.parse_args()
    for name in ("STUB_JWT_SECRET", "STUB_PUBLISHABLE_KEY"):
        if not os.environ.get(name):
            sys.exit(f"Set {name} first (see the top of this file).")
    Handler.secret = os.environ["STUB_JWT_SECRET"]
    Handler.publishable = os.environ["STUB_PUBLISHABLE_KEY"]
    Handler.secret_key = os.environ.get("STUB_SECRET_KEY", "")
    Handler.issuer = f"http://127.0.0.1:{args.port}/auth/v1"
    Handler.lifetime = int(os.environ.get("STUB_EXPIRES_IN", "3600"))
    Handler.confirm = os.environ.get("STUB_CONFIRM") == "1"
    Handler.providers_off = {name.strip() for name in os.environ.get("STUB_PROVIDERS_OFF", "").split(",") if name.strip()}
    Handler.google_mode = os.environ.get("STUB_GOOGLE_MODE", "ask")
    Handler.google_email = os.environ.get("STUB_GOOGLE_EMAIL", Handler.google_email)
    Handler.redirect_allow = {item.strip() for item in os.environ.get("STUB_REDIRECT_ALLOW", "littlearchive://auth-callback").split(",") if item.strip()}
    Handler.site_url = os.environ.get("STUB_SITE_URL", Handler.site_url)
    Handler.apple_client_ids = {item.strip() for item in os.environ.get("STUB_APPLE_CLIENT_IDS", "app.littlearchive.mobile").split(",") if item.strip()}
    Handler.code_ttl = int(os.environ.get("STUB_CODE_TTL", "300"))
    Handler.otp_ttl = int(os.environ.get("STUB_OTP_TTL", "3600"))
    Handler.mail_gap = int(os.environ.get("STUB_MAIL_GAP", "60"))
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"Stub Supabase Auth on http://127.0.0.1:{args.port} (development only)", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
