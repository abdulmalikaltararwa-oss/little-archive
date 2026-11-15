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

Routes: signup, token (password, refresh_token, pkce and id_token grants), authorize (with a stand-in Google), logout, an empty
key set, and the admin call that deletes a user (`DELETE /auth/v1/admin/users/<id>`, which needs the secret key in the `apikey`
header). The routes the real service answers to a browser (authorize and the stand-in Google's own pages) need no key; the
others require the publishable key in the `apikey` header, as the real service does.

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
FLOWS = {}      # state -> {"redirect", "challenge", "method"}: a browser sign-in that has started
CODES = {}      # auth code -> {"key", "challenge", "method", "made"}: one that Google approved and that waits to be traded


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
        self.send_response(302)
        self.send_header("Location", location)
        self.send_header("Content-Length", "0")
        self.end_headers()

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
        FLOWS[state] = {"redirect": redirect, "challenge": challenge, "method": method.lower()}
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
        if url.path == "/auth/v1/authorize":
            return self.authorize(query)
        if url.path == "/stand-in-google":
            state = escape(query.get("state", [""])[0])
            return self.page(
                "<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'><title>Stand-in Google</title>"
                "<body style='font:17px system-ui;margin:2rem'><h1>Stand-in Google</h1><p>Development only. No real Google account is involved.</p>"
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
                if email not in USERS or USERS[email]["password"] is None or USERS[email]["password"] != password:
                    return self.send(400, {"code": 400, "error_code": "invalid_credentials", "msg": "Invalid login credentials"})
                return self.send(200, self.session(email))
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
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"Stub Supabase Auth on http://127.0.0.1:{args.port} (development only)", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
