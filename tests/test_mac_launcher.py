"""Mac app launcher logic: library location, port choice, one server per library, first-run password.

These tests import `packaging/mac/little_archive_mac/core.py`, which never touches AppKit, so they run
without building the app bundle. They do not test the AppKit shell (`gui.py`) or the built `.app`.
"""
from contextlib import contextmanager, redirect_stderr, redirect_stdout
import http.server
import io
import json
import logging
import os
from pathlib import Path
import socket
import stat
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

if os.name != "posix":
    raise unittest.SkipTest("The Mac launcher uses POSIX file locks.")

from sqlite3 import connect as sqlite3_connect

import httpx

REPOSITORY = Path(__file__).resolve().parent.parent
LAUNCHER_PATH = REPOSITORY / "packaging" / "mac"
if str(LAUNCHER_PATH) not in sys.path:
    sys.path.append(str(LAUNCHER_PATH))

from little_archive_mac import core, main as app_main  # noqa: E402
from server.config import Config  # noqa: E402
from server.storage import Store  # noqa: E402


def free_port():
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


@contextmanager
def listening(host="127.0.0.1", port=0):
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind((host, port))
    sock.listen(4)
    try:
        yield sock.getsockname()[1]
    finally:
        sock.close()


class TemporaryLibraryCase(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="little-archive-mac-test-")
        self.addCleanup(self.temporary.cleanup)
        self.home = Path(self.temporary.name).resolve()
        self.paths = core.resolve_paths(environ={}, home=self.home)


class LocationTests(TemporaryLibraryCase):
    def test_library_is_in_application_support_under_the_home_folder(self):
        self.assertEqual(self.paths.root, self.home / "Library" / "Application Support" / "Little Archive")
        self.assertEqual(self.paths.log_dir, self.home / "Library" / "Logs" / "Little Archive")
        self.assertEqual(self.paths.database, self.paths.root / "library.sqlite3")

    def test_default_follows_the_current_home_environment_variable(self):
        with patch.dict(os.environ, {"HOME": str(self.home)}, clear=False):
            os.environ.pop(core.SUPPORT_DIR_ENV, None)
            self.assertEqual(core.resolve_paths().root, self.home / "Library" / "Application Support" / "Little Archive")

    def test_testing_override_must_be_absolute(self):
        override = self.home / "elsewhere"
        self.assertEqual(core.resolve_paths(environ={core.SUPPORT_DIR_ENV: str(override)}).root, override)
        with self.assertRaises(core.LauncherError):
            core.resolve_paths(environ={core.SUPPORT_DIR_ENV: "relative/folder"})

    def test_private_directory_is_owner_only_and_loose_permissions_are_tightened(self):
        folder = core.ensure_private_directory(self.paths.root)
        self.assertEqual(stat.S_IMODE(folder.stat().st_mode), 0o700)
        folder.chmod(0o755)
        core.ensure_private_directory(folder)
        self.assertEqual(stat.S_IMODE(folder.stat().st_mode), 0o700)

    def test_a_file_in_the_way_is_a_readable_error(self):
        blocker = self.home / "blocker"
        blocker.write_text("not a folder")
        with self.assertRaises(core.LauncherError):
            core.ensure_private_directory(blocker)


