#!/usr/bin/env python3
"""Exercise a real packaged image with disposable volumes and synthetic data.

Requires Python 3.10+ and a running local Docker Engine/Docker Desktop.
Build the image first, then run:
    python3 scripts/container_smoke.py --image little-archive:verify

No application checkout, .env, Compose project, or existing volume is modified.
The optional JSON report contains outcomes and image identity, never credentials.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
from http.cookiejar import CookieJar
import io
import json
import os
from pathlib import Path
import secrets
import shutil
import signal
import socket
import sqlite3
import struct
import subprocess
import sys
import tempfile
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import HTTPCookieProcessor, ProxyHandler, Request, build_opener
import zipfile
import zlib


LABEL = "io.little-archive.verification"
MAX_RESPONSE = 16 * 1024 * 1024


class VerificationError(RuntimeError):
    """A release gate did not pass."""


def require(condition, message):
    if not condition:
        raise VerificationError(message)


def timestamp():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def synthetic_png():
    """Build an original 4x4 RGB PNG without needing Pillow on the host."""
    def chunk(kind, data):
        return struct.pack("!I", len(data)) + kind + data + struct.pack("!I", zlib.crc32(kind + data) & 0xFFFFFFFF)
    pixels = b"".join(b"\0" + b"\x97\xb3\xa4" * 4 for _ in range(4))
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack("!2I5B", 4, 4, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(pixels)) + chunk(b"IEND", b"")


class Client:
    def __init__(self, origin):
        self.origin = origin
        self.cookies = CookieJar()
        # A proxy configured in the operator's shell must not receive test credentials.
        self.opener = build_opener(ProxyHandler({}), HTTPCookieProcessor(self.cookies))
        self.csrf = ""

    def request(self, method, path, *, payload=None, body=None, headers=None, expected=200):
        request_headers = dict(headers or {})
        if method not in {"GET", "HEAD"}:
            request_headers.setdefault("Origin", self.origin)
            if self.csrf:
                request_headers.setdefault("X-CSRF-Token", self.csrf)
        if payload is not None:
            body = json.dumps(payload, ensure_ascii=False).encode()
            request_headers.setdefault("Content-Type", "application/json")
        request = Request(self.origin + path, data=body, method=method, headers=request_headers)
        try:
            response = self.opener.open(request, timeout=30)
        except HTTPError as exc:
            response = exc
        with response:
            data = response.read(MAX_RESPONSE + 1)
            require(len(data) <= MAX_RESPONSE, "A test HTTP response exceeded the fixture limit.")
            require(response.status == expected, f"{method} {path.split('?')[0]} returned HTTP {response.status}; expected {expected}.")
            return data

    def json(self, method, path, **kwargs):
        try:
            return json.loads(self.request(method, path, **kwargs))
        except json.JSONDecodeError as exc:
            raise VerificationError(f"{method} {path.split('?')[0]} did not return JSON.") from exc

    def login(self, password):
        result = self.json("POST", "/api/auth/login", payload={"password": password})
        require(result.get("authenticated") is True and bool(result.get("csrf_token")), "Login did not establish an owner session.")
        self.csrf = result["csrf_token"]
        require(any(cookie.name == "little_archive_session" for cookie in self.cookies), "Login did not set the owner cookie.")

    def cookie(self):
        return next(cookie.value for cookie in self.cookies if cookie.name == "little_archive_session")


class Harness:
    def __init__(self, args, temporary):
        self.args = args
        self.temporary = Path(temporary)
        self.run_id = secrets.token_hex(10)
        self.prefix = "little-archive-check-" + self.run_id
        self.containers = []
        self.volumes = []
        self.secrets = []
        self.report = {
            "format": "little-archive-container-verification",
            "started_at": timestamp(),
            "status": "running",
            "image": args.image,
            "requested_platform": args.platform or "native",
            "checks": [],
        }

    def redact(self, value):
        for secret in sorted(self.secrets, key=len, reverse=True):
            if secret:
                value = value.replace(secret, "[redacted]")
        return value

    def docker(self, *args, data=None, timeout=90, check=True):
        try:
            result = subprocess.run(
                ["docker", *args], input=data, stdout=subprocess.PIPE,
                stderr=subprocess.PIPE, timeout=timeout, check=False,
            )
        except subprocess.TimeoutExpired as exc:
            raise VerificationError(f"Docker {args[0]} exceeded {timeout} seconds.") from exc
        if check and result.returncode:
            detail = self.redact(result.stderr.decode(errors="replace")[-1800:]).strip()
            raise VerificationError(f"Docker {args[0]} failed (exit {result.returncode}): {detail}")
        return result

    def record(self, name, **details):
        self.report["checks"].append({"name": name, "status": "passed", **details})
        print("PASS " + name, flush=True)

    def inspect(self, kind, name):
        result = self.docker(kind, "inspect", name, check=False)
        if result.returncode:
            message = result.stderr.decode(errors="replace")
            if any(value in message.lower() for value in ("no such object", "no such container", "no such volume", "no such image")):
                return None
            raise VerificationError(f"Docker {kind} inspection failed: " + self.redact(message[-1200:]).strip())
        return json.loads(result.stdout)[0]

    def new_volume(self, role):
        name = self.prefix + "-" + role
        require(self.inspect("volume", name) is None, "A generated test volume name already exists; no existing volume was modified.")
        self.volumes.append(name)
        self.docker("volume", "create", "--label", LABEL + "=" + self.run_id, name)
        return name

    def runtime_args(self, name, volume):
        args = [
            "--name", name, "--label", LABEL + "=" + self.run_id,
            "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
            "--tmpfs", "/tmp:size=512m,mode=1777",
            "--mount", "type=volume,src=" + volume + ",dst=/data",
        ]
        if self.args.platform:
            args += ["--platform", self.args.platform]
        return args

    def start(self, role, volume, password, data_dir="/data"):
        name = self.prefix + "-" + role
        require(self.inspect("container", name) is None, "A generated test container name already exists.")
        with socket.socket() as reservation:
            reservation.bind(("127.0.0.1", 0))
            port = reservation.getsockname()[1]
        origin = f"http://127.0.0.1:{port}"
        env_path = self.temporary / (role + ".env")
        with open(env_path, "x", encoding="utf-8") as stream:
            os.chmod(env_path, 0o600)
            stream.write(f"LA_ADMIN_PASSWORD={password}\nLA_PUBLIC_URL={origin}\nLA_DATA_DIR={data_dir}\nLA_OLLAMA_URL=\nLA_OLLAMA_MODEL=\n")
        self.containers.append(name)
        self.docker(
            "run", "--detach", *self.runtime_args(name, volume),
            "--env-file", str(env_path), "--publish", f"127.0.0.1:{port}:8787", self.args.image,
        )
        client = Client(origin)
        self.wait_ready(name, client)
        self.verify_hardening(name)
        return name, client

    def wait_ready(self, name, client):
        deadline = time.monotonic() + self.args.startup_timeout
        while time.monotonic() < deadline:
            state = self.inspect("container", name)
            require(state and state["State"]["Running"], "The packaged server exited before becoming ready.")
            try:
                result = client.json("GET", "/api/health")
                if result.get("status") == "ok":
                    self.report.setdefault("application_version", result.get("version"))
                    return
            except (URLError, TimeoutError, OSError, VerificationError):
                pass
            time.sleep(0.5)
        raise VerificationError("The packaged server did not become ready within the startup limit.")

    def verify_hardening(self, name):
        state = self.inspect("container", name)
        config = state["HostConfig"]
        require(config.get("ReadonlyRootfs") is True, "The container root filesystem is writable.")
        require("ALL" in {value.upper() for value in config.get("CapDrop") or []}, "The container did not drop all Linux capabilities.")
        require(any(value in {"no-new-privileges", "no-new-privileges:true", "no-new-privileges=true"} for value in config.get("SecurityOpt") or []), "The container lacks no-new-privileges.")
        require("/tmp" in (config.get("Tmpfs") or {}), "The container lacks the configured /tmp tmpfs.")
        probe = """import json, os, platform
