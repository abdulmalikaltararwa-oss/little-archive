"""Adversarial checks on hosted sign-in: which tokens prove an account, and which never do.

Tokens are signed with keys generated in the test and verified by the real
server code. The key set comes from a fake fetcher or a loopback HTTP server;
no request leaves the machine and no real identity project is involved.
"""
import base64
import hashlib
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import tempfile
from threading import Event, Thread
import time
import unittest
from unittest.mock import patch
from uuid import uuid4
import warnings

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec, rsa
from fastapi.testclient import TestClient
import jwt

from server.app import create_app
from server.config import Config
from server.identity import IdentityError, IdentityUnavailable, JWKSCache, SupabaseVerifier, fetch_jwks
from support_hosted import ISSUER, LEGACY_SECRET, SUPABASE_URL, FakeKeySet, SigningKey, bearer, claims, hosted_app, hosted_config


def b64(data):
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def raw_token(header, payload, secret=None):
    """Assemble a token by hand, for shapes a well-behaved library refuses to produce."""
    body = b64(json.dumps(header).encode()) + "." + b64(json.dumps(payload).encode())
    signature = hmac.new(secret, body.encode(), hashlib.sha256).digest() if secret else b""
    return body + "." + b64(signature)


class HostedSignInTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="little-archive-identity-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.key, self.rsa = SigningKey("ES256"), SigningKey("RS256")
        self.app, self.keyset = hosted_app(self.root, self.key, self.rsa, supabase_jwt_secret=LEGACY_SECRET)
        self.client = TestClient(self.app)
        self.client.__enter__()
        self.addCleanup(self.client.__exit__, None, None, None)
        self.user = str(uuid4())

    def status(self, token):
        return self.client.get("/api/items", headers=bearer(token)).status_code

    def libraries(self):
        return sorted(path.name for path in (self.root / "data" / "users").iterdir())

    def assertRefused(self, tokens):
        for label, token in tokens.items():
            with self.subTest(token=label):
                response = self.client.get("/api/items", headers=bearer(token))
                self.assertEqual(response.status_code, 401, label)
                self.assertEqual(response.headers["www-authenticate"], "Bearer")
                self.assertEqual(self.client.post("/api/items", json={"url": "https://example.com/x"}, headers=bearer(token)).status_code, 401)
                self.assertFalse(self.client.get("/api/auth/me", headers=bearer(token)).json()["authenticated"])
        self.assertEqual(self.libraries(), [], "a refused token must never create or open a library")

    def test_accepts_each_supported_signature_type_for_its_own_account(self):
        accounts = {"ES256": str(uuid4()), "RS256": str(uuid4()), "HS256": str(uuid4())}
        tokens = {
            "ES256": self.key.sign(claims(accounts["ES256"])),
            "RS256": self.rsa.sign(claims(accounts["RS256"])),
            "HS256": jwt.encode(claims(accounts["HS256"]), LEGACY_SECRET, algorithm="HS256"),
        }
        for name, token in tokens.items():
            with self.subTest(algorithm=name):
                self.assertEqual(self.status(token), 200)
                self.assertEqual(self.client.get("/api/auth/me", headers=bearer(token)).json(),
                                 {"authenticated": True, "version": "0.1.0", "auth": "supabase-jwt", "user_id": accounts[name]})
        self.assertEqual(self.libraries(), sorted(accounts.values()))
        self.assertEqual(self.keyset.urls, [SUPABASE_URL + "/auth/v1/.well-known/jwks.json"], "one fetch, from the configured project only")

    def test_refuses_forged_tampered_and_unsigned_tokens(self):
        genuine = self.key.sign(claims(self.user))
        header, payload, signature = genuine.split(".")
        other_account = b64(json.dumps(claims(str(uuid4()))).encode())
        self.assertRefused({
            "another key under the published key id": SigningKey("ES256", kid=self.key.kid).sign(claims(self.user)),
            "another rsa key under the published key id": SigningKey("RS256", kid=self.rsa.kid).sign(claims(self.user)),
            "payload swapped under a genuine signature": ".".join((header, other_account, signature)),
            "signature removed": header + "." + payload + ".",
            "signature truncated": genuine[:-6],
            "unknown key id": SigningKey("ES256").sign(claims(self.user)),
            "no key id": jwt.encode(claims(self.user), self.key.private, algorithm="ES256"),
            "self-supplied key in the header": SigningKey("ES256").sign(claims(self.user), headers={"jwk": SigningKey("ES256").jwk(), "jku": "https://attacker.example/keys.json"}),
        })

    def test_refuses_expired_premature_and_incomplete_tokens(self):
        moment = int(time.time())
        tokens = {
            "expired": self.key.sign(claims(self.user, iat=moment - 7200, exp=moment - 3600)),
            "expired just past the leeway": self.key.sign(claims(self.user, exp=moment - 30)),
            "not valid yet": self.key.sign(claims(self.user, nbf=moment + 600)),
            "issued in the future": self.key.sign(claims(self.user, iat=moment + 600)),
            "fractional times": self.key.sign(claims(self.user, iat=moment - 5.5)),
            "textual expiry": self.key.sign(claims(self.user, exp=str(moment + 3600))),
        }
        for name in ("exp", "iat", "sub", "aud", "iss"):
            tokens["missing " + name] = self.key.sign(claims(self.user, **{name: None}))
        self.assertRefused(tokens)

    def test_refuses_wrong_audience_issuer_role_and_anonymous_sign_ins(self):
        self.assertRefused({
            "another audience": self.key.sign(claims(self.user, aud="anon")),
            "audience list": self.key.sign(claims(self.user, aud=["authenticated"])),
            "audience list with ours inside": self.key.sign(claims(self.user, aud=["other-service", "authenticated"])),
            "another project": self.key.sign(claims(self.user, iss="https://another-project.supabase.test/auth/v1")),
            "issuer with a trailing slash": self.key.sign(claims(self.user, iss=ISSUER + "/")),
            "issuer prefix": self.key.sign(claims(self.user, iss=SUPABASE_URL)),
            "anon role": self.key.sign(claims(self.user, role="anon")),
            "service role": self.key.sign(claims(self.user, role="service_role")),
            "no role": self.key.sign(claims(self.user, role=None)),
            "anonymous sign-in": self.key.sign(claims(self.user, is_anonymous=True)),
            "anonymous flag as text": self.key.sign(claims(self.user, is_anonymous="true")),
            "anonymous flag as a number": self.key.sign(claims(self.user, is_anonymous=1)),
        })

    def test_refuses_the_projects_own_api_keys(self):
        # Legacy anon and service-role keys are JWTs signed with the same shared secret.
        moment = int(time.time())
        for role in ("anon", "service_role"):
            key = {"iss": "supabase", "ref": "synthetic-project", "role": role, "iat": moment - 5, "exp": moment + 3600}
            self.assertRefused({role + " api key": jwt.encode(key, LEGACY_SECRET, algorithm="HS256"),
                                role + " api key with a subject": jwt.encode({**key, "sub": self.user}, LEGACY_SECRET, algorithm="HS256")})

    def test_refuses_algorithm_none_and_every_algorithm_confusion(self):
        document = claims(self.user)
        public = self.key.private.public_key()
        rsa_public = self.rsa.private.public_key()
        confusable = {
            "EC public key PEM": public.public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo),
            "EC public key DER": public.public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo),
            "EC public point": public.public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint),
            "EC public JWK": json.dumps(self.key.jwk()).encode(),
            "RSA public key PEM": rsa_public.public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo),
            "RSA public key PKCS1": rsa_public.public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.PKCS1),
            "RSA public JWK": json.dumps(self.rsa.jwk()).encode(),
            "empty secret": b"",
            "wrong secret": b"another-secret-of-at-least-thirty-two-bytes",
        }
        tokens = {}
        for label, secret in confusable.items():
            for kid in (self.key.kid, self.rsa.kid, None):
                header = {"alg": "HS256", "typ": "JWT", **({"kid": kid} if kid else {})}
                tokens[f"HS256 keyed with {label} (kid {kid})"] = raw_token(header, document, secret or b"\x00")
        for spelling in ("none", "None", "NONE", "nOnE"):
            tokens["algorithm " + spelling] = raw_token({"alg": spelling, "typ": "JWT", "kid": self.key.kid}, document)
        genuine_header, genuine_payload, genuine_signature = self.key.sign(document).split(".")
        relabelled = b64(json.dumps({"alg": "RS256", "typ": "JWT", "kid": self.key.kid}).encode())
        self.enterContext(warnings.catch_warnings())
        warnings.simplefilter("ignore", jwt.InsecureKeyLengthWarning)  # deliberately mismatched keys below
        tokens.update({
            "no algorithm": raw_token({"typ": "JWT", "kid": self.key.kid}, document),
            "algorithm list": raw_token({"alg": ["ES256", "none"], "kid": self.key.kid}, document),
            "algorithm number": raw_token({"alg": 256, "kid": self.key.kid}, document),
            "HS512 with the real secret": jwt.encode(document, LEGACY_SECRET, algorithm="HS512"),
            "HS384 with the real secret": jwt.encode(document, LEGACY_SECRET, algorithm="HS384"),
            "PS256 from the real RSA key": jwt.encode(document, self.rsa.private, algorithm="PS256", headers={"kid": self.rsa.kid}),
            "RS512 from the real RSA key": jwt.encode(document, self.rsa.private, algorithm="RS512", headers={"kid": self.rsa.kid}),
            "ES384 key": jwt.encode(document, ec.generate_private_key(ec.SECP384R1()), algorithm="ES384", headers={"kid": self.key.kid}),
            "RS256 token naming the EC key": jwt.encode(document, rsa.generate_private_key(public_exponent=65537, key_size=2048), algorithm="RS256", headers={"kid": self.key.kid}),
            "ES256 token naming the RSA key": jwt.encode(document, ec.generate_private_key(ec.SECP256R1()), algorithm="ES256", headers={"kid": self.rsa.kid}),
            "real ES256 signature relabelled RS256": ".".join((relabelled, genuine_payload, genuine_signature)),
        })
        self.assertRefused(tokens)
        by_hand = raw_token({"alg": "HS256", "typ": "JWT"}, document, LEGACY_SECRET.encode())
        self.assertEqual(self.status(by_hand), 200, "the hand-built form is accepted once it is keyed correctly")

    def test_the_legacy_shared_secret_is_off_unless_configured(self):
        app, keyset = hosted_app(self.root / "asymmetric-only", self.key)
        with TestClient(app) as client:
            for secret in (LEGACY_SECRET, "", "x"):
                token = raw_token({"alg": "HS256", "typ": "JWT"}, claims(self.user), secret.encode() or b"\x00")
                self.assertEqual(client.get("/api/items", headers=bearer(token)).status_code, 401)
            self.assertEqual(client.get("/api/items", headers=bearer(self.key.sign(claims(self.user)))).status_code, 200)

    def test_refuses_subjects_that_are_not_canonical_account_ids(self):
        account = str(uuid4())
        subjects = ["../" + account, "..", ".", "", "/", account + "/..", account + "/../" + str(uuid4()), "../../etc/passwd", "users/" + account,
                    account.upper(), "{" + account + "}", account.replace("-", ""), "urn:uuid:" + account, account + "\x00", account + "\n", " " + account,
                    "%2e%2e%2f" + account, "00000000-0000-0000-0000-000000000000", "accounts.sqlite3", ".deleting-" + "a" * 32, "a" * 36, 42, True, ["x"], {"id": account}]
        self.assertRefused({"subject " + repr(subject): self.key.sign(claims(account, sub=subject)) for subject in subjects})
        data = self.root / "data"
        self.assertEqual({path.name for path in data.iterdir()} - {"accounts.sqlite3-wal", "accounts.sqlite3-shm"}, {"users", "accounts.sqlite3"})
        self.assertEqual({path.name for path in self.root.iterdir()}, {"data"}, "nothing may be created outside the data directory")

    def test_refuses_malformed_oversized_and_misplaced_tokens(self):
        genuine = self.key.sign(claims(self.user))
        self.assertRefused({
            "empty": "", "one part": "token", "two parts": "a.b", "three empty parts": "..", "not base64": "@@@.@@@.@@@",
            "four parts": genuine + ".extra", "oversized": self.key.sign(claims(self.user, padding="x" * 9000)),
            "device token shape": "lad_" + "A" * 43, "extension token shape": "la_" + "A" * 43,
        })
        for request in (
            lambda: self.client.get("/api/items", params={"access_token": genuine, "token": genuine}),
            lambda: self.client.get("/api/items", headers={"Authorization": "Basic " + genuine}),
            lambda: self.client.get("/api/items", headers={"Authorization": genuine}),
            lambda: self.client.get("/api/items", headers={"X-Authorization": "Bearer " + genuine, "apikey": genuine}),
        ):
            self.assertEqual(request().status_code, 401)
        self.client.cookies.set("sb-access-token", genuine)
        self.client.cookies.set("little_archive_session", genuine)
        self.assertEqual(self.client.get("/api/items").status_code, 401, "a cookie is never a hosted credential")
        self.assertEqual(self.client.get("/api/auth/me").json(), {"authenticated": False, "version": "0.1.0"})
        self.client.cookies.clear()
        self.assertEqual(self.libraries(), [])
        self.assertEqual(self.status(genuine), 200, "the same token works when presented correctly")

    def test_unreachable_signing_keys_answer_503_not_401(self):
        app, keyset = hosted_app(self.root / "outage", self.key, supabase_jwt_secret=LEGACY_SECRET)
        keyset.failing = True
        with TestClient(app) as client:
            token = self.key.sign(claims(self.user))
            for path in ("/api/items", "/api/auth/me"):
                response = client.get(path, headers=bearer(token))
                self.assertEqual(response.status_code, 503)
                self.assertEqual(response.headers["retry-after"], "30")
            self.assertEqual(client.get("/api/items", headers=bearer(jwt.encode(claims(self.user), LEGACY_SECRET, algorithm="HS256"))).status_code, 200)
            keyset.failing = False
            self.assertEqual(client.get("/api/items", headers=bearer(token)).status_code, 503, "a failed fetch is not retried on every request")


