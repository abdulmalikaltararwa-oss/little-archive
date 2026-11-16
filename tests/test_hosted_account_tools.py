"""Things an operator and a full account must be able to do in hosted mode: delete an account at a person's request from the
command line, switch a setting off at the storage limit, and find every setting and refusal code written down.

Synthetic data only. The sign-in service is the development stand-in for Supabase Auth on loopback; Tap is a dictionary.
"""
import contextlib
import importlib.util
from http.server import ThreadingHTTPServer
import io
import json
import os
from pathlib import Path
import re
import sqlite3
import sys
import warnings
import tempfile
from threading import Thread
import unittest
from unittest.mock import patch
from uuid import uuid4

from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent))
from support_hosted import SigningKey, bearer, claims, hosted_app, no_worker_threads  # noqa: E402
from test_hosted_tap import KEY as TAP_KEY, FakeTap  # noqa: E402

from server import cli  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
PUBLISHABLE = "sb_publishable_synthetic0value0xxxxxxxx"
SERVICE_KEY = "sb_secret_synthetic0test0value0not0real0"
JWT_SECRET = "j" * 40


class FullAccountTests(unittest.TestCase):
    def test_an_account_at_its_storage_quota_can_still_change_its_settings(self):
        with tempfile.TemporaryDirectory(prefix="little-archive-full-") as folder, no_worker_threads():
            key = SigningKey()
            app, _ = hosted_app(Path(folder), key, hosted_storage_quota_mb=1)
            user = str(uuid4())
            auth = bearer(key.sign(claims(user)))
            with TestClient(app) as client:
                self.assertEqual(client.patch("/api/settings", json={"ai_sharing_allowed": True}, headers=auth).json()["ai_sharing_allowed"], True)
                store = app.state.libraries.open(user)
                (store.assets / ("0" * 64 + ".png")).write_bytes(b"\0" * (1024 * 1024))
                store.asset_bytes = None
                self.assertEqual(client.post("/api/items", json={"url": "https://example.com/full"}, headers=auth).status_code, 507, "the account is full")
                off = client.patch("/api/settings", json={"ai_sharing_allowed": False}, headers=auth)
                self.assertEqual((off.status_code, off.json()["ai_sharing_allowed"]), (200, False), "switching sharing off must not be refused for want of room")
                self.assertEqual(client.get("/api/settings", headers=auth).json()["ai_sharing_allowed"], False)


