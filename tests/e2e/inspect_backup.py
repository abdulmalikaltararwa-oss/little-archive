"""Read a downloaded test backup without restoring it or trusting archive paths."""
import hashlib
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import zipfile


def inspect(path):
    with zipfile.ZipFile(path) as archive:
        assert archive.testzip() is None, "Backup ZIP failed its CRC checks"
        manifest = json.loads(archive.read("manifest.json"))
        assert manifest["format"] == "little-archive-backup"
        assert manifest["version"] == 1
        assert set(archive.namelist()) == set(manifest["files"]) | {"manifest.json"}
        for name, metadata in manifest["files"].items():
            content = archive.read(name)
            assert len(content) == metadata["size"], name
            assert hashlib.sha256(content).hexdigest() == metadata["sha256"], name
        with tempfile.TemporaryDirectory(prefix="little-archive-backup-check-") as directory:
            database_path = Path(directory) / "snapshot.sqlite3"
            database_path.write_bytes(archive.read("library.sqlite3"))
            with sqlite3.connect(database_path) as database:
                database.row_factory = sqlite3.Row
                database.execute("PRAGMA query_only=ON")
                database.execute("PRAGMA trusted_schema=OFF")
                assert database.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
                assert not database.execute("PRAGMA foreign_key_check").fetchall()
                result = {
                    "manifest": manifest,
                    "members": archive.namelist(),
                    "sessions": database.execute("SELECT count(*) FROM sessions").fetchone()[0],
                    "tokens": database.execute("SELECT count(*) FROM extension_tokens").fetchone()[0],
                    "password_hashes": database.execute("SELECT count(*) FROM meta WHERE key='password_hash'").fetchone()[0],
                    "items": [dict(row) for row in database.execute("SELECT id,url,title,notes,asset_hash FROM items")],
                }
    return result


if __name__ == "__main__":
    print(json.dumps(inspect(sys.argv[1]), ensure_ascii=False))