class SigningKeyCacheTests(unittest.TestCase):
    def setUp(self):
        self.key, self.clock = SigningKey("ES256"), [1000.0]
        self.keyset = FakeKeySet(self.key)
        self.cache = JWKSCache("https://keys.test/jwks.json", fetch=self.keyset, clock=lambda: self.clock[0])
        self.verifier = SupabaseVerifier(issuer=ISSUER, audience="authenticated", jwks=self.cache)
        self.user = str(uuid4())

    def test_keys_are_cached_and_a_rotation_is_picked_up_without_being_a_request_amplifier(self):
        token = self.key.sign(claims(self.user))
        for _ in range(5):
            self.assertEqual(self.verifier.verify(token).user_id, self.user)
        self.assertEqual(self.keyset.calls, 1)
        rotated = SigningKey("ES256")
        self.keyset.keys.append(rotated)
        newer = rotated.sign(claims(self.user))
        self.clock[0] += 10
        for _ in range(50):
            with self.assertRaises(IdentityError):
                self.verifier.verify(SigningKey("ES256").sign(claims(self.user)))
        with self.assertRaises(IdentityError):
            self.verifier.verify(newer)
        self.assertEqual(self.keyset.calls, 1, "unknown key ids must not trigger a fetch each")
        self.clock[0] += 21
        self.assertEqual(self.verifier.verify(newer).user_id, self.user)
        self.assertEqual(self.keyset.calls, 2)
        self.assertEqual(self.verifier.verify(token).user_id, self.user, "the previous key stays valid while still published")

    def test_a_withdrawn_key_stops_working_after_the_cache_lifetime(self):
        token = self.key.sign(claims(self.user))
        self.verifier.verify(token)
        self.keyset.keys[:] = [SigningKey("ES256")]
        self.clock[0] += 599
        self.verifier.verify(token)
        self.clock[0] += 2
        with self.assertRaises(IdentityError):
            self.verifier.verify(token)

    def test_an_outage_keeps_recent_keys_for_a_bounded_time_only(self):
        token = self.key.sign(claims(self.user))
        self.verifier.verify(token)
        self.keyset.failing = True
        self.clock[0] += 700
        self.assertEqual(self.verifier.verify(token).user_id, self.user)
        attempts = self.keyset.calls
        self.verifier.verify(token)
        self.assertEqual(self.keyset.calls, attempts, "retries are spaced out during an outage")
        self.clock[0] += 3000
        with self.assertRaises(IdentityUnavailable):
            self.verifier.verify(token)
        self.keyset.failing = False
        self.clock[0] += 31
        self.assertEqual(self.verifier.verify(token).user_id, self.user)

    def test_a_slow_key_endpoint_does_not_hold_up_requests_that_already_have_their_key(self):
        token = self.key.sign(claims(self.user))
        self.verifier.verify(token)
        entered, release, outcome = Event(), Event(), []

        def slow(url):
            entered.set()
            if not release.wait(10):
                raise AssertionError("The slow fetch was never released.")
            return {"keys": [self.key.jwk()]}

        self.cache.fetch = slow
        self.clock[0] += 31
        stranger = Thread(target=lambda: outcome.append(self.assertRaises(IdentityError, self.verifier.verify, SigningKey("ES256").sign(claims(self.user)))), daemon=True)
        stranger.start()
        try:
            self.assertTrue(entered.wait(5), "the unknown key id should have started a refresh")
            started = time.monotonic()
            for _ in range(20):
                self.assertEqual(self.verifier.verify(token).user_id, self.user)
            with self.assertRaises(IdentityError):
                self.verifier.verify(SigningKey("ES256").sign(claims(self.user)))  # a second unknown key id does not queue behind the first
            self.assertLess(time.monotonic() - started, 2)
        finally:
            release.set()
            stranger.join(5)
        self.assertFalse(stranger.is_alive())

    def test_concurrent_first_requests_share_one_key_fetch(self):
        token, gate, results = self.key.sign(claims(self.user)), Event(), []
        original = self.keyset

        def gated(url):
            gate.wait(5)
            return original(url)

        self.cache.fetch = gated
        threads = [Thread(target=lambda: results.append(self.verifier.verify(token).user_id), daemon=True) for _ in range(8)]
        for thread in threads:
            thread.start()
        gate.set()
        for thread in threads:
            thread.join(5)
        self.assertEqual(results, [self.user] * 8)
        self.assertEqual(self.keyset.calls, 1)

    def test_never_having_fetched_keys_is_unavailable_rather_than_invalid(self):
        self.keyset.failing = True
        with self.assertRaises(IdentityUnavailable):
            self.verifier.verify(self.key.sign(claims(self.user)))

    def published(self, *rows):
        cache = JWKSCache("https://keys.test/jwks.json", fetch=lambda url: {"keys": list(rows)}, clock=lambda: self.clock[0])
        return SupabaseVerifier(issuer=ISSUER, audience="authenticated", jwks=cache), cache

    def test_only_public_signature_keys_of_the_expected_kind_are_loaded(self):
        token = self.key.sign(claims(self.user))
        good = self.key.jwk()
        private = json.loads(jwt.algorithms.ECAlgorithm.to_jwk(self.key.private))
        verifier, cache = self.published({**good, **private, "kid": self.key.kid})
        self.assertEqual(verifier.verify(token).user_id, self.user)
        loaded = cache.key(self.key.kid)[1]
        self.assertIsInstance(loaded, ec.EllipticCurvePublicKey)
        self.assertFalse(hasattr(loaded, "private_numbers"), "private key material must never be loaded")
        weak = SigningKey("RS256")
        weak.private = rsa.generate_private_key(public_exponent=65537, key_size=1024)
        self.enterContext(warnings.catch_warnings())
        warnings.simplefilter("ignore", jwt.InsecureKeyLengthWarning)  # a deliberately weak key
        ignored = {
            "encryption key": {**good, "use": "enc"}, "signing-only operations": {**good, "key_ops": ["sign"]},
            "mislabelled algorithm": {**good, "alg": "RS256"}, "other curve": {**good, "crv": "P-384"},
            "symmetric key": {"kty": "oct", "kid": self.key.kid, "k": b64(LEGACY_SECRET.encode()), "alg": "HS256"},
            "no key id": {name: value for name, value in good.items() if name != "kid"}, "incomplete": {"kty": "EC", "crv": "P-256", "kid": self.key.kid, "x": good["x"]},
            "not an object": "key", "weak rsa": weak.jwk(),
        }
        for label, row in ignored.items():
            with self.subTest(key=label):
                verifier, _ = self.published(row)
                with self.assertRaises(IdentityError):
                    verifier.verify(weak.sign(claims(self.user)) if label == "weak rsa" else token)
        for malformed in ({**SigningKey("ES256").jwk(), "key_ops": "verify"}, {**SigningKey("ES256").jwk(), "key_ops": None}, {**SigningKey("ES256").jwk(), "x": 7}, None, 3):
            verifier, _ = self.published(malformed, good)
            self.assertEqual(verifier.verify(token).user_id, self.user, "one malformed entry must not discard the rest of the key set")
        verifier, _ = self.published(SigningKey("ES256", kid=self.key.kid).jwk(), good)
        with self.assertRaises(IdentityError):
            verifier.verify(token)  # A duplicated key id resolves to the first entry only.
        symmetric, _ = self.published(ignored["symmetric key"])
        with self.assertRaises(IdentityError):
            symmetric.verify(jwt.encode(claims(self.user), LEGACY_SECRET, algorithm="HS256", headers={"kid": self.key.kid}))

    def test_an_unbounded_or_malformed_key_set_is_not_trusted(self):
        token = self.key.sign(claims(self.user))
        for label, document in (("too many keys", {"keys": [SigningKey("ES256").jwk() for _ in range(16)] + [self.key.jwk()]}),
                                ("no keys member", {"key": [self.key.jwk()]}), ("a list", [self.key.jwk()]), ("text", "keys")):
            with self.subTest(document=label):
                cache = JWKSCache("https://keys.test/jwks.json", fetch=lambda url, document=document: document, clock=lambda: self.clock[0])
                with self.assertRaises(IdentityUnavailable):
                    SupabaseVerifier(issuer=ISSUER, audience="authenticated", jwks=cache).verify(token)

    def test_a_verifier_needs_some_trust_root(self):
        with self.assertRaises(ValueError):
            SupabaseVerifier(issuer=ISSUER, audience="authenticated")
        with self.assertRaises(ValueError):
            SupabaseVerifier(issuer="", audience="authenticated", secret=LEGACY_SECRET)


