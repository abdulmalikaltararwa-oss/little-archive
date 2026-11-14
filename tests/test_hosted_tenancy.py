"""Adversarial checks on hosted tenancy: isolation, limits, deletion and background work.

Two or more synthetic accounts share one hosted server. Each test tries to make
one account see, change, enumerate or outlive another's library, or to escape the
limits a public service needs. Everything lives in a temporary directory; tokens
are signed locally and no network is used.
"""
import ast
import io
import json
import os
from pathlib import Path
import random
import sqlite3
import tempfile
from threading import Event, Thread
import time
import unittest
from unittest.mock import patch
from uuid import uuid4
import zipfile

from fastapi.testclient import TestClient
from PIL import Image, ImageOps

from server.app import create_app
from server.config import Config
from fastapi import HTTPException

from server.backups import create_backup
from server.enrich.images import write_asset
from server.entitlements import MemoryEntitlements, OwnerEntitlements, SQLiteEntitlements, usage_key
from server.storage import LibraryClosed, LibraryFull
from server.tenancy import AccountDeleted, LibraryManager, account_hash, release_orphans
from support_hosted import SigningKey, bearer, claims, fake_model, hosted_app, hosted_config, no_worker_threads, offer_closer_reads


MODEL = {"ollama_url": "http://127.0.0.1:1", "ollama_model": "synthetic-model"}
PUBLIC = {("GET", "/api/health"), ("GET", "/api/discovery"), ("GET", "/api/auth/me")}


def image(color="#91a58f", size=(24, 18), kind="PNG"):
    body = io.BytesIO()
    Image.new("RGB", size, color).save(body, kind)
    return body.getvalue()


def api_routes(app):
    for route in app.routes:
        path = getattr(route, "path", "")
        if path.startswith("/api/"):
            for method in sorted(route.methods - {"HEAD", "OPTIONS"}):
                yield method, path


class HostedCase(unittest.TestCase):
    settings = {}

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="little-archive-tenancy-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.data = self.root / "data"
        self.enterContext(no_worker_threads())
        self.key = SigningKey()
        self.app, self.keyset = hosted_app(self.root, self.key, **self.settings)
        self.client = TestClient(self.app)
        self.client.__enter__()
        self.addCleanup(self.client.__exit__, None, None, None)
        self.libraries, self.entitlements = self.app.state.libraries, self.app.state.entitlements

    def account(self, **token_claims):
        user = str(uuid4())
        return user, bearer(self.key.sign(claims(user, **token_claims)))

    def ok(self, auth, method, path, data=None, **kwargs):
        if data is not None:
            kwargs["json"] = data
        response = self.client.request(method, path, headers={**auth, **kwargs.pop("headers", {})}, **kwargs)
        self.assertEqual(response.status_code, 200, response.text[:300])
        return response

    def status(self, auth, method, path, data=None, **kwargs):
        if data is not None:
            kwargs["json"] = data
        return self.client.request(method, path, headers=auth, **kwargs).status_code

    def tree(self):
        return sorted(str(path.relative_to(self.data)) for path in self.data.rglob("*") if path.is_file())


