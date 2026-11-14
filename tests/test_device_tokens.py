"""Full-access device tokens on a self-hosted library, and the scopes around them.

A native client cannot use the cookie and CSRF flow, so it exchanges the owner
password for a bearer token. These tests attack the edges: guessing, the
import-only extension scope, and a cookie riding along with a bad token.
Everything is synthetic and stays in a temporary directory.
"""
import hashlib
import io
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch
import zipfile

from fastapi.testclient import TestClient

from server import cli
from server.app import create_app
from server.backups import schema_signature
from server.config import Config
from server.enrich.schema import ENRICH_SCHEMA
from server.storage import SCHEMA


PASSWORD = "device-owner-password-2026"
ORIGIN = {"Origin": "http://testserver"}

# Routes that take no owner credential at all, and the import-only routes.
PUBLIC = {("GET", "/api/health"), ("GET", "/api/discovery"), ("GET", "/api/auth/me"), ("POST", "/api/auth/login"), ("POST", "/api/auth/devices")}
IMPORT_ONLY = {("GET", "/api/extension/status"), ("POST", "/api/extension/imports"),
               ("POST", "/api/extension/imports/{rid}/batches"), ("POST", "/api/extension/imports/{rid}/finish")}
HOSTED_ONLY = {("POST", "/api/account/delete")}  # answers 404 on a self-hosted library, whoever asks


def api_routes(app):
    for route in app.routes:
        path = getattr(route, "path", "")
        if path.startswith("/api/"):
            for method in sorted(route.methods - {"HEAD", "OPTIONS"}):
                yield method, path


def concrete(path):
    for name in ("{iid}", "{cid}", "{tid}", "{jid}", "{rid}"):
        path = path.replace(name, "00000000-0000-4000-8000-000000000000")
    return path.replace("{digest}", "0" * 64)


class DeviceTokenTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="little-archive-device-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.config = Config(data_dir=self.root / "data", admin_password=PASSWORD, public_url="http://testserver", testing=True)
        self.app = create_app(self.config)
        self.client = TestClient(self.app)
        self.client.__enter__()
        self.addCleanup(self.client.__exit__, None, None, None)

    def pair(self, name="Synthetic phone", password=PASSWORD, **kwargs):
        return self.client.post("/api/auth/devices", json={"password": password, "name": name}, **kwargs)

    def device(self, name="Synthetic phone"):
        response = self.pair(name)
        self.assertEqual(response.status_code, 200, response.text)
        return response.json(), {"Authorization": "Bearer " + response.json()["token"]}

    def session(self):
        """A separate browser that signed in with the cookie flow."""
        browser = TestClient(self.app)
        browser.__enter__()
        self.addCleanup(browser.__exit__, None, None, None)
        login = browser.post("/api/auth/login", json={"password": PASSWORD}, headers=ORIGIN)
        self.assertEqual(login.status_code, 200)
        return browser, {**ORIGIN, "X-CSRF-Token": login.json()["csrf_token"]}

    def extension(self):
        device, auth = self.device("Token maker")
        created = self.client.post("/api/extension/tokens", json={"name": "Synthetic browser"}, headers=auth)
        self.assertEqual(created.status_code, 200, created.text)
        return {"Authorization": "Bearer " + created.json()["token"]}

    def test_exchange_returns_a_named_token_that_is_listed_hashed_and_revocable(self):
        device, auth = self.device("  Kitchen tablet  ")
        self.assertEqual(set(device), {"id", "name", "token", "created_at"})
        self.assertEqual(device["name"], "Kitchen tablet")
        self.assertTrue(device["token"].startswith("lad_"))
        self.assertNotIn("set-cookie", self.pair("Second").headers)
        self.assertEqual(self.client.get("/api/items", headers=auth).status_code, 200)
        listed = self.client.get("/api/auth/devices", headers=auth).json()["devices"]
        self.assertEqual({row["name"] for row in listed}, {"Kitchen tablet", "Second"})
        mine = next(row for row in listed if row["id"] == device["id"])
        self.assertEqual(set(mine), {"id", "name", "created_at", "last_used_at", "current"})
        self.assertTrue(mine["current"])
        self.assertIsNotNone(mine["last_used_at"])
        self.assertFalse(next(row for row in listed if row["id"] != device["id"])["current"])
        with sqlite3.connect(self.root / "data" / "devices.sqlite3") as c:
            stored = [row[0] for row in c.execute("SELECT hash FROM device_tokens")]
            self.assertIn(hashlib.sha256(device["token"].encode()).hexdigest(), stored)
            dump = "\n".join(c.iterdump())
        self.assertNotIn(device["token"], dump, "the token itself must never be stored")
        self.assertEqual((self.root / "data" / "devices.sqlite3").stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.client.delete("/api/auth/devices/" + device["id"], headers=auth).status_code, 200)
        self.assertEqual(self.client.get("/api/items", headers=auth).status_code, 401)
        self.assertEqual(self.client.get("/api/items", headers=auth).headers["www-authenticate"], "Bearer")

    def test_browser_session_lists_and_revokes_devices_from_settings(self):
        device, auth = self.device()
        browser, headers = self.session()
        listed = browser.get("/api/auth/devices").json()["devices"]
        self.assertEqual([(row["name"], row["current"]) for row in listed], [("Synthetic phone", False)])
        self.assertEqual(browser.delete("/api/auth/devices/" + device["id"]).status_code, 403, "cookie writes still need CSRF")
        self.assertEqual(browser.delete("/api/auth/devices/" + device["id"], headers=headers).status_code, 200)
        self.assertEqual(self.client.get("/api/items", headers=auth).status_code, 401)
        self.assertEqual(self.client.get("/api/auth/me", headers=auth).json(), {"authenticated": False, "version": "0.1.0"})

    def test_wrong_passwords_share_one_lockout_with_browser_sign_in(self):
        for attempt in range(5):
            self.assertEqual(self.pair(password="wrong-guess-" + str(attempt)).status_code, 401)
            self.assertEqual(self.client.post("/api/auth/login", json={"password": "wrong-guess"}, headers=ORIGIN).status_code, 401)
        for response in (self.pair(), self.client.post("/api/auth/login", json={"password": PASSWORD}, headers=ORIGIN)):
            self.assertEqual(response.status_code, 429, "the correct password must not get through a locked-out peer")
            self.assertEqual(response.headers["retry-after"], "900")
        self.assertEqual(sorted(path.name for path in (self.root / "data").iterdir() if not path.name.startswith("library.sqlite3-")), ["assets", "library.sqlite3"],
                         "no device was paired, so the data directory holds exactly what it always has")

    def test_a_successful_exchange_clears_the_peers_failed_attempts(self):
        for attempt in range(9):
            self.assertEqual(self.pair(password="wrong-guess").status_code, 401)
        self.assertEqual(self.pair().status_code, 200)
        for attempt in range(9):
            self.assertEqual(self.pair(password="wrong-guess").status_code, 401)
        self.assertEqual(self.pair().status_code, 200)

    def test_exchange_refuses_cross_site_browsers_and_malformed_requests(self):
        self.assertEqual(self.pair(headers={"Origin": "https://unrelated.example"}).status_code, 403)
        self.assertEqual(self.pair(headers={"Sec-Fetch-Site": "cross-site"}).status_code, 403)
        self.assertEqual(self.pair(headers=ORIGIN).status_code, 200)
        self.assertEqual(self.client.post("/api/auth/devices", json={"password": PASSWORD}).status_code, 422)
        self.assertEqual(self.client.post("/api/auth/devices", json={"password": PASSWORD, "name": "x", "scope": "admin"}).status_code, 422)
        self.assertEqual(self.client.post("/api/auth/devices", content=b"x" * 9000, headers={"Content-Type": "application/json"}).status_code, 413)
        self.assertEqual(self.client.post("/api/auth/devices?password=" + PASSWORD + "&name=x").status_code, 422, "credentials are never read from a URL")

    def test_last_use_is_recorded_at_most_once_a_minute(self):
        device, auth = self.device()

        def used():
            return next(row for row in self.client.get("/api/auth/devices", headers=auth).json()["devices"] if row["id"] == device["id"])["last_used_at"]

        with patch("server.devices.now", return_value="2031-01-01T10:00:05+00:00"):
            self.assertEqual(used(), "2031-01-01T10:00:05+00:00")
        with patch("server.devices.now", return_value="2031-01-01T10:00:55+00:00"):
            self.assertEqual(used(), "2031-01-01T10:00:05+00:00")
        with patch("server.devices.now", return_value="2031-01-01T10:01:02+00:00"):
            self.assertEqual(used(), "2031-01-01T10:01:02+00:00")

    def test_twenty_device_limit(self):
        for number in range(20):
            self.assertEqual(self.pair(f"Device {number}").status_code, 200)
        refused = self.pair("One too many")
        self.assertEqual(refused.status_code, 400)
        self.assertIn("20-device limit", refused.json()["detail"])

    def test_signing_out_on_a_device_revokes_only_that_device(self):
        first, first_auth = self.device("First")
        second, second_auth = self.device("Second")
        self.assertEqual(self.client.post("/api/auth/logout", headers=first_auth).json(), {"ok": True})
        self.assertEqual(self.client.get("/api/items", headers=first_auth).status_code, 401)
        self.assertEqual(self.client.get("/api/items", headers=second_auth).status_code, 200)

    def test_a_cookie_never_rescues_a_bad_bearer_token(self):
        browser, headers = self.session()
        self.assertEqual(browser.get("/api/items").status_code, 200)
        extension = self.extension()["Authorization"]
        for label, value in (("unknown", "Bearer lad_" + "A" * 43), ("empty", "Bearer "), ("bare", "Bearer"), ("lowercase scheme", "bearer lad_wrong"),
                             ("extension token", extension), ("oversized", "Bearer lad_" + "A" * 400), ("session cookie value", "Bearer " + browser.cookies["little_archive_session"])):
            with self.subTest(token=label):
                bad = {"Authorization": value}
                self.assertEqual(browser.get("/api/items", headers=bad).status_code, 401)
                self.assertEqual(browser.get("/api/export", headers=bad).status_code, 401)
                self.assertEqual(browser.post("/api/items", json={"url": "https://example.com/x"}, headers={**headers, **bad}).status_code, 401)
                self.assertFalse(browser.get("/api/auth/me", headers=bad).json()["authenticated"])
        # A bearer credential hidden behind another Authorization header, or after one, still counts.
        for label, pairs in (("after a proxy's header", [("Authorization", "Basic c3ludGhldGljOnByb3h5"), ("Authorization", "Bearer lad_" + "A" * 43)]),
                             ("before a proxy's header", [("Authorization", "Bearer lad_" + "A" * 43), ("Authorization", "Basic c3ludGhldGljOnByb3h5")]),
                             ("two bearer values", [("Authorization", "Bearer lad_" + "A" * 43), ("Authorization", "Bearer lad_" + "B" * 43)]),
                             ("tab separator", [("Authorization", "Bearer\tlad_" + "A" * 43)]), ("leading space", [("Authorization", " Bearer lad_" + "A" * 43)])):
            with self.subTest(headers=label):
                self.assertEqual(browser.get("/api/items", headers=pairs).status_code, 401)
                self.assertEqual(browser.post("/api/items", json={"url": "https://example.com/x"}, headers=[*headers.items(), *pairs]).status_code, 401)
        self.assertEqual(browser.get("/api/items").json()["total"], 0, "no refused request may have written")
        self.assertTrue(browser.get("/api/auth/me").json()["authenticated"], "the session itself is still valid")

    def test_other_authorization_schemes_leave_the_cookie_flow_and_its_csrf_check_intact(self):
        browser, headers = self.session()
        proxy = {"Authorization": "Basic c3ludGhldGljOnByb3h5"}
        self.assertEqual(browser.get("/api/items", headers=proxy).status_code, 200)
        self.assertEqual(browser.post("/api/items", json={"url": "https://example.com/a"}, headers=proxy).status_code, 403)
        self.assertEqual(browser.post("/api/items", json={"url": "https://example.com/a"}, headers={**headers, **proxy}).status_code, 200)

    def test_bearer_writes_skip_csrf_while_cookie_writes_still_require_it(self):
        device, auth = self.device()
        browser, headers = self.session()
        body = {"url": "https://example.com/written"}
        self.assertEqual(self.client.post("/api/items", json=body, headers=auth).status_code, 200)
        self.assertEqual(self.client.post("/api/items", json=body, headers={**auth, "Origin": "https://unrelated.example", "X-CSRF-Token": "irrelevant"}).status_code, 200)
        self.assertEqual(browser.post("/api/items", json=body).status_code, 403)
        self.assertEqual(browser.post("/api/items", json=body, headers={**headers, "Origin": "https://unrelated.example"}).status_code, 403)

    def test_tokens_are_not_accepted_from_urls_cookies_or_other_headers(self):
        device, auth = self.device()
        token = device["token"]
        with TestClient(self.app) as other:
            self.assertEqual(other.get("/api/items", params={"token": token, "access_token": token, "authorization": "Bearer " + token}).status_code, 401)
            self.assertEqual(other.get("/api/items", headers={"X-Api-Key": token, "X-Authorization": "Bearer " + token}).status_code, 401)
            other.cookies.set("little_archive_session", token)
            other.cookies.set("Authorization", "Bearer " + token)
            self.assertEqual(other.get("/api/items").status_code, 401)

    def test_an_extension_token_reaches_nothing_but_its_import_routes(self):
        extension = self.extension()
        seen = 0
        for method, path in api_routes(self.app):
            if (method, path) in PUBLIC:
                continue
            with self.subTest(route=method + " " + path):
                response = self.client.request(method, concrete(path), json={}, headers=extension)
                if (method, path) in IMPORT_ONLY:
                    self.assertNotEqual(response.status_code, 401, "the import scope itself must keep working")
                else:
                    self.assertEqual(response.status_code, 404 if (method, path) in HOSTED_ONLY else 401)
                    seen += 1
        self.assertGreaterEqual(seen, 35, "the route inventory shrank unexpectedly")
        self.assertEqual(self.client.get("/api/auth/me", headers=extension).json(), {"authenticated": False, "version": "0.1.0"})
        self.assertEqual(self.pair(headers=extension, password="not-the-password").status_code, 401)

    def test_a_device_token_cannot_use_the_import_only_routes(self):
        device, auth = self.device()
        for method, path in sorted(IMPORT_ONLY):
            with self.subTest(route=method + " " + path):
                self.assertEqual(self.client.request(method, concrete(path), json={}, headers=auth).status_code, 401)

    def test_a_device_token_manages_extension_tokens_like_the_owner(self):
        device, auth = self.device()
        created = self.client.post("/api/extension/tokens", json={"name": "Synthetic browser"}, headers=auth).json()
        self.assertEqual([row["id"] for row in self.client.get("/api/extension/tokens", headers=auth).json()["tokens"]], [created["id"]])
        self.assertEqual(self.client.delete("/api/extension/tokens/" + created["id"], headers=auth).status_code, 200)
        self.assertEqual(self.client.get("/api/extension/status", headers={"Authorization": "Bearer " + created["token"]}).status_code, 401)

    def test_password_reset_revokes_every_device_token(self):
        device, auth = self.device()
        environment = {"LA_DATA_DIR": str(self.root / "data"), "LA_PUBLIC_URL": "http://localhost:8787", "LA_ADMIN_PASSWORD": "", "LA_MODE": ""}
        with patch.dict(os.environ, environment), patch("getpass.getpass", return_value="a-replacement-owner-password"), patch("builtins.print"):
            self.assertEqual(cli.main(["reset-password", "--env-file", str(self.root / "absent.env")]), 0)
        self.assertEqual(self.client.get("/api/items", headers=auth).status_code, 401)
        self.assertEqual(self.pair().status_code, 401)
        self.assertEqual(self.pair(password="a-replacement-owner-password").status_code, 200)

    def test_the_library_file_and_backups_stay_exactly_as_an_earlier_release_expects(self):
        device, auth = self.device()
        self.client.post("/api/items", json={"url": "https://example.com/kept"}, headers=auth)
        with sqlite3.connect(self.root / "data" / "library.sqlite3") as library, sqlite3.connect(":memory:") as reference:
            reference.executescript(SCHEMA + ENRICH_SCHEMA)
            self.assertEqual(schema_signature(library), schema_signature(reference), "device tokens must not change the library schema")
        archive = zipfile.ZipFile(io.BytesIO(self.client.get("/api/backup", headers=auth).content))
        self.assertEqual(sorted(archive.namelist()), ["library.sqlite3", "manifest.json"])
        for name in archive.namelist():
            for private in (device["token"], hashlib.sha256(device["token"].encode()).hexdigest()):
                self.assertNotIn(private.encode(), archive.read(name))


if __name__ == "__main__":
    unittest.main()