class LoopbackKeyEndpointTests(unittest.TestCase):
    """The real key fetcher and default wiring, against a key set served on loopback."""

    def setUp(self):
        self.key = SigningKey("ES256")
        test = self

        class Endpoint(BaseHTTPRequestHandler):
            def do_GET(self):
                test.paths.append(self.path)
                if self.path == "/auth/v1/.well-known/jwks.json":
                    self.reply(200, json.dumps({"keys": [test.key.jwk()]}).encode())
                elif self.path == "/huge":
                    self.reply(200, b'{"keys": [' + b" " * (70 * 1024) + b"]}")
                elif self.path == "/moved":
                    self.send_response(302)
                    self.send_header("Location", "/auth/v1/.well-known/jwks.json")
                    self.end_headers()
                else:
                    self.reply(500, b"{}")

            def reply(self, status, body):
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):
                pass

        self.paths = []
        self.service = ThreadingHTTPServer(("127.0.0.1", 0), Endpoint)
        self.thread = Thread(target=self.service.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.thread.join, 2)
        self.addCleanup(self.service.server_close)
        self.addCleanup(self.service.shutdown)
        self.origin = f"http://127.0.0.1:{self.service.server_port}"

    def test_default_wiring_fetches_the_projects_published_keys(self):
        with tempfile.TemporaryDirectory(prefix="little-archive-loopback-") as folder:
            config = Config(data_dir=Path(folder) / "data", public_url="http://testserver", testing=True, mode="hosted", supabase_url=self.origin)
            user = str(uuid4())
            with TestClient(create_app(config)) as client:
                token = self.key.sign(claims(user, iss=self.origin + "/auth/v1"))
                self.assertEqual(client.get("/api/items", headers=bearer(token)).status_code, 200)
                self.assertEqual(client.get("/api/items", headers=bearer(self.key.sign(claims(user)))).status_code, 401, "another project's issuer")
                self.assertEqual(client.get("/api/discovery").json()["auth"]["supabase_url"], self.origin)
        self.assertEqual(self.paths, ["/auth/v1/.well-known/jwks.json"])

    def test_the_fetcher_is_bounded_follows_no_redirects_and_ignores_ambient_proxies(self):
        proxies = {name: "http://127.0.0.1:1" for name in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy")}
        with patch.dict(os.environ, {**proxies, "NO_PROXY": "", "no_proxy": ""}):
            self.assertEqual(len(fetch_jwks(self.origin + "/auth/v1/.well-known/jwks.json")["keys"]), 1)
        for path in ("/huge", "/moved", "/missing"):
            with self.subTest(path=path), self.assertRaises(ValueError):
                fetch_jwks(self.origin + path)
        self.assertEqual(self.paths.count("/auth/v1/.well-known/jwks.json"), 1, "the redirect target was not requested")


class HostedConfigurationTests(unittest.TestCase):
    def test_hosted_mode_is_opt_in_and_reads_only_environment_settings(self):
        with tempfile.TemporaryDirectory() as folder:
            default = Config.from_env({"LA_DATA_DIR": folder, "LA_ADMIN_PASSWORD": "a-private-owner-password"})
            default.validate()
            self.assertEqual((default.mode, default.hosted, default.supabase_url), ("self-hosted", False, ""))
            hosted = Config.from_env({
                "LA_DATA_DIR": folder, "LA_MODE": " Hosted ", "LA_SUPABASE_URL": "https://abc.supabase.co/", "LA_SUPABASE_JWT_SECRET": LEGACY_SECRET,
                "LA_HOSTED_STORAGE_QUOTA_MB": "250", "LA_HOSTED_MAX_JSON_KB": "256", "LA_HOSTED_MAX_UPLOAD_MB": "4", "LA_HOSTED_MAX_THUMBNAIL_MB": "2",
                "LA_HOSTED_OPEN_LIBRARIES": "8", "LA_HOSTED_DEEP_READS_MONTHLY": "50", "LA_HOSTED_FREE_DEEP_READS_MONTHLY": "3",
            })
            hosted.validate()
            self.assertTrue(hosted.hosted)
            self.assertEqual(hosted.supabase_issuer, "https://abc.supabase.co/auth/v1")
            self.assertEqual(hosted.supabase_jwks_url, "https://abc.supabase.co/auth/v1/.well-known/jwks.json")
            self.assertEqual((hosted.hosted_storage_quota_mb, hosted.hosted_max_json_kb, hosted.hosted_max_upload_mb, hosted.hosted_max_thumbnail_mb,
                              hosted.hosted_open_libraries, hosted.hosted_deep_reads_monthly, hosted.hosted_free_deep_reads_monthly), (250, 256, 4, 2, 8, 50, 3))
            custom = Config.from_env({"LA_DATA_DIR": folder, "LA_MODE": "hosted", "LA_SUPABASE_URL": "https://auth.example.com", "LA_SUPABASE_JWT_ISSUER": "https://abc.supabase.co/auth/v1", "LA_SUPABASE_JWT_AUDIENCE": "members"})
            custom.validate()
            self.assertEqual((custom.supabase_issuer, custom.supabase_jwt_audience), ("https://abc.supabase.co/auth/v1", "members"))

    def test_incomplete_or_contradictory_settings_stop_startup(self):
        with tempfile.TemporaryDirectory() as folder:
            base = {"LA_DATA_DIR": folder, "LA_MODE": "hosted", "LA_SUPABASE_URL": "https://abc.supabase.co"}
            for label, values in {
                "unknown mode": {"LA_DATA_DIR": folder, "LA_MODE": "multi", "LA_ADMIN_PASSWORD": "a-private-owner-password"},
                "hosted without a project": {"LA_DATA_DIR": folder, "LA_MODE": "hosted"},
                "hosted with an owner password": {**base, "LA_ADMIN_PASSWORD": "a-private-owner-password"},
                "provider settings without hosted mode": {"LA_DATA_DIR": folder, "LA_SUPABASE_URL": "https://abc.supabase.co"},
                "secret without hosted mode": {"LA_DATA_DIR": folder, "LA_SUPABASE_JWT_SECRET": LEGACY_SECRET},
                "plain http project": {**base, "LA_SUPABASE_URL": "http://abc.supabase.co"},
                "project with a path": {**base, "LA_SUPABASE_URL": "https://abc.supabase.co/auth/v1"},
                "project with credentials": {**base, "LA_SUPABASE_URL": "https://user:pass@abc.supabase.co"},
                "short secret": {**base, "LA_SUPABASE_JWT_SECRET": "too-short"},
                "zero quota": {**base, "LA_HOSTED_STORAGE_QUOTA_MB": "0"},
                "oversized thumbnails": {**base, "LA_HOSTED_MAX_THUMBNAIL_MB": "9"},
                "no open libraries": {**base, "LA_HOSTED_OPEN_LIBRARIES": "0"},
                "negative allowance": {**base, "LA_HOSTED_DEEP_READS_MONTHLY": "-1"},
                "issuer that is not a url": {**base, "LA_SUPABASE_JWT_ISSUER": "supabase"},
            }.items():
                with self.subTest(case=label), self.assertRaises(ValueError):
                    Config.from_env(values).validate()
            with self.assertRaisesRegex(ValueError, "LA_HOSTED_STORAGE_QUOTA_MB must be a whole number"):
                Config.from_env({**base, "LA_HOSTED_STORAGE_QUOTA_MB": "lots"})
            Config.from_env({**base, "LA_SUPABASE_URL": "http://127.0.0.1:54321"}).validate()

    def test_hosted_mode_refuses_a_directory_that_holds_a_single_owner_library(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            create_app(Config(data_dir=root / "data", admin_password="a-private-owner-password", public_url="http://testserver", testing=True))
            with self.assertRaisesRegex(ValueError, "single-owner library"):
                create_app(hosted_config(root))
            self.assertFalse((root / "data" / "users").exists())
            self.assertFalse((root / "data" / "accounts.sqlite3").exists())


if __name__ == "__main__":
    unittest.main()