class TenantIsolationTests(HostedCase):
    settings = {**MODEL, "hosted_free_deep_reads_monthly": 100}

    def populate(self, auth, name):
        """One of every resource type, each carrying the owner's private marker."""
        marker = name + "-private-marker"
        shelf = self.ok(auth, "POST", "/api/collections", {"name": marker + " shelf"}).json()
        item = self.ok(auth, "POST", "/api/items", {"url": f"https://example.com/{name}", "title": marker + " title", "notes": marker + " note",
                                                    "tags": [marker + "-tag"], "collection_ids": [shelf["id"]], "caption": marker + " caption"}).json()
        color = {"alice": "#aa3311", "bob": "#1133aa"}[name]
        thumbnail = self.ok(auth, "POST", f"/api/items/{item['id']}/thumbnail", content=image(color)).json()["thumbnail_url"]
        self.ok(auth, "POST", f"/api/items/{item['id']}/page", {"extraction": {"creator": marker + " creator", "site_name": marker + " site"}})
        self.ok(auth, "POST", f"/api/items/{item['id']}/transcript", {"text": marker + " spoken words"})
        run = self.ok(auth, "POST", "/api/imports/file", params={"filename": name + ".csv"}, content=f"url,title\nhttps://example.com/{name}/imported,{marker} imported\n".encode()).json()
        self.ok(auth, "PATCH", "/api/settings", {"remote_previews": name == "alice"})
        self.ok(auth, "POST", "/api/ai/jobs", {"ids": [item["id"]]})
        job = self.ok(auth, "GET", "/api/ai/jobs").json()["jobs"][0]
        return {"marker": marker, "item": item["id"], "shelf": shelf["id"], "thumbnail": thumbnail, "run": run["run_id"], "job": job["id"]}

    def setUp(self):
        super().setUp()
        (self.alice, self.a), (self.bob, self.b) = self.account(), self.account()
        self.hers, self.his = self.populate(self.a, "alice"), self.populate(self.b, "bob")

    def snapshot(self, auth):
        return {"items": self.ok(auth, "GET", "/api/export").json()["items"], "collections": self.ok(auth, "GET", "/api/collections").json(),
                "listed": self.ok(auth, "GET", "/api/items").json()["items"], "usage": self.ok(auth, "GET", "/api/enrichment/usage").json(),
                "jobs": self.ok(auth, "GET", "/api/ai/jobs").json(), "imports": self.ok(auth, "GET", "/api/imports").json(),
                "settings": self.ok(auth, "GET", "/api/settings").json(), "tags": self.ok(auth, "GET", "/api/tags").json()}

    def test_each_account_has_its_own_directory_and_nothing_is_shared(self):
        self.assertEqual({path.name for path in (self.data / "users").iterdir()}, {self.alice, self.bob})
        for user in (self.alice, self.bob):
            folder = self.data / "users" / user
            self.assertTrue((folder / "library.sqlite3").is_file())
            self.assertEqual(len(list((folder / "assets").glob("*.png"))), 1)
            self.assertEqual(folder.stat().st_mode & 0o777, 0o700)
        self.assertEqual({path.name for path in self.data.iterdir() if not path.name.startswith("accounts.sqlite3-")}, {"users", "accounts.sqlite3"})
        hers = (self.data / "users" / self.alice / "library.sqlite3").read_bytes()
        his = (self.data / "users" / self.bob / "library.sqlite3").read_bytes()
        self.assertIn(b"alice-private-marker", hers)
        self.assertNotIn(b"bob-private-marker", hers)
        self.assertNotIn(b"alice-private-marker", his)

    def test_one_account_cannot_reach_any_resource_of_another(self):
        before = self.snapshot(self.a)
        hers, b = self.hers, self.b
        refused = {
            "read item": ("GET", f"/api/items/{hers['item']}", None, 404),
            "edit item": ("PATCH", f"/api/items/{hers['item']}", {"notes": "taken over"}, 404),
            "delete item": ("DELETE", f"/api/items/{hers['item']}", None, 404),
            "replace thumbnail": ("POST", f"/api/items/{hers['item']}/thumbnail", None, 404),
            "remove thumbnail": ("DELETE", f"/api/items/{hers['item']}/thumbnail", None, 404),
            "read thumbnail": ("GET", hers["thumbnail"], None, 404),
            "bulk by id": ("POST", "/api/items/bulk", {"ids": [hers["item"]], "action": "archive"}, 404),
            "bulk into her collection": ("POST", "/api/items/bulk", {"ids": [self.his["item"]], "action": "collection", "value": hers["shelf"]}, 400),
            "rename collection": ("PATCH", f"/api/collections/{hers['shelf']}", {"name": "taken over"}, 404),
            "delete collection": ("DELETE", f"/api/collections/{hers['shelf']}", None, 404),
            "file into her collection": ("PATCH", f"/api/items/{self.his['item']}", {"collection_ids": [hers["shelf"]]}, 400),
            "save into her collection": ("POST", "/api/items", {"url": "https://example.com/new", "collection_ids": [hers["shelf"]]}, 400),
            "queue her item": ("POST", "/api/ai/jobs", {"ids": [hers["item"]]}, 400),
            "retry her job": ("POST", f"/api/ai/jobs/{hers['job']}/retry", None, 404),
            "accept her suggestion": ("POST", f"/api/items/{hers['item']}/ai/accept", None, 404),
            "dismiss her suggestion": ("POST", f"/api/items/{hers['item']}/ai/dismiss", None, 404),
            "attach page details": ("POST", f"/api/items/{hers['item']}/page", {"extraction": {"title": "taken over", "caption": "taken over"}}, 404),
            "ask the server to read her page": ("POST", f"/api/items/{hers['item']}/page", {"fetch": True}, 404),
            "add a transcript": ("POST", f"/api/items/{hers['item']}/transcript", {"text": "taken over"}, 404),
            "remove her transcript": ("DELETE", f"/api/items/{hers['item']}/transcript", None, 404),
            "closer read of her item": ("POST", f"/api/items/{hers['item']}/deep-read", None, 404),
        }
        for label, (method, path, body, expected) in refused.items():
            with self.subTest(attempt=label):
                kwargs = {"content": image("#000000")} if label == "replace thumbnail" else {}
                self.assertEqual(self.status(b, method, path, body, **kwargs), expected)
        self.assertEqual(self.snapshot(self.a), before, "none of the attempts may have changed her library")
        self.assertEqual(self.ok(self.a, "GET", hers["thumbnail"]).headers["content-type"], "image/png")

    def test_listing_search_and_summaries_never_include_another_account(self):
        b, marker = self.b, self.hers["marker"]
        for params in ({}, {"q": "alice"}, {"q": marker}, {"tag": marker + "-tag"}, {"collection_id": self.hers["shelf"]}, {"status": "archived"}, {"sort": "random"}):
            listed = self.ok(b, "GET", "/api/items", params=params).json()
            self.assertNotIn(marker, json.dumps(listed))
        self.assertEqual(self.ok(b, "GET", "/api/items", params={"collection_id": self.hers["shelf"]}).json()["total"], 0)
        self.assertEqual(self.ok(b, "POST", "/api/items/bulk", {"filters": {"q": "alice"}, "action": "archive"}).json(), {"updated": 0})
        self.assertEqual(self.ok(b, "POST", "/api/ai/jobs", {"filters": {"q": "alice"}}).json()["matched"], 0)
        for path in ("/api/collections", "/api/tags", "/api/stats", "/api/imports", "/api/ai/jobs", "/api/settings", "/api/account",
                     "/api/enrichment/status", "/api/enrichment/usage", "/api/export", "/api/export?format=csv", "/api/export?format=html"):
            with self.subTest(path=path):
                body = self.ok(b, "GET", path).text
                self.assertNotIn(marker, body)
                self.assertNotIn(self.alice, body)
                for identifier in ("item", "shelf", "run", "job"):
                    self.assertNotIn(self.hers[identifier], body)
        self.assertEqual(self.ok(b, "GET", "/api/stats").json()["total"], 2)
        self.assertEqual([run["id"] for run in self.ok(b, "GET", "/api/imports").json()["imports"]], [self.his["run"]])
        self.assertEqual([job["id"] for job in self.ok(b, "GET", "/api/ai/jobs").json()["jobs"]], [self.his["job"]])
        self.assertFalse(self.ok(b, "GET", "/api/settings").json()["remote_previews"])
        self.assertTrue(self.ok(self.a, "GET", "/api/settings").json()["remote_previews"])
        self.assertEqual(self.ok(b, "GET", "/api/account").json()["user_id"], self.bob)
        self.assertEqual(self.ok(b, "GET", "/api/enrichment/usage").json()["page_reads"], 1, "each account's usage is its own")
        self.assertEqual(self.ok(b, "GET", "/api/items", params={"q": "spoken"}).json()["total"], 1, "search over transcripts stays in the caller's library")

    def test_each_account_has_its_own_understanding_service(self):
        hers, his = self.libraries.open(self.alice), self.libraries.open(self.bob)
        self.assertIsNot(hers.enrichment, his.enrichment)
        self.assertIs(hers.enrichment.store, hers)
        self.assertIs(his.enrichment.worker.store, his)
        self.assertIs(his.enrichment.ledger.store, his)
        self.assertIsNone(self.app.state.enrichment, "a hosted server has no library-wide service a route could fall back to")
        offer_closer_reads(hers)
        self.assertFalse(hers.enrichment.settings.transcribe_auto)
        self.assertFalse(hers.enrichment.wants_auto_transcript(hers.get_item(self.hers["item"])), "transcripts are made only by a metered closer read")
        self.assertIsNone(self.app.state.store)
        tree = ast.parse((Path(__file__).resolve().parents[1] / "server" / "enrich" / "routes.py").read_text())
        installer = next(node for node in ast.walk(tree) if isinstance(node, ast.FunctionDef) and node.name == "install_routes")
        self.assertNotIn("service", [argument.arg for argument in installer.args.args + installer.args.kwonlyargs], "no service is fixed when the routes are installed")
        handlers = [node for node in installer.body if isinstance(node, ast.FunctionDef)]
        self.assertEqual(len(handlers), 6)
        for handler in handlers:
            with self.subTest(handler=handler.name):
                self.assertIn("Depends(owner)", ast.unparse(handler.args))
                self.assertIn("auth.store.enrichment", ast.unparse(handler), "every understanding route uses the caller's own service")

    def test_cancelling_and_bulk_operations_stay_inside_the_callers_library(self):
        self.assertEqual(self.ok(self.b, "POST", "/api/ai/jobs/cancel").json(), {"cancelled": 1})
        self.assertEqual(self.ok(self.a, "GET", "/api/ai/jobs").json()["counts"]["queued"], 1)
        self.assertEqual(self.ok(self.b, "POST", "/api/items/bulk", {"filters": {}, "action": "tag", "value": "bob-was-here"}).json(), {"updated": 2})
        self.assertNotIn("bob-was-here", self.ok(self.a, "GET", "/api/export").text)
        self.ok(self.b, "POST", "/api/demo")
        self.assertEqual(self.ok(self.a, "GET", "/api/stats").json()["total"], 2)

    def test_backup_holds_only_the_callers_library_and_assets(self):
        archive = zipfile.ZipFile(io.BytesIO(self.ok(self.b, "GET", "/api/backup").content))
        manifest = json.loads(archive.read("manifest.json"))
        self.assertEqual(manifest["items"], 2)
        his_asset = self.his["thumbnail"].rsplit("/", 1)[1]
        self.assertEqual({name for name in archive.namelist() if name.startswith("assets/")}, {f"assets/{his_asset}.png"})
        for name in archive.namelist():
            content = archive.read(name)
            self.assertNotIn(b"alice-private-marker", content)
            self.assertNotIn(self.alice.encode(), content)
        self.assertIn(b"bob-private-marker", archive.read("library.sqlite3"))
        self.assertEqual(list((self.data / "users" / self.alice).glob(".backup-work/*")), [], "her directory was not used as staging")

    def test_identical_thumbnails_are_stored_per_account_and_do_not_leak_existence(self):
        _, carol = self.account()
        shared = image("#445566")
        theirs = []
        for auth in (self.a, carol):
            item = self.ok(auth, "POST", "/api/items", {"url": "https://example.com/shared-picture"}).json()
            theirs.append((item["id"], self.ok(auth, "POST", f"/api/items/{item['id']}/thumbnail", content=shared).json()["thumbnail_url"]))
        self.assertEqual(theirs[0][1], theirs[1][1], "content addressing gives both the same relative URL")
        self.assertEqual(self.status(self.b, "GET", theirs[0][1]), 404, "a third account learns nothing from a known digest")
        self.ok(carol, "DELETE", "/api/items/" + theirs[1][0])
        self.assertEqual(self.status(carol, "GET", theirs[1][1]), 404)
        self.assertEqual(self.status(self.a, "GET", theirs[0][1]), 200, "removing one account's copy leaves the other's intact")

    def test_one_accounts_slow_upload_or_import_does_not_stall_another_account(self):
        from server import importers
        entered, release, results = Event(), Event(), {}
        decode, parse = ImageOps.exif_transpose, importers.parse_import

        def held(original):
            def slow(*args, **kwargs):
                entered.set()
                if not release.wait(10):
                    raise AssertionError("The blocked request was never released.")
                return original(*args, **kwargs)
            return slow

        for label, target, send in (
            ("thumbnail", patch("PIL.ImageOps.exif_transpose", side_effect=held(decode)),
             lambda: self.client.post(f"/api/items/{self.hers['item']}/thumbnail", content=image("#123456"), headers=self.a)),
            ("import", patch("server.importers.parse_import", side_effect=held(parse)),
             lambda: self.client.post("/api/imports/file?filename=slow.csv", content=b"url\nhttps://example.com/slow\n", headers=self.a)),
        ):
            with self.subTest(blocked=label), target:
                entered.clear()
                release.clear()
                slow = Thread(target=lambda: results.__setitem__(label, send().status_code), daemon=True)
                other = Thread(target=lambda: results.__setitem__(label + " other", self.client.get("/api/items", headers=self.b).status_code), daemon=True)
                slow.start()
                try:
                    self.assertTrue(entered.wait(5), "the slow request never reached its blocking step")
                    other.start()
                    other.join(5)
                    self.assertFalse(other.is_alive(), "another account's request waited behind a blocked upload")
                    self.assertEqual(results[label + " other"], 200)
                    self.assertNotIn(label, results, "the slow request should still be in progress")
                finally:
                    release.set()
                    slow.join(10)
                self.assertEqual(results[label], 200)

    def test_nothing_a_client_sends_can_select_another_library(self):
        target = self.alice
        selectors = {"X-User-Id": target, "X-Account-Id": target, "X-Tenant": target, "X-Supabase-User": target, "X-Forwarded-User": target, "Cookie": "user_id=" + target}
        listed = self.ok(self.b, "GET", "/api/items", params={"user_id": target, "account": target, "tenant": target, "sub": target}, headers=selectors).json()
        self.assertNotIn("alice-private-marker", json.dumps(listed))
        self.assertEqual(self.ok(self.b, "GET", "/api/account", headers=selectors).json()["user_id"], self.bob)
        self.assertEqual(self.status(self.b, "POST", "/api/items", {"url": "https://example.com/x", "user_id": target}), 422)
        self.assertEqual(self.status(self.b, "GET", f"/api/items/..%2F..%2F{target}%2F{self.hers['item']}"), 404)
        self.assertEqual(self.status(self.b, "GET", f"/api/assets/..%2F..%2F{target}%2Fassets%2F{self.hers['thumbnail'].rsplit('/', 1)[1]}"), 404)

    def test_every_route_needs_a_verified_account_or_does_not_exist(self):
        checked = 0
        for method, path in api_routes(self.app):
            if (method, path) in PUBLIC:
                continue
            concrete = path.replace("{iid}", self.hers["item"]).replace("{cid}", self.hers["shelf"]).replace("{jid}", self.hers["job"]) \
                .replace("{digest}", self.hers["thumbnail"].rsplit("/", 1)[1]).replace("{tid}", "x").replace("{rid}", self.hers["run"])
            with self.subTest(route=method + " " + path):
                anonymous = self.client.request(method, concrete, json={})
                self.assertIn(anonymous.status_code, {401, 404})
                self.assertNotIn("alice-private-marker", anonymous.text)
                checked += 1
        self.assertGreaterEqual(checked, 40)

    def test_route_handlers_use_only_the_authenticated_library(self):
        """Structural guard: a handler may touch the single-owner store only if hosted mode refuses the route."""
        source = (Path(__file__).resolve().parents[1] / "server" / "app.py").read_text()
        public = {"/api/health", "/api/discovery", "/api/auth/me"}
        routes = 0
        for node in ast.walk(ast.parse(source)):
            if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            for decorator in node.decorator_list:
                if not (isinstance(decorator, ast.Call) and isinstance(decorator.func, ast.Attribute) and getattr(decorator.func.value, "id", "") == "app"
                        and decorator.func.attr in {"get", "post", "put", "patch", "delete"}):
                    continue
                routes += 1
                path = decorator.args[0].value
                refused_when_hosted = any(k.arg == "dependencies" and getattr(k.value, "id", "") == "self_hosted_route" for k in decorator.keywords)
                names = {n.id for n in ast.walk(node) if isinstance(n, ast.Name)}
                guards = {d.args[0].id for d in node.args.defaults if isinstance(d, ast.Call) and getattr(d.func, "id", "") == "Depends"}
                with self.subTest(route=path, handler=node.name):
                    if "owner_store" in names or "importer" in guards or node.name in {"login", "create_device"}:
                        self.assertTrue(refused_when_hosted, "single-owner state reachable in hosted mode")
                    elif path not in public:
                        self.assertIn("owner", guards, "route does not resolve its library from the authenticated caller")
                        if node.name == "delete_account":
                            calls = [ast.unparse(n) for n in ast.walk(node) if isinstance(n, ast.Call) and "libraries" in ast.unparse(n.func)]
                            self.assertEqual(calls, ["libraries.delete(auth.user_id)"], "deletion must target the caller only")
                        else:
                            self.assertFalse(names & {"libraries", "identity", "enrichment", "worker"}, "route chooses a library, identity or service itself")
        self.assertGreaterEqual(routes, 45)


