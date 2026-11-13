"""Operator/assistant commands must not mutate or disclose a personal library."""
from contextlib import redirect_stdout
import io
import json
import os
from pathlib import Path
import sqlite3
import stat
import tempfile
import unittest
from unittest.mock import patch

import httpx

from server.bootstrap import setup_configuration
from server.cli import main
from server.config import Config
from server.configuration import read_env_values
from server.diagnostics import diagnose, probe_ollama
from server.storage import Store


class OperatorSetupTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.config_file = self.root / ".env"
        self.data = self.root / "private-library"
        self.password = "synthetic-owner-secret-do-not-print"
        self.values = {
            "LA_ADMIN_PASSWORD": self.password,
            "LA_DATA_DIR": str(self.data),
            "LA_PUBLIC_URL": "http://localhost:8787",
            "LA_OLLAMA_URL": "",
            "LA_OLLAMA_MODEL": "",
        }
        self.metadata = patch("server.diagnostics.metadata.version", return_value="1.0.0")
        self.metadata.start()
        self.addCleanup(self.metadata.stop)

    def write_config(self, values=None):
        values = self.values if values is None else values
        self.config_file.write_text("".join(f"{key}={value}\n" for key, value in values.items()))
        self.config_file.chmod(0o600)

    def report(self, **kwargs):
        return diagnose(env_file=self.config_file, environment={}, **kwargs)

    def row(self, report, identifier):
        return next(row for row in report["checks"] if row["id"] == identifier)

    def snapshot(self):
        return {str(p.relative_to(self.root)): (p.stat().st_mode, p.stat().st_mtime_ns, p.read_bytes() if p.is_file() else None)
                for p in self.root.rglob("*") if not p.is_symlink()}

    def test_dry_run_creates_nothing_and_does_not_disclose_inputs(self):
        result = setup_configuration(self.config_file, data_dir=str(self.data))
        self.assertEqual(result["status"], "planned")
        self.assertEqual(list(self.root.iterdir()), [])
        self.assertNotIn(str(self.root), json.dumps(result))

    def test_apply_is_private_and_repeat_preserves_credentials_and_data(self):
        first = setup_configuration(self.config_file, data_dir=str(self.data), apply=True)
        self.assertEqual(first["status"], "created")
        saved = self.config_file.read_bytes()
        generated = read_env_values(self.config_file)["LA_ADMIN_PASSWORD"]
        self.assertGreaterEqual(len(generated), 32)
        self.assertNotIn(generated, json.dumps(first))
        self.assertEqual(stat.S_IMODE(self.config_file.stat().st_mode), 0o600)
        self.assertFalse(self.data.exists())
        self.data.mkdir()
        note = self.data / "owner-note"
        note.write_text("Preserve this existing personal file.")
        before = self.snapshot()
        second = setup_configuration(self.config_file, data_dir=str(self.root / "different"), apply=True)
        self.assertEqual(second["status"], "unchanged")
        self.assertEqual(self.config_file.read_bytes(), saved)
        self.assertEqual(self.snapshot(), before)

    def test_fresh_setup_refuses_existing_library_and_symlink_configuration(self):
        self.data.mkdir()
        (self.data / "library.sqlite3").write_bytes(b"SQLite format 3\0")
        result = setup_configuration(self.config_file, data_dir=str(self.data), apply=True)
        self.assertEqual(result["code"], "existing_library")
        self.assertFalse(self.config_file.exists())
        real = self.root / "original"
        real.write_text("private unchanged")
        self.config_file.symlink_to(real)
        result = setup_configuration(self.config_file, data_dir=str(self.root / "new"), apply=True)
        self.assertEqual(result["code"], "configuration_not_regular")
        self.assertEqual(real.read_text(), "private unchanged")

    def test_setup_publishes_only_complete_configuration_and_leaves_no_partial_file(self):
        with patch("server.bootstrap.os.fsync", side_effect=OSError("synthetic disk failure")):
            result = setup_configuration(self.config_file, data_dir=str(self.data), apply=True)
        self.assertEqual(result["code"], "configuration_write_failed")
        self.assertFalse(self.config_file.exists())
        self.assertEqual(list(self.root.iterdir()), [])
        original_link = os.link
        def racing_link(source, destination, **kwargs):
            self.config_file.write_text("LA_ADMIN_PASSWORD=another-process-private-value\n")
            return original_link(source, destination, **kwargs)
        with patch("server.bootstrap.os.link", side_effect=racing_link):
            result = setup_configuration(self.config_file, data_dir=str(self.data), apply=True)
        self.assertEqual(result["status"], "unchanged")
        self.assertIn("another-process-private-value", self.config_file.read_text())
        self.assertNotIn("another-process-private-value", json.dumps(result))
        self.assertEqual(list(self.root.iterdir()), [self.config_file])

    def test_setup_rejects_public_configuration_and_newline_injection(self):
        public_config = Path(__file__).resolve().parents[1] / "web" / "operator-private.env"
        result = setup_configuration(public_config, data_dir=str(self.data))
        self.assertEqual(result["code"], "configuration_in_public_directory")
        result = setup_configuration(self.config_file, data_dir=str(self.data) + "\nLA_PUBLIC_URL=https://unexpected.invalid", apply=True)
        self.assertEqual(result["status"], "blocked")
        self.assertFalse(self.config_file.exists())
        for separator in ("\u2028", "\u2029", "\u0085", "\v", "\f"):
            with self.subTest(separator=repr(separator)):
                result = setup_configuration(self.config_file, data_dir=str(self.data) + separator + "LA_OLLAMA_URL=https://unexpected.invalid", apply=True)
                self.assertEqual(result["status"], "blocked")
                self.assertFalse(self.config_file.exists())

    def test_configuration_reader_is_bounded_nonexecuting_and_first_value_wins(self):
        self.config_file.write_text("LA_DATA_DIR=first\nLA_DATA_DIR=second\nLA_ADMIN_PASSWORD='$(not-a-command)'\nIGNORED=secret\n")
        values = read_env_values(self.config_file)
        self.assertEqual(values["LA_DATA_DIR"], "first")
        self.assertEqual(values["LA_ADMIN_PASSWORD"], "$(not-a-command)")
        self.assertNotIn("IGNORED", values)
        self.config_file.write_bytes(b"x" * (64 * 1024 + 1))
        with self.assertRaises(ValueError):
            read_env_values(self.config_file)
        self.config_file.unlink()
        real = self.root / "private"
        real.write_text("LA_ADMIN_PASSWORD=do-not-follow")
        self.config_file.symlink_to(real)
        with self.assertRaises(ValueError):
            read_env_values(self.config_file)

    def test_doctor_on_fresh_install_never_initializes_library_or_requests_network(self):
        self.write_config()
        before = self.snapshot()
        with patch("socket.create_connection", side_effect=AssertionError("Network was not requested")), patch("server.storage.Store", side_effect=AssertionError("Store must not be opened")), patch("httpx.Client", side_effect=AssertionError("No model request was requested")):
            result = self.report()
        self.assertEqual(result["exit_code"], 0)
        self.assertEqual(self.row(result, "database")["code"], "library_not_initialized")
        self.assertEqual(self.row(result, "local_ai")["code"], "ai_disabled")
        self.assertEqual(self.snapshot(), before)
        self.assertFalse(self.data.exists())
        serialized = json.dumps(result)
        for private in (self.password, str(self.root), self.values["LA_PUBLIC_URL"]):
            self.assertNotIn(private, serialized)

    def test_doctor_preserves_active_wal_and_running_jobs_without_reading_post_text(self):
        self.write_config()
        store = Store(Config.from_env(self.values))
        with store.transaction() as conn:
            item = store.apply_item(conn, {"url": "https://example.com/synthetic-private", "title": "Never disclose this saved text"})
        # Use the actual schema but a synthetic job. Keep a WAL connection open
        # to catch diagnostics that initialize Store or checkpoint the database.
        conn = sqlite3.connect(store.path)
        self.addCleanup(conn.close)
        conn.execute("PRAGMA journal_mode=WAL")
        item_id = conn.execute("SELECT id FROM items").fetchone()[0]
        conn.execute("INSERT INTO ai_jobs VALUES(?,?,?,?,?,?,?)", ("synthetic-job", item_id, "synthetic-hash", "running", "", "now", "now"))
        conn.commit()
        before = self.snapshot()
        with patch("server.storage.Store", side_effect=AssertionError("No Store initialization")), patch("sqlite3.connect", side_effect=AssertionError("No SQLite connection")):
            result = self.report()
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(conn.execute("SELECT status FROM ai_jobs").fetchone()[0], "running")
        self.assertEqual(self.row(result, "database")["code"], "sqlite_header_present")
        self.assertNotIn("Never disclose", json.dumps(result))

    def test_environment_precedence_is_reported_without_changing_environment(self):
        self.write_config()
        alternate = self.root / "other-library"
        environment = {"LA_DATA_DIR": str(alternate), "LA_ADMIN_PASSWORD": "another-private-synthetic-password"}
        before = dict(environment)
        result = diagnose(env_file=self.config_file, environment=environment)
        self.assertEqual(environment, before)
        sources = self.row(result, "configuration")["details"]["sources"]
        self.assertEqual(sources["LA_DATA_DIR"], "environment")
        self.assertEqual(sources["LA_PUBLIC_URL"], "file")
        self.assertNotIn(str(alternate), json.dumps(result))
        self.assertFalse(alternate.exists())

    def test_missing_password_and_corrupt_database_are_actionable_without_mutation(self):
        self.write_config({**self.values, "LA_ADMIN_PASSWORD": ""})
        result = self.report()
        self.assertEqual(self.row(result, "owner_access")["code"], "owner_password_missing")
        self.assertEqual(result["exit_code"], 1)
        self.data.mkdir()
        database = self.data / "library.sqlite3"
        database.write_bytes(b"private malformed database contents")
        before = self.snapshot()
        result = self.report()
        self.assertEqual(self.row(result, "database")["code"], "database_header_unrecognized")
        self.assertEqual(self.snapshot(), before)
        self.assertNotIn("malformed database contents", json.dumps(result))

    def test_doctor_reuses_startup_password_validation(self):
        for password in ("replace-with-a-unique-password-of-at-least-12-characters", "short", "x" * 1025):
            with self.subTest(length=len(password)):
                self.write_config({**self.values, "LA_ADMIN_PASSWORD": password})
                result = self.report()
                self.assertEqual(self.row(result, "owner_access")["code"], "owner_password_invalid")
                self.assertEqual(result["exit_code"], 1)
                self.assertNotIn(password, json.dumps(result))

    def test_invalid_config_is_redacted_and_no_model_probe_occurs(self):
        self.write_config({**self.values, "LA_OLLAMA_URL": "https://private-secret@example.invalid", "LA_OLLAMA_MODEL": "private-model"})
        with patch("httpx.Client", side_effect=AssertionError("Invalid config must not be probed")):
            result = self.report(check_ai=True)
        self.assertEqual(self.row(result, "configuration")["code"], "configuration_invalid")
        self.assertNotIn("private-secret", json.dumps(result))
        self.assertNotIn("private-model", json.dumps(result))

    def test_config_rejects_invalid_ports_control_characters_and_oversized_model(self):
        cases = [
            {"public_url": "http://localhost:bad"},
            {"public_url": "http://local\nhost:8787"},
            {"ollama_url": "http://localhost:99999", "ollama_model": "model"},
            {"ollama_url": "http://localhost:11434", "ollama_model": "x" * 201},
        ]
        for values in cases:
            with self.subTest(values=tuple(values)):
                with self.assertRaises(ValueError):
                    Config(data_dir=self.data, **values).validate()

    def model_config(self):
        return Config(data_dir=self.data, ollama_url="http://localhost:11434", ollama_model="synthetic-private-model")

    def client(self, handler):
        client = httpx.Client(transport=httpx.MockTransport(handler), follow_redirects=False)
        self.addCleanup(client.close)
        return client

    def test_model_probe_checks_inventory_without_inference_or_private_output(self):
        calls = []
        def handler(request):
            calls.append((request.method, request.url.path))
            self.assertEqual(request.headers["accept-encoding"], "identity")
            if request.url.path == "/api/version":
                return httpx.Response(200, json={"version": "0.12.3"})
            return httpx.Response(200, json={"models": [{"name": "synthetic-private-model:latest", "size": 1234}]})
        result = probe_ollama(self.model_config(), client=self.client(handler))
        self.assertEqual(result["code"], "model_available")
        self.assertEqual(calls, [("GET", "/api/version"), ("GET", "/api/tags")])
        self.assertFalse(result["details"]["inference_tested"])
        self.assertFalse(result["details"]["local_processing_verified"])
        self.assertNotIn("synthetic-private-model", json.dumps(result))

    def test_missing_model_remote_metadata_and_invalid_inventory_are_distinct(self):
        for models, expected in [([], "model_missing"), ([{"name": "synthetic-private-model", "remote_host": "https://private-model-host.invalid"}], "remote_model_selected"), ("private-malformed-response", "invalid_response")]:
            with self.subTest(expected=expected):
                def handler(request):
                    return httpx.Response(200, json={"version": "0.12.3"} if request.url.path == "/api/version" else {"models": models})
                result = probe_ollama(self.model_config(), client=self.client(handler))
                self.assertEqual(result["code"], expected)
                self.assertNotIn("private-model-host", json.dumps(result))
                self.assertNotIn("private-malformed-response", json.dumps(result))

    def test_model_probe_bounds_responses_refuses_redirects_and_redacts_errors(self):
        handlers = [
            (lambda request: httpx.Response(302, headers={"location": "https://unexpected.invalid"}), "service_rejected"),
            (lambda request: httpx.Response(200, content=b"x" * (16 * 1024 + 1)), "response_limit"),
            (lambda request: httpx.Response(401, text="private-error-body"), "service_rejected"),
            (lambda request: httpx.Response(200, content=b"[" * 4000 + b"]" * 4000), "invalid_response"),
        ]
        for handler, expected in handlers:
            with self.subTest(expected=expected):
                result = probe_ollama(self.model_config(), client=self.client(handler))
                self.assertEqual(result["code"], expected)
                self.assertNotIn("private-error-body", json.dumps(result))
        def timeout(request):
            raise httpx.ReadTimeout("private endpoint and credentials", request=request)
        result = probe_ollama(self.model_config(), client=self.client(timeout))
        self.assertEqual(result["code"], "model_service_timeout")
        self.assertNotIn("credentials", json.dumps(result))

    def test_model_probe_rejects_compression_without_reading_body(self):
        class NeverRead(httpx.SyncByteStream):
            def __iter__(self):
                raise AssertionError("Encoded health body must not be read or decompressed")
                yield b""
        client = self.client(lambda request: httpx.Response(200, headers={"content-encoding": "gzip"}, stream=NeverRead()))
        result = probe_ollama(self.model_config(), client=client)
        self.assertEqual(result["code"], "encoded_response")

    def test_cli_json_setup_and_doctor_never_print_password(self):
        stream = io.StringIO()
        with redirect_stdout(stream), patch.dict(os.environ, {}, clear=True):
            code = main(["setup", "--apply", "--config", str(self.config_file), "--data-dir", str(self.data), "--json"])
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(stream.getvalue())["status"], "created")
        secret = read_env_values(self.config_file)["LA_ADMIN_PASSWORD"]
        self.assertNotIn(secret, stream.getvalue())
        stream = io.StringIO()
        with redirect_stdout(stream), patch.dict(os.environ, {}, clear=True):
            code = main(["doctor", "--env-file", str(self.config_file), "--json"])
        self.assertEqual(code, 0)
        self.assertTrue(json.loads(stream.getvalue())["read_only"])
        self.assertNotIn(secret, stream.getvalue())
        self.assertFalse(self.data.exists())


if __name__ == "__main__":
    unittest.main()
