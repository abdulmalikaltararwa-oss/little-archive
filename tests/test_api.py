"""Integration checks for authentication, import integrity and real recovery.

All fixtures are synthetic; every instance and artifact lives in a temporary
directory. No source-platform or model service requests are made.
"""
import hashlib
import io
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from uuid import uuid4
import zipfile

from fastapi.testclient import TestClient
from PIL import Image

from server.app import create_app
from server.backups import restore_backup
from server.config import Config


PASSWORD = "test-owner-password-2026"


class APIIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="little-archive-test-")
        self.root = Path(self.temporary.name)
        self.config = Config(data_dir=self.root / "data", admin_password=PASSWORD, public_url="http://testserver", testing=True)
        self.app = create_app(self.config)
        self.client = TestClient(self.app)
        self.client.__enter__()
        response = self.client.post("/api/auth/login", json={"password": PASSWORD}, headers={"Origin": "http://testserver"})
        self.assertEqual(response.status_code, 200, response.text)
        self.headers = {"X-CSRF-Token": response.json()["csrf_token"], "Origin": "http://testserver"}

    def tearDown(self):
        self.client.__exit__(None, None, None)
        self.temporary.cleanup()

    def write(self, method, url, data=None, **kwargs):
        return self.client.request(method, url, json=data, headers=self.headers, **kwargs)

    def item(self, url="https://example.com/guide", **kwargs):
        response = self.write("POST", "/api/items", {"url": url, "title": "A useful guide", **kwargs})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def token(self, name="Test browser"):
        response = self.write("POST", "/api/extension/tokens", {"name": name})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def begin(self, token, platform="instagram", account="demo-account", scope="Examples"):
        response = self.client.post("/api/extension/imports", json={"platform": platform, "source_account": account, "scope": scope}, headers={"Authorization": "Bearer " + token["token"]})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()["run_id"]

    def batch(self, token, run, items=None, sequence=0, batch_id=None):
        data = {"batch_id": batch_id or str(uuid4()), "sequence": sequence, "items": items or [{"url": "https://www.instagram.com/p/EXAMPLE123/", "title": "Source title"}]}
        response = self.client.post(f"/api/extension/imports/{run}/batches", json=data, headers={"Authorization": "Bearer " + token["token"]})
        return response, data

    def finish(self, token, run, expected=1, coverage="enumeration_exhausted"):
        return self.client.post(f"/api/extension/imports/{run}/finish", json={"expected_batches": expected, "coverage": coverage}, headers={"Authorization": "Bearer " + token["token"]})

    def count(self):
        return self.client.get("/api/items").json()["total"]

    def test_owner_auth_csrf_origin_and_logout(self):
        with TestClient(self.app) as anonymous:
            self.assertFalse(anonymous.get("/api/auth/me").json()["authenticated"])
            self.assertEqual(anonymous.get("/api/items").status_code, 401)
            self.assertEqual(anonymous.post("/api/auth/login", json={"password": PASSWORD}, headers={"Origin": "https://unrelated.example"}).status_code, 403)
        self.assertEqual(self.client.post("/api/items", json={"url": "https://example.com/a"}).status_code, 403)
        self.assertEqual(self.client.post("/api/items", json={"url": "https://example.com/a"}, headers={**self.headers, "Origin": "https://unrelated.example"}).status_code, 403)
        self.assertEqual(self.client.post("/api/items", json={"url": "https://example.com/a"}, headers={**self.headers, "X-CSRF-Token": "wrong"}).status_code, 403)
        self.assertEqual(self.write("POST", "/api/auth/logout").status_code, 200)
        self.assertEqual(self.client.get("/api/items").status_code, 401)

    def test_session_cookie_and_security_headers(self):
        response = self.client.post("/api/auth/login", json={"password": PASSWORD}, headers={"Origin": "http://testserver"})
        cookie = response.headers["set-cookie"].lower()
        self.assertIn("httponly", cookie)
        self.assertIn("samesite=strict", cookie)
        self.assertEqual(response.headers["cache-control"], "no-store")
        self.assertIn("frame-ancestors 'none'", response.headers["content-security-policy"])
        self.assertEqual(self.client.get("/api/items", headers={"Host": "untrusted.example"}).status_code, 400)

    def test_import_token_cannot_browse_and_revocation_works(self):
        token = self.token()
        auth = {"Authorization": "Bearer " + token["token"]}
        with TestClient(self.app) as extension:
            self.assertEqual(extension.get("/api/extension/status", headers=auth).status_code, 200)
            self.assertEqual(extension.get("/api/items", headers=auth).status_code, 401)
            self.assertEqual(extension.post("/api/extension/tokens", json={"name": "bad"}, headers=auth).status_code, 401)
            self.assertEqual(extension.get("/api/export", headers=auth).status_code, 401)
        listed = self.client.get("/api/extension/tokens").json()["tokens"]
        self.assertNotIn("token", listed[0])
        self.assertNotIn("hash", listed[0])
        run = self.begin(token)
        self.assertEqual(self.write("DELETE", "/api/extension/tokens/" + token["id"]).status_code, 200)
        self.assertEqual(self.client.get("/api/extension/status", headers=auth).status_code, 401)
        with self.app.state.store.transaction() as c:
            self.assertEqual(c.execute("SELECT status FROM import_runs WHERE id=?", (run,)).fetchone()[0], "cancelled")

    def test_item_crud_arabic_search_and_favorite_filters(self):
        item = self.item(title="أفكار للرسم", notes="تمارين بسيطة", tags=["فن", "sketchbook"])
        self.assertEqual(self.client.get("/api/items", params={"q": "افكار"}).json()["total"], 1)
        self.assertEqual(self.client.get("/api/items", params={"q": "تمارين"}).json()["items"][0]["id"], item["id"])
        self.assertEqual(self.client.get("/api/items", params={"q": "sketch"}).json()["total"], 1)
        self.assertEqual(self.client.get("/api/items", params={"favorite": "true"}).json()["total"], 0)
        edited = self.write("PATCH", "/api/items/" + item["id"], {"favorite": True, "status": "to_revisit", "notes": "Updated note"})
        self.assertEqual(edited.status_code, 200, edited.text)
        self.assertEqual(self.client.get("/api/items", params={"favorite": "true", "status": "to_revisit"}).json()["total"], 1)
        self.assertEqual(self.client.get("/api/items", params={"q": "Updated"}).json()["total"], 1)
        self.assertEqual(self.client.get("/api/items", params={"q": "تمارين"}).json()["total"], 0)
        self.assertEqual(self.write("DELETE", "/api/items/" + item["id"]).status_code, 200)
        self.assertEqual(self.count(), 0)
        self.assertEqual(self.client.get("/api/items/" + item["id"]).status_code, 404)

    def test_canonical_link_dedup_and_strict_inputs(self):
        first = self.item("https://www.instagram.com/reel/EXAMPLE123/?igsh=tracking")
        second = self.item("https://www.instagram.com/p/EXAMPLE123/")
        self.assertEqual(first["id"], second["id"])
        self.assertEqual(self.count(), 1)
        self.assertEqual(self.write("PATCH", "/api/items/" + first["id"], {"notes": None}).status_code, 422)
        self.assertEqual(self.write("PATCH", "/api/items/" + first["id"], {"source_account": "other"}).status_code, 422)
        self.assertEqual(self.write("POST", "/api/items", {"url": "javascript:alert(1)"}).status_code, 400)

    def test_source_memberships_survive_manual_changes_and_refresh(self):
        token = self.token()
        run = self.begin(token, account="default")
        record = {"url": "https://www.instagram.com/p/EXAMPLE123/", "title": "Source title", "collections": [{"source_key": "c1", "name": "Original one"}, {"source_key": "c2", "name": "Original two"}, {"source_key": "c3", "name": "Original three"}]}
        response, _ = self.batch(token, run, [record])
        self.assertEqual(response.status_code, 200, response.text)
        item = self.client.get("/api/items").json()["items"][0]
        self.assertEqual(len(item["collections"]), 3)
        local = self.write("POST", "/api/collections", {"name": "My ideas"}).json()
        changed = self.write("PATCH", "/api/items/" + item["id"], {"title": "My corrected title", "notes": "Keep this note", "tags": ["mine"], "collection_ids": [local["id"]]}).json()
        self.assertEqual(len(changed["collections"]), 4)
        source_id = next(c["id"] for c in changed["collections"] if c["kind"] == "source")
        self.assertEqual(self.write("PATCH", "/api/collections/" + source_id, {"name": "Wrong"}).status_code, 403)
        run2 = self.begin(token, account="default")
        response, _ = self.batch(token, run2, [{"url": record["url"], "title": "New source title", "caption": "Fresh caption"}])
        self.assertEqual(response.status_code, 200, response.text)
        refreshed = self.client.get("/api/items/" + item["id"]).json()
        self.assertEqual(refreshed["title"], "My corrected title")
        self.assertEqual(refreshed["notes"], "Keep this note")
        self.assertEqual(refreshed["tags"], ["mine"])
        self.assertEqual(len(refreshed["collections"]), 4)
        self.assertEqual(self.count(), 1)
        removed = self.write("PATCH", "/api/items/" + item["id"], {"collection_ids": []}).json()
        self.assertEqual(len(removed["collections"]), 3)

    def test_batch_replay_conflict_sequence_and_finish_gaps(self):
        token = self.token()
        run = self.begin(token)
        response, body = self.batch(token, run, batch_id="stable-batch", sequence=0)
        self.assertEqual(response.status_code, 200, response.text)
        auth = {"Authorization": "Bearer " + token["token"]}
        replay = self.client.post(f"/api/extension/imports/{run}/batches", json=body, headers=auth)
        self.assertTrue(replay.json()["replayed"])
        self.assertEqual(self.count(), 1)
        altered = {**body, "items": [{"url": "https://www.instagram.com/p/OTHER123/"}]}
        self.assertEqual(self.client.post(f"/api/extension/imports/{run}/batches", json=altered, headers=auth).status_code, 409)
        self.assertEqual(self.finish(token, run, expected=2).status_code, 409)
        self.assertEqual(self.finish(token, run).status_code, 200)
        self.assertEqual(self.finish(token, run, coverage="partial").status_code, 409)
        self.assertTrue(self.client.post(f"/api/extension/imports/{run}/batches", json=body, headers=auth).json()["replayed"])
        new, _ = self.batch(token, run, sequence=1)
        self.assertEqual(new.status_code, 409)

    def test_wrong_platform_batch_is_atomic_and_account_override_rejected(self):
        token = self.token()
        run = self.begin(token, platform="instagram", account="account-a")
        response, _ = self.batch(token, run, [{"url": "https://www.instagram.com/p/EXAMPLE123/"}, {"url": "https://www.tiktok.com/@demo/video/123456"}])
        self.assertEqual(response.status_code, 400, response.text)
        self.assertEqual(self.count(), 0)
        override, _ = self.batch(token, run, [{"url": "https://www.instagram.com/p/EXAMPLE123/", "source_account": "account-b"}])
        self.assertEqual(override.status_code, 422)
        self.assertEqual(self.count(), 0)
        response, _ = self.batch(token, run)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.client.get("/api/items").json()["items"][0]["source_account"], "account-a")

    def test_run_bound_to_token_and_separate_accounts(self):
        token = self.token()
        other = self.token("Another browser")
        run = self.begin(token, account="one")
        wrong, _ = self.batch(other, run)
        self.assertEqual(wrong.status_code, 404)
        self.assertEqual(self.batch(token, run)[0].status_code, 200)
        second = self.begin(token, account="two")
        self.assertEqual(self.batch(token, second)[0].status_code, 200)
        self.assertEqual(self.count(), 2)
        self.assertEqual({i["source_account"] for i in self.client.get("/api/items").json()["items"]}, {"one", "two"})

    def test_empty_scan_does_not_claim_complete_or_delete(self):
        self.item()
        token = self.token()
        run = self.begin(token)
        response = self.finish(token, run, expected=0)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["coverage"], "partial")
        self.assertEqual(self.count(), 1)

    def test_json_export_roundtrip_annotations_evidence_and_memberships(self):
        token = self.token()
        run = self.begin(token, account="example-account")
        response, _ = self.batch(token, run, [{"url": "https://www.instagram.com/p/EXAMPLE123/", "title": "Source", "thumbnail_alt": "Cover text", "collections": [{"source_key": "original-collection", "name": "Original spelling"}]}])
        self.assertEqual(response.status_code, 200)
        item = self.client.get("/api/items").json()["items"][0]
        local = self.write("POST", "/api/collections", {"name": "Weekend"}).json()
        self.write("PATCH", "/api/items/" + item["id"], {"title": "My title", "summary": "My summary", "notes": "Do this later", "tags": ["idea", "فن"], "favorite": True, "status": "done", "needs_review": False, "collection_ids": [local["id"]]})
        export = self.client.get("/api/export?format=json")
        self.assertEqual(export.status_code, 200)
        self.assertNotIn("token", export.text)
        self.assertNotIn("password_hash", export.text)
        self.write("DELETE", "/api/items/" + item["id"])
        result = self.client.post("/api/imports/file?filename=export.json", content=export.content, headers=self.headers)
        self.assertEqual(result.status_code, 200, result.text)
        self.assertEqual(result.json()["created"], 1)
        restored = self.client.get("/api/items").json()["items"][0]
        for field, expected in {"title": "My title", "summary": "My summary", "notes": "Do this later", "tags": ["idea", "فن"], "favorite": True, "status": "done", "needs_review": False, "source_account": "example-account"}.items():
            self.assertEqual(restored[field], expected, field)
        self.assertEqual({(c["name"], c["kind"]) for c in restored["collections"]}, {("Original spelling", "source"), ("Weekend", "local")})
        self.assertIn({"kind": "thumbnail_alt", "text": "Cover text"}, restored["evidence"])

    def test_csv_import_preserves_supplied_annotations_on_new_records(self):
        raw = b'url,title,notes,tags,favorite,status\nhttps://example.com/csv,CSV title,Keep this note,one;two,true,done\n'
        response = self.client.post("/api/imports/file?filename=items.csv", content=raw, headers=self.headers)
        self.assertEqual(response.status_code, 200, response.text)
        imported = self.client.get("/api/items").json()["items"][0]
        self.assertEqual(imported["notes"], "Keep this note")
        self.assertEqual(imported["tags"], ["one", "two"])
        self.assertTrue(imported["favorite"])
        self.assertEqual(imported["status"], "done")

    def test_portable_import_keeps_empty_collections_and_colors(self):
        payload = {"format": "little-archive", "version": 1, "items": [], "collections": [
            {"id": "foreign-local-id", "name": "My empty folder", "kind": "local", "color": "#D5A7AC"},
            {"id": "foreign-source-id", "name": "أفكار", "kind": "source", "platform": "instagram", "source_account": "example", "source_key": "original-key", "color": "#6F8A72"},
        ]}
        response = self.client.post("/api/imports/file?filename=archive.json", content=json.dumps(payload).encode(), headers=self.headers)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["created"], 0)
        rows = self.client.get("/api/collections").json()["collections"]
        self.assertEqual(len(rows), 2)
        by_name = {row["name"]: row for row in rows}
        self.assertEqual(by_name["My empty folder"]["color"], "#D5A7AC")
        self.assertNotEqual(by_name["My empty folder"]["id"], "foreign-local-id")
        self.assertEqual(by_name["أفكار"]["source_key"], "original-key")
        self.assertEqual(by_name["أفكار"]["source_account"], "example")
        self.assertTrue(all(row["count"] == 0 for row in rows))
        self.assertEqual(self.client.post("/api/imports/file?filename=archive.json", content=json.dumps(payload).encode(), headers=self.headers).status_code, 200)
        self.assertEqual(len(self.client.get("/api/collections").json()["collections"]), 2)

    def test_ai_accept_rejects_stale_evidence(self):
        item = self.item(notes="Initial context")
        suggestion = {"input_hash": self.app.state.worker.fingerprint(item), "suggested_title": "Suggested", "summary": "Source-based summary", "topics": ["idea"]}
        with self.app.state.store.transaction() as c:
            c.execute("UPDATE items SET ai=? WHERE id=?", (json.dumps(suggestion), item["id"]))
        self.write("PATCH", "/api/items/" + item["id"], {"notes": "New context"})
        rejected = self.write("POST", f"/api/items/{item['id']}/ai/accept")
        self.assertEqual(rejected.status_code, 409, rejected.text)
        current = self.client.get("/api/items/" + item["id"]).json()
        self.assertEqual(current["tags"], [])
        suggestion["input_hash"] = self.app.state.worker.fingerprint(current)
        with self.app.state.store.transaction() as c:
            c.execute("UPDATE items SET ai=? WHERE id=?", (json.dumps(suggestion), item["id"]))
        accepted = self.write("POST", f"/api/items/{item['id']}/ai/accept")
        self.assertEqual(accepted.status_code, 200, accepted.text)
        self.assertEqual(accepted.json()["notes"], "New context")
        self.assertEqual(accepted.json()["title"], "A useful guide")
        self.assertEqual(accepted.json()["tags"], ["idea"])

    def test_bulk_failure_does_not_partially_mutate(self):
        item = self.item()
        failure = self.write("POST", "/api/items/bulk", {"ids": [item["id"], "missing"], "action": "favorite"})
        self.assertEqual(failure.status_code, 404)
        self.assertFalse(self.client.get("/api/items/" + item["id"]).json()["favorite"])
        self.assertEqual(self.write("POST", "/api/items/bulk", {"ids": [item["id"]], "action": "archive"}).status_code, 200)
        self.assertEqual(self.count(), 0)
        self.assertEqual(self.client.get("/api/items?status=archived").json()["total"], 1)
        self.assertEqual(self.write("POST", "/api/items/bulk", {"ids": [item["id"]], "action": "restore"}).status_code, 200)
        self.assertEqual(self.count(), 1)

    def test_thumbnail_is_raster_reencoded_and_auth_required(self):
        item = self.item()
        body = io.BytesIO()
        Image.new("RGB", (24, 18), "#91a58f").save(body, "JPEG")
        uploaded = self.client.post(f"/api/items/{item['id']}/thumbnail", content=body.getvalue(), headers={**self.headers, "Content-Type": "image/jpeg"})
        self.assertEqual(uploaded.status_code, 200, uploaded.text)
        url = uploaded.json()["thumbnail_url"]
        asset = self.client.get(url)
        self.assertEqual(asset.status_code, 200)
        self.assertEqual(asset.headers["content-type"], "image/png")
        self.assertTrue(asset.content.startswith(b"\x89PNG"))
        with TestClient(self.app) as anonymous:
            self.assertEqual(anonymous.get(url).status_code, 401)
        bad = self.client.post(f"/api/items/{item['id']}/thumbnail", content=b'<svg onload="alert(1)"/>', headers=self.headers)
        self.assertEqual(bad.status_code, 400)

    def test_backup_restore_assets_integrity_and_authentication_exclusion(self):
        item = self.item(notes="Back me up", tags=["saved"])
        self.write("PATCH", "/api/items/" + item["id"], {"favorite": True})
        body = io.BytesIO()
        Image.new("RGB", (10, 10), "#d7a5ae").save(body, "PNG")
        self.assertEqual(self.client.post(f"/api/items/{item['id']}/thumbnail", content=body.getvalue(), headers=self.headers).status_code, 200)
        token = self.token()
        old_instance = self.app.state.store.meta("instance_id")
        password_hash = self.app.state.store.meta("password_hash")
        response = self.client.get("/api/backup")
        self.assertEqual(response.status_code, 200, response.text[:100] if response.status_code != 200 else "")
        archive_path = self.root / "backup.zip"
        archive_path.write_bytes(response.content)
        with zipfile.ZipFile(archive_path) as z:
            manifest = json.loads(z.read("manifest.json"))
            self.assertEqual(manifest["items"], 1)
            db_bytes = z.read("library.sqlite3")
            self.assertNotIn(password_hash.encode(), db_bytes, "Deleted authentication values remain in snapshot free pages")
            self.assertNotIn(self.headers["X-CSRF-Token"].encode(), db_bytes, "Deleted CSRF credentials remain in snapshot free pages")
            for name, meta in manifest["files"].items():
                self.assertEqual(hashlib.sha256(z.read(name)).hexdigest(), meta["sha256"])
            self.assertEqual(sum(name.startswith("assets/") for name in z.namelist()), 1)
        destination = self.root / "restored"
        restore_backup(archive_path, destination)
        with sqlite3.connect(destination / "library.sqlite3") as c:
            self.assertEqual(c.execute("SELECT count(*) FROM sessions").fetchone()[0], 0)
            self.assertEqual(c.execute("SELECT count(*) FROM extension_tokens").fetchone()[0], 0)
            self.assertIsNone(c.execute("SELECT value FROM meta WHERE key='password_hash'").fetchone())
            self.assertNotEqual(c.execute("SELECT value FROM meta WHERE key='instance_id'").fetchone()[0], old_instance)
        restored_app = create_app(Config(data_dir=destination, admin_password="a-new-owner-password", public_url="http://testserver", testing=True))
        with TestClient(restored_app) as restored:
            self.assertEqual(restored.post("/api/auth/login", json={"password": PASSWORD}).status_code, 401)
            self.assertEqual(restored.post("/api/auth/login", json={"password": "a-new-owner-password"}).status_code, 200)
            row = restored.get("/api/items").json()["items"][0]
            self.assertEqual(row["notes"], "Back me up")
            self.assertTrue(row["favorite"])
            self.assertEqual(restored.get(row["thumbnail_url"]).status_code, 200)
            self.assertEqual(restored.get("/api/extension/status", headers={"Authorization": "Bearer " + token["token"]}).status_code, 401)

    def test_backup_rejects_missing_asset_and_restore_rejects_tampering(self):
        item = self.item()
        body = io.BytesIO()
        Image.new("RGB", (5, 5), "#91a58f").save(body, "PNG")
        self.client.post(f"/api/items/{item['id']}/thumbnail", content=body.getvalue(), headers=self.headers)
        response = self.client.get("/api/backup")
        self.assertEqual(response.status_code, 200)
        original = zipfile.ZipFile(io.BytesIO(response.content))
        tampered = self.root / "tampered.zip"
        with zipfile.ZipFile(tampered, "w") as changed:
            for name in original.namelist():
                changed.writestr(name, b"tampered" if name.startswith("assets/") else original.read(name))
        with self.assertRaisesRegex(ValueError, "checksum|size"):
            restore_backup(tampered, self.root / "must-not-exist")
        self.assertFalse((self.root / "must-not-exist").exists())
        for asset in self.app.state.store.assets.glob("*.png"):
            asset.unlink()
        self.assertEqual(self.client.get("/api/backup").status_code, 400)

    def test_optional_ai_disabled_and_remote_preview_opt_in(self):
        item = self.item(preview_url="https://untrusted.example/private.png")
        self.assertIsNone(item["preview_url"])
        settings = self.client.get("/api/settings").json()
        self.assertFalse(settings["remote_previews"])
        self.assertFalse(settings["ai_enabled"])
        self.assertEqual(self.write("POST", "/api/ai/jobs", {"ids": [item["id"]]}).status_code, 503)
        changed = self.write("PATCH", "/api/settings", {"remote_previews": True})
        self.assertTrue(changed.json()["remote_previews"])


if __name__ == "__main__":
    unittest.main()