from pathlib import Path
status = dict(line.split(':', 1) for line in Path('/proc/self/status').read_text().splitlines() if ':' in line)
print(json.dumps({'uid': os.getuid(), 'gid': os.getgid(), 'machine': platform.machine(), 'capabilities': int(status['CapEff'].strip(), 16), 'no_new_privileges': int(status['NoNewPrivs'].strip()), 'root_read_only': bool(os.statvfs('/app').f_flag & os.ST_RDONLY)}))
"""
        identity = json.loads(self.docker("exec", name, "python", "-c", probe).stdout)
        # These fields contain no credentials. Retain them even when a strict
        # assertion fails so architecture/emulation failures can be diagnosed.
        self.report["runtime"] = identity
        print("Runtime hardening probe: " + json.dumps(identity, sort_keys=True), flush=True)
        require(identity["uid"] != 0, "The image ran as root.")
        require(identity["capabilities"] == 0, f"Runtime effective capabilities must be zero; observed {identity['capabilities']}.")
        require(identity["no_new_privileges"] == 1, f"Runtime NoNewPrivs must be 1; observed {identity['no_new_privileges']}.")
        require(identity["root_read_only"] is True, f"Runtime /app filesystem must be read-only; observed {identity['root_read_only']}.")
        if self.args.platform:
            machine = {"linux/amd64": {"x86_64", "amd64"}, "linux/arm64": {"aarch64", "arm64"}}[self.args.platform]
            require(identity["machine"].lower() in machine, "The runtime architecture does not match the requested image platform.")

    def snapshot(self, client):
        value = client.json("GET", "/api/export?format=json")
        return {
            "items": sorted(value["items"], key=lambda row: row["id"]),
            "collections": sorted(value["collections"], key=lambda row: row["id"]),
        }

    def verify_backup(self, data, expected_count, forbidden_values):
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            require(archive.testzip() is None, "The downloaded backup contains a corrupt ZIP member.")
            manifest = json.loads(archive.read("manifest.json"))
            require(manifest.get("format") == "little-archive-backup" and manifest["items"] == expected_count, "The backup manifest does not describe the expected library.")
            require(set(archive.namelist()) == {"manifest.json", *manifest["files"]}, "The backup contains unexpected entries.")
            for name, metadata in manifest["files"].items():
                body = archive.read(name)
                require(len(body) == metadata["size"] and hashlib.sha256(body).hexdigest() == metadata["sha256"], "A downloaded backup member does not match its manifest.")
            db_bytes = archive.read("library.sqlite3")
            require(any(name.startswith("assets/") for name in manifest["files"]), "The backup omitted the local thumbnail.")
        for value in forbidden_values:
            require(value.encode() not in db_bytes, "Authentication material survived in the downloadable database bytes.")
        path = self.temporary / "downloaded-library.sqlite3"
        path.write_bytes(db_bytes)
        with sqlite3.connect(path) as connection:
            require(connection.execute("PRAGMA integrity_check").fetchone()[0] == "ok", "The downloaded database failed its integrity check.")
            require(connection.execute("SELECT count(*) FROM sessions").fetchone()[0] == 0, "A backup contained active owner sessions.")
            require(connection.execute("SELECT count(*) FROM extension_tokens").fetchone()[0] == 0, "A backup contained extension credentials.")
            require(connection.execute("SELECT value FROM meta WHERE key='password_hash'").fetchone() is None, "A backup contained the owner password hash.")

    def restore(self, volume, backup):
        name = self.prefix + "-restore-helper"
        self.containers.append(name)
        # Feed only synthetic backup bytes through stdin. This avoids host/VM
        # bind-mount ownership assumptions on Linux and Docker Desktop.
        code = """from pathlib import Path
