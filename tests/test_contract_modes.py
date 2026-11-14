"""One API contract, exercised against both server modes with a native-style client.

Every scenario below runs twice: against a self-hosted library reached with a
full-access device token, and against a hosted library reached with an access
token signed by a locally generated key and verified through a fake key set.
Neither client holds a cookie. A final parity check replays one script against
both and compares the JSON shapes, so the two modes cannot drift apart silently.

All records are synthetic and live in temporary directories. No network is used.
"""
import hashlib
import io
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch
from uuid import uuid4
import zipfile

from fastapi.testclient import TestClient
from PIL import Image

from server.app import create_app
from server.backups import restore_backup
from server.config import Config
from support_hosted import SigningKey, bearer, claims, hosted_app


PASSWORD = "contract-owner-password-2026"
MODEL = {"ollama_url": "http://127.0.0.1:1", "ollama_model": "synthetic-model"}


def image(color="#91a58f", size=(24, 18), kind="JPEG"):
    body = io.BytesIO()
    Image.new("RGB", size, color).save(body, kind)
    return body.getvalue()


class SelfHostedClient:
    """A self-hosted library, used the way a phone app would: by device token."""
    mode = "self-hosted"

    def __init__(self, root, **settings):
        self.app = create_app(Config(data_dir=root / "data", admin_password=PASSWORD, public_url="http://testserver", testing=True, **settings))
        self.client = TestClient(self.app)
        self.client.__enter__()
        paired = self.client.post("/api/auth/devices", json={"password": PASSWORD, "name": "Synthetic phone"})
        assert paired.status_code == 200, paired.text
        self.auth = bearer(paired.json()["token"])

    def library(self):
        return self.app.state.store

    def close(self):
        self.client.__exit__(None, None, None)


class HostedClient:
    """A hosted account, signed in through the synthetic identity provider."""
    mode = "hosted"

    def __init__(self, root, **settings):
        self.key, self.user = SigningKey(), str(uuid4())
        if settings:  # A model is configured: give the account an allowance to queue with.
            settings["hosted_free_deep_reads_monthly"] = 1000
        self.app, self.keyset = hosted_app(root, self.key, **settings)
        self.client = TestClient(self.app)
        self.client.__enter__()
        self.auth = bearer(self.key.sign(claims(self.user)))

    def library(self):
        return self.app.state.libraries.open(self.user)

    def close(self):
        self.client.__exit__(None, None, None)


class ContractScenarios:
    """Mixed into one TestCase per mode; `backend` chooses the mode."""
    backend = None
    settings = {}

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="little-archive-contract-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.no_worker = patch("server.jobs.ClassificationWorker.start")
        self.no_worker.start()
        self.addCleanup(self.no_worker.stop)
        self.target = self.backend(self.root, **self.settings)
        self.addCleanup(self.target.close)
        self.client, self.app = self.target.client, self.target.app

    def call(self, method, path, data=None, **kwargs):
        headers = {**self.target.auth, **kwargs.pop("headers", {})}
        if data is not None:
            kwargs["json"] = data
        return self.client.request(method, path, headers=headers, **kwargs)

    def ok(self, method, path, data=None, **kwargs):
        response = self.call(method, path, data, **kwargs)
        self.assertEqual(response.status_code, 200, response.text[:300])
        return response

    def item(self, url="https://example.com/guide", **fields):
        return self.ok("POST", "/api/items", {"url": url, "title": "A useful guide", **fields}).json()

    def count(self):
        return self.ok("GET", "/api/items").json()["total"]


