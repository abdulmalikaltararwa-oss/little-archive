"""Full-access device tokens for native clients of a single-owner library.

They live in their own file, `devices.sqlite3`, beside the library, created when
the first device is paired. The library database and the portable backup format
are therefore untouched: a backup never contains them, and an earlier release
can still open and back up the library.

A token expires in two ways, both optional and both judged from this file alone:

* **Idle expiry** (default 180 days, `LA_DEVICE_TOKEN_IDLE_DAYS`, 0 turns it off): a token
  that has not been used for that long stops working and its row is removed. It bounds
  what a lost, sold or forgotten phone can do, without signing out anyone who opens the
  app now and then. Use is recorded at most once a minute, which is far finer than days.
* **Lifetime** (default none, `LA_DEVICE_TOKEN_MAX_DAYS`, or `expires_in_days` when a
  device is paired): a hard stop counted from when the token was created, however often
  it is used.

Tokens made by an earlier release have no expiry column. They keep working: the first
time this code opens a devices file it records the moment the policy began, and idle time
is counted from the later of that moment and the token's last use, so an upgrade never
signs a device out by itself. Only an operator who sets a lifetime ends old tokens early.
"""
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
import secrets
import sqlite3
from threading import RLock
from uuid import uuid4

from .security import token_hash
from .storage import now


PREFIX = "lad_"
LIMIT = 20
DEFAULT_IDLE_DAYS = 180
MAX_DAYS = 3650
SCHEMA = """
CREATE TABLE IF NOT EXISTS device_tokens(id TEXT PRIMARY KEY, name TEXT NOT NULL, hash TEXT UNIQUE NOT NULL, created_at TEXT NOT NULL, last_used_at TEXT, expires_at TEXT);
CREATE TABLE IF NOT EXISTS device_policy(key TEXT PRIMARY KEY, value TEXT NOT NULL);
"""


def _moment(value):
    """An ISO timestamp as an aware datetime; None when there is none (or it cannot be read)."""
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _stamp(moment):
    return moment.astimezone(timezone.utc).isoformat(timespec="seconds")


class DeviceTokens:
    def __init__(self, data_dir, idle_days=DEFAULT_IDLE_DAYS, max_days=0):
        for label, value in (("idle_days", idle_days), ("max_days", max_days)):
            if not isinstance(value, int) or isinstance(value, bool) or not 0 <= value <= MAX_DAYS:
                raise ValueError(f"{label} must be a whole number of days from 0 to {MAX_DAYS}.")
        self.path, self._lock = Path(data_dir) / "devices.sqlite3", RLock()
        self.idle_days, self.max_days = idle_days, max_days

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
                    self._upgrade(conn)
                    yield conn
            finally:
                conn.close()

    @staticmethod
    def _upgrade(conn):
        """Bring a file made by an earlier release up to this one, in place. It never touches a token's secret."""
        if not conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='device_tokens'").fetchone():
            return
        if "expires_at" not in {row[1] for row in conn.execute("PRAGMA table_info(device_tokens)")}:
            conn.execute("ALTER TABLE device_tokens ADD COLUMN expires_at TEXT")
        conn.execute("CREATE TABLE IF NOT EXISTS device_policy(key TEXT PRIMARY KEY, value TEXT NOT NULL)")
        conn.execute("INSERT OR IGNORE INTO device_policy(key,value) VALUES('policy_started_at',?)", (now(),))

    # -- expiry --------------------------------------------------------------
    def _expiry(self, conn, row):
        """When this token stops working unless it is used again: the earliest applicable limit, or None."""
        limits = []
        explicit = _moment(row["expires_at"])
        if explicit:
            limits.append(explicit)
        created = _moment(row["created_at"])
        if self.max_days and created:
            limits.append(created + timedelta(days=self.max_days))
        if self.idle_days:
            started = conn.execute("SELECT value FROM device_policy WHERE key='policy_started_at'").fetchone()
            reference = [moment for moment in (_moment(row["last_used_at"]), created, _moment(started[0]) if started else None) if moment]
            if reference:
                limits.append(max(reference) + timedelta(days=self.idle_days))
        return min(limits) if limits else None

    def _live(self, conn, row):
        """The listing form of a row, or None (and the row removed) once it has expired."""
        expiry = self._expiry(conn, row)
        if expiry is not None and expiry <= _moment(now()):
            conn.execute("DELETE FROM device_tokens WHERE id=?", (row["id"],))
            return None
        return {"id": row["id"], "name": row["name"], "created_at": row["created_at"], "last_used_at": row["last_used_at"], "expires_at": _stamp(expiry) if expiry else None}

    # -- the API -----------------------------------------------------------------
    def create(self, name, expires_in_days=None):
        """A new token, returned once; only its hash is stored."""
        if expires_in_days is not None and (not isinstance(expires_in_days, int) or isinstance(expires_in_days, bool) or not 1 <= expires_in_days <= MAX_DAYS):
            raise ValueError(f"Choose a lifetime of 1 to {MAX_DAYS} days, or none.")
        token, tid, stamp = PREFIX + secrets.token_urlsafe(32), str(uuid4()), now()
        explicit = _stamp(_moment(stamp) + timedelta(days=expires_in_days)) if expires_in_days else None
        with self._transaction() as c:
            c.executescript(SCHEMA)
            self._upgrade(c)
            for row in c.execute("SELECT * FROM device_tokens").fetchall():
                self._live(c, row)  # an expired device no longer counts toward the limit
            if c.execute("SELECT count(*) FROM device_tokens").fetchone()[0] >= LIMIT:
                raise ValueError(f"Revoke an unused device before adding another ({LIMIT}-device limit).")
            c.execute("INSERT INTO device_tokens(id,name,hash,created_at,expires_at) VALUES(?,?,?,?,?)", (tid, name, token_hash(token), stamp, explicit))
            expiry = self._expiry(c, c.execute("SELECT * FROM device_tokens WHERE id=?", (tid,)).fetchone())
        try:
            self.path.chmod(0o600)
        except OSError:
            pass
        return {"id": tid, "name": name, "token": token, "created_at": stamp, "expires_at": _stamp(expiry) if expiry else None}

    def authenticate(self, token):
        """The device row for a presented token, or None. Records use at most once a minute.

        An expired token is refused exactly like an unknown one, and its row is removed.
        """
        if not isinstance(token, str) or not token.startswith(PREFIX) or len(token) > 128 or not self.path.is_file():
            return None
        with self._transaction() as c:
            row = c.execute("SELECT * FROM device_tokens WHERE hash=?", (token_hash(token),)).fetchone()
            if not row:
                return None
            if self._live(c, row) is None:
                return None
            stamp = now()
            if (row["last_used_at"] or "")[:16] != stamp[:16]:
                c.execute("UPDATE device_tokens SET last_used_at=? WHERE id=?", (stamp, row["id"]))
                row = c.execute("SELECT * FROM device_tokens WHERE id=?", (row["id"],)).fetchone()
            return self._live(c, row)

    def list(self):
        if not self.path.is_file():
            return []
        with self._transaction() as c:
            rows = c.execute("SELECT * FROM device_tokens ORDER BY created_at DESC,id").fetchall()
            return [live for live in (self._live(c, row) for row in rows) if live]

    def revoke(self, device_id):
        if self.path.is_file():
            with self._transaction() as c:
                c.execute("DELETE FROM device_tokens WHERE id=?", (device_id,))

    def revoke_all(self):
        if self.path.is_file():
            with self._transaction() as c:
                c.execute("DELETE FROM device_tokens")
