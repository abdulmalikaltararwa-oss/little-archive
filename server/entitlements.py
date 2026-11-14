"""What an account may use: the one-time unlock, a monthly deep-read allowance, and a daily and monthly allowance of
ordinary AI suggestions.

The unlock is set by `set_unlocked`, which only server code calls: `server/purchases` after it has verified a store's
proof itself, or an operator. Nothing in the request path sets the flag from what a client says.

Three meters, all per account, all on UTC calendar periods, all counted under a hash of the account id so a count outlives
its account for the rest of the period (deleting and coming back does not refill an allowance):

* deep reads, monthly (`consume_deep_reads` / `refund_deep_reads`);
* suggestions, daily and monthly (`reserve_suggestions` / `refund_suggestions`). Each has its own limit for an account that
  has not unlocked and for one that has. A reservation is granted in part when the room left is smaller than the request.
  Failed work is refunded from the daily and monthly counts but not from an attempts count that is never refunded and is capped
  at three times the daily limit, so work that fails after it has cost something cannot be repeated without end.
"""
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import hashlib
import sqlite3
from threading import RLock


ATTEMPT_FACTOR = 3  # attempts counted per day, as a multiple of the daily limit; never refunded


def usage_key(user_id):
    """Usage is counted under a hash, so a count can outlive its account for the rest of the month."""
    return hashlib.sha256(str(user_id).encode()).hexdigest()


def _moment(clock=None):
    moment = clock() if clock else datetime.now(timezone.utc)
    return moment


def current_period(clock=None):
    """Allowances reset on the first day of each UTC month."""
    return _moment(clock).strftime("%Y-%m")


def current_day(clock=None):
    return _moment(clock).strftime("%Y-%m-%d")


