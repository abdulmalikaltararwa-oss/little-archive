"""Deleting an account revokes its Sign in with Apple, against stand-ins for Apple and for Supabase.

Two layers. The application is run with a scripted Apple client (what was asked of it, in what order, and what it answers), and
the real client is run against a scripted HTTP transport, with a key made in memory, so the client secret it signs is checked
with real cryptography. No Apple account, key or network is involved: every identifier, code and token here is made up.
"""
import json
import logging
from pathlib import Path
import sqlite3
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
from urllib.parse import parse_qs
from uuid import uuid4

import httpx
import jwt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec, rsa
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent))
from support_hosted import FakeKeySet, SigningKey, bearer, claims, hosted_config, no_worker_threads  # noqa: E402

from server.apple_signin import AppleSignIn, AppleSignInClient, AppleUnavailable, client_from_config  # noqa: E402
from server.app import create_app  # noqa: E402
from server.config import Config  # noqa: E402
from server.diagnostics import diagnose  # noqa: E402
from server.identity import SupabaseVerifier  # noqa: E402
from server.supabase_admin import AdminUnavailable  # noqa: E402

TEAM, KEY_ID, CLIENT_ID = "TEAM123456", "KEY1234567", "app.littlearchive.mobile"
CODE = "c0de.synthetic-authorization-code.0.rrtq.Zx9"
REFRESH = "r.synthetic-apple-refresh-token-0123456789"
SERVICE_KEY = "sb_secret_synthetic0stand0in0value0xyz"


def pem(key=None):
    key = key or ec.generate_private_key(ec.SECP256R1())
    return key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()).decode()


class FakeApple:
    """Stands in for AppleSignInClient. `journal` is shared with the stand-in Supabase so the order of the two is visible."""

    def __init__(self, journal=None, exchange=None, revoke=None):
        self.journal = [] if journal is None else journal
        self.exchange_problem, self.revoke_problem, self.tokens = exchange, revoke, 0

    def exchange(self, code):
        self.journal.append(("apple.exchange", code))
        if self.exchange_problem:
            raise AppleUnavailable(self.exchange_problem)
        self.tokens += 1
        return f"{REFRESH}-{self.tokens}"

    def revoke(self, token):
        self.journal.append(("apple.revoke", token))
        if self.revoke_problem:
            raise self.revoke_problem if isinstance(self.revoke_problem, Exception) else AppleUnavailable(self.revoke_problem)


class FakeSupabaseAdmin:
    def __init__(self, journal, failing=False):
        self.journal, self.failing = journal, failing

    def delete_user(self, user_id):
        self.journal.append(("supabase.delete_user", user_id))
        if self.failing:
            raise AdminUnavailable("service_unavailable")


