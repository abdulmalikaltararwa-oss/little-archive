"""What an account may use: the one-time unlock and a monthly deep-read allowance.

No payment provider is integrated. `set_unlocked` is the seam: a future
purchase-verification webhook calls it after it has verified a receipt itself.
Nothing in the request path can set the flag.
"""
from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import sqlite3
from threading import RLock


def usage_key(user_id):
    """Usage is counted under a hash, so a count can outlive its account for the rest of the month."""
    return hashlib.sha256(str(user_id).encode()).hexdigest()


def current_period(clock=None):
    """Allowances reset on the first day of each UTC month."""
    moment = clock() if clock else datetime.now(timezone.utc)
    return moment.strftime("%Y-%m")


class Entitlements:
    """The interface the server asks. `limit` is None when nothing is metered."""

    def is_unlocked(self, user_id) -> bool:
        raise NotImplementedError

    def set_unlocked(self, user_id, unlocked, source="manual") -> None:
        raise NotImplementedError

    def deep_reads(self, user_id) -> dict:
        """`{period, used, limit, remaining}` for the current month."""
        raise NotImplementedError

    def consume_deep_reads(self, user_id, count=1) -> bool:
        """Atomically record `count` deep reads; False (and no change) past the cap."""
        raise NotImplementedError

    def forget(self, user_id) -> None:
        """Remove what is stored about a deleted account. This month's usage count
        stays, under a hash, so deleting and returning does not refill an allowance."""
        raise NotImplementedError


class OwnerEntitlements(Entitlements):
    """A self-hosted owner runs their own hardware: unlocked, never metered."""

    def is_unlocked(self, user_id):
        return True

    def set_unlocked(self, user_id, unlocked, source="manual"):
        raise ValueError("A self-hosted library is always unlocked.")

    def deep_reads(self, user_id):
        return {"period": current_period(), "used": 0, "limit": None, "remaining": None}

    def consume_deep_reads(self, user_id, count=1):
        return True

    def forget(self, user_id):
        return None


class _Metered(Entitlements):
    def __init__(self, unlocked_limit, free_limit, clock=None):
        self.unlocked_limit, self.free_limit, self.clock = int(unlocked_limit), int(free_limit), clock

    def _limit(self, unlocked):
        return self.unlocked_limit if unlocked else self.free_limit

    @staticmethod
    def _report(period, used, limit):
        return {"period": period, "used": used, "limit": limit, "remaining": max(0, limit - used)}

    @staticmethod
    def _count(count):
        if not isinstance(count, int) or isinstance(count, bool) or count < 1:
            raise ValueError("Deep reads are counted in whole numbers of at least one.")
        return count


class MemoryEntitlements(_Metered):
    """Process-local implementation for tests and experiments; nothing persists."""

    def __init__(self, unlocked_limit=300, free_limit=0, clock=None):
        super().__init__(unlocked_limit, free_limit, clock)
        self._unlocked, self._used, self._lock = set(), {}, RLock()

    def is_unlocked(self, user_id):
        with self._lock:
            return user_id in self._unlocked

    def set_unlocked(self, user_id, unlocked, source="manual"):
        with self._lock:
            (self._unlocked.add if unlocked else self._unlocked.discard)(user_id)

    def deep_reads(self, user_id):
        with self._lock:
            period = current_period(self.clock)
            return self._report(period, self._used.get((usage_key(user_id), period), 0), self._limit(user_id in self._unlocked))

    def consume_deep_reads(self, user_id, count=1):
        count = self._count(count)
        with self._lock:
            period = current_period(self.clock)
            used = self._used.get((usage_key(user_id), period), 0)
            if used + count > self._limit(user_id in self._unlocked):
                return False
            # Earlier months are not kept once a new one is in use.
            self._used = {key: value for key, value in self._used.items() if key[1] == period}
            self._used[(usage_key(user_id), period)] = used + count
            return True

    def forget(self, user_id):
        with self._lock:
            self._unlocked.discard(user_id)


ENTITLEMENT_SCHEMA = """
CREATE TABLE IF NOT EXISTS entitlements(user_id TEXT PRIMARY KEY, unlocked INTEGER NOT NULL DEFAULT 0, source TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS deep_reads(user_hash TEXT NOT NULL, period TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(user_hash,period));
"""


class SQLiteEntitlements(_Metered):
    """Durable implementation in the hosted service's own account database."""

    def __init__(self, path, unlocked_limit=300, free_limit=0, clock=None):
        super().__init__(unlocked_limit, free_limit, clock)
        self.path, self._lock = path, RLock()
        with self._transaction() as c:
            c.executescript(ENTITLEMENT_SCHEMA)

    @contextmanager
    def _transaction(self):
        with self._lock:
            conn = sqlite3.connect(self.path, timeout=15)
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA busy_timeout=15000")
            conn.execute("PRAGMA secure_delete=ON")  # a forgotten account leaves no row remnants
            try:
                with conn:
                    yield conn
            finally:
                conn.close()

    @staticmethod
    def _is_unlocked(c, user_id):
        row = c.execute("SELECT unlocked FROM entitlements WHERE user_id=?", (user_id,)).fetchone()
        return bool(row and row[0])

    def is_unlocked(self, user_id):
        with self._transaction() as c:
            return self._is_unlocked(c, user_id)

    def set_unlocked(self, user_id, unlocked, source="manual"):
        stamp = datetime.now(timezone.utc).isoformat(timespec="seconds")
        with self._transaction() as c:
            c.execute("INSERT INTO entitlements(user_id,unlocked,source,updated_at) VALUES(?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET unlocked=excluded.unlocked,source=excluded.source,updated_at=excluded.updated_at", (user_id, int(bool(unlocked)), str(source)[:100], stamp))

    def deep_reads(self, user_id):
        period = current_period(self.clock)
        with self._transaction() as c:
            row = c.execute("SELECT used FROM deep_reads WHERE user_hash=? AND period=?", (usage_key(user_id), period)).fetchone()
            return self._report(period, row[0] if row else 0, self._limit(self._is_unlocked(c, user_id)))

    def consume_deep_reads(self, user_id, count=1):
        count = self._count(count)
        period = current_period(self.clock)
        with self._transaction() as c:
            c.execute("BEGIN IMMEDIATE")
            key = usage_key(user_id)
            row = c.execute("SELECT used FROM deep_reads WHERE user_hash=? AND period=?", (key, period)).fetchone()
            used = row[0] if row else 0
            if used + count > self._limit(self._is_unlocked(c, user_id)):
                return False
            # Earlier months are not kept once a new one is in use, for any account.
            c.execute("DELETE FROM deep_reads WHERE period<>?", (period,))
            c.execute("INSERT INTO deep_reads(user_hash,period,used) VALUES(?,?,?) ON CONFLICT(user_hash,period) DO UPDATE SET used=excluded.used", (key, period, used + count))
            return True

    def forget(self, user_id):
        with self._transaction() as c:
            c.execute("DELETE FROM entitlements WHERE user_id=?", (user_id,))