class PortTests(TemporaryLibraryCase):
    def test_uses_the_first_preferred_port_when_it_is_free_and_binds_loopback_only(self):
        wanted = free_port()
        sock, port = core.bind_loopback_listener([wanted])
        self.addCleanup(sock.close)
        self.assertEqual(port, wanted)
        self.assertEqual(sock.getsockname(), ("127.0.0.1", wanted))

    def test_skips_a_port_another_program_is_listening_on(self):
        with listening() as busy:
            sock, port = core.bind_loopback_listener([busy])
            self.addCleanup(sock.close)
            self.assertNotEqual(port, busy)
            self.assertEqual(sock.getsockname()[0], "127.0.0.1")

    def test_skips_a_port_held_by_a_wildcard_listener(self):
        with listening("0.0.0.0") as busy:
            self.assertTrue(core.port_is_taken(busy))
            sock, port = core.bind_loopback_listener([busy])
            self.addCleanup(sock.close)
            self.assertNotEqual(port, busy)

    def test_falls_back_to_a_free_port_for_unusable_preferences(self):
        sock, port = core.bind_loopback_listener([None, 80, 70000, True, "8787"])
        self.addCleanup(sock.close)
        self.assertGreaterEqual(port, 1024)
        self.assertEqual(sock.getsockname(), ("127.0.0.1", port))

    def test_the_bound_socket_is_not_available_to_a_second_listener(self):
        sock, port = core.bind_loopback_listener([])
        self.addCleanup(sock.close)
        other, other_port = core.bind_loopback_listener([port])
        self.addCleanup(other.close)
        self.assertNotEqual(port, other_port)

    def test_remembered_port_round_trips_and_bad_values_are_ignored(self):
        core.ensure_private_directory(self.paths.root)
        self.assertIsNone(core.saved_port(self.paths))
        core.remember_port(self.paths, 54321)
        self.assertEqual(core.saved_port(self.paths), 54321)
        self.assertEqual(stat.S_IMODE(self.paths.prefs_file.stat().st_mode), 0o600)
        for bad in ('{"port": 80}', '{"port": "8787"}', '{"port": true}', "not json", "[1]"):
            self.paths.prefs_file.write_text(bad)
            self.assertIsNone(core.saved_port(self.paths), bad)


