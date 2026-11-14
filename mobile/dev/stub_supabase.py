#!/usr/bin/env python3
"""A small local stand-in for Supabase Auth, so the app's hosted flow can be tried on this computer.

Development only. It is not Supabase and secures nothing: accounts live in memory, and it signs access tokens with a
secret that you choose when you start it. Use it with a hosted-mode Little Archive server that trusts the same secret:

    export STUB_JWT_SECRET="$(python3 -c 'import secrets; print(secrets.token_urlsafe(48))')"
    export STUB_PUBLISHABLE_KEY="the sb_publishable_... value from app.config.json"
    python3 mobile/dev/stub_supabase.py --port 8853 &

    LA_MODE=hosted LA_SUPABASE_URL=http://127.0.0.1:8853 LA_SUPABASE_JWT_SECRET="$STUB_JWT_SECRET" \\
    LA_PUBLIC_URL=http://localhost:8852 LA_DATA_DIR=/tmp/la-hosted \\
    python -m uvicorn server.app:create_app --factory --port 8852

Build the app against both with a development config (see docs/mobile-app.md). Settings, all optional:

    STUB_EXPIRES_IN    seconds an access token lives (default 3600; use 90 to watch refreshing)
    STUB_CONFIRM=1     sign-up answers "check your email" without a session, like a project that confirms emails

Routes: signup, token (password and refresh_token grants), logout, and an empty key set. Every route requires the
publishable key in the `apikey` header, as the real service does.
"""
import argparse
import base64
import hashlib
import hmac
import json
import os
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit
from uuid import uuid4

USERS = {}      # email -> {"id", "password"}
REFRESH = {}    # refresh token -> email


def b64(data):
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


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
    lifetime = 3600
    confirm = False

    def log_message(self, *args):
        pass

    def send(self, status, body=None):
        data = b"" if body is None else json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def session(self, email):
        user = USERS[email]
        refresh = "r-" + uuid4().hex
        REFRESH[refresh] = email
        token = access_token(self.secret, self.issuer, user["id"], email, self.lifetime)
        return {"access_token": token, "token_type": "bearer", "expires_in": self.lifetime, "expires_at": int(time.time()) + self.lifetime, "refresh_token": refresh, "user": {"id": user["id"], "email": email}}

    def authorised(self):
        if self.headers.get("apikey") != self.publishable:
            self.send(401, {"code": 401, "error_code": "no_authorization", "msg": "No API key found in request"})
            return False
        return True

    def do_GET(self):
        if urlsplit(self.path).path == "/auth/v1/.well-known/jwks.json":
            return self.send(200, {"keys": []})
        self.send(404, {"msg": "not found"})

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
            USERS[email] = {"id": str(uuid4()), "password": password}
            if self.confirm:
                return self.send(200, {"id": USERS[email]["id"], "email": email, "confirmation_sent_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())})
            return self.send(200, self.session(email))
        if url.path == "/auth/v1/token":
            grant = parse_qs(url.query).get("grant_type", [""])[0]
            if grant == "password":
                if email not in USERS or USERS[email]["password"] != password:
                    return self.send(400, {"code": 400, "error_code": "invalid_credentials", "msg": "Invalid login credentials"})
                return self.send(200, self.session(email))
            if grant == "refresh_token":
                owner = REFRESH.pop(str(body.get("refresh_token", "")), None)
                if owner is None:
                    return self.send(400, {"error": "invalid_grant", "error_description": "Invalid Refresh Token: Refresh Token Not Found"})
                return self.send(200, self.session(owner))
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
    Handler.issuer = f"http://127.0.0.1:{args.port}/auth/v1"
    Handler.lifetime = int(os.environ.get("STUB_EXPIRES_IN", "3600"))
    Handler.confirm = os.environ.get("STUB_CONFIRM") == "1"
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"Stub Supabase Auth on http://127.0.0.1:{args.port} (development only)", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
