"""Versioned import compatibility using a real temporary application/database.

Fixtures are synthetic. These tests do not call a platform or model service.
"""
import json
from pathlib import Path
import secrets
import tempfile
import unittest
from uuid import uuid4

from fastapi.testclient import TestClient

from server.app import create_app
from server.config import Config


class ExtensionProtocolTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="little-archive-protocol-")
        self.addCleanup(self.temporary.cleanup)
        password = secrets.token_urlsafe(24)
        self.app = create_app(Config(data_dir=Path(self.temporary.name) / "data", admin_password=password, public_url="http://testserver", testing=True))
        self.client = TestClient(self.app)
        self.client.__enter__()
        self.addCleanup(self.client.__exit__, None, None, None)
        login = self.client.post("/api/auth/login", json={"password": password}, headers={"Origin": "http://testserver"})
        self.assertEqual(login.status_code, 200)
        self.owner_headers = {"Origin": "http://testserver", "X-CSRF-Token": login.json()["csrf_token"]}
        token = self.client.post("/api/extension/tokens", json={"name": "Synthetic protocol test"}, headers=self.owner_headers)
        self.assertEqual(token.status_code, 200)
        self.auth = {"Authorization": "Bearer " + token.json()["token"]}

    def start(self, protocol=None):
        headers = dict(self.auth)
        if protocol is not None:
            headers["X-Little-Archive-Protocol"] = protocol
        response = self.client.post("/api/extension/imports", json={"platform": "instagram", "source_account": "protocol_fixture", "scope": "Exact source name · 🌿"}, headers=headers)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["protocol_version"], 1)
        return response.json()["run_id"]

    @staticmethod
    def body():
        return {
            "batch_id": str(uuid4()), "sequence": 0,
            "items": [{"url": "https://www.instagram.com/p/PROTOCOL_SYNTHETIC/", "caption": "Synthetic caption",
                       "collections": [{"source_key": "saved:1234567890123456", "name": "Exact source name · 🌿"}]}],
        }

    def snapshot(self):
        with self.app.state.store.transaction() as connection:
            return {
                "runs": [dict(row) for row in connection.execute("SELECT * FROM import_runs ORDER BY id")],
                "batches": [dict(row) for row in connection.execute("SELECT * FROM batches ORDER BY batch_id")],
                "items": [dict(row) for row in connection.execute("SELECT * FROM items ORDER BY id")],
            }

    def test_status_advertises_v1_capabilities_and_limits_to_import_tokens_only(self):
        self.assertEqual(self.client.get("/api/extension/status").status_code, 401)
        response = self.client.get("/api/extension/status", headers=self.auth)
        self.assertEqual(response.status_code, 200)
        status = response.json()
        self.assertTrue(status["ok"])
        self.assertTrue(status["instance_id"])
        self.assertEqual(status["extension_protocol"], {
            "name": "little-archive.extension",
            "versions": {"1": {
                "capabilities": ["current_view_imports", "idempotent_batches", "exact_batch_finish", "source_collection_memberships", "partial_coverage"],
                "limits": {"max_batch_items": 50, "max_batch_bytes": 262144},
            }},
        })

    def test_headerless_run_can_retry_unchanged_payload_with_v1_and_finish(self):
        run = self.start()
        payload = json.dumps(self.body(), ensure_ascii=False, separators=(",", ":")).encode()
        legacy_headers = {**self.auth, "Content-Type": "application/json"}
        negotiated_headers = {**legacy_headers, "X-Little-Archive-Protocol": "1"}
        endpoint = f"/api/extension/imports/{run}/batches"
        first = self.client.post(endpoint, content=payload, headers=legacy_headers)
        self.assertEqual(first.status_code, 200, first.text)
        self.assertFalse(first.json()["replayed"])
        committed = self.snapshot()
        replay = self.client.post(endpoint, content=payload, headers=negotiated_headers)
        self.assertEqual(replay.status_code, 200, replay.text)
        self.assertTrue(replay.json()["replayed"])
        self.assertEqual(self.snapshot(), committed)
        finish = self.client.post(f"/api/extension/imports/{run}/finish", json={"expected_batches": 1, "coverage": "partial"}, headers=negotiated_headers)
        self.assertEqual(finish.status_code, 200, finish.text)
        self.assertEqual(finish.json()["created"], 1)
        # Original clients may also retry an acknowledged payload after finish.
        final_replay = self.client.post(endpoint, content=payload, headers=legacy_headers)
        self.assertEqual(final_replay.status_code, 200)
        self.assertTrue(final_replay.json()["replayed"])
        items = self.client.get("/api/items").json()["items"]
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["collections"][0]["name"], "Exact source name · 🌿")

    def test_unknown_explicit_protocol_rejects_every_import_write_without_mutation(self):
        run = self.start("1")
        before = self.snapshot()
        requests = [
            ("/api/extension/imports", {"platform": "instagram", "source_account": "protocol_fixture", "scope": "All posts"}),
            (f"/api/extension/imports/{run}/batches", self.body()),
            (f"/api/extension/imports/{run}/finish", {"expected_batches": 0, "coverage": "partial"}),
        ]
        for value in ["2", "0", "01", "", "1, 2"]:
            for endpoint, payload in requests:
                with self.subTest(protocol=value, endpoint=endpoint.rsplit("/", 1)[-1]):
                    response = self.client.post(endpoint, json=payload, headers={**self.auth, "X-Little-Archive-Protocol": value})
                    self.assertEqual(response.status_code, 409)
                    self.assertIn("keep pending batches unchanged", response.json()["detail"])
                    self.assertEqual(self.snapshot(), before)
        duplicate = list(self.auth.items()) + [("X-Little-Archive-Protocol", "1"), ("X-Little-Archive-Protocol", "1")]
        response = self.client.post(requests[1][0], json=requests[1][1], headers=duplicate)
        self.assertEqual(response.status_code, 409)
        self.assertEqual(self.snapshot(), before)

    def test_v1_preserves_conflicts_and_requires_the_exact_committed_sequence(self):
        run = self.start("1")
        headers = {**self.auth, "X-Little-Archive-Protocol": "1"}
        payload = self.body()
        endpoint = f"/api/extension/imports/{run}/batches"
        self.assertEqual(self.client.post(endpoint, json=payload, headers=headers).status_code, 200)
        before = self.snapshot()
        changed = {**payload, "items": [{"url": "https://www.instagram.com/p/DIFFERENT_SYNTHETIC/"}]}
        self.assertEqual(self.client.post(endpoint, json=changed, headers=headers).status_code, 409)
        self.assertEqual(self.snapshot(), before)
        wrong_count = self.client.post(f"/api/extension/imports/{run}/finish", json={"expected_batches": 2, "coverage": "enumeration_exhausted"}, headers=headers)
        self.assertEqual(wrong_count.status_code, 409)
        self.assertEqual(self.snapshot(), before)

    def test_protocol_header_cors_is_limited_to_extension_origin_and_path(self):
        origin = "chrome-extension://" + "a" * 32
        preflight = {"Origin": origin, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization,content-type,x-little-archive-protocol"}
        response = self.client.options("/api/extension/imports", headers=preflight)
        self.assertEqual(response.status_code, 204)
        self.assertEqual(response.headers["access-control-allow-origin"], origin)
        self.assertIn("x-little-archive-protocol", response.headers["access-control-allow-headers"].lower())
        self.assertNotIn("access-control-allow-credentials", response.headers)
        for path, headers in [("/api/items", preflight), ("/api/extension/imports", {**preflight, "Origin": "https://unrelated.example"})]:
            response = self.client.options(path, headers=headers)
            self.assertNotIn("access-control-allow-origin", response.headers)
            self.assertNotIn("access-control-allow-credentials", response.headers)


if __name__ == "__main__":
    unittest.main()
