"""Full-access device tokens for native clients of a single-owner library.

They live in their own file, `devices.sqlite3`, beside the library, created when
the first device is paired. The library database and the portable backup format
are therefore untouched: a backup never contains them, and an earlier release
can still open and back up the library.
"""
from contextlib import contextmanager
from pathlib import Path
import secrets
import sqlite3
from threading import RLock
from uuid import uuid4

from .security import token_hash
from .storage import now


PREFIX = "lad_"
LIMIT = 20
SCHEMA = "CREATE TABLE IF NOT EXISTS device_tokens(id TEXT PRIMARY KEY, name TEXT NOT NULL, hash TEXT UNIQUE NOT NULL, created_at TEXT NOT NULL, last_used_at TEXT);"


class DeviceTokens:
    def __init__(self, data_dir):
        self.path, self._lock = Path(data_dir) / "devices.sqlite3", RLock()

    @contextmanager
    def _transaction(self):
        with self._lock:
            conn = sqlite3.connect(self.path, timeout=15)
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA busy_timeout=15000")
            conn.execute("PRAGMA secure_delete=ON")  # a revoked token leaves no hash behind
            try:
                with conn:
                    yield conn
            finally:
                conn.close()

    def create(self, name):
        """A new token, returned once; only its hash is stored."""
        token, tid, stamp = PREFIX + secrets.token_urlsafe(32), str(uuid4()), now()
        with self._transaction() as c:
            c.executescript(SCHEMA)
            if c.execute("SELECT count(*) FROM device_tokens").fetchone()[0] >= LIMIT:
                raise ValueError(f"Revoke an unused device before adding another ({LIMIT}-device limit).")
            c.execute("INSERT INTO device_tokens(id,name,hash,created_at) VALUES(?,?,?,?)", (tid, name, token_hash(token), stamp))
        try:
            self.path.chmod(0o600)
        except OSError:
            pass
        return {"id": tid, "name": name, "token": token, "created_at": stamp}

    def authenticate(self, token):
        """The device row for a presented token, or None. Records use at most once a minute."""
        if not isinstance(token, str) or not token.startswith(PREFIX) or len(token) > 128 or not self.path.is_file():
            return None
        with self._transaction() as c:
            row = c.execute("SELECT id,name,created_at,last_used_at FROM device_tokens WHERE hash=?", (token_hash(token),)).fetchone()
            if not row:
                return None
            stamp = now()
            if (row["last_used_at"] or "")[:16] != stamp[:16]:
                c.execute("UPDATE device_tokens SET last_used_at=? WHERE id=?", (stamp, row["id"]))
            return dict(row)

    def list(self):
        if not self.path.is_file():
            return []
        with self._transaction() as c:
            return [dict(row) for row in c.execute("SELECT id,name,created_at,last_used_at FROM device_tokens ORDER BY created_at DESC,id")]

    def revoke(self, device_id):
        if self.path.is_file():
            with self._transaction() as c:
                c.execute("DELETE FROM device_tokens WHERE id=?", (device_id,))

    def revoke_all(self):
        if self.path.is_file():
            with self._transaction() as c:
                c.execute("DELETE FROM device_tokens")