class HostedSurfaceTests(HostedCase):
    def test_single_owner_sign_in_and_the_extension_flow_do_not_exist(self):
        _, auth = self.account()
        gone = [("POST", "/api/auth/login"), ("POST", "/api/auth/logout"), ("POST", "/api/auth/devices"), ("GET", "/api/auth/devices"), ("DELETE", "/api/auth/devices/x"),
                ("GET", "/api/extension/tokens"), ("POST", "/api/extension/tokens"), ("DELETE", "/api/extension/tokens/x"), ("GET", "/api/extension/status"),
                ("POST", "/api/extension/imports"), ("POST", "/api/extension/imports/x/batches"), ("POST", "/api/extension/imports/x/finish")]
        for method, path in gone:
            for headers in ({}, auth, bearer("la_" + "A" * 43), bearer("lad_" + "A" * 43)):
                with self.subTest(route=method + " " + path, credential=sorted(headers)):
                    response = self.client.request(method, path, json={"password": "any-password-at-all", "name": "x"}, headers=headers)
                    self.assertEqual(response.status_code, 404)
                    self.assertNotIn("set-cookie", response.headers)
        self.assertEqual(list((self.data / "users").iterdir()), [], "a refused route opens no library")
        user, mine = self.account()
        self.ok(mine, "GET", "/api/items")
        with sqlite3.connect(self.data / "users" / user / "library.sqlite3") as c:
            self.assertEqual(c.execute("SELECT count(*) FROM sqlite_master WHERE name='device_tokens'").fetchone()[0], 0)
            self.assertIsNone(c.execute("SELECT value FROM meta WHERE key='password_hash'").fetchone())

    def test_no_cross_origin_allowance_and_no_bundled_web_interface(self):
        extension = {"Origin": "chrome-extension://" + "a" * 32}
        preflight = self.client.options("/api/extension/imports", headers={**extension, "Access-Control-Request-Method": "POST"})
        self.assertFalse([name for name in preflight.headers if name.lower().startswith("access-control-")])
        self.assertFalse([name for name in self.client.get("/api/extension/status", headers=extension).headers if name.lower().startswith("access-control-")])
        for path in ("/", "/index.html", "/app.js"):
            self.assertEqual(self.client.get(path).status_code, 404)
        self.assertEqual(self.client.get("/api/health").headers["x-content-type-options"], "nosniff")

    def test_public_service_request_limits_apply(self):
        _, auth = self.account()
        too_long = {"url": "https://example.com/big", "notes": "n" * 20000, "caption": "ج" * 20000, "summary": "s" * 4000, "tags": ["t" * 80] * 50}
        self.assertGreater(len(json.dumps(too_long).encode()), 64 * 1024)
        self.assertEqual(self.status(auth, "POST", "/api/items", too_long), 200, "a legitimate maximal item fits the default JSON limit")
        self.assertEqual(self.client.post("/api/items", content=b'{"url":"https://example.com/x","notes":"' + b"n" * (513 * 1024) + b'"}', headers={**auth, "Content-Type": "application/json"}).status_code, 413)
        self.assertEqual(self.client.post("/api/imports/file?filename=big.csv", content=b"url\n" + b"x" * (8 * 1024 * 1024), headers=auth).status_code, 413)
        rows = b"".join(b"https://example.com/in-a-file/%d,%s\n" % (number, b"n" * 100000) for number in range(6))
        imported = self.client.post("/api/imports/file?filename=fine.csv", content=b"url,notes\n" + rows, headers=auth)
        self.assertEqual((imported.status_code, imported.json()["created"]), (200, 6), "an import may be larger than the JSON limit")
        item = self.ok(auth, "POST", "/api/items", {"url": "https://example.com/pictured"}).json()
        self.assertEqual(self.client.post(f"/api/items/{item['id']}/thumbnail", content=b"\x89PNG" + b"0" * (4 * 1024 * 1024), headers=auth).status_code, 413)

    def test_request_limits_are_configurable(self):
        app, _ = hosted_app(self.root / "small", self.key, hosted_max_json_kb=64, hosted_max_upload_mb=1, hosted_max_thumbnail_mb=1)
        _, auth = self.account()
        with TestClient(app) as client:
            self.assertEqual(client.post("/api/items", json={"url": "https://example.com/x", "notes": "n" * 20000, "caption": "ج" * 20000}, headers=auth).status_code, 200)
            self.assertEqual(client.post("/api/items", content=b'{"url":"https://example.com/y","notes":"' + b"n" * 70000 + b'"}', headers={**auth, "Content-Type": "application/json"}).status_code, 413)
            self.assertEqual(client.post("/api/imports/file?filename=big.csv", content=b"url\n" + b"x" * (1024 * 1024), headers=auth).status_code, 413)
            self.assertEqual(client.post("/api/items/x/thumbnail", content=b"0" * (1024 * 1024 + 1), headers=auth).status_code, 413)

    def test_self_hosted_libraries_have_no_account_deletion_route(self):
        with tempfile.TemporaryDirectory() as folder:
            app = create_app(Config(data_dir=Path(folder) / "data", admin_password="a-private-owner-password", public_url="http://testserver", testing=True))
            with TestClient(app) as client:
                token = client.post("/api/auth/devices", json={"password": "a-private-owner-password", "name": "Phone"}).json()["token"]
                client.post("/api/items", json={"url": "https://example.com/kept"}, headers=bearer(token))
                self.assertEqual(client.post("/api/account/delete", json={"confirm": "DELETE"}, headers=bearer(token)).status_code, 404)
                self.assertEqual(client.get("/api/items", headers=bearer(token)).json()["total"], 1)


