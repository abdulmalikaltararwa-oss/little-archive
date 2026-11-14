"""Deleting an account also deletes its Supabase sign-in, with the project's secret key, against a stand-in Supabase.

The stand-in is an HTTP server on 127.0.0.1 that records what it is sent and answers as scripted. No real project, key or
network is involved, and the secret key used here is a made-up string.
"""
from contextlib import contextmanager
import json
import logging
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import sqlite3
import sys
import tempfile
from threading import Thread
import time
import unittest
from uuid import uuid4

from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent))
from support_hosted import SigningKey, bearer, claims, hosted_app, hosted_config, no_worker_threads  # noqa: E402

from server.account_deletion import FIRST_WAIT, LONGEST_WAIT, AuthDeletions, wait_for_attempt  # noqa: E402
from server.app import create_app  # noqa: E402
from server.config import Config  # noqa: E402
from server.diagnostics import diagnose  # noqa: E402
from server.supabase_admin import AdminUnavailable, SupabaseAdmin  # noqa: E402

KEY = "sb_secret_synthetic0stand0in0value0xyz"
LEGACY_KEY = "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic3ludGhldGljIn0.c3ludGhldGljLXNpZ25hdHVyZQ"


class StubSupabase:
    """`DELETE /auth/v1/admin/users/<id>` as a scripted loopback server. Replies are consumed in order; the last repeats."""

    def __init__(self, *replies):
        self.replies, self.requests = list(replies or [200]), []
        stub = self

        class Handler(BaseHTTPRequestHandler):
            def do_DELETE(self):
                length = int(self.headers.get("content-length") or 0)
                stub.requests.append({"method": "DELETE", "path": self.path, "headers": {k.lower(): v for k, v in self.headers.items()}, "body": self.rfile.read(length)})
                reply = stub.replies.pop(0) if len(stub.replies) > 1 else stub.replies[0]
                if isinstance(reply, tuple):  # ("redirect", location)
                    self.send_response(302)
                    self.send_header("Location", reply[1])
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                self.send_response(reply)
                body = b'{"id":"gone"}' if reply == 200 else b'{"msg":"not found-ish"}'
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            do_GET = do_POST = do_PUT = do_PATCH = do_DELETE

            def log_message(self, *args):
                pass
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = "http://127.0.0.1:%d" % self.server.server_address[1]
        Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


class DeletionCase(unittest.TestCase):
    key = KEY

    def build(self, *replies, key=None):
        self.stub = StubSupabase(*replies)
        self.addCleanup(self.stub.close)
        return self.start_app(self.stub.url, key or self.key)

    def start_app(self, url, key):
        self.app, _ = hosted_app(self.root, self.signing, supabase_url=url, supabase_service_key=key)
        client = TestClient(self.app)
        client.__enter__()
        self.addCleanup(client.__exit__, None, None, None)
        return client

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="little-archive-deletion-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.enterContext(no_worker_threads())
        self.signing = SigningKey()
        self.moment = [1_900_000_000]

    def account(self):
        user = str(uuid4())
        return user, bearer(self.signing.sign(claims(user)))

    def backdate_deletions(self):
        """Record deletions as if they had happened a while ago, so a token issued 'after' one can be made without waiting."""
        self.app.state.libraries.clock = lambda: time.time() - 100

    def signed_in_again(self, user):
        return bearer(self.signing.sign(claims(user, iat=int(time.time()) - 5, exp=int(time.time()) + 3600)))

    def delete(self, client, auth):
        return client.post("/api/account/delete", json={"confirm": "DELETE"}, headers=auth)

    def clocked(self):
        self.app.state.auth_deletions.clock = lambda: self.moment[0]
        return self.app.state.auth_deletions

    def owed(self):
        with sqlite3.connect(self.root / "data" / "accounts.sqlite3") as c:
            return c.execute("SELECT user_id,attempts,last_error FROM auth_deletions").fetchall()


