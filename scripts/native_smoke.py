#!/usr/bin/env python3
"""Verify native setup, HTTP behavior, persistence, and CLI recovery.

Run with the candidate's Python 3.12 virtual environment after installing its
requirements. All configuration, credentials, files, and servers are temporary.
No Docker, existing .env, private library, or real social account is used.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import io
import json
import os
from pathlib import Path
import platform
import secrets
import shutil
import signal
import socket
import sqlite3
import stat
import subprocess
import sys
import tempfile
import time
from urllib.error import URLError
from urllib.parse import urlencode, urlsplit
import zipfile

from container_smoke import Client, VerificationError, require, synthetic_png


ROOT = Path(__file__).resolve().parent.parent


def timestamp():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def clean_environment():
    # Exercise the copied checkout's .env, never a caller's live LA_* settings.
    result = {key: value for key, value in os.environ.items() if not key.startswith("LA_")}
    result.pop("PYTHONPATH", None)
    result["PYTHONNOUSERSITE"] = "1"
    result["PYTHONUNBUFFERED"] = "1"
    return result


def snapshot(client):
    value = client.json("GET", "/api/export?format=json")
    return {
        "items": sorted(value["items"], key=lambda row: row["id"]),
        "collections": sorted(value["collections"], key=lambda row: row["id"]),
    }


class NativeHarness:
    def __init__(self, folder, timeout):
        self.folder = Path(folder)
        self.checkout = self.folder / "source"
        self.timeout = timeout
        self.secrets = []
        self.processes = []
        self.report = {
            "format": "little-archive-native-verification",
            "started_at": timestamp(),
            "status": "running",
            "system": platform.system(),
            "system_release": platform.release(),
            "macos_version": platform.mac_ver()[0] or None,
            "machine": platform.machine(),
            "python": platform.python_version(),
            "sqlite": sqlite3.sqlite_version,
            "checks": [],
        }

    def redact(self, value):
        for secret in sorted(self.secrets, key=len, reverse=True):
            if secret:
                value = value.replace(secret, "[redacted]")
        return value

    def record(self, name, **details):
        self.report["checks"].append({"name": name, "status": "passed", **details})
        print("PASS " + name, flush=True)

    def copy_source(self):
        self.checkout.mkdir()
        for directory in ("server", "web"):
            source = ROOT / directory
            require(source.is_dir(), "The candidate source is missing an application directory.")
            require(not any(path.is_symlink() for path in source.rglob("*")), "Native verification requires regular source files, not symlinks.")
            shutil.copytree(source, self.checkout / directory, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
        (self.checkout / "scripts").mkdir()
        for name in ("scripts/setup.py", "requirements.txt", "requirements-lock.txt", ".env.example"):
            source = ROOT / name
            require(source.is_file() and not source.is_symlink(), "The candidate source is missing a regular setup/dependency file.")
            shutil.copy2(source, self.checkout / name)
        digest = hashlib.sha256()
        for path in sorted(self.checkout.rglob("*")):
            if path.is_file():
                digest.update(str(path.relative_to(self.checkout)).encode())
                digest.update(b"\0")
                digest.update(path.read_bytes())
                digest.update(b"\0")
        self.report["copied_source_sha256"] = digest.hexdigest()
        if shutil.which("git"):
            result = subprocess.run(["git", "rev-parse", "HEAD"], cwd=ROOT, capture_output=True, timeout=10)
            if result.returncode == 0:
                self.report["source_commit"] = result.stdout.decode().strip()
                status = subprocess.run(["git", "status", "--porcelain"], cwd=ROOT, capture_output=True, timeout=10)
                self.report["source_worktree_modified"] = bool(status.stdout.strip()) or status.returncode != 0

    def command(self, args, *, stdin=None, expected=0, environment=None):
        result = subprocess.run(
            [sys.executable, *args], cwd=self.checkout,
            env=environment or clean_environment(), input=stdin,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            timeout=max(60, self.timeout), check=False,
        )
        if result.returncode != expected:
            detail = self.redact(result.stderr.decode(errors="replace")[-1500:]).strip()
            raise VerificationError(f"Native command {args[0]} returned {result.returncode}; expected {expected}. {detail}")
        return result

    def setup(self):
        self.copy_source()
        require(not (self.checkout / ".env").exists() and not (self.checkout / "data").exists(), "The copied source unexpectedly contains runtime data.")
        preview = self.command(["-m", "server.cli", "setup", "--dry-run", "--json"])
        require(json.loads(preview.stdout).get("status") == "planned", "The deterministic setup preview did not return its versioned plan.")
        require(not (self.checkout / ".env").exists() and not (self.checkout / "data").exists(), "Setup preview wrote configuration or initialized a database.")
        setup_result = self.command(["scripts/setup.py"])
        env_path = self.checkout / ".env"
        self.original_configuration = env_path.read_bytes()
        values = dict(line.split("=", 1) for line in self.original_configuration.decode().splitlines() if line and not line.startswith("#"))
        password = values["LA_ADMIN_PASSWORD"]
        self.secrets.append(password)
        require(password.encode() not in setup_result.stdout + setup_result.stderr, "The setup helper printed its generated owner password.")
        require(len(password) >= 12, "Setup generated a password shorter than the application minimum.")
        require(stat.S_IMODE(env_path.stat().st_mode) == 0o600, "Setup configuration is not owner-only.")
        require(values.get("LA_DATA_DIR") == "./data", "Setup's native data-directory default changed; update its acceptance check deliberately.")
        before = env_path.stat().st_mtime_ns
        self.command(["scripts/setup.py"], expected=1)
        require(env_path.read_bytes() == self.original_configuration and env_path.stat().st_mtime_ns == before, "A repeated setup overwrote existing configuration.")
        self.record("clean_source_setup_private_configuration_and_overwrite_protection")
        repeated = self.command(["-m", "server.cli", "setup", "--apply", "--json"])
        require(json.loads(repeated.stdout).get("status") == "unchanged", "Repeated deterministic setup did not preserve the existing configuration.")
        diagnostic = self.command(["-m", "server.cli", "doctor", "--json"])
        report = json.loads(diagnostic.stdout)
        require(report.get("format") == "little-archive-diagnostics" and report.get("schema_version") == 1 and report.get("read_only") is True, "Doctor did not return the versioned read-only contract.")
        require(report.get("exit_code") == 0 and report.get("network_checks_requested") is False, "Default diagnostics failed or requested a network probe.")
        require(password.encode() not in diagnostic.stdout + diagnostic.stderr + repeated.stdout + repeated.stderr, "An operator command disclosed the owner password.")
        require(env_path.read_bytes() == self.original_configuration and env_path.stat().st_mtime_ns == before and not (self.checkout / "data").exists(), "Diagnostics or repeated setup changed configuration or initialized the library.")
        self.record("deterministic_setup_preview_and_read_only_redacted_diagnostics")
        return password

    def start(self, label, *, port=None, data_dir=None, password=None):
        if port is None:
            with socket.socket() as listener:
                listener.bind(("127.0.0.1", 0))
                port = listener.getsockname()[1]
        client = Client(f"http://127.0.0.1:{port}")
        environment = clean_environment()
        environment["LA_PUBLIC_URL"] = client.origin
        if data_dir is not None:
            environment["LA_DATA_DIR"] = str(data_dir)
        if password is not None:
            environment["LA_ADMIN_PASSWORD"] = password
        log_path = self.folder / (label + ".log")
        stream = log_path.open("wb")
        try:
            process = subprocess.Popen(
                [sys.executable, "-m", "server.cli", "serve", "--host", "127.0.0.1", "--port", str(port)],
                cwd=self.checkout, env=environment, stdout=stream, stderr=stream,
            )
        except Exception:
            stream.close()
            raise
        handle = {"process": process, "stream": stream, "log": log_path}
        self.processes.append(handle)
        deadline = time.monotonic() + self.timeout
        while time.monotonic() < deadline:
            require(process.poll() is None, "The native application exited during startup.")
            try:
                health = client.json("GET", "/api/health")
                if health.get("status") == "ok":
                    self.report.setdefault("application_version", health.get("version"))
                    return handle, client
            except (URLError, TimeoutError, OSError, VerificationError):
                pass
            time.sleep(0.25)
        raise VerificationError("The native application did not become ready within the startup limit.")

    def stop(self, handle):
        process = handle["process"]
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=12)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=12)
        handle["stream"].close()

    def verify_backup(self, data, password_hash, cookie, csrf, token):
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            require(archive.testzip() is None, "Native backup ZIP verification failed.")
            manifest = json.loads(archive.read("manifest.json"))
            require(manifest.get("format") == "little-archive-backup" and manifest["items"] == 2, "Native backup manifest has the wrong format or item count.")
            require(set(archive.namelist()) == {"manifest.json", *manifest["files"]}, "Native backup contains unmanifested entries.")
            for name, metadata in manifest["files"].items():
                value = archive.read(name)
                require(len(value) == metadata["size"] and hashlib.sha256(value).hexdigest() == metadata["sha256"], "A native backup member failed its manifest check.")
            require(any(name.startswith("assets/") for name in manifest["files"]), "Native backup omitted the synthetic image.")
            database = archive.read("library.sqlite3")
        for value in (password_hash, csrf, hashlib.sha256(cookie.encode()).hexdigest(), hashlib.sha256(token.encode()).hexdigest()):
            require(value.encode() not in database, "Authentication material remained in native backup bytes.")
        snapshot_path = self.folder / "verified-snapshot.sqlite3"
        snapshot_path.write_bytes(database)
        with sqlite3.connect(snapshot_path) as connection:
            require(connection.execute("PRAGMA integrity_check").fetchone()[0] == "ok", "Native backup SQLite integrity check failed.")
            require(connection.execute("SELECT count(*) FROM sessions").fetchone()[0] == 0, "Native backup included owner sessions.")
            require(connection.execute("SELECT count(*) FROM extension_tokens").fetchone()[0] == 0, "Native backup included import tokens.")
            require(connection.execute("SELECT value FROM meta WHERE key='password_hash'").fetchone() is None, "Native backup included the owner password hash.")

    def run(self):
        initial_password = self.setup()
        source, owner = self.start("initial")
        anonymous = Client(owner.origin)
        anonymous.request("GET", "/api/items", expected=401)
        owner.login(initial_password)
        initial_cookie = owner.cookie()
        self.secrets += [initial_cookie, owner.csrf]
        require((self.checkout / "data" / "library.sqlite3").is_file(), "Native CLI did not use the copied .env's relative data directory.")
        self.record("native_cli_env_loading_and_authenticated_http")

        collection = owner.json("POST", "/api/collections", payload={"name": "Native check shelf", "color": "#735A93"})
        owner.json("POST", "/api/collections", payload={"name": "Empty native shelf", "color": "#D5A7AC"})
        item = owner.json("POST", "/api/items", payload={"url": "https://example.com/native-lemon", "title": "Native lemon note", "notes": "Keep this native note — محفوظ", "tags": ["native", "استعادة"], "collection_ids": [collection["id"]]})
        iid = item["id"]
        owner.json("PATCH", "/api/items/" + iid, payload={"status": "done", "favorite": True, "needs_review": False})
        disposable = owner.json("POST", "/api/items", payload={"url": "https://example.com/native-delete", "title": "Delete this synthetic item"})
        owner.json("DELETE", "/api/items/" + disposable["id"])
        owner.request("GET", "/api/items/" + disposable["id"], expected=404)
        item = owner.json("POST", f"/api/items/{iid}/thumbnail", body=synthetic_png(), headers={"Content-Type": "image/png"})
        thumbnail_url = item["thumbnail_url"]
        thumbnail = owner.request("GET", thumbnail_url)
        anonymous.request("GET", thumbnail_url, expected=401)
        imported = owner.json("POST", "/api/imports/file?filename=synthetic.csv", body=b"url,title,notes,tags,favorite,status\nhttps://example.com/native-import,Native imported record,Imported note,synthetic,true,to_revisit\n", headers={"Content-Type": "text/csv"})
        require(imported["created"] == 1 and imported["skipped"] == 0, "The native file import failed.")
        require(owner.json("GET", "/api/items?" + urlencode({"q": "محفوظ"}))["total"] == 1, "Native Unicode search did not find the edited item.")
        expected = snapshot(owner)
        require(len(expected["items"]) == 2 and len(expected["collections"]) == 2, "Native fixture counts are incorrect.")
        self.record("native_http_crud_import_unicode_search_and_local_image", items=2, collections=2)

        token = owner.json("POST", "/api/extension/tokens", payload={"name": "Native original token"})["token"]
        self.secrets.append(token)
        bearer = {"Authorization": "Bearer " + token}
        extension = Client(owner.origin)
        instance_id = extension.json("GET", "/api/extension/status", headers=bearer)["instance_id"]
        unfinished = extension.json("POST", "/api/extension/imports", payload={"platform": "instagram", "source_account": "native-fixture", "scope": "Synthetic interrupted view"}, headers=bearer)["run_id"]
        with sqlite3.connect(self.checkout / "data" / "library.sqlite3") as connection:
            password_hash = connection.execute("SELECT value FROM meta WHERE key='password_hash'").fetchone()[0]
        self.secrets.append(password_hash)
        backup = owner.request("GET", "/api/backup")
        self.verify_backup(backup, password_hash, initial_cookie, owner.csrf, token)
        backup_path = self.folder / "native-backup.zip"
        with backup_path.open("xb") as stream:
            backup_path.chmod(0o600)
            stream.write(backup)
        self.record("native_http_backup_integrity_assets_and_authentication_exclusion")

        self.stop(source)
        restarted, _ = self.start("restarted", port=urlsplit(owner.origin).port)
        require(snapshot(owner) == expected and owner.request("GET", thumbnail_url) == thumbnail, "Native restart changed library content or local image bytes.")
        require(extension.json("GET", "/api/extension/status", headers=bearer)["instance_id"] == instance_id, "Native restart changed instance identity.")
        self.record("native_restart_retains_content_images_sessions_and_identity")
        self.stop(restarted)

        reset_password = secrets.token_urlsafe(30)
        self.secrets.append(reset_password)
        result = self.command(["-m", "server.cli", "reset-password"], stdin=(reset_password + "\n" + reset_password + "\n").encode())
        require(reset_password.encode() not in result.stdout + result.stderr, "Password reset echoed its runtime secret.")
        require((self.checkout / ".env").read_bytes() == self.original_configuration, "Password reset changed the setup configuration.")
        reset_process, reset_owner = self.start("after-reset")
        stale = Client(reset_owner.origin)
        stale.request("GET", "/api/items", headers={"Cookie": "little_archive_session=" + initial_cookie}, expected=401)
        stale.request("GET", "/api/extension/status", headers=bearer, expected=401)
        stale.request("POST", "/api/auth/login", payload={"password": initial_password}, expected=401)
        reset_owner.login(reset_password)
        self.secrets += [reset_owner.cookie(), reset_owner.csrf]
        require(snapshot(reset_owner) == expected, "Password reset changed the library.")
        require(reset_owner.json("GET", "/api/extension/tokens")["tokens"] == [], "Password reset retained an import token.")
        runs = reset_owner.json("GET", "/api/imports")["imports"]
        require(next(row for row in runs if row["id"] == unfinished)["status"] == "cancelled", "Password reset did not cancel an active import.")
        self.record("offline_cli_password_reset_revokes_old_auth_and_preserves_config")
        self.stop(reset_process)

        restored_directory = self.checkout / "recovered-data"
        require(not restored_directory.exists(), "The native recovery destination already exists.")
        self.command(["-m", "server.cli", "restore", str(backup_path), "--destination", str(restored_directory)])
        fresh_password = secrets.token_urlsafe(30)
        self.secrets.append(fresh_password)
        _, recovered = self.start("recovered", data_dir=restored_directory, password=fresh_password)
        rejected = Client(recovered.origin)
        rejected.request("GET", "/api/items", headers={"Cookie": "little_archive_session=" + initial_cookie}, expected=401)
        rejected.request("GET", "/api/extension/status", headers=bearer, expected=401)
        rejected.request("POST", "/api/auth/login", payload={"password": initial_password}, expected=401)
        rejected.request("POST", "/api/auth/login", payload={"password": reset_password}, expected=401)
        recovered.login(fresh_password)
        self.secrets += [recovered.cookie(), recovered.csrf]
        require(snapshot(recovered) == expected and recovered.request("GET", thumbnail_url) == thumbnail, "Native offline restore changed records, collections, or local images.")
        require(recovered.json("GET", "/api/extension/tokens")["tokens"] == [], "Native restore revived old import tokens.")
        runs = recovered.json("GET", "/api/imports")["imports"]
        require(next(row for row in runs if row["id"] == unfinished)["status"] == "cancelled", "Native restore did not cancel the interrupted import.")
        fresh_token = recovered.json("POST", "/api/extension/tokens", payload={"name": "Fresh native recovery token"})["token"]
        self.secrets.append(fresh_token)
        new_identity = Client(recovered.origin).json("GET", "/api/extension/status", headers={"Authorization": "Bearer " + fresh_token})["instance_id"]
        require(new_identity != instance_id, "Native restore retained the old instance identity.")
        require((self.checkout / ".env").read_bytes() == self.original_configuration, "Native recovery altered the original configuration.")
        self.record("offline_cli_restore_preserves_data_and_requires_fresh_authentication")

    def diagnostics(self):
        for handle in self.processes:
            handle["stream"].flush() if not handle["stream"].closed else None
            content = self.redact(handle["log"].read_text(errors="replace")[-5000:])
            if content.strip():
                print("Native server diagnostics (" + handle["log"].name + "):\n" + content, file=sys.stderr)

    def cleanup(self):
        errors = []
        for handle in reversed(self.processes):
            try:
                self.stop(handle)
            except Exception as exc:
                errors.append(self.redact(str(exc)))
        return errors


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--startup-timeout", type=int, default=45)
    parser.add_argument("--report", type=Path, help="Write a credential-free JSON result to a new file.")
    args = parser.parse_args()
    if not 15 <= args.startup_timeout <= 300:
        parser.error("startup timeout must be between 15 and 300 seconds")
    if args.report and args.report.exists():
        parser.error("report destination already exists; choose a new file")
    def interrupted(signum, frame):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, interrupted)
    result = 1
    with tempfile.TemporaryDirectory(prefix="little-archive-native-check-") as folder:
        harness = NativeHarness(folder, args.startup_timeout)
        try:
            harness.run()
            harness.report["status"] = "passed"
            result = 0
        except (Exception, KeyboardInterrupt) as exc:
            message = "Native verification interrupted." if isinstance(exc, KeyboardInterrupt) else str(exc)
            harness.report.update({"status": "failed", "error": harness.redact(message)})
            print("FAIL " + harness.redact(message), file=sys.stderr)
            try:
                harness.diagnostics()
            except Exception:
                pass
        finally:
            errors = harness.cleanup()
            harness.report["cleanup"] = {"status": "failed" if errors else "passed", "errors": errors}
            if errors:
                harness.report["status"] = "failed"
                result = 1
                print("Native cleanup failed: " + "; ".join(errors), file=sys.stderr)
            harness.report["finished_at"] = timestamp()
    # Write only after the owned temporary checkout and all data were removed.
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        with args.report.open("x", encoding="utf-8") as stream:
            json.dump(harness.report, stream, indent=2)
            stream.write("\n")
    if result == 0:
        print("Native CLI verification passed; temporary servers, configuration, and data removed.")
    return result


if __name__ == "__main__":
    raise SystemExit(main())