class StorageQuotaTests(HostedCase):
    settings = {"hosted_storage_quota_mb": 1}
    QUOTA = 1024 * 1024

    def fill(self, auth):
        ids = []
        for number in range(200):
            response = self.client.post("/api/items", json={"url": f"https://example.com/fill/{number}", "notes": f"{number} " + "word " * 3900}, headers=auth)
            if response.status_code != 200:
                return ids, response
            ids.append(response.json()["id"])
        self.fail("the quota was never reached")

    def test_writes_stop_at_the_quota_while_reads_exports_and_deletes_continue(self):
        user, auth = self.account()
        _, other = self.account()
        ids, refused = self.fill(auth)
        self.assertEqual(refused.status_code, 507)
        self.assertIn("storage limit", refused.json()["detail"])
        self.assertGreater(len(ids), 5)
        usage = self.ok(auth, "GET", "/api/account").json()["storage"]
        self.assertEqual(usage["quota_bytes"], self.QUOTA)
        self.assertLessEqual(usage["used_bytes"], self.QUOTA + 64 * 1024, "the overshoot is bounded by one request's stored size")
        self.assertGreater(usage["used_bytes"], self.QUOTA - 64 * 1024)
        big = "x" * 19990
        for label, (method, path, body) in {
            "new item": ("POST", "/api/items", {"url": "https://example.com/more", "notes": big}),
            "edit": ("PATCH", "/api/items/" + ids[0], {"notes": big}),
            "bulk": ("POST", "/api/items/bulk", {"filters": {}, "action": "tag", "value": big[:80]}),
            "demo": ("POST", "/api/demo", {"padding": big}),
            "import": ("POST", "/api/imports/file?filename=more.csv", None),
        }.items():
            with self.subTest(write=label):
                kwargs = {"content": b"url,notes\nhttps://example.com/imported," + big.encode() + b"\n"} if body is None else {}
                self.assertEqual(self.status(auth, method, path, body, **kwargs), 507)
        self.assertEqual(self.ok(auth, "GET", "/api/items").json()["total"], len(ids))
        self.assertEqual(len(self.ok(auth, "GET", "/api/export").json()["items"]), len(ids))
        self.assertEqual(self.status(auth, "GET", "/api/backup"), 200)
        self.assertNotIn("request.state", (Path(__file__).resolve().parents[1] / "server" / "app.py").read_text(), "request bodies are kept in the request's own scope, never in shared state")
        self.assertEqual(self.status(auth, "POST", "/api/ai/jobs/cancel"), 200)
        self.assertEqual(self.status(other, "POST", "/api/items", {"url": "https://example.com/other", "notes": big}), 200, "another account has its own quota")
        for iid in ids[: len(ids) // 2]:
            self.assertEqual(self.status(auth, "DELETE", "/api/items/" + iid), 200)
        self.assertLess(self.ok(auth, "GET", "/api/account").json()["storage"]["used_bytes"], self.QUOTA - 100 * 1024)
        self.assertEqual(self.status(auth, "POST", "/api/items", {"url": "https://example.com/after", "notes": big}), 200)

    def test_an_account_at_its_quota_can_still_leave(self):
        user, auth = self.account()
        ids, refused = self.fill(auth)
        self.assertEqual(refused.status_code, 507)
        self.assertEqual(self.ok(auth, "POST", "/api/account/delete", {"confirm": "DELETE"}).json(), {"deleted": True})
        self.assertFalse((self.data / "users" / user).exists())

    def expanding_archive(self, members=40):
        """A small ZIP of portable exports that expands to many megabytes of saved text."""
        body = io.BytesIO()
        with zipfile.ZipFile(body, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            for member in range(members):
                items = [{"url": f"https://example.com/expand/{member}/{number}", "title": "Expanding", "notes": "n" * 20000, "caption": "c" * 20000} for number in range(20)]
                archive.writestr(f"little-archive-{member}.json", json.dumps({"format": "little-archive", "version": 1, "items": items}))
        return body.getvalue()

    def test_the_ceiling_holds_against_requests_that_expand_and_requests_that_race(self):
        user, auth = self.account()
        ceiling = self.QUOTA + 256 * 1024
        archive = self.expanding_archive()
        self.assertLess(len(archive), 200 * 1024, "the upload is far smaller than what it would store")
        refused = self.client.post("/api/imports/file?filename=expanding.zip", content=archive, headers=auth)
        self.assertEqual(refused.status_code, 507)
        self.assertTrue(refused.json()["detail"].startswith("This library has reached its storage limit"))
        self.assertEqual(self.ok(auth, "GET", "/api/items").json()["total"], 0, "a refused import is rolled back whole")
        self.assertEqual(self.ok(auth, "GET", "/api/imports").json()["imports"], [])
        results = []

        def burst(number):
            with TestClient(self.app) as client:
                for attempt in range(12):
                    results.append(client.post("/api/items", json={"url": f"https://example.com/race/{number}/{attempt}", "notes": "word " * 3900, "caption": "text " * 3900}, headers=auth).status_code)
                results.append(client.post("/api/imports/file?filename=expanding.zip", content=archive, headers=auth).status_code)

        threads = [Thread(target=burst, args=(number,)) for number in range(8)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(60)
        self.assertEqual(set(results) - {200, 507}, set())
        self.assertIn(507, results)
        folder = self.data / "users" / user
        on_disk = sum(path.stat().st_size for path in folder.rglob("*") if path.is_file() and path.suffix != ".sqlite3-wal" and not path.name.endswith(("-wal", "-shm")))
        self.assertLessEqual(on_disk, ceiling)
        self.assertLessEqual(self.ok(auth, "GET", "/api/account").json()["storage"]["used_bytes"], ceiling)
        listed = self.ok(auth, "GET", "/api/items").json()["total"]
        self.assertEqual(self.status(auth, "DELETE", "/api/items/" + self.ok(auth, "GET", "/api/items").json()["items"][0]["id"]), 200, "an account at its ceiling can still delete")
        self.assertEqual(self.ok(auth, "GET", "/api/items").json()["total"], listed - 1)

    def test_freed_space_is_returned_to_the_disk(self):
        user, auth = self.account()
        ids, _ = self.fill(auth)
        database = self.data / "users" / user / "library.sqlite3"
        self.ok(auth, "GET", "/api/items")
        full = database.stat().st_size
        for iid in ids:
            self.ok(auth, "DELETE", "/api/items/" + iid)
        self.assertLess(database.stat().st_size, full // 2, "an account's file shrinks when its content is deleted")

    def test_a_thumbnail_that_would_pass_the_quota_is_refused_and_leaves_no_file(self):
        app, _ = hosted_app(self.root / "pictures", self.key, hosted_storage_quota_mb=2)
        user, auth = self.account()
        noise = Image.frombytes("RGB", (900, 900), random.Random(7).randbytes(900 * 900 * 3))
        upload = io.BytesIO()
        noise.save(upload, "JPEG", quality=30)
        self.assertLess(len(upload.getvalue()), 400 * 1024, "the upload itself is small; only its stored form is too large")
        with TestClient(app) as client:
            item = client.post("/api/items", json={"url": "https://example.com/pictured"}, headers=auth).json()
            self.assertEqual(client.post(f"/api/items/{item['id']}/thumbnail", content=upload.getvalue(), headers=auth).status_code, 507)
            assets = self.root / "pictures" / "data" / "users" / user / "assets"
            self.assertEqual(list(assets.iterdir()), [])
            self.assertIsNone(client.get("/api/items/" + item["id"], headers=auth).json()["thumbnail_url"])
            self.assertEqual(client.post(f"/api/items/{item['id']}/thumbnail", content=image(), headers=auth).status_code, 200)
            self.assertEqual(len(list(assets.iterdir())), 1)

    def test_unreferenced_thumbnails_are_removed_so_they_cannot_exhaust_a_quota(self):
        user, auth = self.account()
        assets = self.data / "users" / user / "assets"
        first = self.ok(auth, "POST", "/api/items", {"url": "https://example.com/one"}).json()["id"]
        second = self.ok(auth, "POST", "/api/items", {"url": "https://example.com/two"}).json()["id"]
        empty = self.ok(auth, "GET", "/api/account").json()["storage"]["used_bytes"]
        for color in ("#111111", "#222222", "#333333"):
            self.ok(auth, "POST", f"/api/items/{first}/thumbnail", content=image(color, (64, 64)))
            self.assertEqual(len(list(assets.iterdir())), 1, "replacing a thumbnail removes the previous file")
        shared = image("#444444", (64, 64))
        for iid in (first, second):
            self.ok(auth, "POST", f"/api/items/{iid}/thumbnail", content=shared)
        self.assertEqual(len(list(assets.iterdir())), 1)
        pictured = self.ok(auth, "GET", "/api/account").json()["storage"]["used_bytes"]
        self.assertEqual(pictured - empty, next(assets.iterdir()).stat().st_size, "a stored thumbnail counts toward the quota")
        self.ok(auth, "DELETE", f"/api/items/{first}/thumbnail")
        self.assertEqual(len(list(assets.iterdir())), 1, "still referenced by the other item")
        self.ok(auth, "DELETE", "/api/items/" + second)
        self.assertEqual(list(assets.iterdir()), [])
        self.assertLess(self.ok(auth, "GET", "/api/account").json()["storage"]["used_bytes"], pictured)

    def test_no_stored_image_can_pass_the_quota_and_unreferenced_ones_are_tidied(self):
        user, auth = self.account()
        item = self.ok(auth, "POST", "/api/items", {"url": "https://example.com/pictured"}).json()["id"]
        library = self.libraries.open(user)
        noise = io.BytesIO()
        Image.frombytes("RGB", (700, 700), random.Random(11).randbytes(700 * 700 * 3)).save(noise, "PNG")
        with self.assertRaises(LibraryFull):
            write_asset(library, noise.getvalue())  # the path a stored cover copy takes as well
        self.assertEqual(list(library.assets.iterdir()), [])
        kept = self.ok(auth, "POST", f"/api/items/{item}/thumbnail", content=image("#345678")).json()["thumbnail_url"].rsplit("/", 1)[1]
        stray = write_asset(library, image("#876543"))
        self.assertEqual(len(list(library.assets.iterdir())), 2)
        self.ok(auth, "POST", f"/api/items/{item}/page", {"extraction": {"title": "Read from the page", "caption": "A caption."}})
        self.assertEqual([path.name for path in library.assets.iterdir()], [kept + ".png"], "attaching page details tidies covers no item uses")
        self.assertNotEqual(stray, kept)
        (library.assets / "notes.txt").write_text("not an image this server wrote")
        release_orphans(library)
        self.assertEqual(sorted(path.name for path in library.assets.iterdir()), sorted([kept + ".png", "notes.txt"]))

    def test_self_hosted_thumbnail_files_are_left_exactly_as_before(self):
        with tempfile.TemporaryDirectory() as folder:
            app = create_app(Config(data_dir=Path(folder) / "data", admin_password="a-private-owner-password", public_url="http://testserver", testing=True))
            with TestClient(app) as client:
                auth = bearer(client.post("/api/auth/devices", json={"password": "a-private-owner-password", "name": "Phone"}).json()["token"])
                item = client.post("/api/items", json={"url": "https://example.com/kept"}, headers=auth).json()
                client.post(f"/api/items/{item['id']}/thumbnail", content=image(), headers=auth)
                client.delete(f"/api/items/{item['id']}/thumbnail", headers=auth)
                client.delete("/api/items/" + item["id"], headers=auth)
                self.assertEqual(len(list((Path(folder) / "data" / "assets").glob("*.png"))), 1)


class AccountDeletionTests(HostedCase):
    settings = {**MODEL, "hosted_deep_reads_monthly": 50}

    def seeded(self, name):
        user, auth = self.account()
        item = self.ok(auth, "POST", "/api/items", {"url": f"https://example.com/{name}", "title": name + "-private-marker", "caption": "Text to classify."}).json()
        self.ok(auth, "POST", f"/api/items/{item['id']}/thumbnail", content=image("#aa3311" if name == "alice" else "#1133aa"))
        self.entitlements.set_unlocked(user, True, source="synthetic-test")
        self.assertTrue(self.entitlements.consume_deep_reads(user, 1))
        self.ok(auth, "POST", "/api/ai/jobs", {"ids": [item["id"]]})
        return user, auth, item["id"]

    def everything_on_disk(self):
        return b"\n".join(str(path).encode() + b"\n" + (path.read_bytes() if path.is_file() else b"") for path in self.data.rglob("*"))

    def test_deletion_removes_every_file_and_record_of_the_account_and_only_that_account(self):
        alice, a, _ = self.seeded("alice")
        bob, b, his_item = self.seeded("bob")
        self.ok(a, "GET", "/api/backup")
        before = self.everything_on_disk()
        for present in (alice.encode(), b"alice-private-marker", bob.encode(), b"bob-private-marker"):
            self.assertIn(present, before)
        self.assertEqual(self.status(a, "POST", "/api/account/delete"), 422)
        self.assertEqual(self.status(a, "POST", "/api/account/delete", {"confirm": "delete"}), 422)
        self.assertEqual(self.status(a, "POST", "/api/account/delete", {"confirm": "DELETE", "user_id": bob}), 422)
        self.assertEqual(self.client.post("/api/account/delete", json={"confirm": "DELETE"}).status_code, 401)
        self.assertTrue((self.data / "users" / alice / "library.sqlite3").is_file(), "refused requests delete nothing")
        self.assertEqual(self.ok(a, "POST", "/api/account/delete", {"confirm": "DELETE"}).json(), {"deleted": True})
        self.assertFalse((self.data / "users" / alice).exists())
        self.assertEqual({path.name for path in (self.data / "users").iterdir()}, {bob})
        after = self.everything_on_disk()
        self.assertNotIn(alice.encode(), after, "the account id survives somewhere on disk")
        self.assertNotIn(b"alice-private-marker", after)
        with sqlite3.connect(self.data / "accounts.sqlite3") as c:
            self.assertEqual(c.execute("SELECT user_id FROM entitlements").fetchall(), [(bob,)])
            self.assertEqual({row[0] for row in c.execute("SELECT user_hash FROM deep_reads")}, {usage_key(alice), usage_key(bob)}, "this month's counts stay, under hashes only")
            self.assertEqual(c.execute("SELECT user_id FROM pending_jobs").fetchall(), [(bob,)])
            self.assertEqual([row[0] for row in c.execute("SELECT user_hash FROM deleted_accounts")], [account_hash(alice)])
        self.assertFalse(self.entitlements.is_unlocked(alice))
        self.assertEqual(self.ok(b, "GET", "/api/items/" + his_item).json()["title"], "bob-private-marker")
        self.assertTrue(self.ok(b, "GET", "/api/account").json()["entitlements"]["unlocked"])
        self.assertEqual(self.ok(b, "GET", "/api/ai/jobs").json()["counts"]["queued"], 1)

    def test_a_token_from_before_the_deletion_cannot_recreate_the_library(self):
        alice, a, _ = self.seeded("alice")
        second_device = bearer(self.key.sign(claims(alice)))
        self.ok(a, "POST", "/api/account/delete", {"confirm": "DELETE"})
        for auth in (a, second_device):
            for method, path in (("GET", "/api/items"), ("POST", "/api/items"), ("GET", "/api/account"), ("GET", "/api/export"), ("POST", "/api/account/delete")):
                response = self.client.request(method, path, json={"url": "https://example.com/again", "confirm": "DELETE"}, headers=auth)
                self.assertEqual(response.status_code, 401)
            self.assertEqual(self.client.get("/api/auth/me", headers=auth).json(), {"authenticated": False, "version": "0.1.0"})
        self.assertFalse((self.data / "users" / alice).exists())

    def test_a_later_sign_in_starts_an_empty_library(self):
        alice, a, _ = self.seeded("alice")
        self.libraries.clock = lambda: time.time() - 3600  # the deletion happened an hour ago
        self.ok(a, "POST", "/api/account/delete", {"confirm": "DELETE"})
        self.libraries.clock = time.time
        fresh = bearer(self.key.sign(claims(alice)))
        self.assertEqual(self.ok(fresh, "GET", "/api/items").json()["total"], 0)
        summary = self.ok(fresh, "GET", "/api/account").json()
        self.assertFalse(summary["entitlements"]["unlocked"], "an unlock does not survive deletion")
        self.assertEqual(summary["entitlements"]["deep_reads"]["used"], 1, "deleting and returning must not refill this month's allowance")
        self.assertEqual(self.ok(fresh, "GET", "/api/ai/jobs").json()["total"], 0)
        self.assertEqual(list((self.data / "users" / alice / "assets").iterdir()), [])

    def test_a_request_or_job_holding_the_library_fails_cleanly_after_deletion(self):
        alice, a, item = self.seeded("alice")
        held = self.libraries.open(alice)
        self.ok(a, "POST", "/api/account/delete", {"confirm": "DELETE"})
        with self.assertRaises(LibraryClosed):
            with held.transaction():
                self.fail("a deleted library accepted a transaction")
        with self.assertRaises(LibraryClosed):
            held.used_bytes()
        with self.assertRaises(LibraryClosed):
            create_backup(held)
        self.assertFalse((self.data / "users" / alice).exists(), "a stale reference must not recreate files")

    def test_a_request_that_passed_sign_in_before_the_deletion_cannot_open_the_library_after_it(self):
        alice, a, _ = self.seeded("alice")
        issued = int(time.time()) - 5
        self.libraries.delete(alice)
        with self.assertRaises(AccountDeleted):
            self.libraries.open(alice, issued_at=issued)
        self.assertFalse((self.data / "users" / alice).exists())
        with patch.object(self.libraries, "revoked", side_effect=[False, True]):  # the first check, made before the deletion, passed
            late = self.client.post("/api/items", json={"url": "https://example.com/late"}, headers=a)
        self.assertEqual(late.status_code, 401)
        self.assertFalse((self.data / "users" / alice).exists(), "the late request must not recreate the library")

    def test_a_deletion_that_fails_part_way_still_removes_the_library_and_is_finished_at_the_next_start(self):
        alice, a, _ = self.seeded("alice")
        bob, b, his_item = self.seeded("bob")
        forgotten = []

        def failing(user_id):
            raise sqlite3.OperationalError("synthetic bookkeeping failure")

        self.libraries.on_delete.insert(0, failing)
        with TestClient(self.app, raise_server_exceptions=False) as client:
            self.assertEqual(client.post("/api/account/delete", json={"confirm": "DELETE"}, headers=a).status_code, 500)
        self.assertFalse((self.data / "users" / alice).exists(), "the library must be unreachable even when a later step failed")
        markers = list((self.data / "users").glob(".deleting-*"))
        self.assertEqual(len(markers), 1)
        self.assertEqual(list(markers[0].iterdir()), [], "content is removed regardless; only an empty marker remains")
        self.assertNotIn(b"alice-private-marker", self.everything_on_disk())
        self.assertEqual(self.status(a, "GET", "/api/items"), 401)
        self.libraries.clock = lambda: time.time() + 60
        self.assertFalse(self.libraries.revoked(alice, int(time.time()) + 30))
        self.libraries.clock = time.time
        restarted, _ = hosted_app(self.root, self.key, **self.settings)
        restarted.state.libraries.on_delete.append(forgotten.append)
        restarted.state.libraries.resume_deletions()
        self.assertEqual(list((self.data / "users").glob(".deleting-*")), [], "the restart finished the deletion")
        self.assertFalse(restarted.state.entitlements.is_unlocked(alice))
        with TestClient(restarted) as client:
            self.assertEqual(client.get("/api/items", headers=a).status_code, 401)
            self.assertEqual(client.get("/api/items/" + his_item, headers=b).status_code, 200)

    def test_a_request_that_meets_a_library_being_deleted_gets_410(self):
        alice, a, item = self.seeded("alice")
        self.libraries._deleting.add(alice)  # the moment between the deletion starting and its record being written
        try:
            for method, path in (("GET", "/api/items"), ("GET", "/api/items/" + item), ("POST", "/api/items"), ("GET", "/api/backup")):
                response = self.client.request(method, path, json={"url": "https://example.com/late"}, headers=a)
                self.assertEqual((response.status_code, response.json()), (410, {"detail": "This library was deleted."}))
        finally:
            self.libraries._deleting.discard(alice)
        self.assertEqual(self.ok(a, "GET", "/api/items").json()["total"], 1)

    def test_the_worker_survives_an_account_deleted_in_the_middle_of_its_job(self):
        alice, a, _ = self.seeded("alice")
        bob, b, his_item = self.seeded("bob")
        worker, entered, release, seen = self.app.state.worker, Event(), Event(), []
        worker.backoff = 0

        def before(batch):
            if batch[0].evidence.source["title"].startswith("alice"):
                entered.set()
                if not release.wait(5):
                    raise AssertionError("The controlled model call was not released.")
            else:
                worker.stopping.set()

        with fake_model(seen, before):
            thread = Thread(target=worker.run, daemon=True)
            thread.start()
            try:
                self.assertTrue(entered.wait(5), "the worker did not claim the first account's job")
                self.ok(a, "POST", "/api/account/delete", {"confirm": "DELETE"})
            finally:
                release.set()
                thread.join(10)
            self.assertFalse(thread.is_alive())
        worker.stopping.clear()
        self.assertEqual(seen, ["alice-private-marker", "bob-private-marker"])
        self.assertEqual(self.ok(b, "GET", "/api/items/" + his_item).json()["ai"]["suggested_title"], "About bob-private-marker")
        self.assertFalse((self.data / "users" / alice).exists())

    def test_a_deletion_interrupted_by_a_crash_is_finished_at_the_next_start(self):
        alice, a, _ = self.seeded("alice")
        bob, b, his_item = self.seeded("bob")
        # As if the process died right after the library was detached: no record, no bookkeeping done.
        leftover = self.data / "users" / f".deleting-{alice}-{'a' * 16}"
        os.rename(self.data / "users" / alice, leftover)
        outside = self.root / "outside"
        outside.mkdir()
        (outside / "keep.txt").write_text("not ours")
        (self.data / "users" / f".deleting-{bob}-link").symlink_to(outside, target_is_directory=True)
        (self.data / "users" / ".deleting-unrelated").mkdir()
        restarted, _ = hosted_app(self.root, self.key, **self.settings)
        self.assertFalse(leftover.exists())
        self.assertNotIn(b"alice-private-marker", self.everything_on_disk())
        self.assertTrue((outside / "keep.txt").is_file(), "a symbolic link is never followed")
        self.assertTrue((self.data / "users" / ".deleting-unrelated").is_dir(), "only directories named after an account are touched")
        self.assertFalse(restarted.state.entitlements.is_unlocked(alice))
        with sqlite3.connect(self.data / "accounts.sqlite3") as c:
            self.assertEqual(c.execute("SELECT user_id FROM pending_jobs").fetchall(), [(bob,)])
        with TestClient(restarted) as client:
            self.assertEqual(client.get("/api/items", headers=a).status_code, 401, "the deletion is recorded when it is finished")
            self.assertEqual(client.get("/api/items/" + his_item, headers=b).status_code, 200)


class LibraryManagerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="little-archive-manager-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.manager = LibraryManager(hosted_config(self.root, hosted_open_libraries=2))
        self.users = self.root / "data" / "users"

    def test_only_canonical_account_ids_become_paths(self):
        account = str(uuid4())
        for value in ("../" + account, "..", ".", "", "/tmp/" + account, account + "/..", account.upper(), "{" + account + "}", account + "\x00",
                      account[:-1], account + "0", "a" * 36, "00000000-0000-0000-0000-000000000000", ".deleting-" + "a" * 32, None, 7, account.encode(), Path(account)):
            for operation in (self.manager.open, self.manager.delete):
                with self.subTest(value=repr(value), operation=operation.__name__), self.assertRaises(ValueError):
                    operation(value)
        self.assertEqual(list(self.users.iterdir()), [])
        self.assertEqual({path.name for path in self.root.iterdir()}, {"data"})
        self.assertEqual(self.manager.open(account).root, self.users / account)

    def test_a_symbolic_link_in_place_of_an_account_directory_is_refused(self):
        account, outside = str(uuid4()), self.root / "outside"
        outside.mkdir()
        (self.users / account).symlink_to(outside, target_is_directory=True)
        for operation in (self.manager.open, self.manager.delete):
            with self.assertRaises(ValueError):
                operation(account)
        self.assertEqual(list(outside.iterdir()), [])

    def test_the_open_library_cache_is_bounded_and_never_opens_one_library_twice(self):
        accounts = [str(uuid4()) for _ in range(6)]
        held = self.manager.open(accounts[0])
        with held.transaction() as c:
            held.apply_item(c, {"url": "https://example.com/kept", "title": "Kept"})
        for account in accounts[1:]:
            self.manager.open(account)
            self.assertLessEqual(len(self.manager._recent), 2)
        self.assertNotIn(accounts[0], self.manager._recent)
        self.assertIs(self.manager.open(accounts[0]), held, "a library still in use must be reused, not reopened")
        del held
        for account in accounts[1:]:
            self.manager.open(account)
        reopened = self.manager.open(accounts[0])
        self.assertEqual(reopened.list_items()["total"], 1)
        self.assertEqual(len(self.manager._live), 2, "evicted, unreferenced libraries are released")

    def test_deleting_one_account_leaves_the_others_and_blocks_stale_tokens(self):
        first, second = str(uuid4()), str(uuid4())
        for account in (first, second):
            self.manager.open(account)
        moment = int(time.time())
        self.assertFalse(self.manager.revoked(first, moment))
        self.manager.delete(first)
        self.assertEqual({path.name for path in self.users.iterdir()}, {second})
        self.assertTrue(self.manager.revoked(first, moment - 100))
        self.assertTrue(self.manager.revoked(first, moment + 5), "within the clock margin")
        self.assertFalse(self.manager.revoked(first, moment + 120))
        self.assertFalse(self.manager.revoked(second, moment - 100))
        restarted = LibraryManager(hosted_config(self.root))
        self.assertTrue(restarted.revoked(first, moment - 100), "the record survives a restart")
        self.manager.delete(first)  # Deleting an account with no library is harmless.

    def test_background_work_never_creates_a_library(self):
        gone, kept = str(uuid4()), str(uuid4())
        store = self.manager.open(kept)
        self.manager.mark_pending(store)
        with self.manager._accounts() as c:  # as if a queue entry outlived its files
            c.execute("INSERT INTO pending_jobs VALUES(?)", (gone,))
        restarted = LibraryManager(hosted_config(self.root))
        self.assertEqual(set(restarted._pending), {kept, gone})
        with self.assertRaises(LibraryClosed):
            restarted.open(gone, create=False)
        self.assertIsNone(restarted.next_pending(lambda connection: False))
        self.assertEqual({path.name for path in self.users.iterdir()}, {kept})
        self.assertEqual(len(restarted._pending), 0)

    def test_old_deletion_records_are_pruned(self):
        account = str(uuid4())
        self.manager.open(account)
        self.manager.clock = lambda: time.time() - 31 * 86400
        self.manager.delete(account)
        self.assertTrue(self.manager.revoked(account, 0))
        self.assertFalse(LibraryManager(hosted_config(self.root)).revoked(account, 0))


class EntitlementTests(unittest.TestCase):
    def implementations(self, **limits):
        folder = tempfile.TemporaryDirectory(prefix="little-archive-entitlements-")
        self.addCleanup(folder.cleanup)
        self.month = ["2026-11"]

        class Clock:
            def __init__(self, month):
                self.month = month

            def __call__(self):
                return self

            def strftime(self, pattern):
                return self.month[0]

        clock = Clock(self.month)
        yield MemoryEntitlements(clock=clock, **limits)
        yield SQLiteEntitlements(Path(folder.name) / "accounts.sqlite3", clock=clock, **limits)

    def test_unlock_seam_and_monthly_allowance(self):
        for entitlements in self.implementations(unlocked_limit=5, free_limit=2):
            with self.subTest(implementation=type(entitlements).__name__):
                self.month[0] = "2026-11"
                user, other = str(uuid4()), str(uuid4())
                self.assertFalse(entitlements.is_unlocked(user))
                self.assertEqual(entitlements.deep_reads(user), {"period": "2026-11", "used": 0, "limit": 2, "remaining": 2})
                self.assertTrue(entitlements.consume_deep_reads(user, 2))
                self.assertFalse(entitlements.consume_deep_reads(user), "the free allowance is spent")
                entitlements.set_unlocked(user, True, source="synthetic-purchase")
                self.assertTrue(entitlements.is_unlocked(user))
                self.assertFalse(entitlements.is_unlocked(other))
                self.assertFalse(entitlements.consume_deep_reads(user, 4), "a request past the cap is refused whole")
                self.assertEqual(entitlements.deep_reads(user)["used"], 2)
                self.assertTrue(entitlements.consume_deep_reads(user, 3))
                self.assertEqual(entitlements.deep_reads(user), {"period": "2026-11", "used": 5, "limit": 5, "remaining": 0})
                self.assertEqual(entitlements.deep_reads(other)["used"], 0)
                for bad in (0, -1, 1.5, True, "2"):
                    with self.assertRaises(ValueError):
                        entitlements.consume_deep_reads(user, bad)
                self.month[0] = "2026-12"
                self.assertEqual(entitlements.deep_reads(user), {"period": "2026-12", "used": 0, "limit": 5, "remaining": 5})
                self.assertTrue(entitlements.consume_deep_reads(user))
                self.month[0] = "2026-11"
                self.assertEqual(entitlements.deep_reads(user)["used"], 0, "an earlier month is not kept")
                entitlements.set_unlocked(user, False, source="synthetic-refund")
                self.assertFalse(entitlements.is_unlocked(user))
                entitlements.set_unlocked(user, True)
                entitlements.forget(user)
                self.assertFalse(entitlements.is_unlocked(user))
                self.assertEqual(entitlements.deep_reads(user)["used"], 0)

    def test_sqlite_entitlements_persist(self):
        with tempfile.TemporaryDirectory() as folder:
            path, user = Path(folder) / "accounts.sqlite3", str(uuid4())
            first = SQLiteEntitlements(path, 10, 0)
            first.set_unlocked(user, True, source="synthetic-purchase")
            first.consume_deep_reads(user, 4)
            second = SQLiteEntitlements(path, 10, 0)
            self.assertTrue(second.is_unlocked(user))
            self.assertEqual(second.deep_reads(user)["used"], 4)
            with sqlite3.connect(path) as c:
                self.assertEqual(c.execute("SELECT source FROM entitlements").fetchone()[0], "synthetic-purchase")

    def test_a_self_hosted_owner_is_unlocked_and_unmetered(self):
        owner = OwnerEntitlements()
        self.assertTrue(owner.is_unlocked(None))
        self.assertTrue(owner.consume_deep_reads(None, 10000))
        self.assertIsNone(owner.deep_reads(None)["limit"])
        with self.assertRaises(ValueError):
            owner.set_unlocked(None, False)


class HostedQueueTests(HostedCase):
    settings = {**MODEL, "hosted_deep_reads_monthly": 3, "hosted_free_deep_reads_monthly": 0}

    def items(self, auth, name, count):
        return [self.ok(auth, "POST", "/api/items", {"url": f"https://example.com/{name}/{number}", "title": f"{name} {number}", "caption": "Text to classify."}).json()["id"] for number in range(count)]

    def run_worker(self, jobs, app=None):
        """Run the real account worker in a thread until the model was asked about `jobs` items."""
        worker, seen = (app or self.app).state.worker, []
        worker.backoff = 0

        def before(batch):
            if len(seen) + len(batch) >= jobs:
                worker.stopping.set()

        with fake_model(seen, before):
            thread = Thread(target=worker.run, daemon=True)
            thread.start()
            thread.join(10)
        self.assertFalse(thread.is_alive(), "the worker did not finish the expected jobs")
        worker.stopping.clear()
        return seen

    def unlock(self, *users):
        for user in users:
            self.entitlements.set_unlocked(user, True, source="synthetic-purchase")

    def test_closer_reads_are_gated_and_metered_per_account(self):
        (alice, a), (bob, b) = self.account(), self.account()
        hers, his = self.items(a, "alice", 5), self.items(b, "bob", 1)
        offered = self.client.post(f"/api/items/{hers[0]}/deep-read", headers=a)
        self.assertEqual(offered.status_code, 409, "nothing is charged while a closer read is not on offer")
        for user in (alice, bob):
            offer_closer_reads(self.libraries.open(user))
        locked = self.client.post(f"/api/items/{hers[0]}/deep-read", headers=a)
        self.assertEqual((locked.status_code, locked.json()["detail"]), (402, "Deep reads come with the full unlock."))
        self.assertEqual(self.ok(a, "GET", "/api/ai/jobs").json()["total"], 0, "a refused request queues nothing")
        self.unlock(alice)
        for iid in hers[:3]:
            self.assertEqual(self.ok(a, "POST", f"/api/items/{iid}/deep-read").json(), {"queued": 1})
        self.assertEqual(self.status(a, "POST", f"/api/items/{hers[0]}/deep-read"), 409, "one already in progress is not charged twice")
        over = self.client.post(f"/api/items/{hers[3]}/deep-read", headers=a)
        self.assertEqual(over.status_code, 429)
        self.assertIn("3 of 3", over.json()["detail"])
        self.assertEqual(self.ok(a, "GET", "/api/ai/jobs").json()["counts"]["queued"], 3, "a refused request queues nothing")
        self.assertEqual(self.ok(a, "GET", "/api/items/" + hers[3]).json()["enrichment"]["deep_read"]["state"], "")
        self.assertEqual(self.ok(a, "GET", "/api/account").json()["entitlements"]["deep_reads"], {"period": time.strftime("%Y-%m", time.gmtime()), "used": 3, "limit": 3, "remaining": 0})
        self.assertIn(alice, self.libraries._pending, "a queued closer read is offered to the worker")
        self.assertEqual(self.ok(a, "POST", "/api/ai/jobs", {"ids": hers[3:]}).json()["queued"], 2, "ordinary suggestions are not deep reads")
        self.assertEqual(self.ok(a, "GET", "/api/account").json()["entitlements"]["deep_reads"]["used"], 3)
        self.assertEqual(self.status(b, "POST", f"/api/items/{his[0]}/deep-read"), 402, "one account's unlock is not another's")
        self.unlock(bob)
        self.assertEqual(self.ok(b, "POST", f"/api/items/{his[0]}/deep-read").json(), {"queued": 1})
        self.assertEqual(self.ok(b, "GET", "/api/account").json()["entitlements"]["deep_reads"]["used"], 1)
        with self.assertRaises(HTTPException) as refused:
            self.libraries.open(alice).enrichment.worker.enqueue_deep(hers[4])
        self.assertEqual(refused.exception.status_code, 429, "the meter sits on the queueing itself, whatever route reaches it")

    def test_no_request_can_grant_an_unlock(self):
        user, auth = self.account()
        attempts = [("POST", "/api/account", {"unlocked": True}), ("PATCH", "/api/account", {"unlocked": True}), ("PUT", "/api/account", {"unlocked": True}),
                    ("PATCH", "/api/settings", {"remote_previews": True, "unlocked": True}), ("POST", "/api/account/unlock", {}), ("POST", "/api/entitlements", {"unlocked": True}),
                    ("POST", "/api/account/delete", {"confirm": "DELETE", "unlocked": True})]
        for method, path, body in attempts:
            with self.subTest(attempt=method + " " + path):
                self.assertIn(self.status(auth, method, path, body), {404, 405, 422})
        self.assertFalse(self.ok(auth, "GET", "/api/account").json()["entitlements"]["unlocked"])
        self.assertEqual([path for method, path in api_routes(self.app) if "unlock" in path or "entitle" in path or "purchase" in path], [])

    def test_the_worker_serves_accounts_in_turn_and_writes_each_result_to_its_own_library(self):
        (alice, a), (bob, b) = self.account(), self.account()
        hers, his = self.items(a, "alice", 3), self.items(b, "bob", 1)
        self.ok(a, "POST", "/api/ai/jobs", {"ids": hers})
        self.ok(b, "POST", "/api/ai/jobs", {"ids": his})
        seen = self.run_worker(4)
        self.assertEqual([title.split()[0] for title in seen], ["alice", "bob", "alice", "alice"], "a busy account must not starve another")
        for auth, ids, name in ((a, hers, "alice"), (b, his, "bob")):
            for number, iid in enumerate(ids):
                self.assertEqual(self.ok(auth, "GET", "/api/items/" + iid).json()["ai"]["suggested_title"], f"About {name} {number}")
            self.assertEqual(self.ok(auth, "GET", "/api/ai/jobs").json()["counts"]["completed"], len(ids))
        self.assertFalse(self.app.state.worker.step(), "nothing is left queued")
        self.assertEqual(len(self.libraries._pending), 0)
        with sqlite3.connect(self.data / "accounts.sqlite3") as c:
            self.assertEqual(c.execute("SELECT count(*) FROM pending_jobs").fetchone()[0], 0)

    def broken_library_scenario(self, transactions_that_work_first):
        """Alice's library starts failing; Bob's queued job must still be done."""
        (alice, a), (bob, b) = self.account(), self.account()
        self.ok(a, "POST", "/api/ai/jobs", {"ids": self.items(a, "alice", 1)})
        his = self.items(b, "bob", 1)
        self.ok(b, "POST", "/api/ai/jobs", {"ids": his})
        broken, calls = self.libraries.open(alice), []
        real = broken.transaction

        def transaction():
            calls.append(1)
            if len(calls) > transactions_that_work_first:
                raise sqlite3.OperationalError("database or disk is full")
            return real()

        with patch.object(broken, "transaction", side_effect=transaction):
            self.assertEqual(self.run_worker(1), ["bob 0"])
        self.assertGreater(len(calls), transactions_that_work_first, "the failure was never reached")
        self.assertEqual(self.ok(b, "GET", "/api/items/" + his[0]).json()["ai"]["suggested_title"], "About bob 0")
        self.assertNotIn(alice, self.libraries._pending, "a failing library is set aside rather than retried in a loop")
        self.assertEqual(self.ok(a, "GET", "/api/ai/jobs").json()["total"], 1, "her job is kept, not lost")
        self.ok(a, "POST", "/api/ai/jobs/cancel")
        job = self.ok(a, "GET", "/api/ai/jobs").json()["jobs"][0]["id"]
        self.ok(a, "POST", f"/api/ai/jobs/{job}/retry")
        self.assertEqual(self.run_worker(1), ["alice 0"], "queueing again brings the library back into rotation")

    def test_a_library_that_fails_while_being_checked_does_not_stop_the_worker_for_everyone(self):
        self.broken_library_scenario(transactions_that_work_first=0)

    def test_a_library_that_fails_while_a_job_is_claimed_does_not_stop_the_worker_for_everyone(self):
        self.broken_library_scenario(transactions_that_work_first=1)

    def test_a_library_busy_with_its_own_request_does_not_hold_up_another_accounts_work(self):
        (alice, a), (bob, b) = self.account(), self.account()
        self.ok(a, "POST", "/api/ai/jobs", {"ids": self.items(a, "alice", 1)})
        self.ok(b, "POST", "/api/ai/jobs", {"ids": self.items(b, "bob", 1)})
        busy, holding, release = self.libraries.open(alice), Event(), Event()

        def long_import():
            with busy.lock:
                holding.set()
                release.wait(10)

        holder = Thread(target=long_import, daemon=True)
        holder.start()
        self.assertTrue(holding.wait(5))
        try:
            started = time.monotonic()
            self.assertEqual(self.run_worker(1), ["bob 0"])
            self.assertLess(time.monotonic() - started, 5)
            self.assertIn(alice, self.libraries._pending, "the busy library keeps its place in the queue")
        finally:
            release.set()
            holder.join(5)
        self.assertEqual(self.run_worker(1), ["alice 0"])

    def test_queued_work_resumes_after_a_restart_without_scanning_accounts(self):
        alice, a = self.account()
        _, idle = self.account()
        iid = self.items(a, "alice", 1)[0]
        self.items(idle, "idle", 1)
        self.ok(a, "POST", "/api/ai/jobs", {"ids": [iid]})
        restarted, _ = hosted_app(self.root, self.key, **self.settings)
        with patch.object(restarted.state.libraries, "open", wraps=restarted.state.libraries.open) as opened:
            self.assertEqual(self.run_worker(1, restarted), ["alice 0"])
        self.assertEqual({call.args[0] for call in opened.call_args_list}, {alice}, "only accounts with queued work are opened")
        self.assertTrue(all(call.kwargs == {"create": False} for call in opened.call_args_list))
        with TestClient(restarted) as client:
            self.assertEqual(client.get("/api/items/" + iid, headers=a).json()["ai"]["suggested_title"], "About alice 0")


if __name__ == "__main__":
    unittest.main()