class AppCase(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="little-archive-apple-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.enterContext(no_worker_threads())
        self.signing, self.journal = SigningKey(), []

    def build(self, apple="default", admin="default", **settings):
        self.apple = FakeApple(self.journal) if apple == "default" else apple
        self.admin = FakeSupabaseAdmin(self.journal) if admin == "default" else admin
        config = hosted_config(self.root, **settings)
        self.app = create_app(config, identity=SupabaseVerifier.from_config(config, fetch=FakeKeySet(self.signing)), auth_admin=self.admin, apple_signin=self.apple)
        client = TestClient(self.app)
        client.__enter__()
        self.addCleanup(client.__exit__, None, None, None)
        return client

    def account(self):
        user = str(uuid4())
        return user, bearer(self.signing.sign(claims(user)))

    def send_code(self, client, auth, code=CODE):
        return client.post("/api/account/apple-authorization", json={"authorization_code": code}, headers=auth)

    def delete(self, client, auth):
        return client.post("/api/account/delete", json={"confirm": "DELETE"}, headers=auth)

    def kept(self):
        with sqlite3.connect(self.root / "data" / "accounts.sqlite3") as c:
            return c.execute("SELECT user_id,refresh_token FROM apple_signin_tokens ORDER BY rowid").fetchall()

    def everything_on_disk(self):
        return b"".join(path.read_bytes() for path in sorted((self.root / "data").rglob("*")) if path.is_file())


class AppleRevocationTests(AppCase):
    def test_the_code_is_traded_and_the_token_kept_for_that_account_only_and_never_returned(self):
        client = self.build()
        (alice, a), (bob, b) = self.account(), self.account()
        answer = self.send_code(client, a)
        self.assertEqual((answer.status_code, answer.json()), (200, {"stored": True}))
        self.assertEqual(self.journal, [("apple.exchange", CODE)])
        self.assertEqual(self.kept(), [(alice, REFRESH + "-1")])
        # Signing in again replaces the token: one per account, the newest.
        self.assertEqual(self.send_code(client, a, CODE + "2").json(), {"stored": True})
        self.assertEqual(self.kept(), [(alice, REFRESH + "-2")])
        for path in ("/api/account", "/api/auth/me", "/api/purchases", "/api/settings"):
            for auth in (a, b):
                text = client.get(path, headers=auth).text
                self.assertNotIn(REFRESH, text, path)
                self.assertNotIn(CODE, text, path)
        self.assertNotIn(REFRESH, answer.text)
        self.assertNotIn(REFRESH, repr(self.app.state.apple_signin) + repr(self.app.state.config))

    def test_deleting_revokes_with_apple_before_the_sign_in_is_deleted_and_keeps_nothing(self):
        client = self.build()
        (alice, a), (bob, b) = self.account(), self.account()
        self.send_code(client, a)
        self.send_code(client, b, CODE + "b")
        client.post("/api/items", json={"url": "https://example.com/mine"}, headers=a)
        del self.journal[:]
        answer = self.delete(client, a)
        self.assertEqual((answer.status_code, answer.json()), (200, {"deleted": True, "auth_user_deleted": True}), "the answer is what it always was")
        self.assertEqual(self.journal, [("apple.revoke", REFRESH + "-1"), ("supabase.delete_user", alice)], "Apple first, then the sign-in")
        self.assertFalse((self.root / "data" / "users" / alice).exists())
        self.assertEqual(self.kept(), [(bob, REFRESH + "-2")], "the other account's token is untouched")
        self.assertNotIn((REFRESH + "-1").encode(), self.everything_on_disk(), "no remnant of the token is left in the database files")

    def test_an_account_with_no_apple_sign_in_on_record_is_deleted_without_asking_apple(self):
        client = self.build()
        user, auth = self.account()
        client.post("/api/items", json={"url": "https://example.com/mine"}, headers=auth)
        self.assertEqual(self.delete(client, auth).json(), {"deleted": True, "auth_user_deleted": True})
        self.assertEqual(self.journal, [("supabase.delete_user", user)])

    def test_apple_failing_does_not_block_the_deletion_and_says_so_without_secrets(self):
        for problem in ("unreachable", "timeout", "service_unavailable", "key_refused", "rejected", RuntimeError("synthetic surprise " + REFRESH)):
            with self.subTest(problem=str(problem)[:20]):
                self.journal = []
                client = self.build(apple=FakeApple(self.journal, revoke=problem))
                user, auth = self.account()
                self.send_code(client, auth)
                client.post("/api/items", json={"url": "https://example.com/mine"}, headers=auth)
                with self.assertLogs("little_archive", "WARNING") as logged:
                    answer = self.delete(client, auth)
                self.assertEqual((answer.status_code, answer.json()), (200, {"deleted": True, "auth_user_deleted": True}))
                self.assertEqual([step[0] for step in self.journal], ["apple.exchange", "apple.revoke", "supabase.delete_user"], "one attempt, then on with the deletion")
                self.assertFalse((self.root / "data" / "users" / user).exists())
                self.assertEqual(self.kept(), [], "the token is not kept for later")
                text = "\n".join(logged.output)
                self.assertIn("Apple", text)
                for private in (REFRESH, CODE, user):
                    self.assertNotIn(private, text)
                if problem == "key_refused":
                    self.assertIn("LA_APPLE_SIGNIN_KEY_ID", text)
                    self.assertEqual(logged.records[0].levelno, logging.ERROR)

    def test_a_token_apple_no_longer_honours_counts_as_revoked_and_is_not_a_warning(self):
        client = self.build(apple=FakeApple(self.journal, revoke="grant_refused"))
        user, auth = self.account()
        self.send_code(client, auth)
        with self.assertNoLogs("little_archive", "WARNING"):
            self.assertEqual(self.delete(client, auth).status_code, 200)
        self.assertEqual(self.kept(), [])

    def test_a_sign_in_that_supabase_could_not_delete_yet_and_an_apple_sign_in_made_meanwhile_are_both_finished_by_the_retry(self):
        client = self.build(admin=FakeSupabaseAdmin(self.journal, failing=True))
        user, auth = self.account()
        self.send_code(client, auth)
        self.app.state.libraries.clock = lambda: time.time() - 100
        self.assertEqual(self.delete(client, auth).status_code, 202)
        self.assertEqual([step[0] for step in self.journal], ["apple.exchange", "apple.revoke", "supabase.delete_user"])
        # The person signs in with Apple again before the sign-in is gone: a new library and a new token.
        again = bearer(self.signing.sign(claims(user)))
        self.assertEqual(self.send_code(client, again, CODE + "again").json(), {"stored": True})
        self.assertEqual(len(self.kept()), 1)
        self.admin.failing = False
        deletions = self.app.state.auth_deletions
        deletions.clock = lambda: 4_000_000_000
        del self.journal[:]
        self.assertEqual(deletions.tick(), 1)
        self.assertEqual(self.journal, [("apple.revoke", REFRESH + "-2"), ("supabase.delete_user", user)])
        self.assertEqual(self.kept(), [])

    def test_a_code_apple_refuses_is_a_plain_400_and_an_unreachable_apple_a_503_and_neither_keeps_or_echoes_anything(self):
        for problem, status, code in (("grant_refused", 400, "apple_code_refused"), ("unreachable", 503, "apple_unavailable"), ("key_refused", 503, "apple_unavailable"), ("no_refresh_token", 503, "apple_unavailable")):
            with self.subTest(problem=problem):
                self.journal = []
                client = self.build(apple=FakeApple(self.journal, exchange=problem))
                user, auth = self.account()
                answer = self.send_code(client, auth)
                self.assertEqual((answer.status_code, answer.json()["code"]), (status, code))
                self.assertNotIn(CODE, answer.text)
                self.assertEqual(self.kept(), [])
                self.assertEqual(client.get("/api/items", headers=auth).status_code, 200, "the account works all the same")

    def test_the_log_never_carries_the_code_or_the_token(self):
        with self.assertLogs(level="DEBUG") as logged:
            logging.getLogger("little_archive").debug("synthetic line so that the log is never empty")
            client = self.build(apple=FakeApple(self.journal, revoke="unreachable"))
            (alice, a), (bob, b) = self.account(), self.account()
            self.send_code(client, a)
            self.delete(client, a)
            self.apple.exchange_problem = "key_refused"
            self.send_code(client, b)
        text = "\n".join(logged.output)
        for private in (REFRESH, CODE):
            self.assertNotIn(private, text)

    def test_only_something_shaped_like_a_code_is_sent_to_apple_and_only_by_a_signed_in_account(self):
        client = self.build()
        user, auth = self.account()
        for bad in ("short", "has a space in the middle of it", "line\nbreak-in-the-code", "nul\x00-in-the-code", "x" * 2049):
            self.assertIn(self.send_code(client, auth, bad).status_code, (400, 422), bad[:10])
        self.assertEqual(client.post("/api/account/apple-authorization", json={"authorization_code": CODE, "extra": 1}, headers=auth).status_code, 422)
        self.assertEqual(client.post("/api/account/apple-authorization", json={"authorization_code": CODE}).status_code, 401)
        self.assertEqual(self.journal, [], "Apple was asked nothing")

    def test_a_code_made_of_other_characters_than_the_ones_seen_so_far_is_still_sent_to_apple(self):
        client = self.build()
        user, auth = self.account()
        code = "c~9f!*'();:@&=+$,/?#[]%20é.code"
        self.assertEqual(self.send_code(client, auth, code).json(), {"stored": True})
        self.assertEqual(self.journal, [("apple.exchange", code)])

    def test_an_account_deleted_while_apple_was_answering_leaves_no_token_behind(self):
        client = self.build()
        user, auth = self.account()
        client.post("/api/items", json={"url": "https://example.com/mine"}, headers=auth)
        answers = []
        trade = self.apple.exchange

        def slow_exchange(code):
            answers.append(self.delete(client, auth).status_code)  # the deletion runs to its end while Apple is still answering
            return trade(code)
        self.apple.exchange = slow_exchange
        answer = self.send_code(client, auth)
        self.assertEqual((answers, answer.status_code, answer.json()), ([200], 200, {"stored": False}))
        self.assertEqual(self.kept(), [], "the late token is not kept")
        self.assertEqual([step[0] for step in self.journal], ["supabase.delete_user", "apple.exchange", "apple.revoke"], "and it is revoked")

    def test_one_account_cannot_make_the_server_ask_apple_without_end(self):
        client = self.build(apple=FakeApple(self.journal, exchange="grant_refused"))
        (alice, a), (bob, b) = self.account(), self.account()
        statuses = [self.send_code(client, a).status_code for _ in range(12)]
        self.assertEqual(statuses, [400] * 10 + [429] * 2)
        self.assertEqual(len(self.journal), 10)
        self.assertEqual(self.send_code(client, b).status_code, 400, "another account has its own allowance")

    def test_an_account_at_its_storage_quota_can_still_send_its_code(self):
        client = self.build(hosted_storage_quota_mb=1)
        user, auth = self.account()
        client.get("/api/items", headers=auth)
        store = self.app.state.libraries.open(user)
        (store.assets / ("0" * 64 + ".png")).write_bytes(b"\0" * (1024 * 1024))
        store.asset_bytes = None
        self.assertEqual(client.post("/api/items", json={"url": "https://example.com/full"}, headers=auth).status_code, 507)
        self.assertEqual(self.send_code(client, auth).json(), {"stored": True})


class FeatureOffTests(AppCase):
    def test_with_nothing_configured_nothing_is_sent_or_kept_and_deletion_is_what_it_was(self):
        with patch("server.apple_signin.AppleSignInClient", side_effect=AssertionError("no Apple client may be made")), \
             patch("server.apple_signin.httpx.Client", side_effect=AssertionError("Apple may not be contacted")):
            client = self.build(apple=None)
            self.assertFalse(self.app.state.apple_signin.enabled)
            user, auth = self.account()
            answer = self.send_code(client, auth)
            self.assertEqual((answer.status_code, answer.json()), (200, {"stored": False}))
            self.assertEqual(self.kept(), [])
            client.post("/api/items", json={"url": "https://example.com/mine"}, headers=auth)
            gone = self.delete(client, auth)
            self.assertEqual((gone.status_code, gone.json()), (200, {"deleted": True, "auth_user_deleted": True}))
        self.assertEqual(self.journal, [("supabase.delete_user", user)])

    def test_a_token_kept_before_the_feature_was_switched_off_goes_with_the_account_and_the_operator_is_told(self):
        client = self.build()
        user, auth = self.account()
        self.send_code(client, auth)
        self.app.state.apple_signin.client = None  # the operator removed the settings and restarted
        del self.journal[:]
        with self.assertLogs("little_archive", "WARNING") as logged:
            self.assertEqual(self.delete(client, auth).status_code, 200)
        self.assertEqual(self.journal, [("supabase.delete_user", user)])
        self.assertEqual(self.kept(), [])
        self.assertIn("no longer configured", "\n".join(logged.output))

    def test_a_self_hosted_server_has_no_such_route(self):
        app = create_app(Config(data_dir=self.root / "own", admin_password="owner-password-for-a-test-2026", public_url="http://testserver", testing=True))
        with TestClient(app) as client:
            token = client.post("/api/auth/devices", json={"password": "owner-password-for-a-test-2026", "name": "Synthetic phone"}).json()["token"]
            self.assertEqual(self.send_code(client, bearer(token)).status_code, 404)
        self.assertIsNone(app.state.apple_signin)


class AppleClientTests(unittest.TestCase):
    """The real client against a scripted transport: what it sends is what Apple's pages ask for."""

    def setUp(self):
        self.key = ec.generate_private_key(ec.SECP256R1())
        self.requests, self.answers = [], []

    def client(self, **changes):
        def handler(request):
            self.requests.append(request)
            answer = self.answers.pop(0) if len(self.answers) > 1 else self.answers[0]
            if isinstance(answer, Exception):
                raise answer
            return answer
        settings = {"transport": httpx.MockTransport(handler), "clock": lambda: 1_900_000_000, **changes}
        return AppleSignInClient(TEAM, KEY_ID, CLIENT_ID, pem(self.key), **settings)

    def form(self, index=-1):
        return {name: values[0] for name, values in parse_qs(self.requests[index].content.decode()).items()}

    def check_client_secret(self, secret):
        self.assertEqual(jwt.get_unverified_header(secret), {"alg": "ES256", "kid": KEY_ID, "typ": "JWT"})
        body = jwt.decode(secret, self.key.public_key(), algorithms=["ES256"], audience="https://appleid.apple.com", options={"verify_exp": False, "verify_iat": False})
        self.assertEqual(body, {"iss": TEAM, "iat": 1_900_000_000, "exp": 1_900_000_300, "aud": "https://appleid.apple.com", "sub": CLIENT_ID})

    def test_the_code_is_traded_with_a_client_secret_signed_by_the_key(self):
        self.answers = [httpx.Response(200, json={"access_token": "a.synthetic", "token_type": "Bearer", "expires_in": 3600, "refresh_token": REFRESH, "id_token": "x.y.z"})]
        self.assertEqual(self.client().exchange(CODE), REFRESH)
        request = self.requests[0]
        self.assertEqual((request.method, str(request.url)), ("POST", "https://appleid.apple.com/auth/token"))
        self.assertTrue(request.headers["content-type"].startswith("application/x-www-form-urlencoded"))
        form = self.form()
        self.assertEqual({name: form[name] for name in ("client_id", "code", "grant_type")}, {"client_id": CLIENT_ID, "code": CODE, "grant_type": "authorization_code"})
        self.assertEqual(set(form), {"client_id", "client_secret", "code", "grant_type"}, "no redirect_uri: the app's native sheet has none")
        self.check_client_secret(form["client_secret"])

    def test_the_token_is_revoked_as_a_refresh_token(self):
        self.answers = [httpx.Response(200)]
        self.assertIsNone(self.client().revoke(REFRESH))
        self.assertEqual(str(self.requests[0].url), "https://appleid.apple.com/auth/revoke")
        form = self.form()
        self.assertEqual({name: form[name] for name in ("client_id", "token", "token_type_hint")}, {"client_id": CLIENT_ID, "token": REFRESH, "token_type_hint": "refresh_token"})
        self.check_client_secret(form["client_secret"])

    def test_every_way_apple_can_fail_is_a_short_reason_that_holds_no_secret(self):
        cases = [
            (httpx.Response(400, json={"error": "invalid_grant"}), "grant_refused"),
            (httpx.Response(400, json={"error": "invalid_client"}), "key_refused"),
            (httpx.Response(400, json={"error": "invalid_request", "error_description": "echo " + REFRESH}), "rejected"),
            (httpx.Response(400, text="not json " + REFRESH), "rejected"),
            (httpx.Response(429), "service_unavailable"), (httpx.Response(503), "service_unavailable"),
            (httpx.Response(302, headers={"Location": "https://elsewhere.example/auth/revoke"}), "redirected"),
            (httpx.ConnectError("synthetic refusal " + REFRESH), "unreachable"), (httpx.ReadTimeout("synthetic timeout"), "timeout"),
        ]
        for answer, reason in cases:
            for call, argument in (("revoke", REFRESH), ("exchange", CODE)):
                with self.subTest(reason=reason, call=call):
                    self.requests, self.answers = [], [answer]
                    with self.assertRaises(AppleUnavailable) as raised:
                        getattr(self.client(), call)(argument)
                    self.assertEqual(raised.exception.reason, reason)
                    self.assertEqual(len(self.requests), 1, "a redirect is not followed and nothing is tried twice")
                    told = repr(raised.exception) + str(raised.exception) + repr(raised.exception.__cause__) + repr(raised.exception.__context__ if reason not in {"unreachable", "timeout"} else None)
                    for private in (REFRESH, CODE):
                        self.assertNotIn(private, told)

    def test_an_answer_without_a_usable_refresh_token_is_refused(self):
        for body in ({}, {"refresh_token": ""}, {"refresh_token": 7}, {"refresh_token": "has a space"}, ["list"], {"refresh_token": "x" * 5000}):
            self.answers = [httpx.Response(200, json=body)]
            with self.assertRaises(AppleUnavailable) as raised:
                self.client().exchange(CODE)
            self.assertEqual(raised.exception.reason, "no_refresh_token")

    def test_the_key_is_checked_at_start_and_never_shown(self):
        text = pem(self.key)
        self.assertNotIn(text[40:80], repr(self.client()))
        self.assertIn("\\n", text.replace("\n", "\\n"))
        AppleSignInClient(TEAM, KEY_ID, CLIENT_ID, text.replace("\n", "\\n"))  # one line, as an environment file may hold it
        wrong = [pem(ec.generate_private_key(ec.SECP384R1())), "-----BEGIN PRIVATE KEY-----\nbm90IGEga2V5\n-----END PRIVATE KEY-----", "",
                 rsa.generate_private_key(public_exponent=65537, key_size=2048).private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()).decode()]
        for bad in wrong:
            with self.assertRaises(ValueError) as raised:
                AppleSignInClient(TEAM, KEY_ID, CLIENT_ID, bad)
            self.assertIn("LA_APPLE_SIGNIN_PRIVATE_KEY", str(raised.exception))
            if bad:
                self.assertNotIn(bad[30:60], str(raised.exception))
            self.assertIsNone(raised.exception.__cause__)


class ConfigurationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="little-archive-apple-config-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.key = pem()
        self.base = {"LA_MODE": "hosted", "LA_DATA_DIR": str(self.root / "data"), "LA_PUBLIC_URL": "https://archive.example.test",
                     "LA_SUPABASE_URL": "https://synthetic-project.supabase.test", "LA_SUPABASE_SERVICE_KEY": SERVICE_KEY}
        self.apple = {"LA_APPLE_SIGNIN_TEAM_ID": TEAM, "LA_APPLE_SIGNIN_KEY_ID": KEY_ID, "LA_APPLE_SIGNIN_CLIENT_ID": CLIENT_ID, "LA_APPLE_SIGNIN_PRIVATE_KEY": self.key}

    def config(self, **changes):
        config = Config.from_env({**self.base, **changes})
        config.validate()
        return config

    def test_nothing_set_is_off_and_all_four_set_is_on(self):
        off = self.config()
        self.assertFalse(off.apple_signin_configured)
        self.assertIsNone(client_from_config(off))
        on = self.config(**self.apple)
        self.assertTrue(on.apple_signin_configured)
        self.assertIsInstance(client_from_config(on), AppleSignInClient)
        self.assertNotIn(self.key[40:80], repr(on))
        one_line = self.config(**{**self.apple, "LA_APPLE_SIGNIN_PRIVATE_KEY": self.key.strip().replace("\n", "\\n")})
        self.assertIsInstance(client_from_config(one_line), AppleSignInClient)

    def test_the_key_may_be_a_file_outside_the_source_tree(self):
        path = self.root / "AuthKey_SYNTHETIC.p8"
        path.write_text(self.key)
        settings = {**self.apple, "LA_APPLE_SIGNIN_PRIVATE_KEY": "", "LA_APPLE_SIGNIN_PRIVATE_KEY_FILE": str(path)}
        self.assertIsInstance(client_from_config(self.config(**settings)), AppleSignInClient)
        for bad, word in (("relative/AuthKey.p8", "absolute"), (str(Path(__file__).resolve().parent / "AuthKey.p8"), "outside the source tree")):
            with self.assertRaises(ValueError) as raised:
                self.config(**{**settings, "LA_APPLE_SIGNIN_PRIVATE_KEY_FILE": bad})
            self.assertIn(word, str(raised.exception))
        with self.assertRaises(ValueError) as raised:
            client_from_config(self.config(**{**settings, "LA_APPLE_SIGNIN_PRIVATE_KEY_FILE": str(self.root / "missing.p8")}))
        self.assertIn("LA_APPLE_SIGNIN_PRIVATE_KEY_FILE", str(raised.exception))
        with self.assertRaises(ValueError):
            self.config(**{**self.apple, "LA_APPLE_SIGNIN_PRIVATE_KEY_FILE": str(path)})  # inline and a file: which one?

    def test_a_half_set_or_misshapen_configuration_is_refused_without_showing_the_key(self):
        for missing in self.apple:
            with self.assertRaises(ValueError, msg=missing) as raised:
                self.config(**{**self.apple, missing: ""})
            self.assertIn("together", str(raised.exception))
        for name, bad in (("LA_APPLE_SIGNIN_TEAM_ID", "team123456"), ("LA_APPLE_SIGNIN_TEAM_ID", "SHORT"), ("LA_APPLE_SIGNIN_KEY_ID", "KEY-123456"),
                          ("LA_APPLE_SIGNIN_CLIENT_ID", "TEAM123456 app"), ("LA_APPLE_SIGNIN_PRIVATE_KEY", "c3ludGhldGljLW5vdC1hLXBlbS1rZXk")):
            with self.assertRaises(ValueError, msg=name) as raised:
                self.config(**{**self.apple, name: bad})
            self.assertIn(name, str(raised.exception))
            self.assertNotIn(self.key[40:80], str(raised.exception))
        with self.assertRaises(ValueError) as raised:
            Config.from_env({"LA_DATA_DIR": str(self.root / "own"), "LA_ADMIN_PASSWORD": "owner-password-for-a-test-2026", **self.apple}).validate()
        self.assertIn("LA_MODE=hosted", str(raised.exception))

    def test_a_key_that_is_not_a_key_stops_the_server_from_starting(self):
        broken = "-----BEGIN PRIVATE KEY-----\nbm90IGEga2V5\n-----END PRIVATE KEY-----"
        config = self.config(**{**self.apple, "LA_APPLE_SIGNIN_PRIVATE_KEY": broken})
        with no_worker_threads(), self.assertRaises(ValueError) as raised:
            create_app(config)
        self.assertNotIn("bm90IGEga2V5", str(raised.exception))

    def test_doctor_says_whether_apple_sign_ins_are_revoked_and_never_shows_the_key(self):
        def rows(result):
            return [(row["status"], row["code"]) for row in result["checks"] if row["id"] == "apple_signin_revocation"]
        off = diagnose(env_file=self.root / "absent.env", environment=self.base)
        self.assertEqual(rows(off), [], "with nothing set the report is what it was")
        on = diagnose(env_file=self.root / "absent.env", environment={**self.base, **self.apple})
        self.assertEqual(rows(on), [("passed", "apple_signin_key_configured")])
        self.assertEqual({row["id"]: row["status"] for row in on["checks"] if row["id"] != "apple_signin_revocation"}, {row["id"]: row["status"] for row in off["checks"]})
        self.assertNotIn(self.key[40:80], json.dumps([off, on]))

    def test_the_settings_are_read_from_an_environment_file_with_the_key_on_one_line(self):
        from server.configuration import read_env_values
        path = self.root / "hosted.env"
        one_line = self.key.strip().replace("\n", "\\n")
        path.write_text("".join(f"{name}={value}\n" for name, value in {**self.base, **self.apple, "LA_APPLE_SIGNIN_PRIVATE_KEY": f'"{one_line}"'}.items()))
        self.assertEqual(len(path.read_text().splitlines()), len(self.base) + len(self.apple))
        config = Config.from_env(read_env_values(path))
        config.validate()
        self.assertIsInstance(client_from_config(config), AppleSignInClient)
        report = diagnose(env_file=path, environment={})
        self.assertEqual([row["code"] for row in report["checks"] if row["id"] == "apple_signin_revocation"], ["apple_signin_key_configured"])
        self.assertNotIn(self.key[40:80], json.dumps(report))


class StoreTests(unittest.TestCase):
    def test_forgetting_twice_is_safe_and_asks_apple_once(self):
        with tempfile.TemporaryDirectory(prefix="little-archive-apple-store-") as folder:
            apple = FakeApple()
            accounts = AppleSignIn(Path(folder) / "accounts.sqlite3", apple)
            user = str(uuid4())
            accounts.keep(user, CODE)
            self.assertEqual(accounts.count(), 1)
            accounts.forget(user)
            accounts.forget(user)
            self.assertEqual([step[0] for step in apple.journal], ["apple.exchange", "apple.revoke"])
            self.assertEqual(accounts.count(), 0)
            with self.assertRaises(ValueError):
                accounts.keep("../not-an-account", CODE)


if __name__ == "__main__":
    unittest.main()