class LibraryContract(ContractScenarios):
    def test_discovery_tells_a_client_how_to_sign_in_and_nothing_more(self):
        self.assertEqual(self.client.get("/api/health").json(), {"status": "ok", "version": "0.1.0"})
        found = self.client.get("/api/discovery")
        self.assertEqual(found.status_code, 200)
        body = found.json()
        self.assertEqual(set(body), {"name", "version", "api", "mode", "auth"})
        self.assertEqual((body["name"], body["api"], body["mode"]), ("little-archive", 1, self.target.mode))
        if self.target.mode == "hosted":
            self.assertEqual(body["auth"], {"methods": ["supabase-jwt"], "supabase_url": "https://synthetic-project.supabase.test"})
        else:
            self.assertEqual(body["auth"], {"methods": ["password-session", "device-token"], "device_token_url": "/api/auth/devices"})
        text = found.text.lower()
        for private in ("password_hash", "secret", str(self.root).lower(), "instance_id"):
            self.assertNotIn(private, text)

    def test_every_library_route_refuses_a_request_without_credentials(self):
        item = self.item()
        for method, path in (
            ("GET", "/api/items"), ("POST", "/api/items"), ("POST", "/api/items/bulk"), ("GET", "/api/items/" + item["id"]),
            ("PATCH", "/api/items/" + item["id"]), ("DELETE", "/api/items/" + item["id"]),
            ("POST", f"/api/items/{item['id']}/thumbnail"), ("DELETE", f"/api/items/{item['id']}/thumbnail"),
            ("GET", "/api/assets/" + "0" * 64), ("GET", "/api/collections"), ("POST", "/api/collections"),
            ("GET", "/api/tags"), ("GET", "/api/stats"), ("POST", "/api/imports/file?filename=a.json"), ("GET", "/api/imports"),
            ("GET", "/api/export"), ("GET", "/api/backup"), ("GET", "/api/settings"), ("PATCH", "/api/settings"),
            ("POST", "/api/ai/jobs"), ("GET", "/api/ai/jobs"), ("POST", "/api/ai/jobs/cancel"), ("POST", "/api/ai/jobs/x/retry"),
            ("POST", f"/api/items/{item['id']}/ai/accept"), ("POST", f"/api/items/{item['id']}/ai/dismiss"),
            ("POST", "/api/demo"), ("GET", "/api/account"),
        ):
            with self.subTest(route=method + " " + path):
                self.assertEqual(self.client.request(method, path, json={}).status_code, 401)
        self.assertEqual(self.client.get("/api/auth/me").json(), {"authenticated": False, "version": "0.1.0"})
        self.assertTrue(self.ok("GET", "/api/auth/me").json()["authenticated"])
        self.assertEqual(self.count(), 1)

    def test_item_lifecycle_arabic_search_filters_and_bulk_edits(self):
        item = self.item(title="أفكار للرسم", notes="تمارين بسيطة", tags=["فن", "sketchbook"])
        self.assertEqual(self.ok("GET", "/api/items", params={"q": "افكار"}).json()["total"], 1)
        self.assertEqual(self.ok("GET", "/api/items", params={"q": "sketch"}).json()["items"][0]["id"], item["id"])
        edited = self.ok("PATCH", "/api/items/" + item["id"], {"favorite": True, "status": "to_revisit", "notes": "Updated note"}).json()
        self.assertTrue(edited["favorite"])
        self.assertEqual(self.ok("GET", "/api/items", params={"favorite": "true", "status": "to_revisit"}).json()["total"], 1)
        second = self.item("https://www.instagram.com/reel/EXAMPLE123/?igsh=tracking")
        self.assertEqual(second["id"], self.item("https://www.instagram.com/p/EXAMPLE123/")["id"])
        self.assertEqual(self.ok("POST", "/api/items/bulk", {"filters": {}, "action": "tag", "value": "reference"}).json(), {"updated": 2})
        self.assertEqual(self.ok("GET", "/api/items", params={"tag": "reference"}).json()["total"], 2)
        self.assertEqual(self.call("POST", "/api/items/bulk", {"ids": [item["id"], "missing"], "action": "archive"}).status_code, 404)
        self.assertEqual(self.ok("DELETE", "/api/items/" + item["id"]).json(), {"ok": True})
        self.assertEqual(self.call("GET", "/api/items/" + item["id"]).status_code, 404)
        self.assertEqual(self.count(), 1)

    def test_strict_inputs_and_error_shape(self):
        item = self.item()
        self.assertEqual(self.call("PATCH", "/api/items/" + item["id"], {"notes": None}).status_code, 422)
        self.assertEqual(self.call("PATCH", "/api/items/" + item["id"], {"source_account": "other"}).status_code, 422)
        refused = self.call("POST", "/api/items", {"url": "javascript:alert(1)"})
        self.assertEqual(refused.status_code, 400)
        self.assertEqual(set(refused.json()), {"detail"})

    def test_collections_tags_and_stats(self):
        shelf = self.ok("POST", "/api/collections", {"name": "My reference shelf", "color": "#AABBCC"}).json()
        self.assertEqual(shelf["kind"], "local")
        item = self.item(tags=["recipes"], collection_ids=[shelf["id"]])
        self.assertEqual([entry["id"] for entry in item["collections"]], [shelf["id"]])
        renamed = self.ok("PATCH", "/api/collections/" + shelf["id"], {"name": "Renamed shelf"}).json()
        self.assertEqual((renamed["name"], renamed["count"]), ("Renamed shelf", 1))
        self.assertEqual(self.ok("GET", "/api/tags").json(), {"tags": [{"name": "recipes", "count": 1}]})
        stats = self.ok("GET", "/api/stats").json()
        self.assertEqual((stats["total"], stats["collections"], stats["platforms"]["web"]), (1, 1, 1))
        self.assertEqual(self.ok("GET", "/api/items", params={"collection_id": shelf["id"]}).json()["total"], 1)
        self.assertEqual(self.ok("DELETE", "/api/collections/" + shelf["id"]).json(), {"ok": True})
        self.assertEqual(self.ok("GET", "/api/collections").json(), {"collections": []})
        self.assertEqual(self.count(), 1)

    def test_thumbnail_upload_fetch_and_removal(self):
        item = self.item()
        uploaded = self.ok("POST", f"/api/items/{item['id']}/thumbnail", content=image(), headers={"Content-Type": "image/jpeg"}).json()
        fetched = self.ok("GET", uploaded["thumbnail_url"])
        self.assertEqual(fetched.headers["content-type"], "image/png")
        self.assertTrue(fetched.content.startswith(b"\x89PNG"))
        self.assertEqual(self.client.get(uploaded["thumbnail_url"]).status_code, 401)
        self.assertEqual(self.call("POST", f"/api/items/{item['id']}/thumbnail", content=b'<svg onload="alert(1)"/>').status_code, 400)
        self.assertIsNone(self.ok("DELETE", f"/api/items/{item['id']}/thumbnail").json()["thumbnail_url"])
        self.assertEqual(self.call("GET", uploaded["thumbnail_url"]).status_code, 404)

    def test_file_import_history_and_portable_export_round_trip(self):
        first = self.item(notes="Keep this note", tags=["saved"])
        self.ok("PATCH", "/api/items/" + first["id"], {"favorite": True})
        exported = self.ok("GET", "/api/export")
        self.assertIn("attachment", exported.headers["content-disposition"])
        document = exported.json()
        self.assertEqual((document["format"], document["version"], len(document["items"])), ("little-archive", 1, 1))
        self.assertTrue(self.ok("GET", "/api/export", params={"format": "csv"}).content.startswith(b"\xef\xbb\xbfurl,"))
        self.assertIn(b"NETSCAPE-Bookmark-file-1", self.ok("GET", "/api/export", params={"format": "html"}).content)
        self.ok("DELETE", "/api/items/" + first["id"])
        result = self.ok("POST", "/api/imports/file", params={"filename": "export.json"}, content=exported.content).json()
        self.assertEqual((result["created"], result["updated"], result["skipped"]), (1, 0, 0))
        restored = self.ok("GET", "/api/items").json()["items"][0]
        self.assertEqual((restored["notes"], restored["favorite"], restored["tags"]), ("Keep this note", True, ["saved"]))
        history = self.ok("GET", "/api/imports").json()["imports"]
        self.assertEqual([(run["source"], run["status"], run["created"]) for run in history], [("file", "completed", 1)])

    def test_backup_is_private_complete_and_restores_into_a_single_owner_library(self):
        item = self.item(notes="Back me up", tags=["saved"])
        self.ok("POST", f"/api/items/{item['id']}/thumbnail", content=image("#d7a5ae", (10, 10), "PNG"))
        response = self.ok("GET", "/api/backup")
        archive = self.root / "backup.zip"
        archive.write_bytes(response.content)
        with zipfile.ZipFile(archive) as bundle:
            manifest = json.loads(bundle.read("manifest.json"))
            self.assertEqual(manifest["items"], 1)
            self.assertEqual(sum(name.startswith("assets/") for name in bundle.namelist()), 1)
            for name, entry in manifest["files"].items():
                self.assertEqual(hashlib.sha256(bundle.read(name)).hexdigest(), entry["sha256"])
            snapshot = self.root / "snapshot.sqlite3"
            snapshot.write_bytes(bundle.read("library.sqlite3"))
        credential = self.target.auth["Authorization"][7:]
        for private in (credential, hashlib.sha256(credential.encode()).hexdigest()):
            self.assertNotIn(private.encode(), snapshot.read_bytes(), "a credential or its stored hash reached the backup")
        with sqlite3.connect(snapshot) as c:
            tables = {row[0] for row in c.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            self.assertNotIn("device_tokens", tables, "device credentials must not enter a portable backup")
            self.assertEqual(c.execute("SELECT count(*) FROM sessions").fetchone()[0], 0)
            self.assertEqual(c.execute("SELECT count(*) FROM extension_tokens").fetchone()[0], 0)
            self.assertIsNone(c.execute("SELECT value FROM meta WHERE key='password_hash'").fetchone())
        destination = self.root / "restored"
        restore_backup(archive, destination)
        restored_app = create_app(Config(data_dir=destination, admin_password="a-new-owner-password", public_url="http://testserver", testing=True))
        with TestClient(restored_app) as restored:
            self.assertEqual(restored.get("/api/items", headers=self.target.auth).status_code, 401, "old credentials must not follow a backup")
            self.assertEqual(restored.post("/api/auth/login", json={"password": "a-new-owner-password"}).status_code, 200)
            row = restored.get("/api/items").json()["items"][0]
            self.assertEqual(row["notes"], "Back me up")
            self.assertEqual(restored.get(row["thumbnail_url"]).status_code, 200)

    def test_settings_demo_seed_and_ai_disabled_state(self):
        self.assertEqual(self.ok("GET", "/api/settings").json(), {"remote_previews": False, "ai_enabled": False, "ai_available": False, "ai_model": ""})
        self.assertTrue(self.ok("PATCH", "/api/settings", {"remote_previews": True}).json()["remote_previews"])
        self.assertEqual(self.ok("POST", "/api/demo").json(), {"created": 15})
        self.assertEqual(self.ok("POST", "/api/demo").json(), {"created": 0})
        self.assertEqual(self.count(), 15)
        self.assertEqual(self.call("POST", "/api/ai/jobs", {"filters": {}}).status_code, 503)
        self.assertEqual(self.ok("GET", "/api/ai/jobs").json()["total"], 0)

    def test_account_summary_has_one_shape(self):
        self.item()
        body = self.ok("GET", "/api/account").json()
        self.assertEqual(set(body), {"mode", "user_id", "storage", "entitlements"})
        self.assertEqual(set(body["storage"]), {"used_bytes", "quota_bytes"})
        self.assertEqual(set(body["entitlements"]), {"unlocked", "deep_reads"})
        self.assertEqual(set(body["entitlements"]["deep_reads"]), {"period", "used", "limit", "remaining"})
        self.assertEqual(body["mode"], self.target.mode)
        self.assertGreater(body["storage"]["used_bytes"], 0)
        if self.target.mode == "hosted":
            self.assertEqual(body["user_id"], self.target.user)
            self.assertEqual(body["storage"]["quota_bytes"], 500 * 1024 * 1024)
            self.assertFalse(body["entitlements"]["unlocked"])
        else:
            self.assertIsNone(body["user_id"])
            self.assertIsNone(body["storage"]["quota_bytes"])
            self.assertTrue(body["entitlements"]["unlocked"])
            self.assertIsNone(body["entitlements"]["deep_reads"]["limit"])

    def test_bearer_requests_need_no_csrf_or_origin_and_are_never_granted_cors(self):
        elsewhere = {"Origin": "https://unrelated.example"}
        created = self.call("POST", "/api/items", {"url": "https://example.com/native"}, headers=elsewhere)
        self.assertEqual(created.status_code, 200, created.text)
        for response in (created, self.call("GET", "/api/items", headers=elsewhere),
                         self.client.options("/api/items", headers={**elsewhere, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization"}),
                         self.client.get("/api/discovery", headers=elsewhere)):
            self.assertFalse([name for name in response.headers if name.lower().startswith("access-control-")])
        self.assertEqual(created.headers["cache-control"], "no-store")
        self.assertNotIn("set-cookie", created.headers)

    def test_ai_suggestion_review_uses_the_callers_library(self):
        item = self.item(title="Original", summary="")
        library, worker = self.target.library(), self.app.state.worker
        current = self.ok("GET", "/api/items/" + item["id"]).json()
        suggestion = {"input_hash": worker.fingerprint(current), "suggested_title": "Suggested", "summary": "Suggested summary", "topics": ["idea"]}
        with library.transaction() as c:
            c.execute("UPDATE items SET ai=? WHERE id=?", (json.dumps(suggestion), item["id"]))
        accepted = self.ok("POST", f"/api/items/{item['id']}/ai/accept").json()
        self.assertEqual((accepted["title"], accepted["summary"], accepted["tags"]), ("Original", "Suggested summary", ["idea"]))
        with library.transaction() as c:
            c.execute("UPDATE items SET ai=? WHERE id=?", (json.dumps({**suggestion, "input_hash": "stale"}), item["id"]))
        self.assertEqual(self.call("POST", f"/api/items/{item['id']}/ai/accept").status_code, 409)
        self.assertIsNone(self.ok("POST", f"/api/items/{item['id']}/ai/dismiss").json()["ai"])


class QueueContract(ContractScenarios):
    """The durable AI queue, with a model configured but the worker thread held back."""
    settings = MODEL

    def test_queue_progress_cancel_and_retry(self):
        ids = [self.item(f"https://example.com/queue/{number}", caption="An example for queue verification.")["id"] for number in range(3)]
        self.assertEqual(self.ok("GET", "/api/settings").json()["ai_model"], "synthetic-model")
        self.assertEqual(self.ok("POST", "/api/ai/jobs", {"filters": {}}).json(), {"queued": 3, "matched": 3, "unchanged": 0})
        self.assertEqual(self.ok("POST", "/api/ai/jobs", {"ids": ids}).json(), {"queued": 0, "matched": 3, "unchanged": 3})
        progress = self.ok("GET", "/api/ai/jobs", params={"limit": 2}).json()
        self.assertEqual((len(progress["jobs"]), progress["total"], progress["counts"]["queued"]), (2, 3, 3))
        job = progress["jobs"][0]
        self.assertEqual(set(job), {"id", "item_id", "title", "status", "error", "created_at", "updated_at"})
        self.assertEqual(self.call("POST", f"/api/ai/jobs/{job['id']}/retry").status_code, 409)
        self.assertEqual(self.ok("POST", "/api/ai/jobs/cancel").json(), {"cancelled": 3})
        self.assertEqual(self.ok("POST", f"/api/ai/jobs/{job['id']}/retry").json(), {"queued": 1})
        self.assertEqual(self.call("POST", "/api/ai/jobs/not-found/retry").status_code, 404)
        self.assertEqual(self.call("POST", "/api/ai/jobs", {"ids": [*ids, "no-such-item"]}).status_code, 400)

    def test_worker_writes_each_result_to_the_library_it_was_queued_in(self):
        item = self.item(caption="A synthetic caption.")
        self.ok("POST", "/api/ai/jobs", {"ids": [item["id"]]})
        worker = self.app.state.worker

        def inference(*args):
            worker.stopping.set()  # One job, then let the loop end.
            return {"suggested_title": "Synthetic suggestion", "summary": "Synthetic summary.", "topics": ["example"], "needs_review": True}

        with patch("server.classifier.classify_item", side_effect=inference):
            worker.run()
        worker.stopping.clear()
        suggested = self.ok("GET", "/api/items/" + item["id"]).json()["ai"]
        self.assertEqual(suggested["suggested_title"], "Synthetic suggestion")
        self.assertEqual(self.ok("GET", "/api/ai/jobs").json()["counts"]["completed"], 1)


class SelfHostedLibraryContract(LibraryContract, unittest.TestCase):
    backend = SelfHostedClient


class HostedLibraryContract(LibraryContract, unittest.TestCase):
    backend = HostedClient


class SelfHostedQueueContract(QueueContract, unittest.TestCase):
    backend = SelfHostedClient


class HostedQueueContract(QueueContract, unittest.TestCase):
    backend = HostedClient


def shape(value):
    """Structure without values: key sets, element shapes and scalar types."""
    if isinstance(value, dict):
        return {key: shape(entry) for key, entry in sorted(value.items())}
    if isinstance(value, list):
        return sorted({json.dumps(shape(entry), sort_keys=True) for entry in value})
    return type(value).__name__


class ModeParity(unittest.TestCase):
    """The same requests must produce the same statuses and JSON shapes in both modes."""

    # The only responses allowed to differ, and exactly where.
    MODE_SPECIFIC = {("GET /api/account", "user_id"), ("GET /api/account", "storage.quota_bytes"),
                     ("GET /api/account", "entitlements.deep_reads.limit"), ("GET /api/account", "entitlements.deep_reads.remaining")}

    def script(self, target):
        def call(method, path, data=None, **kwargs):
            if data is not None:
                kwargs["json"] = data
            return target.client.request(method, path, headers={**target.auth, **kwargs.pop("headers", {})}, **kwargs)

        seen = []

        def record(label, response):
            body = response.json() if response.headers.get("content-type", "").startswith("application/json") else response.headers.get("content-type")
            seen.append((label, response.status_code, body))
            return response

        shelf = record("POST /api/collections", call("POST", "/api/collections", {"name": "Shelf"})).json()
        item = record("POST /api/items", call("POST", "/api/items", {"url": "https://example.com/parity", "title": "Parity", "tags": ["one"], "collection_ids": [shelf["id"]]})).json()
        record("POST thumbnail", call("POST", f"/api/items/{item['id']}/thumbnail", content=image()))
        record("GET /api/items", call("GET", "/api/items"))
        record("GET /api/items/{id}", call("GET", "/api/items/" + item["id"]))
        record("PATCH /api/items/{id}", call("PATCH", "/api/items/" + item["id"], {"notes": "Changed", "favorite": True}))
        record("PATCH invalid", call("PATCH", "/api/items/" + item["id"], {"unknown": 1}))
        record("POST /api/items/bulk", call("POST", "/api/items/bulk", {"ids": [item["id"]], "action": "favorite"}))
        record("GET missing item", call("GET", "/api/items/" + str(uuid4())))
        record("GET /api/collections", call("GET", "/api/collections"))
        record("GET /api/tags", call("GET", "/api/tags"))
        record("GET /api/stats", call("GET", "/api/stats"))
        record("POST /api/imports/file", call("POST", "/api/imports/file", params={"filename": "links.csv"}, content=b"url,title\nhttps://example.com/from-file,From a file\n"))
        record("GET /api/imports", call("GET", "/api/imports"))
        record("GET /api/export", call("GET", "/api/export"))
        record("GET /api/export csv", call("GET", "/api/export", params={"format": "csv"}))
        record("GET /api/backup", call("GET", "/api/backup"))
        record("GET /api/settings", call("GET", "/api/settings"))
        record("PATCH /api/settings", call("PATCH", "/api/settings", {"remote_previews": True}))
        record("POST /api/ai/jobs", call("POST", "/api/ai/jobs", {"filters": {}}))
        record("GET /api/ai/jobs", call("GET", "/api/ai/jobs"))
        record("POST /api/ai/jobs/cancel", call("POST", "/api/ai/jobs/cancel"))
        record("POST /api/demo", call("POST", "/api/demo"))
        record("GET /api/account", call("GET", "/api/account"))
        record("GET /api/auth/me anonymous", target.client.get("/api/auth/me"))
        record("GET /api/items anonymous", target.client.get("/api/items"))
        record("DELETE thumbnail", call("DELETE", f"/api/items/{item['id']}/thumbnail"))
        record("DELETE /api/items/{id}", call("DELETE", "/api/items/" + item["id"]))
        record("DELETE /api/collections/{id}", call("DELETE", "/api/collections/" + shelf["id"]))
        return seen

    def comparable(self, label, body):
        if not isinstance(body, dict):
            return shape(body)
        result = shape(body)
        for where, path in self.MODE_SPECIFIC:
            if where == label:
                node, parts = result, path.split(".")
                for part in parts[:-1]:
                    node = node[part]
                node[parts[-1]] = "mode-specific"
        return result

    def test_both_modes_answer_the_same_script_with_the_same_shapes(self):
        with tempfile.TemporaryDirectory(prefix="little-archive-parity-") as folder, patch("server.jobs.ClassificationWorker.start"):
            results = {}
            for backend in (SelfHostedClient, HostedClient):
                target = backend(Path(folder) / backend.mode, **dict(MODEL))
                try:
                    results[backend.mode] = self.script(target)
                finally:
                    target.close()
        owner, account = results["self-hosted"], results["hosted"]
        self.assertEqual(len(owner), 29)
        self.assertEqual([row[0] for row in owner], [row[0] for row in account])
        for (label, owner_status, owner_body), (_, account_status, account_body) in zip(owner, account):
            with self.subTest(request=label):
                self.assertEqual(owner_status, account_status)
                self.assertEqual(self.comparable(label, owner_body), self.comparable(label, account_body))
        statuses = {label: status for label, status, _ in owner}
        self.assertEqual((statuses["PATCH invalid"], statuses["GET missing item"], statuses["GET /api/items anonymous"]), (422, 404, 401))
        self.assertTrue(all(status == 200 for label, status in statuses.items() if label not in {"PATCH invalid", "GET missing item", "GET /api/items anonymous"}))


if __name__ == "__main__":
    unittest.main()