class DeleteAccountCommandTests(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location("stub_supabase", ROOT / "mobile" / "dev" / "stub_supabase.py")
        self.stub = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.stub)
        self.stub.USERS.clear()
        server = ThreadingHTTPServer(("127.0.0.1", 0), self.stub.Handler)
        self.supabase = "http://127.0.0.1:%d" % server.server_address[1]
        self.stub.Handler.secret, self.stub.Handler.publishable, self.stub.Handler.secret_key, self.stub.Handler.issuer = JWT_SECRET, PUBLISHABLE, SERVICE_KEY, self.supabase + "/auth/v1"
        Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        self.temporary = tempfile.TemporaryDirectory(prefix="little-archive-delete-command-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.enterContext(no_worker_threads())
        self.environment = {"LA_MODE": "hosted", "LA_DATA_DIR": str(self.root / "data"), "LA_PUBLIC_URL": "http://localhost:8787", "LA_SUPABASE_URL": self.supabase,
                            "LA_SUPABASE_JWT_SECRET": JWT_SECRET, "LA_SUPABASE_SERVICE_KEY": SERVICE_KEY, "LA_TAP_SECRET_KEY": TAP_KEY, "LA_TAP_PRICE": "2.500"}

    def account(self, email):
        """An account as a person leaves it: a sign-in at the provider, a library with a save, and an unlock bought through Tap."""
        self.stub.USERS[email] = {"id": str(uuid4()), "password": "a-long-enough-password", "email": email}
        user = self.stub.USERS[email]["id"]
        token = self.stub.access_token(JWT_SECRET, self.supabase + "/auth/v1", user, email, 3600)
        tap = FakeTap()
        app, _ = hosted_app(self.root, purchase_clients={"tap": tap}, supabase_url=self.supabase, supabase_jwt_issuer=self.supabase + "/auth/v1", supabase_jwt_secret=JWT_SECRET,
                            supabase_service_key=SERVICE_KEY, tap_secret_key=TAP_KEY, tap_price="2.500")
        with TestClient(app) as client:
            auth = bearer(token)
            self.assertEqual(client.post("/api/items", json={"url": "https://example.com/kept"}, headers=auth).status_code, 200)
            client.post("/api/purchases/tap/start", json={"email": email}, headers=auth)
            tap.change(tap.created[0]["id"], status="CAPTURED")
            self.assertEqual(client.post("/api/purchases/tap/confirm", json={"tap_id": tap.created[0]["id"]}, headers=auth).status_code, 200)
            self.assertTrue(client.get("/api/account", headers=auth).json()["entitlements"]["unlocked"])
        return user, token

    def run_command(self, *arguments, typed=None, environment=None):
        out, err = io.StringIO(), io.StringIO()
        # The interpreter's own warnings (an unclosed database noticed at collection time) are not the command's words.
        with warnings.catch_warnings(), patch.dict(os.environ, environment or self.environment, clear=True), contextlib.redirect_stdout(out), contextlib.redirect_stderr(err), \
             patch("builtins.input", side_effect=[typed] if typed is not None else AssertionError("no question may be asked")):
            warnings.simplefilter("ignore")
            code = cli.main(["delete-account", *arguments, "--env-file", str(self.root / "absent.env")])
        return code, out.getvalue(), err.getvalue()

    def count(self, table, user):
        with sqlite3.connect(self.root / "data" / "accounts.sqlite3") as c:
            return c.execute(f"SELECT COUNT(*) FROM {table} WHERE user_id=?", (user,)).fetchone()[0]

    def test_it_deletes_the_library_the_unlock_the_payment_records_and_the_sign_in_and_says_so_without_secrets(self):
        (user, token), (other, other_token) = self.account("noor@example.test"), self.account("stays@example.test")
        self.assertEqual([self.count(table, user) for table in ("purchases", "tap_attempts", "entitlements")], [1, 1, 1])
        code, said, problems = self.run_command(user, "--yes")
        self.assertEqual((code, problems), (0, ""), said)
        for line in (f"Account {user}: a library is on this server, 1 purchase record(s).", "Deleted from this server", "The sign-in was deleted at the identity provider.", "restart it now"):
            self.assertIn(line, said)
        for secret in (SERVICE_KEY, TAP_KEY, JWT_SECRET, "noor@example.test", token):
            self.assertNotIn(secret, said + problems)
        self.assertEqual([self.count(table, user) for table in ("purchases", "tap_attempts", "entitlements")], [0, 0, 0])
        self.assertFalse((self.root / "data" / "users" / user).exists(), "the library and its thumbnails are gone")
        self.assertEqual(sorted(self.stub.USERS), ["stays@example.test"], "the sign-in is deleted at the provider, and only that one")
        self.assertEqual([self.count(table, other) for table in ("purchases", "tap_attempts", "entitlements")], [1, 1, 1], "nobody else's account is touched")
        app, _ = hosted_app(self.root, supabase_url=self.supabase, supabase_jwt_issuer=self.supabase + "/auth/v1", supabase_jwt_secret=JWT_SECRET, supabase_service_key=SERVICE_KEY)
        with TestClient(app) as client:
            self.assertEqual(client.get("/api/items", headers=bearer(token)).status_code, 401, "a sign-in from before the deletion no longer opens anything")
            self.assertEqual(client.get("/api/items", headers=bearer(other_token)).json()["total"], 1)
        code, said, _ = self.run_command(user, "--yes")
        self.assertEqual(code, 0, "asking again is safe")
        self.assertIn("no library is on this server, 0 purchase record(s)", said)

    def test_a_sign_in_with_apple_on_record_is_revoked_at_apple_and_removed(self):
        class Apple:
            def __init__(self):
                self.revoked = []

            def exchange(self, code):
                return "synthetic-apple-refresh-token"

            def revoke(self, token):
                self.revoked.append(token)

        apple = Apple()
        with patch("server.apple_signin.client_from_config", return_value=apple):
            user, token = self.account("noor@example.test")
            app, _ = hosted_app(self.root, supabase_url=self.supabase, supabase_jwt_issuer=self.supabase + "/auth/v1", supabase_jwt_secret=JWT_SECRET, supabase_service_key=SERVICE_KEY)
            app.state.apple_signin.keep(user, "synthetic-authorization-code")
            self.assertEqual(app.state.apple_signin.count(), 1)
            code, said, problems = self.run_command(user, "--yes")
            self.assertEqual((code, apple.revoked, app.state.apple_signin.count()), (0, ["synthetic-apple-refresh-token"], 0), said + problems)
        self.assertNotIn("synthetic-apple-refresh-token", said + problems)

    def test_it_asks_first_and_deletes_nothing_without_the_word(self):
        user, token = self.account("noor@example.test")
        code, said, _ = self.run_command(user, typed="yes")
        self.assertEqual(code, 1)
        self.assertIn("Nothing was deleted.", said)
        self.assertEqual((self.count("purchases", user), sorted(self.stub.USERS)), (1, ["noor@example.test"]))
        self.assertEqual(self.run_command(user, typed="DELETE")[0], 0)
        self.assertEqual((self.count("purchases", user), self.stub.USERS), (0, {}))

    def test_a_sign_in_that_could_not_be_deleted_is_said_plainly_and_left_on_record(self):
        user, token = self.account("noor@example.test")
        code, said, _ = self.run_command(user, "--yes", environment={**self.environment, "LA_SUPABASE_URL": "http://127.0.0.1:9"})
        self.assertEqual(code, 2)
        self.assertIn("could NOT be deleted", said)
        self.assertFalse((self.root / "data" / "users" / user).exists(), "the library is gone all the same")
        with sqlite3.connect(self.root / "data" / "accounts.sqlite3") as c:
            self.assertEqual(c.execute("SELECT COUNT(*) FROM auth_deletions WHERE user_id=?", (user,)).fetchone()[0], 1, "so the server finishes it later")

    def test_it_refuses_what_is_not_an_account_and_a_self_hosted_library(self):
        for bad in ("noor@example.test", "../../etc", "not-a-uuid"):
            code, said, problems = self.run_command(bad, "--yes")
            self.assertEqual(code, 1, bad)
            self.assertIn("not an account id", problems)
        code, said, problems = self.run_command(str(uuid4()), "--yes", environment={"LA_DATA_DIR": str(self.root / "own"), "LA_ADMIN_PASSWORD": "a-self-hosted-owner-password"})
        self.assertEqual(code, 1)
        self.assertIn("hosted mode", problems)
        self.assertFalse((self.root / "own").exists(), "refused before anything was made")


class WrittenDownTests(unittest.TestCase):
    def test_every_setting_added_for_payments_and_apple_sign_in_is_in_the_example_file_with_no_value(self):
        example = (ROOT / ".env.example").read_text(encoding="utf-8")
        names = ["LA_TAP_SECRET_KEY", "LA_TAP_PRICE", "LA_TAP_CURRENCY", "LA_TAP_RETURN_URL", "LA_TAP_MERCHANT_ID", "LA_TAP_ALLOW_TEST_PURCHASES", "LA_SUPABASE_PUBLISHABLE_KEY", "LA_PUBLIC_SITE_URL", "LA_SELLER_NAME",
                 "LA_APPLE_SIGNIN_TEAM_ID", "LA_APPLE_SIGNIN_KEY_ID", "LA_APPLE_SIGNIN_CLIENT_ID", "LA_APPLE_SIGNIN_PRIVATE_KEY", "LA_APPLE_SIGNIN_PRIVATE_KEY_FILE"]
        config = (ROOT / "server" / "config.py").read_text(encoding="utf-8")
        for name in names:
            self.assertIn(f'"{name}"', config, name + " is read by the server")
            lines = [line for line in example.splitlines() if line.startswith(f"# {name}=")]
            self.assertEqual(len(lines), 1, name)
            self.assertRegex(lines[0], r"^# [A-Z_]+=\s+# \S", name + " has a one-line comment and no value")
        self.assertIsNone(re.search(r"sk_(test|live)_[A-Za-z0-9]{8}|sb_secret_[A-Za-z0-9]|BEGIN PRIVATE KEY", example))

    def test_the_contract_names_every_refusal_code_and_way_of_unlocking_the_server_can_answer(self):
        contract = (ROOT / "API_CONTRACT.md").read_text(encoding="utf-8")
        source = "".join(path.read_text(encoding="utf-8") for path in (ROOT / "server").rglob("*.py"))
        for code in ("apple_code_refused", "apple_unavailable", "payment_open", "purchase_wrong_environment", "purchase_not_paid", "notification_invalid", "notification_unauthenticated"):
            self.assertIn(f'"{code}"', source, code + " is a code the server answers")
            self.assertIn(f"`{code}`", contract, code)
        account_line = next(line for line in contract.splitlines() if line.startswith("- GET `/api/account`"))
        self.assertIn("'tap'", account_line, "unlocked_via can be tap")

    def test_the_hosted_guide_names_the_outside_hosts_and_the_tables_the_new_code_added(self):
        guide = (ROOT / "docs" / "hosted-mode.md").read_text(encoding="utf-8")
        outbound = next(line for line in guide.splitlines() if line.startswith("The server's other outbound requests go to fixed hosts"))
        for host in ("api.tap.company", "appleid.apple.com"):
            self.assertIn(host, outbound)
        bookkeeping = next(line for line in guide.splitlines() if line.startswith("`accounts.sqlite3` holds small tables"))
        for held in ("Sign in with Apple", "payments started at Tap"):
            self.assertIn(held, bookkeeping)
        self.assertIn("delete-account", guide)


if __name__ == "__main__":
    unittest.main()
