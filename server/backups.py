"""Consistent, portable, authentication-free backups and bounded offline restore."""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import sqlite3
import tempfile
from uuid import uuid4
import zipfile

from .enrich.schema import ENRICH_SCHEMA
from .storage import now, json_text, SCHEMA


MAX_RESTORE_BYTES = 4 * 1024 * 1024 * 1024


def file_digest(path):
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def schema_signature(connection):
    import re
    return {(r[0], r[1], r[2], re.sub(r"\s+", " ", r[3] or "").strip()) for r in connection.execute("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'")}


def create_backup(store):
    # Container /tmp is intentionally a small tmpfs. A snapshot plus its ZIP
    # may be larger than that even for a modest thumbnail library, so stage on
    # the same persistent disk as the library, inside an owner-only directory.
    staging_root = store.root / ".backup-work"
    staging_root.mkdir(mode=0o700, exist_ok=True)
    staging_root.chmod(0o700)
    tmp = tempfile.TemporaryDirectory(prefix="snapshot-", dir=staging_root)
    folder = Path(tmp.name)
    snapshot = folder / "library.sqlite3"
    try:
        with store.lock:
            with sqlite3.connect(store.path) as src, sqlite3.connect(snapshot) as dest:
                src.backup(dest)
                dest.execute("PRAGMA secure_delete=ON")
                dest.execute("DELETE FROM sessions")
                dest.execute("DELETE FROM extension_tokens")
                dest.execute("DELETE FROM meta WHERE key='password_hash'")
                dest.commit()
                hashes = [r[0] for r in dest.execute("SELECT DISTINCT asset_hash FROM items WHERE asset_hash IS NOT NULL")]
                count = dest.execute("SELECT count(*) FROM items").fetchone()[0]
                dest.execute("PRAGMA journal_mode=DELETE")
                # Compact the sanitized snapshot so deleted authentication data
                # cannot survive in freelist pages of the downloadable file.
                dest.execute("VACUUM")
            files = {"library.sqlite3": snapshot}
            for digest in hashes:
                asset = store.assets / (digest + ".png")
                if not asset.is_file() or file_digest(asset) != digest:
                    raise ValueError("Backup could not verify a referenced local thumbnail.")
                files["assets/" + digest + ".png"] = asset
            manifest = {"format": "little-archive-backup", "version": 1, "schema_version": 1, "created_at": now(), "items": count, "files": {}}
            output = folder / "backup.zip"
            with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as z:
                for name, path in files.items():
                    manifest["files"][name] = {"sha256": file_digest(path), "size": path.stat().st_size}
                    z.write(path, name)
                z.writestr("manifest.json", json_text(manifest))
            with zipfile.ZipFile(output) as check:
                if check.testzip() is not None:
                    raise ValueError("Backup archive verification failed.")
        return tmp, output
    except Exception:
        tmp.cleanup()
        raise


def restore_backup(archive, destination):
    """Restore into a NEW directory only. Never modify a running library."""
    destination = Path(destination).resolve()
    if destination.exists():
        raise ValueError("Restore destination must not exist. Choose a new directory.")
    if Path(archive).stat().st_size > MAX_RESTORE_BYTES:
        raise ValueError("Backup exceeds the 4 GiB restore safety limit.")
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="little-archive-restore-", dir=destination.parent) as staging:
        target = Path(staging) / "library"
        target.mkdir(mode=0o700)
        with zipfile.ZipFile(archive) as z:
            infos = z.infolist()
            names = [x.filename for x in infos]
            if len(names) > 100000 or len(set(names)) != len(names) or sum(x.file_size for x in infos) > MAX_RESTORE_BYTES:
                raise ValueError("Backup has duplicate entries or exceeds resource limits.")
            if "manifest.json" not in names or z.getinfo("manifest.json").file_size > 16 * 1024 * 1024:
                raise ValueError("Backup manifest is missing or too large.")
            for i in infos:
                p = PurePosixPath(i.filename)
                mode = i.external_attr >> 16
                if p.is_absolute() or ".." in p.parts or "\\" in i.filename or (mode & 0o170000) == 0o120000:
                    raise ValueError("Unsafe backup path or symbolic link.")
                if i.file_size > 1000000 and i.file_size / max(i.compress_size, 1) > 500:
                    raise ValueError("Suspicious backup compression ratio.")
            manifest = json.loads(z.read("manifest.json"))
            if manifest.get("format") != "little-archive-backup" or manifest.get("version") != 1 or manifest.get("schema_version") != 1:
                raise ValueError("Unsupported backup format or schema.")
            expected = manifest.get("files", {})
            if not isinstance(expected, dict) or set(names) != set(expected) | {"manifest.json"} or "library.sqlite3" not in expected:
                raise ValueError("Backup manifest does not match its contents.")
            for name, info in expected.items():
                if name != "library.sqlite3" and not __import__("re").fullmatch(r"assets/[0-9a-f]{64}\.png", name):
                    raise ValueError("Unexpected backup member.")
                path = target / name
                path.parent.mkdir(exist_ok=True, mode=0o700)
                digest, size = hashlib.sha256(), 0
                with z.open(name) as src, open(path, "xb") as out:
                    for chunk in iter(lambda: src.read(1024 * 1024), b""):
                        size += len(chunk)
                        if size > info.get("size", -1):
                            raise ValueError("Backup expanded past its declared size.")
                        digest.update(chunk)
                        out.write(chunk)
                if size != info.get("size") or digest.hexdigest() != info.get("sha256"):
                    raise ValueError("Backup checksum or size mismatch.")
                path.chmod(0o600)
        dbpath = target / "library.sqlite3"
        with sqlite3.connect(dbpath) as c:
            c.execute("PRAGMA trusted_schema=OFF")
            with sqlite3.connect(":memory:") as reference:
                reference.executescript(SCHEMA)
                base = schema_signature(reference)
                reference.executescript(ENRICH_SCHEMA)
                # A backup is valid with or without the additive understanding tables.
                if schema_signature(c) not in (base, schema_signature(reference)):
                    raise ValueError("Backup database schema differs from the supported version.")
            if c.execute("PRAGMA integrity_check").fetchone()[0] != "ok" or c.execute("PRAGMA foreign_key_check").fetchall():
                raise ValueError("Database integrity check failed.")
            schema = c.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()
            if not schema or schema[0] != "1":
                raise ValueError("Unsupported database schema.")
            if c.execute("SELECT count(*) FROM items").fetchone()[0] != manifest.get("items"):
                raise ValueError("Backup item count does not match.")
            for (digest,) in c.execute("SELECT DISTINCT asset_hash FROM items WHERE asset_hash IS NOT NULL"):
                if not isinstance(digest, str) or not __import__("re").fullmatch(r"[0-9a-f]{64}", digest) or f"assets/{digest}.png" not in expected:
                    raise ValueError("Backup is missing a referenced asset.")
                if expected[f"assets/{digest}.png"]["sha256"] != digest:
                    raise ValueError("Asset identity mismatch.")
            c.execute("DELETE FROM sessions")
            c.execute("DELETE FROM extension_tokens")
            c.execute("DELETE FROM meta WHERE key='password_hash'")
            c.execute("UPDATE meta SET value=? WHERE key='instance_id'", (str(uuid4()),))
            c.execute("UPDATE import_runs SET status='cancelled',coverage='partial',token_id=NULL WHERE status='running'")
            c.execute("UPDATE ai_jobs SET status='failed',error='Restored backup: queue explicitly to resume.' WHERE status IN ('queued','running')")
            c.commit()
        os.rename(target, destination)
    return manifest