class SignInDeletionTests(DeletionCase):
    def test_the_library_and_then_the_sign_in_are_deleted(self):
        client = self.build(200)
        (alice, a), (bob, b) = self.account(), self.account()
        client.post("/api/items", json={"url": "https://example.com/mine"}, headers=a)
        client.post("/api/items", json={"url": "https://example.com/his"}, headers=b)
        answer = self.delete(client, a)
        self.assertEqual((answer.status_code, answer.json()), (200, {"deleted": True, "auth_user_deleted": True}))
        self.assertFalse((self.root / "data" / "users" / alice).exists())
        self.assertTrue((self.root / "data" / "users" / bob).exists(), "another account is untouched")
        self.assertEqual(len(self.stub.requests), 1)
        sent = self.stub.requests[0]
        self.assertEqual((sent["method"], sent["path"]), ("DELETE", f"/auth/v1/admin/users/{alice}"))
        self.assertEqual(sent["headers"]["apikey"], KEY)
        self.assertNotIn("authorization", sent["headers"], "a sb_secret_ key is not a JWT and goes in apikey only")
        self.assertEqual(json.loads(sent["body"]), {"should_soft_delete": False}, "the user is removed, not just marked")
        self.assertEqual(self.owed(), [], "nothing is left owing, and the account id is not kept")
        self.assertEqual(client.get("/api/items", headers=a).status_code, 401, "and the token is refused from then on")

    def test_a_legacy_service_role_key_is_sent_the_way_supabases_own_libraries_send_it(self):
        client = self.build(200, key=LEGACY_KEY)
        user, auth = self.account()
        self.assertEqual(self.delete(client, auth).status_code, 200)
        headers = self.stub.requests[0]["headers"]
        self.assertEqual((headers["apikey"], headers["authorization"]), (LEGACY_KEY, "Bearer " + LEGACY_KEY))

    def test_a_user_who_is_already_gone_counts_as_deleted_so_a_repeat_is_safe(self):
        client = self.build(404)
        user, auth = self.account()
        self.backdate_deletions()
        self.assertEqual(self.delete(client, auth).json(), {"deleted": True, "auth_user_deleted": True})
        again = self.delete(client, self.signed_in_again(user))
        self.assertEqual((again.status_code, again.json()), (200, {"deleted": True, "auth_user_deleted": True}), "deleting twice is not an error")
        self.assertEqual(self.owed(), [])

    def test_when_supabase_fails_the_library_is_gone_the_person_is_told_and_it_is_retried(self):
        client = self.build(500, 503, 200)
        user, auth = self.account()
        client.post("/api/items", json={"url": "https://example.com/mine"}, headers=auth)
        deletions = self.clocked()
        answer = self.delete(client, auth)
        self.assertEqual(answer.status_code, 202)
        body = answer.json()
        self.assertEqual((body["deleted"], body["auth_user_deleted"], body["auth_deletion"]), (True, False, "pending"))
        self.assertIn("retried", body["detail"])
        self.assertFalse((self.root / "data" / "users" / user).exists(), "the library is deleted whatever happens to the sign-in")
        self.assertEqual(self.owed(), [(user, 1, "service_unavailable")], "the intent is kept until Supabase confirms")
        self.assertEqual(deletions.tick(), 0, "not yet due")
        self.assertEqual(len(self.stub.requests), 1)
        self.moment[0] += FIRST_WAIT + 1
        self.assertEqual(deletions.tick(), 0, "the second attempt fails too")
        self.assertEqual(self.owed(), [(user, 2, "service_unavailable")])
        self.moment[0] += 2 * FIRST_WAIT + 1
        self.assertEqual(deletions.tick(), 1)
        self.assertEqual(self.owed(), [])
        self.assertEqual([r["path"] for r in self.stub.requests], [f"/auth/v1/admin/users/{user}"] * 3)

    def test_waits_grow_and_are_bounded(self):
        self.assertEqual([wait_for_attempt(n) for n in range(1, 10)], [30, 60, 120, 240, 480, 960, 1920, 3600, 3600])
        self.assertEqual(wait_for_attempt(500), LONGEST_WAIT)

    def test_a_retry_also_removes_a_library_made_by_signing_in_again_meanwhile(self):
        client = self.build(500, 200)
        user, auth = self.account()
        deletions = self.clocked()
        self.backdate_deletions()
        self.assertEqual(self.delete(client, auth).status_code, 202)
        later = self.signed_in_again(user)
        self.assertEqual(client.post("/api/items", json={"url": "https://example.com/again"}, headers=later).status_code, 200, "they can still sign in until their sign-in is gone")
        self.assertTrue((self.root / "data" / "users" / user).exists())
        self.moment[0] += FIRST_WAIT + 1
        self.assertEqual(deletions.tick(), 1)
        self.assertFalse((self.root / "data" / "users" / user).exists(), "the new library goes with the sign-in")

    def test_a_refused_key_is_reported_to_the_operator_and_retried_without_the_key_in_the_log(self):
        client = self.build(401, 403, 200)
        user, auth = self.account()
        deletions = self.clocked()
        with self.assertLogs("little_archive", "WARNING") as logged:
            self.assertEqual(self.delete(client, auth).status_code, 202)
            self.moment[0] += FIRST_WAIT + 1
            deletions.tick()
        text = "\n".join(logged.output)
        self.assertIn("refused the secret key", text)
        self.assertIn("LA_SUPABASE_SERVICE_KEY", text, "the operator is told which setting to look at")
        for private in (KEY, user, "not found-ish"):
            self.assertNotIn(private, text)
        self.assertEqual(self.owed()[0][2], "key_refused")
        self.moment[0] += 10_000
        self.assertEqual(deletions.tick(), 1, "once the operator fixes it, the same deletion completes")

    def test_a_supabase_that_cannot_be_reached_is_the_same_as_one_that_fails(self):
        stub = StubSupabase(200)
        url = stub.url
        stub.close()  # nothing listens there now
        client = self.start_app(url, KEY)
        user, auth = self.account()
        answer = self.delete(client, auth)
        self.assertEqual((answer.status_code, answer.json()["auth_deletion"]), (202, "pending"))
        self.assertEqual(self.owed()[0][2], "unreachable")

    def test_a_redirect_is_never_followed_so_the_key_cannot_be_sent_elsewhere(self):
        elsewhere = StubSupabase(200)
        self.addCleanup(elsewhere.close)
        client = self.build(("redirect", elsewhere.url + "/capture"))
        user, auth = self.account()
        self.assertEqual(self.delete(client, auth).status_code, 202)
        self.assertEqual(elsewhere.requests, [], "the second host was never contacted")
        self.assertEqual(self.owed()[0][2], "redirected")

    def test_what_is_owed_survives_a_restart_and_is_finished_by_the_next_one(self):
        client = self.build(500)
        user, auth = self.account()
        self.assertEqual(self.delete(client, auth).status_code, 202)
        self.stub.replies[:] = [200]
        second, _ = hosted_app(self.root, self.signing, supabase_url=self.stub.url, supabase_service_key=KEY)
        deletions = second.state.auth_deletions
        deletions.clock = lambda: self.moment[0] + 10_000
        self.assertEqual(deletions.due(), [user])
        self.assertEqual(deletions.tick(), 1)
        self.assertEqual(self.owed(), [])

    def test_a_deletion_that_failed_part_way_through_the_library_is_still_finished(self):
        client = self.build(200)
        user, auth = self.account()
        client.post("/api/items", json={"url": "https://example.com/mine"}, headers=auth)
        libraries = self.app.state.libraries
        real = libraries.delete
        calls = []

        def failing_once(user_id):
            calls.append(user_id)
            if len(calls) == 1:
                raise OSError("disk trouble")
            return real(user_id)
        libraries.delete = failing_once
        with TestClient(self.app, raise_server_exceptions=False) as quiet:
            self.assertEqual(self.delete(quiet, auth).status_code, 500)
        self.assertEqual([row[0] for row in self.owed()], [user], "the intent was written before the library was touched")
        self.assertEqual(self.stub.requests, [], "the sign-in is not deleted while the library still is there")
        self.assertEqual(self.clocked().tick(), 1)
        self.assertEqual((len(calls), self.owed()), (3, []), "once by the request that failed, then before and after the sign-in call by the retry")