class SingleInstanceTests(TemporaryLibraryCase):
    def setUp(self):
        super().setUp()
        core.ensure_private_directory(self.paths.root)

    def test_a_second_lock_on_the_same_library_is_refused_until_the_first_is_released(self):
        first, second = core.InstanceLock(self.paths.lock_file), core.InstanceLock(self.paths.lock_file)
        self.assertTrue(first.acquire())
        self.assertFalse(second.acquire())
        first.release()
        self.assertTrue(second.acquire())
        second.release()

    def test_a_different_library_is_not_blocked(self):
        other = self.home / "other-library"
        other.mkdir()
        first, second = core.InstanceLock(self.paths.lock_file), core.InstanceLock(other / ".instance.lock")
        self.assertTrue(first.acquire() and second.acquire())
        first.release()
        second.release()

    def test_the_lock_disappears_when_the_holding_process_dies(self):
        code = ("import sys, time; sys.path.insert(0, sys.argv[1]); from little_archive_mac import core; "
                "lock = core.InstanceLock(sys.argv[2]); assert lock.acquire(); print('locked', flush=True); time.sleep(60)")
        child = subprocess.Popen([sys.executable, "-c", code, str(LAUNCHER_PATH), str(self.paths.lock_file)], stdout=subprocess.PIPE, text=True,
                                 env={**os.environ, "PYTHONPATH": str(REPOSITORY)})
        self.addCleanup(child.stdout.close)
        self.addCleanup(child.wait)
        self.addCleanup(child.kill)
        self.assertEqual(child.stdout.readline().strip(), "locked")
        mine = core.InstanceLock(self.paths.lock_file)
        self.assertFalse(mine.acquire())
        child.kill()
        child.wait()
        self.assertTrue(mine.acquire())
        mine.release()

    def test_state_file_round_trip_rejects_tampering_and_only_the_owner_clears_it(self):
        core.write_state(self.paths, 8791, "9.9.9")
        self.assertEqual(core.read_state(self.paths), {"pid": os.getpid(), "port": 8791, "url": "http://localhost:8791"})
        self.assertEqual(stat.S_IMODE(self.paths.state_file.stat().st_mode), 0o600)
        for tampered in ({"pid": 1, "port": 8791, "url": "https://example.com"}, {"pid": 1, "port": 99999, "url": "http://localhost:99999"},
                         {"pid": "1", "port": 8791, "url": "http://localhost:8791"}, {"pid": 1, "port": 8791}):
            self.paths.state_file.write_text(json.dumps(tampered))
            self.assertIsNone(core.read_state(self.paths), tampered)
        self.paths.state_file.write_text(json.dumps({"pid": os.getpid() + 1, "port": 8791, "url": "http://localhost:8791"}))
        core.clear_state(self.paths)
        self.assertTrue(self.paths.state_file.exists(), "A state file written by another process must not be removed.")
        core.write_state(self.paths, 8791, "9.9.9")
        core.clear_state(self.paths)
        self.assertFalse(self.paths.state_file.exists())

    def test_health_probe_accepts_only_a_loopback_little_archive_answer(self):
        class Handler(http.server.BaseHTTPRequestHandler):
            body = b'{"status":"ok","version":"0"}'

            def do_GET(self):
                self.send_response(200 if self.path == "/api/health" else 404)
                self.send_header("Content-Length", str(len(self.body)))
                self.end_headers()
                self.wfile.write(self.body)

            def log_message(self, *args):
                pass

        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        url = f"http://localhost:{server.server_address[1]}"
        self.assertTrue(core.probe_health(url))
        Handler.body = b'{"status":"broken"}'
        self.assertFalse(core.probe_health(url))
        Handler.body = b"not json"
        self.assertFalse(core.probe_health(url))
        self.assertFalse(core.probe_health("http://example.com:80"), "Only loopback origins may be probed.")
        self.assertFalse(core.probe_health(f"http://localhost:{free_port()}"))

    def test_finding_a_running_instance_needs_both_a_state_file_and_a_healthy_server(self):
        self.assertIsNone(core.find_running_instance(self.paths))
        core.write_state(self.paths, free_port(), "0")
        self.assertIsNone(core.find_running_instance(self.paths), "A state file without a server is stale.")

    def test_browser_is_only_opened_for_loopback_origins_and_can_be_disabled(self):
        with patch.object(core.subprocess, "run") as run:
            self.assertTrue(core.open_in_browser("http://localhost:8787/", environ={}))
            run.assert_called_once()
            self.assertEqual(run.call_args.args[0], ["/usr/bin/open", "http://localhost:8787/"])
        with patch.object(core.subprocess, "run") as run:
            self.assertFalse(core.open_in_browser("http://localhost:8787/", environ={core.NO_BROWSER_ENV: "1"}))
            self.assertFalse(core.open_in_browser("https://example.com/", environ={}))
            self.assertFalse(core.open_in_browser("http://localhost:8787@evil.example/", environ={}))
            run.assert_not_called()