def next_reset(kind, clock=None):
    """When a daily or monthly count starts again, as an ISO time in UTC. (`clock` tests may give only strftime.)"""
    moment = _moment(clock)
    try:
        if kind == "daily":
            nxt = (moment + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
        else:
            nxt = (moment.replace(day=1, hour=0, minute=0, second=0, microsecond=0) + timedelta(days=32)).replace(day=1)
        return nxt.astimezone(timezone.utc).isoformat(timespec="seconds")
    except (AttributeError, TypeError, ValueError):
        return None


@dataclass(frozen=True)
class SuggestionLimits:
    """Ordinary AI suggestions (titles, folders, summaries) per account: what each kind of account may queue."""
    free_daily: int = 25
    free_monthly: int = 300
    unlocked_daily: int = 200
    unlocked_monthly: int = 3000

    def for_account(self, unlocked):
        return (self.unlocked_daily, self.unlocked_monthly) if unlocked else (self.free_daily, self.free_monthly)


@dataclass(frozen=True)
class Reservation:
    """What `reserve_suggestions` granted. `blocked` names what stopped a full grant: daily, monthly, attempts or not_included."""
    granted: int
    wanted: int
    blocked: str | None
    suggestions: dict   # the account's counts after the reservation (the same shape `suggestions()` returns)

    @property
    def refused(self):
        return self.granted < self.wanted


def plan_reservation(wanted, limits, used):
    """Pure arithmetic shared by every implementation: how many of `wanted` fit, and what stopped the rest."""
    daily, monthly = limits
    room = {"daily": daily - used["daily"], "monthly": monthly - used["monthly"], "attempts": daily * ATTEMPT_FACTOR - used["attempts"]}
    granted = max(0, min(wanted, *room.values()))
    blocked = None
    if granted < wanted:
        if daily <= 0 or monthly <= 0:
            blocked = "not_included"
        else:
            blocked = min(("daily", "monthly", "attempts"), key=lambda name: room[name])
    return granted, blocked


class Entitlements:
    """The interface the server asks. `limit` is None when nothing is metered."""

    def is_unlocked(self, user_id) -> bool:
        raise NotImplementedError

    def unlock_source(self, user_id):
        """Who set the unlock (`apple`, `google`, `manual`, ...), or None when the account is not unlocked."""
        raise NotImplementedError

    def set_unlocked(self, user_id, unlocked, source="manual") -> None:
        raise NotImplementedError

    def deep_reads(self, user_id) -> dict:
        """`{period, used, limit, remaining}` for the current month."""
        raise NotImplementedError

    def consume_deep_reads(self, user_id, count=1) -> bool:
        """Atomically record `count` deep reads; False (and no change) past the cap."""
        raise NotImplementedError

    def refund_deep_reads(self, user_id, count=1) -> None:
        """Give back deep reads whose work failed, without going below zero for this month."""
        raise NotImplementedError

    def suggestions(self, user_id) -> dict:
        """`{daily: {period, used, limit, remaining, resets_at}, monthly: {...}}`."""
        raise NotImplementedError

    def reserve_suggestions(self, user_id, wanted) -> Reservation:
        raise NotImplementedError

    def refund_suggestions(self, user_id, count, unspent=False) -> None:
        """Give back daily and monthly counts for work that failed. `unspent=True` is for a reservation that was never used
        for a job at all, and also gives back the attempt, which a failed job keeps."""
        raise NotImplementedError

    def forget(self, user_id) -> None:
        """Remove what is stored about a deleted account. This month's usage count
        stays, under a hash, so deleting and returning does not refill an allowance."""
        raise NotImplementedError


class OwnerEntitlements(Entitlements):
    """A self-hosted owner runs their own hardware: unlocked, never metered."""

    def is_unlocked(self, user_id):
        return True

    def unlock_source(self, user_id):
        return "owner"

    def set_unlocked(self, user_id, unlocked, source="manual"):
        raise ValueError("A self-hosted library is always unlocked.")

    def deep_reads(self, user_id):
        return {"period": current_period(), "used": 0, "limit": None, "remaining": None}

    def consume_deep_reads(self, user_id, count=1):
        return True

    def refund_deep_reads(self, user_id, count=1):
        return None

    def suggestions(self, user_id):
        return {name: {"period": period(), "used": 0, "limit": None, "remaining": None, "resets_at": None} for name, period in (("daily", current_day), ("monthly", current_period))}

    def reserve_suggestions(self, user_id, wanted):
        return Reservation(wanted, wanted, None, self.suggestions(user_id))

    def refund_suggestions(self, user_id, count, unspent=False):
        return None

    def forget(self, user_id):
        return None


class _Metered(Entitlements):
    def __init__(self, unlocked_limit, free_limit, clock=None, suggestion_limits=None):
        self.unlocked_limit, self.free_limit, self.clock = int(unlocked_limit), int(free_limit), clock
        self.suggestion_limits = suggestion_limits or SuggestionLimits()

    def _limit(self, unlocked):
        return self.unlocked_limit if unlocked else self.free_limit

    @staticmethod
    def _report(period, used, limit):
        return {"period": period, "used": used, "limit": limit, "remaining": max(0, limit - used)}

    def _suggestion_report(self, unlocked, used):
        daily, monthly = self.suggestion_limits.for_account(unlocked)
        return {
            "daily": {**self._report(current_day(self.clock), used["daily"], daily), "resets_at": next_reset("daily", self.clock)},
            "monthly": {**self._report(current_period(self.clock), used["monthly"], monthly), "resets_at": next_reset("monthly", self.clock)},
        }

    @staticmethod
    def _count(count):
        if not isinstance(count, int) or isinstance(count, bool) or count < 1:
            raise ValueError("Deep reads are counted in whole numbers of at least one.")
        return count

    @staticmethod
    def _natural(count):
        if not isinstance(count, int) or isinstance(count, bool) or count < 0:
            raise ValueError("Suggestions are counted in whole numbers.")
        return count


class MemoryEntitlements(_Metered):
    """Process-local implementation for tests and experiments; nothing persists."""

    def __init__(self, unlocked_limit=300, free_limit=0, clock=None, suggestion_limits=None):
        super().__init__(unlocked_limit, free_limit, clock, suggestion_limits)
        self._unlocked, self._used, self._lock, self._counts = {}, {}, RLock(), {}

    def is_unlocked(self, user_id):
        with self._lock:
            return user_id in self._unlocked

    def unlock_source(self, user_id):
        with self._lock:
            return self._unlocked.get(user_id)

    def set_unlocked(self, user_id, unlocked, source="manual"):
        with self._lock:
            if unlocked:
                self._unlocked[user_id] = str(source)[:100]
            else:
                self._unlocked.pop(user_id, None)

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

    def refund_deep_reads(self, user_id, count=1):
        count = self._count(count)
        with self._lock:
            key = (usage_key(user_id), current_period(self.clock))
            if key in self._used:
                self._used[key] = max(0, self._used[key] - count)

    # suggestions: counts live under (hash, meter, period); a new period drops the earlier ones
    def _used_suggestions(self, key):
        return {"daily": self._counts.get((key, "day", current_day(self.clock)), 0), "monthly": self._counts.get((key, "month", current_period(self.clock)), 0),
                "attempts": self._counts.get((key, "attempts", current_day(self.clock)), 0)}

    def suggestions(self, user_id):
        with self._lock:
            return self._suggestion_report(user_id in self._unlocked, self._used_suggestions(usage_key(user_id)))

    def reserve_suggestions(self, user_id, wanted):
        wanted = self._natural(wanted)
        with self._lock:
            key, unlocked = usage_key(user_id), user_id in self._unlocked
            used = self._used_suggestions(key)
            granted, blocked = plan_reservation(wanted, self.suggestion_limits.for_account(unlocked), used)
            day, month = current_day(self.clock), current_period(self.clock)
            self._counts = {k: v for k, v in self._counts.items() if k[2] in {day, month}}
            for meter, period in (("day", day), ("month", month), ("attempts", day)):
                self._counts[(key, meter, period)] = self._counts.get((key, meter, period), 0) + granted
            return Reservation(granted, wanted, blocked, self._suggestion_report(unlocked, self._used_suggestions(key)))

    def refund_suggestions(self, user_id, count, unspent=False):
        count = self._natural(count)
        with self._lock:
            key = usage_key(user_id)
            for meter, period in (("day", current_day(self.clock)), ("month", current_period(self.clock))) + ((("attempts", current_day(self.clock)),) if unspent else ()):
                if (key, meter, period) in self._counts:
                    self._counts[(key, meter, period)] = max(0, self._counts[(key, meter, period)] - count)

    def forget(self, user_id):
        with self._lock:
            self._unlocked.pop(user_id, None)


ENTITLEMENT_SCHEMA = """
CREATE TABLE IF NOT EXISTS entitlements(user_id TEXT PRIMARY KEY, unlocked INTEGER NOT NULL DEFAULT 0, source TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS deep_reads(user_hash TEXT NOT NULL, period TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(user_hash,period));
CREATE TABLE IF NOT EXISTS suggestion_counts(user_hash TEXT NOT NULL, meter TEXT NOT NULL, period TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(user_hash,meter,period));
"""


class SQLiteEntitlements(_Metered):
    """Durable implementation in the hosted service's own account database."""

    def __init__(self, path, unlocked_limit=300, free_limit=0, clock=None, suggestion_limits=None):
        super().__init__(unlocked_limit, free_limit, clock, suggestion_limits)
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

    def unlock_source(self, user_id):
        with self._transaction() as c:
            row = c.execute("SELECT source FROM entitlements WHERE user_id=? AND unlocked=1", (user_id,)).fetchone()
            return row[0] if row else None

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

    def refund_deep_reads(self, user_id, count=1):
        count = self._count(count)
        with self._transaction() as c:
            c.execute("BEGIN IMMEDIATE")
            c.execute("UPDATE deep_reads SET used=MAX(0,used-?) WHERE user_hash=? AND period=?", (count, usage_key(user_id), current_period(self.clock)))

    def _used_suggestions(self, c, key):
        day, month = current_day(self.clock), current_period(self.clock)
        read = lambda meter, period: (c.execute("SELECT used FROM suggestion_counts WHERE user_hash=? AND meter=? AND period=?", (key, meter, period)).fetchone() or (0,))[0]
        return {"daily": read("day", day), "monthly": read("month", month), "attempts": read("attempts", day)}

    def suggestions(self, user_id):
        with self._transaction() as c:
            return self._suggestion_report(self._is_unlocked(c, user_id), self._used_suggestions(c, usage_key(user_id)))

    def reserve_suggestions(self, user_id, wanted):
        wanted = self._natural(wanted)
        with self._transaction() as c:
            c.execute("BEGIN IMMEDIATE")
            key, unlocked = usage_key(user_id), self._is_unlocked(c, user_id)
            used = self._used_suggestions(c, key)
            granted, blocked = plan_reservation(wanted, self.suggestion_limits.for_account(unlocked), used)
            if granted:
                day, month = current_day(self.clock), current_period(self.clock)
                # Earlier days and months are not kept once a new one is in use, for any account.
                c.execute("DELETE FROM suggestion_counts WHERE (meter IN ('day','attempts') AND period<>?) OR (meter='month' AND period<>?)", (day, month))
                for meter, period in (("day", day), ("month", month), ("attempts", day)):
                    c.execute("INSERT INTO suggestion_counts(user_hash,meter,period,used) VALUES(?,?,?,?) ON CONFLICT(user_hash,meter,period) DO UPDATE SET used=used+excluded.used", (key, meter, period, granted))
            return Reservation(granted, wanted, blocked, self._suggestion_report(unlocked, self._used_suggestions(c, key)))

    def refund_suggestions(self, user_id, count, unspent=False):
        count = self._natural(count)
        if not count:
            return
        with self._transaction() as c:
            c.execute("BEGIN IMMEDIATE")
            key = usage_key(user_id)
            for meter, period in (("day", current_day(self.clock)), ("month", current_period(self.clock))) + ((("attempts", current_day(self.clock)),) if unspent else ()):
                c.execute("UPDATE suggestion_counts SET used=MAX(0,used-?) WHERE user_hash=? AND meter=? AND period=?", (count, key, meter, period))

    def forget(self, user_id):
        with self._transaction() as c:
            c.execute("DELETE FROM entitlements WHERE user_id=?", (user_id,))
