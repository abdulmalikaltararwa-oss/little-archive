"""Regression checks for evidence freshness and disk-backed backup staging."""
import copy
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Thread
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from server.backups import create_backup
from server.config import Config
from server.jobs import ClassificationWorker
from server.security import hash_password, RateLimiter
from server.storage import Store


class ClassificationFingerprintTests(unittest.TestCase):
    def setUp(self):
        self.worker = ClassificationWorker(None, SimpleNamespace(
            ollama_model="synthetic-local-model",
            ollama_url="http://127.0.0.1:11434",
        ))
        self.item = {
            "title": "An example title", "creator": "Example creator",
            "caption": "Available source text", "thumbnail_alt": "Cover text",
            "notes": "A personal note", "evidence": [{"kind": "caption", "text": "Source evidence"}],
            "collections": [{"name": "Original collection"}],
        }

    def test_every_consumed_text_field_and_collection_label_invalidates_suggestions(self):
        original = self.worker.fingerprint(self.item)
        for key in ("title", "creator", "caption", "thumbnail_alt", "notes"):
            with self.subTest(field=key):
                changed = copy.deepcopy(self.item)
                changed[key] += " changed"
                self.assertNotEqual(original, self.worker.fingerprint(changed))
        changed = copy.deepcopy(self.item)
        changed["evidence"][0]["text"] += " changed"
        self.assertNotEqual(original, self.worker.fingerprint(changed))
        changed = copy.deepcopy(self.item)
        changed["collections"][0]["name"] += " changed"
        self.assertNotEqual(original, self.worker.fingerprint(changed))

    def test_unconsumed_workflow_flags_do_not_invalidate_model_input(self):
        changed = {**self.item, "favorite": True, "status": "done"}
        self.assertEqual(self.worker.fingerprint(self.item), self.worker.fingerprint(changed))

    def test_model_service_changes_invalidate_cached_suggestions(self):
        original = self.worker.fingerprint(self.item)
        other = ClassificationWorker(None, SimpleNamespace(
            ollama_model="synthetic-local-model", ollama_url="http://different-private-service:11434",
        ))
        self.assertNotEqual(original, other.fingerprint(self.item))


class BackupStagingTests(unittest.TestCase):
    def test_snapshot_uses_private_library_disk_and_cleanup_removes_temporary_bytes(self):
        with TemporaryDirectory() as folder:
            root = Path(folder)
            store = Store(Config(data_dir=root, admin_password="synthetic-test-password"))
            temporary, archive = create_backup(store)
            temporary_path = Path(temporary.name)
            try:
                self.assertEqual(temporary_path.parent, root / ".backup-work")
                self.assertEqual((root / ".backup-work").stat().st_mode & 0o777, 0o700)
                self.assertTrue(archive.is_file())
                self.assertTrue((temporary_path / "library.sqlite3").is_file())
            finally:
                temporary.cleanup()
            self.assertFalse(temporary_path.exists())
            self.assertEqual(list((root / ".backup-work").iterdir()), [])


class DeploymentHardeningTests(unittest.TestCase):
    def test_shipped_example_password_cannot_initialize_an_owner(self):
        example = Path(__file__).resolve().parents[1] / ".env.example"
        password = next(line.split("=", 1)[1] for line in example.read_text().splitlines()
                        if line.startswith("LA_ADMIN_PASSWORD="))
        with self.assertRaises(ValueError):
            hash_password(password)

    def test_peer_capacity_recovers_after_old_attempts_expire(self):
        limiter = RateLimiter()
        with patch("server.security.time.monotonic", return_value=0) as clock:
            for i in range(10000):
                self.assertTrue(limiter.consume(f"historical-peer-{i}"))
            self.assertFalse(limiter.consume("new-peer"), "unexpired capacity remains bounded")
            clock.return_value = 899
            self.assertTrue(limiter.consume("historical-peer-0"))
            clock.return_value = 901
            self.assertTrue(limiter.consume("new-peer"), "expired peers must not permanently lock out new clients")
            self.assertEqual(len(limiter._attempts), 2, "retain the recently active peer while expiring old buckets")

    def test_testserver_http_exception_is_test_only(self):
        with TemporaryDirectory() as folder:
            with self.assertRaises(ValueError):
                Config(data_dir=Path(folder), public_url="http://testserver", testing=False).validate()
            Config(data_dir=Path(folder), public_url="http://testserver", testing=True).validate()
            Config(data_dir=Path(folder), public_url="http://localhost:8787", testing=False).validate()

    def test_data_directory_cannot_be_served_as_public_static_files(self):
        web = Path(__file__).resolve().parents[1] / "web"
        for path in (web, web / "data"):
            with self.subTest(path=path), self.assertRaises(ValueError):
                Config(data_dir=path).validate()
        with TemporaryDirectory() as folder:
            alias = Path(folder) / "public-web-alias"
            alias.symlink_to(web, target_is_directory=True)
            with self.assertRaises(ValueError):
                Config(data_dir=alias / "data").validate()

    def test_private_model_request_ignores_ambient_proxy_configuration(self):
        from server.classifier import classify_item

        class SyntheticModel(BaseHTTPRequestHandler):
            def do_POST(self):
                self.rfile.read(int(self.headers.get("Content-Length", 0)))
                content = {"suggested_title": "Synthetic title", "summary": "Caption describes a synthetic example.",
                           "topics": ["example"], "content_type": "post", "needs_review": True}
                body = json.dumps({"done": True, "done_reason": "stop", "message": {"content": json.dumps(content)}}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):
                pass

        service = ThreadingHTTPServer(("127.0.0.1", 0), SyntheticModel)
        thread = Thread(target=service.serve_forever, daemon=True)
        thread.start()
        proxies = {key: "http://127.0.0.1:1" for key in
                   ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy")}
        proxies.update(NO_PROXY="", no_proxy="")
        try:
            with patch.dict(os.environ, proxies):
                result = classify_item({"caption": "A synthetic example"},
                                       f"http://127.0.0.1:{service.server_port}", "synthetic-local-model")
            self.assertEqual(result["suggested_title"], "Synthetic title")
        finally:
            service.shutdown()
            service.server_close()
            thread.join(timeout=2)


if __name__ == "__main__":
    unittest.main()
