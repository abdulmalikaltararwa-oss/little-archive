"""Whole-library classification, durable progress, and cancellation regressions.

These tests exercise the real API and database with synthetic records. Inference
is controlled only where a deterministic race needs to be reproduced; the
separate model smoke test verifies an actual local model service.
"""
from pathlib import Path
import secrets
from tempfile import TemporaryDirectory
from threading import Event, Thread
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from server.app import create_app
from server.config import Config
from server.enrich.understanding import AnalysisOutcome, ProviderUsage
from server.storage import Store


class LibraryClassificationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = TemporaryDirectory(prefix="little-archive-queue-")
        self.password = secrets.token_urlsafe(32)
        self.config = Config(data_dir=Path(self.temporary.name), admin_password=self.password,
                             public_url="http://testserver", testing=True,
                             ollama_url="http://127.0.0.1:1", ollama_model="synthetic-model")
        self.no_worker = patch("server.jobs.ClassificationWorker.start")
        self.no_worker.start()
        self.app = create_app(self.config)
        self.client = TestClient(self.app)
        self.client.__enter__()
        login = self.client.post("/api/auth/login", json={"password": self.password})
        self.assertEqual(login.status_code, 200)
        self.headers = {"Origin": "http://testserver", "X-CSRF-Token": login.json()["csrf_token"]}
        self.store = self.app.state.store

    def tearDown(self):
        self.client.__exit__(None, None, None)
        self.no_worker.stop()
        self.temporary.cleanup()

    def post(self, path, data=None):
        return self.client.post(path, json=data, headers=self.headers)

    def seed(self, count):
        with self.store.transaction() as connection:
            return [self.store.apply_item(connection, {"url": f"https://example.com/queue/{i}",
                    "title": f"Synthetic item {i}", "caption": "An example for queue verification."})[0]
                    for i in range(count)]

    def test_whole_library_goes_beyond_page_limit_and_is_idempotent(self):
        ids = self.seed(205)
        self.assertEqual(len(self.client.get("/api/items").json()["items"]), 60)
        queued = self.post("/api/ai/jobs", {"filters": {}})
        self.assertEqual(queued.status_code, 200)
        self.assertEqual(queued.json(), {"queued": 205, "matched": 205, "unchanged": 0})
        repeated = self.post("/api/ai/jobs", {"filters": {}}).json()
        self.assertEqual(repeated, {"queued": 0, "matched": 205, "unchanged": 205})
        progress = self.client.get("/api/ai/jobs?limit=2&offset=2").json()
        self.assertEqual(len(progress["jobs"]), 2)
        self.assertEqual(progress["total"], 205)
        self.assertEqual(progress["counts"]["queued"], 205)
        self.assertTrue(all(job["title"].startswith("Synthetic item") for job in progress["jobs"]))
        self.assertTrue(all(job["item_id"] in ids for job in progress["jobs"]))

    def test_filters_match_gallery_and_exclude_archived_by_default(self):
        ids = self.seed(4)
        with self.store.transaction() as connection:
            collection = self.store.resolve_collection(connection, {"name": "My exact collection", "kind": "local"}, "web", "local")
            for iid in ids[:2]:
                self.store.set_local_memberships(connection, iid, [collection])
            connection.execute("UPDATE items SET status='archived' WHERE id=?", (ids[3],))
        self.client.patch("/api/items/" + ids[0], json={"title": "أفكار cooking", "tags": ["recipes"], "favorite": True}, headers=self.headers)
        filters = {"q": "افكار", "tag": "recipes", "favorite": True, "collection_id": collection}
        expected = self.client.get("/api/items", params=filters).json()
        self.assertEqual(expected["total"], 1)
        self.assertEqual(self.post("/api/ai/jobs", {"filters": filters}).json()["matched"], expected["total"])
        self.assertEqual(self.post("/api/ai/jobs", {"filters": {}}).json()["matched"], 3)
        archived = self.post("/api/ai/jobs", {"filters": {"status": "archived"}}).json()
        self.assertEqual(archived["matched"], 1)
        self.assertEqual(archived["queued"], 1)

    def test_selection_scope_validation_and_missing_item_are_atomic(self):
        ids = self.seed(1)
        for payload in ({}, {"ids": ids, "filters": {}}, {"filters": {"status": "imaginary"}}, {"ids": []}, {"ids": ids * 201}):
            with self.subTest(payload_shape=list(payload)):
                self.assertEqual(self.post("/api/ai/jobs", payload).status_code, 422)
        self.assertEqual(self.post("/api/ai/jobs", {"ids": [*ids, "no-such-item"]}).status_code, 400)
        self.assertEqual(self.client.get("/api/ai/jobs").json()["total"], 0)
        self.assertEqual(self.client.post("/api/ai/jobs", json={"filters": {}}).status_code, 403)

    def test_manual_organization_applies_to_all_matches_beyond_loaded_cards(self):
        ids = self.seed(205)
        collection = self.post("/api/collections", {"name": "My reference shelf"}).json()
        with self.store.transaction() as connection:
            source = self.store.resolve_collection(connection, {"name": "Original category"}, "instagram", "synthetic-account")
            connection.execute("INSERT INTO memberships VALUES(?,?)", (ids[0], source))
        tagged = self.post("/api/items/bulk", {"filters": {}, "action": "tag", "value": "reference"})
        self.assertEqual(tagged.status_code, 200)
        self.assertEqual(tagged.json()["updated"], 205)
        organized = self.post("/api/items/bulk", {"filters": {"tag": "reference"}, "action": "collection", "value": collection["id"]})
        self.assertEqual(organized.json()["updated"], 205)
        self.assertEqual(self.client.get("/api/items", params={"collection_id": collection["id"]}).json()["total"], 205)
        current = self.client.get("/api/items/" + ids[0]).json()
        self.assertEqual({entry["id"] for entry in current["collections"]}, {source, collection["id"]})
        self.assertEqual(self.post("/api/items/bulk", {"ids": ids[:1], "filters": {}, "action": "archive"}).status_code, 422)

    def test_cancel_survives_restart_and_retry_uses_current_evidence(self):
        ids = self.seed(2)
        self.post("/api/ai/jobs", {"ids": ids})
        old = self.client.get("/api/ai/jobs").json()["jobs"][0]
        self.assertEqual(self.post("/api/ai/jobs/" + old["id"] + "/retry").status_code, 409)
        self.assertEqual(self.post("/api/ai/jobs/cancel").json(), {"cancelled": 2})
        Store(self.config)  # A restart must not bring cancelled work back.
        self.assertEqual(self.client.get("/api/ai/jobs").json()["counts"]["cancelled"], 2)
        self.client.patch("/api/items/" + old["item_id"], json={"notes": "Changed evidence after cancellation."}, headers=self.headers)
        self.assertEqual(self.post("/api/ai/jobs/" + old["id"] + "/retry").json(), {"queued": 1})
        progress = self.client.get("/api/ai/jobs").json()
        self.assertEqual(progress["counts"]["queued"], 1)
        self.assertEqual(progress["counts"]["cancelled"], 2)
        self.assertEqual(self.post("/api/ai/jobs/" + old["id"] + "/retry").json(), {"queued": 0})
        self.assertEqual(self.post("/api/ai/jobs/not-found/retry").status_code, 404)

    def test_late_model_result_cannot_revive_cancelled_job(self):
        ids = self.seed(1)
        self.post("/api/ai/jobs", {"ids": ids})
        entered, release = Event(), Event()
        worker = self.app.state.worker

        def inference(batch):
            # The worker reaches the model through the provider interface (server/enrich).
            entered.set()
            if not release.wait(5):
                raise AssertionError("Controlled inference was not released.")
            result = {"suggested_title": "Synthetic suggestion", "summary": "Synthetic summary.", "topics": ["example"],
                      "content_type": "link", "needs_review": True, "category": "Other", "collection": ""}
            return [AnalysisOutcome(batch[0].key, result=result)], ProviderUsage(1)

        with patch("server.enrich.understanding.OllamaProvider.analyze", autospec=True, side_effect=lambda self, batch: inference(batch)):
            thread = Thread(target=worker.run, daemon=True)
            thread.start()
            try:
                self.assertTrue(entered.wait(5), "The real worker did not claim the queued job.")
                self.assertEqual(self.post("/api/ai/jobs/cancel").json(), {"cancelled": 1})
            finally:
                worker.stopping.set()
                release.set()
                thread.join(5)
            self.assertFalse(thread.is_alive())
        self.assertIsNone(self.client.get("/api/items/" + ids[0]).json()["ai"])
        progress = self.client.get("/api/ai/jobs").json()
        self.assertEqual(progress["counts"]["cancelled"], 1)
        self.assertEqual(progress["counts"]["completed"], 0)


if __name__ == "__main__":
    unittest.main()