class WhatIsNeverShownTests(DeletionCase):
    def test_the_key_is_in_no_repr_response_log_file_or_report(self):
        client = self.build(200)
        user, auth = self.account()
        with self.assertLogs("little_archive", "DEBUG") as logged:
            logging.getLogger("little_archive").debug("a line so there is a record to read")
            self.delete(client, auth)
        responses = []
        other, other_auth = self.account()
        for method, path in (("GET", "/api/account"), ("GET", "/api/discovery"), ("GET", "/api/health"), ("GET", "/api/enrichment/status"), ("GET", "/api/settings"), ("GET", "/api/auth/me")):
            responses.append(client.request(method, path, headers=other_auth).text)
        responses.append(self.delete(client, other_auth).text)
        config = self.app.state.config
        admin = SupabaseAdmin("https://p.supabase.test", KEY)
        everything = "\n".join(responses + logged.output + [repr(config), str(config), repr(admin), str(admin), repr(self.app.state.auth_deletions), repr(vars(self.app.state.auth_deletions))])
        self.assertNotIn(KEY, everything)
        report = json.dumps(diagnose(env_file=self.root / "absent.env", environment={"LA_MODE": "hosted", "LA_SUPABASE_URL": "https://p.supabase.test", "LA_SUPABASE_JWT_SECRET": "s" * 40,
                                                                                   "LA_DATA_DIR": str(self.root / "doctor"), "LA_SUPABASE_SERVICE_KEY": KEY}))
        self.assertNotIn(KEY, report)
        for path in (self.root / "data").rglob("*"):
            if path.is_file():
                self.assertNotIn(KEY.encode(), path.read_bytes(), str(path.name))

    def test_an_error_from_the_client_has_no_key_in_it(self):
        admin = SupabaseAdmin("http://127.0.0.1:9", KEY, timeout=1)
        with self.assertRaises(AdminUnavailable) as caught:
            admin.delete_user(str(uuid4()))
        self.assertNotIn(KEY, str(caught.exception) + repr(caught.exception))
        self.assertEqual(caught.exception.reason, "unreachable")
        with self.assertRaises(ValueError):
            admin.delete_user("../../etc/passwd")
        with self.assertRaises(ValueError):
            SupabaseAdmin("https://p.supabase.test", "")