import subprocess, sys
path = Path('/data/.verification-input.zip')
try:
    raw = sys.stdin.buffer.read(16 * 1024 * 1024 + 1)
    if len(raw) > 16 * 1024 * 1024:
        raise SystemExit('Synthetic backup exceeded its test limit.')
    with path.open('xb') as stream:
        path.chmod(0o600)
        stream.write(raw)
    subprocess.run([sys.executable, '-m', 'server.cli', 'restore', str(path), '--destination', '/data/restored'], check=True)
finally:
    path.unlink(missing_ok=True)
"""
        self.docker("run", "--rm", "--interactive", "--network", "none", *self.runtime_args(name, volume), self.args.image, "python", "-c", code, data=backup, timeout=180)

    def run(self):
        image = self.inspect("image", self.args.image)
        require(image is not None, "The requested image is not present locally. Build or load it before running verification.")
        self.report.update({"image_id": image["Id"], "image_platform": image["Os"] + "/" + image["Architecture"]})
        if self.args.platform:
            require(self.report["image_platform"] == self.args.platform, "The locally loaded image architecture differs from --platform.")
        original_password, restored_password = secrets.token_urlsafe(30), secrets.token_urlsafe(30)
        self.secrets += [original_password, restored_password]
        source_volume, recovery_volume = self.new_volume("source-data"), self.new_volume("recovery-data")
        source_name, owner = self.start("source", source_volume, original_password)
        self.record("hardened_packaged_image_start", platform=self.report["image_platform"])
        anonymous = Client(owner.origin)
        anonymous.request("GET", "/api/items", expected=401)
        owner.login(original_password)
        original_cookie = owner.cookie()
        self.secrets += [original_cookie, owner.csrf]
        self.record("owner_login_and_private_library_boundary")

        collection = owner.json("POST", "/api/collections", payload={"name": "Container check shelf", "color": "#735A93"})
        owner.json("POST", "/api/collections", payload={"name": "Empty recovery shelf", "color": "#D5A7AC"})
        item = owner.json("POST", "/api/items", payload={"url": "https://example.com/container-check", "title": "Persistent lemon note", "notes": "Written before restart — محفوظ", "tags": ["container", "استعادة"], "collection_ids": [collection["id"]]})
        iid = item["id"]
        owner.json("PATCH", "/api/items/" + iid, payload={"favorite": True, "status": "done", "needs_review": False})
        item = owner.json("POST", f"/api/items/{iid}/thumbnail", body=synthetic_png(), headers={"Content-Type": "image/png"})
        thumbnail_url = item["thumbnail_url"]
        thumbnail = owner.request("GET", thumbnail_url)
        anonymous.request("GET", thumbnail_url, expected=401)
        imported = [
            {"url": "https://www.instagram.com/p/CONTAINERSMOKE/", "title": "Synthetic saved recipe", "source_account": "container-fixture", "notes": "Imported synthetic note", "tags": ["recipe"], "favorite": True, "status": "to_revisit", "collections": [{"name": "Recipes", "kind": "source", "source_key": "saved-recipes"}]},
            {"url": "https://www.tiktok.com/@synthetic/video/1234567890123456789", "title": "Synthetic saved tutorial", "source_account": "container-fixture", "collections": [{"name": "Watch later", "kind": "source", "source_key": "saved-tutorials"}]},
        ]
        result = owner.json("POST", "/api/imports/file?filename=synthetic.json", body=json.dumps(imported).encode(), headers={"Content-Type": "application/json"})
        require(result["created"] == 2 and result["skipped"] == 0, "The packaged file import did not create both synthetic records.")
        repeated = owner.json("POST", "/api/imports/file?filename=synthetic.json", body=json.dumps(imported).encode(), headers={"Content-Type": "application/json"})
        require(repeated["created"] == 0 and repeated["skipped"] == 0, "A repeated file import created duplicates or skipped records.")
        require(owner.json("GET", "/api/stats")["total"] == 3, "The packaged instance has an unexpected item count.")
        require(owner.json("GET", "/api/items?" + urlencode({"q": "محفوظ"}))["total"] == 1, "Search did not find the persisted Unicode note.")
        expected = self.snapshot(owner)
        self.record("create_edit_import_deduplicate_search_and_local_asset", items=3, collections=len(expected["collections"]))

        token = owner.json("POST", "/api/extension/tokens", payload={"name": "Synthetic recovery check"})["token"]
        self.secrets.append(token)
        bearer = {"Authorization": "Bearer " + token}
        extension = Client(owner.origin)
        instance_id = extension.json("GET", "/api/extension/status", headers=bearer)["instance_id"]
        extension.request("GET", "/api/items", headers=bearer, expected=401)
        unfinished = extension.json("POST", "/api/extension/imports", payload={"platform": "instagram", "source_account": "container-fixture", "scope": "Synthetic interrupted view"}, headers=bearer)["run_id"]
        password_hash = self.docker("exec", source_name, "python", "-c", "import sqlite3; c=sqlite3.connect('/data/library.sqlite3'); print(c.execute(\"SELECT value FROM meta WHERE key='password_hash'\").fetchone()[0])").stdout.decode().strip()
        self.secrets.append(password_hash)
        backup = owner.request("GET", "/api/backup")
        forbidden = [password_hash, owner.csrf, hashlib.sha256(original_cookie.encode()).hexdigest(), hashlib.sha256(token.encode()).hexdigest()]
        self.verify_backup(backup, 3, forbidden)
        self.record("consistent_backup_with_assets_and_without_authentication")

        self.docker("restart", "--time", "20", source_name, timeout=60)
        self.wait_ready(source_name, owner)
        require(self.snapshot(owner) == expected, "Restart changed saved records, annotations, or collections.")
        require(owner.request("GET", thumbnail_url) == thumbnail, "Restart changed the local thumbnail.")
        require(extension.json("GET", "/api/extension/status", headers=bearer)["instance_id"] == instance_id, "Restart unexpectedly changed the instance identity.")
        self.record("restart_preserves_library_asset_session_and_identity")
        self.docker("stop", "--time", "20", source_name, timeout=60)

        self.restore(recovery_volume, backup)
        _, recovered = self.start("recovered", recovery_volume, restored_password, data_dir="/data/restored")
        stale = Client(recovered.origin)
        stale.request("GET", "/api/items", headers={"Cookie": "little_archive_session=" + original_cookie}, expected=401)
        stale.request("GET", "/api/extension/status", headers=bearer, expected=401)
        stale.request("POST", "/api/auth/login", payload={"password": original_password}, expected=401)
        recovered.login(restored_password)
        self.secrets += [recovered.cookie(), recovered.csrf]
        require(self.snapshot(recovered) == expected, "Restore changed saved records, annotations, memberships, or empty collections.")
        require(recovered.request("GET", thumbnail_url) == thumbnail, "Restore did not retain the local thumbnail bytes.")
        require(recovered.json("GET", "/api/extension/tokens")["tokens"] == [], "Restore resurrected an extension token.")
        runs = recovered.json("GET", "/api/imports")["imports"]
        require(next(run for run in runs if run["id"] == unfinished)["status"] == "cancelled", "Restore did not cancel the interrupted import.")
        new_token = recovered.json("POST", "/api/extension/tokens", payload={"name": "Fresh restored token"})["token"]
        self.secrets.append(new_token)
        identity = Client(recovered.origin).json("GET", "/api/extension/status", headers={"Authorization": "Bearer " + new_token})["instance_id"]
        require(identity != instance_id, "Restore did not create a new instance identity.")
        self.record("offline_restore_fresh_volume_preserves_content_and_assets")
        self.record("restore_requires_fresh_password_sessions_and_extension_tokens")

    def failure_logs(self):
        for name in self.containers:
            state = self.inspect("container", name)
            if state and (state.get("Config", {}).get("Labels") or {}).get(LABEL) == self.run_id:
                result = self.docker("logs", "--tail", "70", name, check=False)
                output = self.redact((result.stdout + result.stderr).decode(errors="replace")[-6000:])
                if output.strip():
                    print(f"Container diagnostics ({name}):\n{output}", file=sys.stderr)

    def cleanup(self):
        errors = []
        for kind, names in (("container", self.containers), ("volume", self.volumes)):
            for name in reversed(names):
                try:
                    state = self.inspect(kind, name)
                    if state is None:
                        continue
                    labels = state.get("Config", {}).get("Labels") if kind == "container" else state.get("Labels")
                    require((labels or {}).get(LABEL) == self.run_id, "Cleanup refused a resource without this run's ownership label.")
                    command = ("rm", "--force", name) if kind == "container" else ("volume", "rm", name)
                    self.docker(*command, timeout=60)
                except Exception as exc:
                    errors.append(self.redact(str(exc)))
        return errors


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--image", required=True, help="An already-built local Little Archive image; never pushed or removed.")
    parser.add_argument("--platform", choices=["linux/amd64", "linux/arm64"], help="Require this image and runtime architecture.")
    parser.add_argument("--startup-timeout", type=int, default=90, help="Seconds to wait for each packaged server startup (default: 90).")
    parser.add_argument("--report", type=Path, help="Write a credential-free JSON result to a new file.")
    args = parser.parse_args()
    if not 15 <= args.startup_timeout <= 600:
        parser.error("startup timeout must be between 15 and 600 seconds")
    if args.report and args.report.exists():
        parser.error("report destination already exists; choose a new file")
    if shutil.which("docker") is None:
        print("Container verification requires Docker Engine or Docker Desktop and the docker CLI.", file=sys.stderr)
        return 2
    def interrupted(signum, frame):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, interrupted)
    with tempfile.TemporaryDirectory(prefix="little-archive-container-check-") as temporary:
        harness = Harness(args, temporary)
        result = 1
        try:
            harness.docker("info", "--format", "{{.ServerVersion}}", timeout=20)
            harness.run()
            harness.report["status"] = "passed"
            result = 0
        except (Exception, KeyboardInterrupt) as exc:
            reason = "Verification interrupted." if isinstance(exc, KeyboardInterrupt) else str(exc)
            harness.report.update({"status": "failed", "error": harness.redact(reason)})
            print("FAIL " + harness.redact(reason), file=sys.stderr)
            try:
                harness.failure_logs()
            except (OSError, ValueError, VerificationError):
                pass
        finally:
            cleanup_errors = harness.cleanup()
            harness.report["cleanup"] = {"status": "failed" if cleanup_errors else "passed", "errors": cleanup_errors}
            if cleanup_errors:
                harness.report["status"] = "failed"
                result = 1
                print("Cleanup needs attention: " + "; ".join(cleanup_errors), file=sys.stderr)
            harness.report["finished_at"] = timestamp()
            if args.report:
                args.report.parent.mkdir(parents=True, exist_ok=True)
                with args.report.open("x", encoding="utf-8") as stream:
                    json.dump(harness.report, stream, indent=2)
                    stream.write("\n")
        if result == 0:
            print("Packaged container verification passed; disposable containers and volumes removed.")
        return result


if __name__ == "__main__":
    raise SystemExit(main())
