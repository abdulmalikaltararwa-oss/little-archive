"""Contributor setup must never adopt a personal instance or print credentials."""
from contextlib import redirect_stderr, redirect_stdout
import io
import json
import os
from pathlib import Path
import shutil
import socket
import stat
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

import httpx

from scripts import dev
from scripts import dev_workspace as workspace
from server.storage import Store


REPOSITORY = Path(__file__).resolve().parent.parent


@unittest.skipUnless(os.name == "posix", "Contributor launcher currently supports macOS and Linux.")
class DevelopmentWorkspaceTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="little-archive-contributor-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.personal = self.root / "personal-library"
        self.personal.mkdir()
        (self.personal / "keep.txt").write_text("Private-library sentinel, synthetic for this test.")
        self.env_file = self.root / ".env"
        self.env_file.write_text("LA_DATA_DIR=./personal-library\nLA_ADMIN_PASSWORD=personal-fixture-password\nLA_OLLAMA_URL=http://127.0.0.1:1\nLA_OLLAMA_MODEL=personal-model\n")
        self.personal_bytes = (self.personal / "keep.txt").read_bytes()
        self.env_bytes = self.env_file.read_bytes()

    def dirty_environment(self):
        return {
            "LA_DATA_DIR": str(self.personal), "LA_ADMIN_PASSWORD": "production-fixture-password",
            "LA_PUBLIC_URL": "https://production.example", "LA_OLLAMA_URL": "http://127.0.0.1:1",
            "LA_OLLAMA_MODEL": "production-fixture-model", "LA_FUTURE_SETTING": "must-not-reach-app",
            "PORT": "not-a-port",
        }

    def assert_personal_untouched(self):
        self.assertEqual(sorted(p.name for p in self.personal.iterdir()), ["keep.txt"])
        self.assertTrue((self.personal / "keep.txt").read_bytes() == self.personal_bytes, "Personal sentinel changed.")
        self.assertTrue(self.env_file.read_bytes() == self.env_bytes, "Personal .env changed.")

    def run_cli(self, args):
        output = io.StringIO()
        with redirect_stdout(output), redirect_stderr(output):
            result = dev.main(args, repo_root=self.root)
        return result, output.getvalue()

    def test_check_is_read_only_and_redacted_before_and_after_setup(self):
        with patch.dict(os.environ, self.dirty_environment()):
            result, output = self.run_cli(["--check", "--json"])
        self.assertEqual(result, 0)
        self.assertEqual(json.loads(output)["status"], "missing")
        self.assertFalse((self.root / "work").exists())

        prepared = workspace.prepare_workspace(self.root)
        password = prepared.paths.password.read_text().strip()
        before = {p.relative_to(prepared.paths.root): (p.read_bytes(), p.stat().st_mtime_ns) for p in prepared.paths.root.iterdir() if p.is_file()}
        result, output = self.run_cli(["--check", "--json"])
        after = {p.relative_to(prepared.paths.root): (p.read_bytes(), p.stat().st_mtime_ns) for p in prepared.paths.root.iterdir() if p.is_file()}
        self.assertEqual(result, 0)
        self.assertEqual(json.loads(output)["status"], "ready")
        self.assertTrue(before == after, "Read-only inspection changed the workspace.")
        self.assertTrue(password not in output, "Status output disclosed a credential.")
        self.assertNotIn(str(self.root), output)
        self.assert_personal_untouched()

    def test_prepare_generates_private_credentials_and_preserves_existing_files(self):
        with patch.dict(os.environ, self.dirty_environment()):
            result, output = self.run_cli(["--prepare"])
        self.assertEqual(result, 0)
        prepared = workspace.prepare_workspace(self.root)
        password = prepared.paths.password.read_text().strip()
        self.assertGreaterEqual(len(password), 32)
        self.assertTrue(password not in output, "Prepare output disclosed a credential.")
        self.assertIn("work/contributor-dev/owner-password.txt", output)
        self.assertEqual(stat.S_IMODE(prepared.paths.root.stat().st_mode), 0o700)
        for p in (prepared.paths.config, prepared.paths.password, prepared.paths.lock):
            self.assertEqual(stat.S_IMODE(p.stat().st_mode), 0o600)
        (prepared.paths.data / "keep.txt").write_text("Keep my development edits.")
        config_bytes = prepared.paths.config.read_bytes()
        credential_bytes = prepared.paths.password.read_bytes()
        repeated = workspace.prepare_workspace(self.root)
        self.assertEqual(prepared.metadata["workspace_id"], repeated.metadata["workspace_id"])
        self.assertTrue(repeated.paths.config.read_bytes() == config_bytes, "Repeated setup changed configuration.")
        self.assertTrue(repeated.paths.password.read_bytes() == credential_bytes, "Repeated setup changed credentials.")
        self.assertEqual((prepared.paths.data / "keep.txt").read_text(), "Keep my development edits.")
        self.assert_personal_untouched()

    def test_launcher_passes_explicit_config_and_scrubs_all_inherited_app_settings(self):
        seen = {}

        def capture(app, **options):
            seen.update(config=app.state.config, options=options)
            self.assertFalse(any(key.startswith("LA_") for key in os.environ))

        with patch.dict(os.environ, self.dirty_environment()), patch("server.config.Config.from_env", side_effect=AssertionError("Ambient configuration must not be read")), patch("server.cli.load_env", side_effect=AssertionError("Personal .env must not be read")), patch("uvicorn.run", side_effect=capture):
            result, output = self.run_cli(["--strictPort"])
            self.assertEqual(os.environ["LA_FUTURE_SETTING"], "must-not-reach-app")
        self.assertEqual(result, 0)
        config = seen["config"]
        self.assertEqual(config.data_dir, self.root / "work" / "contributor-dev" / "data")
        self.assertEqual(config.public_url, "http://127.0.0.1:8788")
        self.assertEqual(config.ollama_url, "")
        self.assertEqual(config.ollama_model, "")
        self.assertEqual(seen["options"]["host"], "127.0.0.1")
        self.assertEqual(seen["options"]["port"], 8788)
        self.assertFalse(seen["options"]["access_log"])
        self.assertTrue(config.admin_password not in output, "Launcher output disclosed a credential.")
        self.assert_personal_untouched()

    def test_seed_is_optional_and_once_only_even_after_editing_or_deleting_a_record(self):
        prepared = workspace.prepare_workspace(self.root)
        self.assertFalse((prepared.paths.data / "library.sqlite3").exists())
        self.assertFalse(workspace.inspect_workspace(self.root)["seeded"])
        self.assertEqual(workspace.seed_workspace(prepared), 15)
        store = Store(workspace.server_config(prepared))
        with store.transaction() as connection:
            rows = connection.execute("SELECT id FROM items ORDER BY id LIMIT 2").fetchall()
            connection.execute("UPDATE items SET title=?,notes=?,manual_title=1 WHERE id=?", ("My corrected synthetic title", "Keep this note", rows[0]["id"]))
            connection.execute("DELETE FROM items WHERE id=?", (rows[1]["id"],))
        repeated = workspace.prepare_workspace(self.root)
        self.assertEqual(workspace.seed_workspace(repeated), 0)
        with store.transaction() as connection:
            self.assertEqual(connection.execute("SELECT count(*) FROM items").fetchone()[0], 14)
            edited = connection.execute("SELECT title,notes FROM items WHERE id=?", (rows[0]["id"],)).fetchone()
            self.assertEqual(tuple(edited), ("My corrected synthetic title", "Keep this note"))
        self.assertTrue(workspace.inspect_workspace(self.root)["seeded"])
        self.assert_personal_untouched()

    def test_cleanup_refuses_in_use_workspace_then_removes_only_owned_directory(self):
        prepared = workspace.prepare_workspace(self.root)
        sibling = prepared.paths.root.parent / "other-project.txt"
        sibling.write_text("Keep another project's work.")
        with workspace.workspace_lock(prepared):
            with self.assertRaisesRegex(workspace.WorkspaceError, "in use"):
                workspace.cleanup_workspace(self.root)
            with self.assertRaisesRegex(workspace.WorkspaceError, "in use"):
                workspace.seed_workspace(prepared)
        workspace.cleanup_workspace(self.root)
        self.assertFalse(prepared.paths.root.exists())
        self.assertEqual(sibling.read_text(), "Keep another project's work.")
        self.assert_personal_untouched()

    def test_unowned_existing_directory_is_not_adopted_or_deleted(self):
        target = self.root / workspace.WORKSPACE_RELATIVE
        target.mkdir(parents=True)
        sentinel = target / "personal.txt"
        sentinel.write_text("Do not adopt this directory.")
        for operation in (workspace.prepare_workspace, workspace.cleanup_workspace):
            with self.subTest(operation=operation.__name__), self.assertRaises(workspace.WorkspaceError):
                operation(self.root)
            self.assertEqual(sentinel.read_text(), "Do not adopt this directory.")
        self.assertEqual(list(target.iterdir()), [sentinel])

    def test_foreign_checkout_marker_cannot_authorize_cleanup(self):
        prepared = workspace.prepare_workspace(self.root)
        other = self.root / "another-checkout"
        other.mkdir()
        copied = other / workspace.WORKSPACE_RELATIVE
        copied.parent.mkdir()
        shutil.copytree(prepared.paths.root, copied)
        for operation in (workspace.prepare_workspace, workspace.cleanup_workspace):
            with self.subTest(operation=operation.__name__), self.assertRaisesRegex(workspace.WorkspaceError, "this checkout"):
                operation(other)
        self.assertTrue(copied.exists())
        self.assertTrue(prepared.paths.root.exists())

    def test_symlinked_parent_or_workspace_never_follows_personal_directory(self):
        work = self.root / "work"
        work.symlink_to(self.personal, target_is_directory=True)
        with self.assertRaises(workspace.WorkspaceError):
            workspace.prepare_workspace(self.root)
        self.assertEqual(workspace.inspect_workspace(self.root)["status"], "invalid")
        work.unlink()
        work.mkdir()
        target = work / "contributor-dev"
        target.symlink_to(self.personal, target_is_directory=True)
        for operation in (workspace.prepare_workspace, workspace.cleanup_workspace):
            with self.subTest(operation=operation.__name__), self.assertRaises(workspace.WorkspaceError):
                operation(self.root)
        self.assert_personal_untouched()

    def test_symlinked_config_password_database_or_nested_asset_blocks_operations(self):
        for name in ("config.json", "owner-password.txt", "data/library.sqlite3", "data/assets/linked"):
            with self.subTest(name=name):
                prepared = workspace.prepare_workspace(self.root)
                target = prepared.paths.root / name
                target.parent.mkdir(exist_ok=True)
                if target.exists():
                    target.unlink()
                target.symlink_to(self.personal / "keep.txt")
                self.assertEqual(workspace.inspect_workspace(self.root)["status"], "invalid")
                with self.assertRaises(workspace.WorkspaceError):
                    workspace.cleanup_workspace(self.root)
                with self.assertRaises(workspace.WorkspaceError):
                    workspace.seed_workspace(prepared)
                self.assert_personal_untouched()
                # Test-owned cleanup, after explicitly removing the hostile link.
                target.unlink()
                shutil.rmtree(prepared.paths.root)

    def test_hardlink_and_permissive_credentials_are_refused(self):
        prepared = workspace.prepare_workspace(self.root)
        linked = prepared.paths.data / "linked.txt"
        os.link(self.personal / "keep.txt", linked)
        with self.assertRaisesRegex(workspace.WorkspaceError, "hard-linked"):
            workspace.cleanup_workspace(self.root)
        linked.unlink()
        prepared.paths.password.chmod(0o644)
        with self.assertRaises(workspace.WorkspaceError):
            workspace.prepare_workspace(self.root)
        with self.assertRaises(workspace.WorkspaceError):
            workspace.cleanup_workspace(self.root)
        self.assert_personal_untouched()

    def test_cleanup_limits_are_checked_before_any_deletion(self):
        prepared = workspace.prepare_workspace(self.root)
        sentinel = prepared.paths.data / "keep.txt"
        sentinel.write_text("Retain on every failed preflight.")
        for limit, value in (("MAX_TREE_ENTRIES", 2), ("MAX_TREE_BYTES", 1), ("MAX_TREE_DEPTH", 0)):
            with self.subTest(limit=limit), patch.object(workspace, limit, value), self.assertRaises(workspace.WorkspaceError):
                workspace.cleanup_workspace(self.root)
            self.assertEqual(sentinel.read_text(), "Retain on every failed preflight.")
            self.assertTrue(prepared.paths.config.exists())
            self.assertTrue(prepared.paths.password.exists())

    def test_invalid_metadata_diagnostics_do_not_echo_private_values(self):
        prepared = workspace.prepare_workspace(self.root)
        secret = prepared.paths.password.read_text().strip()
        prepared.paths.config.write_text(json.dumps({"password": secret, "personal_path": str(self.personal)}))
        result, output = self.run_cli(["--check", "--json"])
        self.assertEqual(result, 1)
        self.assertEqual(json.loads(output)["status"], "invalid")
        self.assertTrue(secret not in output, "Invalid configuration diagnostics disclosed a credential.")
        self.assertNotIn(str(self.personal), output)
        self.assert_personal_untouched()

    def test_deeply_nested_metadata_has_a_fixed_redacted_error(self):
        prepared = workspace.prepare_workspace(self.root)
        secret = prepared.paths.password.read_text().strip()
        nested = '[' * 1500 + json.dumps(secret) + ']' * 1500
        self.assertLess(len(nested.encode()), workspace.CONFIG_LIMIT)
        prepared.paths.config.write_text(nested)
        # The accelerated decoder's nesting threshold varies by Python build.
        # Exercise the actual fixture with the stdlib Python decoder to make the
        # recursion failure deterministic on all supported CI runners.
        decoder = json.JSONDecoder()
        decoder.scan_once = json.scanner.py_make_scanner(decoder)
        with patch.object(json, "_default_decoder", decoder):
            with self.assertRaisesRegex(workspace.WorkspaceError, "Development configuration is invalid"):
                workspace.prepare_workspace(self.root)
            result, output = self.run_cli(["--check", "--json"])
        self.assertEqual(result, 1)
        report = json.loads(output)
        self.assertEqual(report["status"], "invalid")
        self.assertEqual(report["errors"], ["Development configuration is invalid; no existing files were adopted."])
        self.assertTrue(secret not in output, "Nested configuration diagnostics disclosed a credential.")
        self.assertNotIn("Traceback", output)
        self.assert_personal_untouched()

    def test_file_replaced_with_fifo_between_stat_and_open_is_rejected_without_blocking(self):
        prepared = workspace.prepare_workspace(self.root)
        real_open = os.open
        replaced = False

        def replace_before_open(path, flags, *args, **kwargs):
            nonlocal replaced
            if Path(path) == prepared.paths.config and not replaced:
                # Assert before the real FIFO open so a regression fails instead
                # of making the test suite hang waiting for a writer.
                self.assertTrue(flags & os.O_NONBLOCK, "Private-file inspection must not block on a substituted FIFO.")
                replaced = True
                prepared.paths.config.unlink()
                os.mkfifo(prepared.paths.config, 0o600)
            return real_open(path, flags, *args, **kwargs)

        with patch.object(os, "open", side_effect=replace_before_open):
            report = workspace.inspect_workspace(self.root)
        self.assertTrue(replaced)
        self.assertEqual(report["status"], "invalid")
        self.assert_personal_untouched()

    def test_non_loopback_and_invalid_ports_fail_before_creating_any_workspace(self):
        for args in (["--host", "0.0.0.0"], ["--host", "example.com"], ["--port", "0"], ["--port", "65536"]):
            with self.subTest(args=args), redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as raised:
                dev.main(args, repo_root=self.root)
            self.assertEqual(raised.exception.code, 2)
        self.assertFalse((self.root / "work").exists())

    def test_real_launcher_auth_restart_and_active_cleanup_protection(self):
        prepared = workspace.prepare_workspace(self.root)
        password = prepared.paths.password.read_text().strip()
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
        origin = f"http://127.0.0.1:{port}"
        environment = {**os.environ, **self.dirty_environment()}
        child = None
        logs = []

        def stop():
            nonlocal child
            if child is None:
                return
            child.terminate()
            try:
                output, _ = child.communicate(timeout=8)
            except subprocess.TimeoutExpired:
                child.kill()
                output, _ = child.communicate(timeout=5)
            logs.append(output)
            child = None

        def start():
            nonlocal child
            command = [sys.executable, "-c", "from pathlib import Path; import sys; from scripts.dev import main; raise SystemExit(main(['--port',sys.argv[2]], repo_root=Path(sys.argv[1])))", str(self.root), str(port)]
            child = subprocess.Popen(command, cwd=REPOSITORY, env=environment, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
            deadline = time.monotonic() + 12
            while time.monotonic() < deadline:
                if child.poll() is not None:
                    self.fail("The isolated contributor server exited before becoming healthy.")
                try:
                    response = httpx.get(origin + "/api/health", timeout=0.4, trust_env=False)
                    if response.status_code == 200:
                        return
                except httpx.HTTPError:
                    pass
                time.sleep(0.05)
            self.fail("The isolated contributor server did not become healthy within the bounded wait.")

        try:
            start()
            with httpx.Client(base_url=origin, timeout=3, trust_env=False) as client:
                wrong = client.post("/api/auth/login", json={"password": "production-fixture-password"}, headers={"Origin": origin})
                self.assertEqual(wrong.status_code, 401)
                login = client.post("/api/auth/login", json={"password": password}, headers={"Origin": origin})
                self.assertEqual(login.status_code, 200)
                headers = {"Origin": origin, "X-CSRF-Token": login.json()["csrf_token"]}
                record = client.post("/api/items", json={"url": "https://example.com/contributor-synthetic", "title": "An isolated synthetic record", "notes": "Keep my development note"}, headers=headers)
                self.assertEqual(record.status_code, 200)
                self.assertFalse(client.get("/api/settings").json()["ai_available"])
                with self.assertRaisesRegex(workspace.WorkspaceError, "in use"):
                    workspace.cleanup_workspace(self.root)
                stop()
                start()
                # The original cookie, data, and private configuration survive.
                items = client.get("/api/items")
                self.assertEqual(items.status_code, 200)
                self.assertEqual(items.json()["total"], 1)
                self.assertEqual(items.json()["items"][0]["notes"], "Keep my development note")
                self.assertTrue(prepared.paths.password.read_text().strip() == password, "Restart changed the development credential.")
        finally:
            stop()
        self.assertTrue(all(password not in output for output in logs), "The real launcher logged a credential.")
        self.assert_personal_untouched()
        workspace.cleanup_workspace(self.root)
        self.assert_personal_untouched()


if __name__ == "__main__":
    unittest.main()