class DevelopmentStandInTests(unittest.TestCase):
    """mobile/dev/stub_supabase.py is the stand-in a person uses to try the app locally; it must accept the same call."""

    def test_the_admin_client_deletes_a_user_from_the_development_stand_in(self):
        import importlib.util
        import urllib.request
        spec = importlib.util.spec_from_file_location("stub_supabase", Path(__file__).resolve().parents[1] / "mobile" / "dev" / "stub_supabase.py")
        stub = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(stub)
        stub.USERS.clear()
        stub.Handler.secret, stub.Handler.publishable, stub.Handler.secret_key, stub.Handler.issuer = "j" * 40, "sb_publishable_synthetic0value0", KEY, "http://127.0.0.1/auth/v1"
        server = ThreadingHTTPServer(("127.0.0.1", 0), stub.Handler)
        Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        base = "http://127.0.0.1:%d" % server.server_address[1]
        request = urllib.request.Request(base + "/auth/v1/signup", data=json.dumps({"email": "a@example.test", "password": "long-enough-password"}).encode(), method="POST",
                                         headers={"apikey": "sb_publishable_synthetic0value0", "Content-Type": "application/json"})
        user = json.load(urllib.request.urlopen(request))["user"]["id"]
        self.assertEqual(len(stub.USERS), 1)
        with self.assertRaises(AdminUnavailable) as wrong:
            SupabaseAdmin(base, "sb_secret_a_different_made_up_value_0").delete_user(user)
        self.assertEqual(wrong.exception.reason, "key_refused")
        SupabaseAdmin(base, KEY).delete_user(user)
        self.assertEqual(stub.USERS, {})
        SupabaseAdmin(base, KEY).delete_user(user)  # already gone: still fine


class StartupRuleTests(unittest.TestCase):
    def config(self, folder, **changes):
        return Config(data_dir=Path(folder) / "data", public_url="http://localhost:8787", mode="hosted", supabase_url="https://p.supabase.test",
                      supabase_jwt_secret="s" * 40, **changes)

    def test_hosted_mode_will_not_start_without_the_key_unless_the_operator_says_to(self):
        with tempfile.TemporaryDirectory() as folder, no_worker_threads():
            with self.assertRaises(ValueError) as caught:
                create_app(self.config(folder))
            self.assertIn("LA_SUPABASE_SERVICE_KEY", str(caught.exception))
            self.assertIn("5.1.1(v)", str(caught.exception))
            self.assertFalse((Path(folder) / "data").exists(), "refused before anything was created")
            allowed = create_app(self.config(folder, hosted_allow_login_survives_deletion=True))
            self.assertIsNone(allowed.state.auth_deletions)
            keyed = create_app(self.config(folder, supabase_service_key=KEY))
            self.assertIsNotNone(keyed.state.auth_deletions)

    def test_the_key_comes_from_the_environment_and_is_checked(self):
        values = {"LA_MODE": "hosted", "LA_SUPABASE_URL": "https://p.supabase.test", "LA_SUPABASE_JWT_SECRET": "s" * 40, "LA_DATA_DIR": "/tmp/x", "LA_PUBLIC_URL": "http://localhost:8787"}
        config = Config.from_env({**values, "LA_SUPABASE_SERVICE_KEY": "  " + KEY + "  "})
        self.assertEqual(config.supabase_service_key, KEY)
        self.assertNotIn(KEY, repr(config))
        for bad in ("sb_publishable_" + "x" * 30, "tiny", "has spaces " * 4, "line\nbreak" + "x" * 30):
            with self.assertRaises(ValueError, msg=bad[:15]):
                Config.from_env({**values, "LA_SUPABASE_SERVICE_KEY": bad}).validate()
        self.assertTrue(Config.from_env({**values, "LA_HOSTED_ALLOW_LOGIN_SURVIVES_DELETION": "true"}).hosted_allow_login_survives_deletion)
        self.assertFalse(Config.from_env(values).hosted_allow_login_survives_deletion)

    def test_a_self_hosted_server_has_no_use_for_the_key(self):
        with self.assertRaises(ValueError) as caught:
            Config.from_env({"LA_SUPABASE_SERVICE_KEY": KEY, "LA_DATA_DIR": "/tmp/x"}).validate()
        self.assertIn("hosted", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