class FirstRunPasswordTests(TemporaryLibraryCase):
    def password(self):
        return core.read_owner_password(self.paths)

    def test_first_run_creates_a_private_generated_password_without_printing_it(self):
        records = []
        handler = logging.Handler()
        handler.emit = records.append
        root = logging.getLogger()
        root.addHandler(handler)
        self.addCleanup(root.removeHandler, handler)
        previous = root.level
        root.setLevel(logging.DEBUG)
        self.addCleanup(root.setLevel, previous)
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            library = core.prepare_library(self.paths, 8787)
        password = self.password()
        self.assertTrue(library.first_run)
        self.assertGreaterEqual(len(password), 32)
        self.assertEqual(stat.S_IMODE(self.paths.config_file.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(self.paths.root.stat().st_mode), 0o700)
        everything = out.getvalue() + err.getvalue() + "\n".join(r.getMessage() for r in records)
        self.assertNotIn(password, everything)
        self.assertEqual(library.config.admin_password, password)
        self.assertEqual(library.config.data_dir, self.paths.root.resolve())
        self.assertEqual(library.config.public_url, "http://localhost:8787")
        self.assertEqual(library.config.ollama_url, "")

    def test_the_password_is_reused_not_regenerated_and_first_run_ends_once_a_library_exists(self):
        first = core.prepare_library(self.paths, 8787)
        before = self.paths.config_file.read_bytes()
        again = core.prepare_library(self.paths, 8790)
        self.assertTrue(again.first_run, "No library has been created yet.")
        Store(first.config)
        later = core.prepare_library(self.paths, 8790)
        self.assertFalse(later.first_run)
        self.assertEqual(self.paths.config_file.read_bytes(), before)
        self.assertEqual(later.config.admin_password, first.config.admin_password)
        self.assertEqual(later.config.public_url, "http://localhost:8790", "The origin follows the port in use, not the file.")

    def test_inherited_deployment_variables_are_ignored(self):
        hostile = {"LA_ADMIN_PASSWORD": "inherited-secret-password", "LA_DATA_DIR": str(self.home / "elsewhere"),
                   "LA_PUBLIC_URL": "https://production.example", "LA_OLLAMA_URL": "http://127.0.0.1:1", "LA_OLLAMA_MODEL": "inherited"}
        with patch.dict(os.environ, hostile):
            library = core.prepare_library(self.paths, 8787)
        self.assertNotEqual(library.config.admin_password, "inherited-secret-password")
        self.assertEqual(library.config.data_dir, self.paths.root.resolve())
        self.assertEqual(library.config.public_url, "http://localhost:8787")
        self.assertEqual(library.config.ollama_url, "")
        self.assertFalse((self.home / "elsewhere").exists())

    def test_model_settings_in_the_apps_own_configuration_file_are_honored_but_folder_and_origin_are_not(self):
        core.ensure_private_directory(self.paths.root)
        self.paths.config_file.write_text("LA_ADMIN_PASSWORD=a-long-enough-test-password\nLA_OLLAMA_URL=http://127.0.0.1:11434\n"
                                          "LA_OLLAMA_MODEL=example-model\nLA_PUBLIC_URL=https://ignored.example\nLA_DATA_DIR=/nowhere\n")
        os.chmod(self.paths.config_file, 0o600)
        library = core.prepare_library(self.paths, 8787)
        self.assertEqual((library.config.ollama_url, library.config.ollama_model), ("http://127.0.0.1:11434", "example-model"))
        self.assertEqual(library.config.public_url, "http://localhost:8787")
        self.assertEqual(library.config.data_dir, self.paths.root.resolve())

    def test_an_existing_library_without_configuration_is_opened_without_inventing_a_password(self):
        core.ensure_private_directory(self.paths.root)
        Store(Config(data_dir=self.paths.root, admin_password="a-previously-chosen-password"))
        library = core.prepare_library(self.paths, 8787)
        self.assertFalse(library.first_run)
        self.assertFalse(self.paths.config_file.exists())
        self.assertEqual(library.config.admin_password, "")
        self.assertIsNone(self.password())

    def test_a_symbolic_link_in_place_of_the_configuration_is_refused(self):
        core.ensure_private_directory(self.paths.root)
        target = self.home / "somewhere-else.env"
        target.write_text("LA_ADMIN_PASSWORD=this-is-not-ours-12345\n")
        self.paths.config_file.symlink_to(target)
        with self.assertRaises(core.LauncherError):
            core.prepare_library(self.paths, 8787)


class RunningInstanceTests(TemporaryLibraryCase):
    def start(self):
        instance = core.LibraryInstance(self.paths, environ={core.NO_BROWSER_ENV: "1"})
        instance.start()
        self.addCleanup(instance.stop)
        return instance

    def login(self, url, password):
        return httpx.post(url + "/api/auth/login", json={"password": password}, headers={"Origin": url}, timeout=10)

    def test_start_serves_the_library_from_application_support_and_stop_shuts_it_down(self):
        instance = self.start()
        health = httpx.get(instance.url + "/api/health", timeout=5)
        self.assertEqual(health.json()["status"], "ok")
        self.assertTrue(instance.first_run)
        self.assertTrue(instance.running)
        for name in ("library.sqlite3", "assets", "config.env", "launcher.json", ".instance.json"):
            self.assertTrue((self.paths.root / name).exists(), name)
        self.assertEqual(self.paths.root, self.home / "Library" / "Application Support" / "Little Archive")
        self.assertTrue(self.login(instance.url, instance.owner_password()).json()["authenticated"])
        self.assertEqual(self.login(instance.url, "wrong-password-entirely").status_code, 401)
        self.assertEqual(httpx.get(instance.url + "/", timeout=5).status_code, 200, "The web interface is served.")
        port, runner = instance.port, instance.runner
        instance.stop()
        self.assertFalse(runner.thread.is_alive())
        self.assertFalse(core.port_is_taken(port))
        self.assertFalse(self.paths.state_file.exists())
        again = core.InstanceLock(self.paths.lock_file)
        self.assertTrue(again.acquire())
        again.release()
        instance.stop()  # Stopping twice is harmless.

    def test_quitting_folds_the_write_ahead_log_into_the_library_file(self):
        import sqlite3
        instance = self.start()
        # A connection that stays open (as an unclosed one in the server would) keeps SQLite
        # from folding the log in by itself when the server's own connections close.
        lingering = sqlite3.connect(self.paths.database)
        self.addCleanup(lingering.close)
        lingering.execute("SELECT count(*) FROM items").fetchone()
        signed_in = self.login(instance.url, instance.owner_password())
        added = httpx.post(instance.url + "/api/items", json={"url": "https://example.com/saved-for-the-test"}, timeout=10,
                           headers={"Origin": instance.url, "X-CSRF-Token": signed_in.json()["csrf_token"]}, cookies=signed_in.cookies)
        self.assertEqual(added.status_code, 200)
        instance.stop()
        wal = self.paths.database.with_name("library.sqlite3-wal")
        self.assertTrue(not wal.exists() or wal.stat().st_size == 0, "The write-ahead log should be empty after quitting.")
        lone_copy = self.home / "lone-copy.sqlite3"
        lone_copy.write_bytes(self.paths.database.read_bytes())
        with sqlite3.connect(lone_copy) as connection:
            self.assertEqual(connection.execute("SELECT count(*) FROM items").fetchone()[0], 1,
                             "Copying only library.sqlite3 after quitting must carry the saved item.")

    def test_the_welcome_is_shown_until_it_has_been_clicked_through_even_across_restarts(self):
        first = self.start()
        self.assertTrue(first.needs_welcome())
        first.stop()
        again = self.start()  # Quit before reading it: the password must be offered again.
        self.assertTrue(again.needs_welcome())
        again.acknowledge_welcome()
        self.assertFalse(again.needs_welcome())
        self.assertEqual(core.saved_port(self.paths), again.port, "Acknowledging must not drop the remembered port.")
        again.stop()
        later = self.start()
        self.assertFalse(later.needs_welcome())

    def test_no_welcome_when_there_is_no_saved_password_to_show(self):
        core.ensure_private_directory(self.paths.root)
        Store(Config(data_dir=self.paths.root, admin_password="a-previously-chosen-password"))
        instance = self.start()
        self.assertIsNone(instance.owner_password())
        self.assertFalse(instance.needs_welcome())

    def test_a_library_with_no_owner_password_anywhere_says_so_without_server_jargon(self):
        core.ensure_private_directory(self.paths.root)
        Store(Config(data_dir=self.paths.root, admin_password="a-previously-chosen-password"))
        with sqlite3_connect(self.paths.database) as connection:
            connection.execute("DELETE FROM meta WHERE key='password_hash'")  # What a restored backup looks like.
        instance = core.LibraryInstance(self.paths, environ={core.NO_BROWSER_ENV: "1"})
        with self.assertRaises(core.LauncherError) as raised:
            instance.start()
        self.assertIn("no owner password", str(raised.exception))
        self.assertNotIn("scripts/setup.py", str(raised.exception))
        self.assertFalse(instance.lock.held)

    def test_the_server_listens_on_loopback_only(self):
        instance = self.start()
        self.assertEqual(instance.runner.sock.getsockname()[0], "127.0.0.1")

    def test_a_second_copy_does_not_start_a_second_server(self):
        first = self.start()
        second = core.LibraryInstance(self.paths, environ={core.NO_BROWSER_ENV: "1"})
        self.assertEqual(second.existing_instance_url(), first.url)
        with self.assertRaises(core.AlreadyRunning) as raised:
            second.start()
        self.assertEqual(raised.exception.url, first.url)
        self.assertIsNone(second.runner)
        self.assertEqual(httpx.get(first.url + "/api/health", timeout=5).status_code, 200)

    def test_restarting_keeps_the_library_password_and_port(self):
        first = self.start()
        password, port = first.owner_password(), first.port
        first.stop()
        second = self.start()
        self.assertFalse(second.first_run)
        self.assertEqual(second.port, port)
        self.assertEqual(second.owner_password(), password)
        self.assertTrue(self.login(second.url, password).json()["authenticated"])

    def test_a_backup_restored_with_the_bundled_command_opens_once_a_password_is_placed_beside_it(self):
        instance = self.start()
        signed_in = self.login(instance.url, instance.owner_password())
        headers = {"Origin": instance.url, "X-CSRF-Token": signed_in.json()["csrf_token"]}
        httpx.post(instance.url + "/api/items", json={"url": "https://example.com/kept-in-the-backup"}, headers=headers, cookies=signed_in.cookies, timeout=10)
        archive = self.home / "backup.zip"
        archive.write_bytes(httpx.get(instance.url + "/api/backup", headers=headers, cookies=signed_in.cookies, timeout=20).content)
        instance.stop()
        restored = self.home / "restored library"
        with redirect_stdout(io.StringIO()):
            self.assertEqual(core.run_server_cli(["restore", str(archive), "--destination", str(restored)]), 0)
        paths = core.AppPaths(root=restored, log_dir=restored / "logs")
        (restored / "config.env").write_text("LA_ADMIN_PASSWORD=a-new-password-after-restore\n")
        os.chmod(restored / "config.env", 0o600)
        reopened = core.LibraryInstance(paths, environ={core.NO_BROWSER_ENV: "1"})
        reopened.start()
        self.addCleanup(reopened.stop)
        again = self.login(reopened.url, "a-new-password-after-restore")
        self.assertTrue(again.json()["authenticated"])
        items = httpx.get(reopened.url + "/api/items", cookies=again.cookies, timeout=10).json()
        self.assertEqual([item["url"] for item in items["items"]], ["https://example.com/kept-in-the-backup"])

    def test_an_occupied_default_port_moves_the_app_and_the_origin_follows(self):
        with listening() as busy, patch.object(core, "DEFAULT_PORT", busy):
            instance = self.start()
            self.assertNotEqual(instance.port, busy)
            self.assertEqual(instance.url, f"http://localhost:{instance.port}")
            self.assertTrue(self.login(instance.url, instance.owner_password()).json()["authenticated"],
                            "Sign-in must work at the origin the app actually uses.")
            self.assertEqual(core.saved_port(self.paths), instance.port)

    def test_a_failed_start_explains_itself_and_leaves_nothing_behind(self):
        core.ensure_private_directory(self.paths.root)
        self.paths.config_file.write_text("LA_ADMIN_PASSWORD=too-short\n")
        os.chmod(self.paths.config_file, 0o600)
        instance = core.LibraryInstance(self.paths, environ={core.NO_BROWSER_ENV: "1"})
        with self.assertRaises(core.LauncherError) as raised:
            instance.start()
        self.assertIn("12", str(raised.exception))
        self.assertIn("config.env", str(raised.exception))
        self.assertNotIn("too-short", str(raised.exception))
        self.assertFalse(self.paths.state_file.exists())
        self.assertFalse(instance.lock.held)
        self.paths.config_file.write_text("LA_ADMIN_PASSWORD=now-a-long-enough-password\n")
        fixed = core.LibraryInstance(self.paths, environ={core.NO_BROWSER_ENV: "1"})
        fixed.start()
        self.addCleanup(fixed.stop)
        self.assertTrue(fixed.running)

    def test_no_secret_reaches_the_log_during_a_full_run(self):
        records = []
        handler = logging.Handler()
        handler.emit = records.append
        root = logging.getLogger()
        root.addHandler(handler)
        self.addCleanup(root.removeHandler, handler)
        previous = root.level
        root.setLevel(logging.DEBUG)
        self.addCleanup(root.setLevel, previous)
        instance = self.start()
        password = instance.owner_password()
        self.login(instance.url, password)
        instance.stop()
        self.assertTrue(records, "The launcher should log its progress.")
        self.assertNotIn(password, "\n".join(r.getMessage() for r in records))


class BuildScriptTests(unittest.TestCase):
    """Pure helpers of scripts/build_mac_app.py. The build itself needs a Mac, network and minutes; it is not run here."""

    def setUp(self):
        from scripts import build_mac_app
        self.build = build_mac_app

    def test_bundle_version_is_the_servers_version(self):
        from server import __version__
        self.assertEqual(self.build.application_version(), __version__)

    def test_minimum_macos_is_read_from_the_macos_load_commands_only(self):
        modern = "Load command 9\n      cmd LC_BUILD_VERSION\n  cmdsize 32\n platform 1\n    minos 12.3\n      sdk 15.0\n"
        older = "Load command 9\n      cmd LC_VERSION_MIN_MACOSX\n  cmdsize 16\n  version 10.15\n      sdk 11.0\n"
        phone = "Load command 9\n      cmd LC_BUILD_VERSION\n  cmdsize 32\n platform 2\n    minos 17.0\n      sdk 17.0\n"
        self.assertEqual(self.build.macos_minimum_in(modern), (12, 3))
        self.assertEqual(self.build.macos_minimum_in(older), (10, 15))
        self.assertIsNone(self.build.macos_minimum_in(phone))
        self.assertIsNone(self.build.macos_minimum_in("no load commands"))

    def test_build_output_is_ignored_by_git_and_docker(self):
        for name in (".gitignore", ".dockerignore"):
            lines = (REPOSITORY / name).read_text().splitlines()
            self.assertTrue(any(line.strip("/") == "dist-mac" for line in lines), name)
            self.assertTrue(any(line.strip("/") == ".mac-build" for line in lines), name)

    def test_build_only_requirements_are_not_in_the_servers_runtime_requirements(self):
        runtime = (REPOSITORY / "requirements.txt").read_text() + (REPOSITORY / "requirements-lock.txt").read_text()
        build = (REPOSITORY / "packaging" / "mac" / "requirements-build.txt").read_text()
        for package in ("pyinstaller", "pyobjc"):
            self.assertIn(package, build.lower())
            self.assertNotIn(package, runtime.lower())


class CommandLineTests(TemporaryLibraryCase):
    def test_version_and_bundled_operator_commands(self):
        out = io.StringIO()
        with redirect_stdout(out):
            self.assertEqual(app_main.main(["--version"]), 0)
        self.assertIn("Little Archive", out.getvalue())
        library = core.prepare_library(self.paths, 8787)
        out = io.StringIO()
        with redirect_stdout(out):
            code = app_main.main(["--cli", "doctor", "--json", "--env-file", str(self.paths.config_file)])
        report = json.loads(out.getvalue())
        self.assertEqual(report["format"], "little-archive-diagnostics")
        self.assertIn(code, {0, 1})
        self.assertNotIn(library.config.admin_password, out.getvalue())


if __name__ == "__main__":
    unittest.main()
