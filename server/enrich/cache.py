"""Optional shared cache of what is derived from a public post itself. Off by default.

Why it exists: a post that many people save is the same public text for all of them, so
it should be read, transcribed and analysed once. Why it is safe to share:

* It is keyed by the canonical post URL, and an analysis entry additionally by a hash
  of the exact public text that was analysed. Another person only receives an analysis
  when their own copy of the post's public text is identical, so a client that submits
  made-up page text cannot change what anyone else is shown.
* Each kind of entry has an allowlist of fields (below). Anything else a caller passes,
  such as notes, tags, collections, favourites or who saved the post, is dropped on
  write, so it cannot be stored by mistake.
* Extraction and transcript entries are written only from the server's own read of the
  public post, never from client-supplied content.

It lives in its own SQLite file, separate from any library, so a deployment can place it
on shared storage and it never appears in a library backup.
"""
from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import sqlite3
from threading import RLock

# Field allowlists. A field that is not listed here can never reach the cache.
ALLOWED = {
    "extraction": {"schema", "kind", "source_url", "canonical_url", "content_type", "title", "creator", "creator_url", "caption", "thumbnail_url",
                   "video_url", "published_at", "duration_seconds", "language", "site_name", "sources", "warnings", "usable", "reason"},
    "transcript": {"text", "language", "seconds", "provider", "model"},
    "analysis": {"suggested_title", "summary", "topics", "content_type", "category", "evidence_level", "evidence_sources", "evidence_note", "model", "provider", "needs_review"},
}
MAX_PAYLOAD_BYTES = 64 * 1024


class PublicPostCache:
    def __init__(self, path, *, ttl_days: int = 30, clock=lambda: datetime.now(timezone.utc)):
        self.path = Path(path)
        self.ttl = timedelta(days=ttl_days)
        self.clock = clock
        self.lock = RLock()
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        with self._connect() as c:
            c.execute("CREATE TABLE IF NOT EXISTS public_posts(url TEXT NOT NULL, kind TEXT NOT NULL, input_hash TEXT NOT NULL DEFAULT '', payload TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, PRIMARY KEY(url,kind,input_hash))")
            c.execute("CREATE INDEX IF NOT EXISTS idx_public_posts_expiry ON public_posts(expires_at)")
        try:
            os.chmod(self.path, 0o600)
        except OSError:
            pass

    @contextmanager
    def _connect(self):
        with self.lock:
            conn = sqlite3.connect(self.path, timeout=10)
            conn.execute("PRAGMA busy_timeout=10000")
            try:
                with conn:
                    yield conn
            finally:
                conn.close()

    def _stamp(self, value: datetime) -> str:
        return value.isoformat(timespec="seconds")

    def get(self, url: str, kind: str, input_hash: str = "") -> dict | None:
        if kind not in ALLOWED:
            raise ValueError("Unknown cache entry kind.")
        with self._connect() as c:
            row = c.execute("SELECT payload,expires_at FROM public_posts WHERE url=? AND kind=? AND input_hash=?", (url, kind, input_hash)).fetchone()
            if not row:
                return None
            if row[1] <= self._stamp(self.clock()):
                c.execute("DELETE FROM public_posts WHERE url=? AND kind=? AND input_hash=?", (url, kind, input_hash))
                return None
        try:
            value = json.loads(row[0])
        except ValueError:
            return None
        return value if isinstance(value, dict) else None

    def put(self, url: str, kind: str, payload: dict, input_hash: str = "") -> bool:
        """Store only allowlisted fields. Returns False when nothing usable was left."""
        if kind not in ALLOWED:
            raise ValueError("Unknown cache entry kind.")
        clean = {k: v for k, v in payload.items() if k in ALLOWED[kind]}
        if not clean:
            return False
        blob = json.dumps(clean, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
        if len(blob.encode("utf-8")) > MAX_PAYLOAD_BYTES:
            return False
        now = self.clock()
        with self._connect() as c:
            c.execute(
                "INSERT INTO public_posts(url,kind,input_hash,payload,created_at,expires_at) VALUES(?,?,?,?,?,?) "
                "ON CONFLICT(url,kind,input_hash) DO UPDATE SET payload=excluded.payload,created_at=excluded.created_at,expires_at=excluded.expires_at",
                (url, kind, input_hash, blob, self._stamp(now), self._stamp(now + self.ttl)),
            )
        return True

    def purge_expired(self) -> int:
        with self._connect() as c:
            return c.execute("DELETE FROM public_posts WHERE expires_at<=?", (self._stamp(self.clock()),)).rowcount

    def stats(self) -> dict:
        with self._connect() as c:
            return {kind: count for kind, count in c.execute("SELECT kind, count(*) FROM public_posts GROUP BY kind")}
