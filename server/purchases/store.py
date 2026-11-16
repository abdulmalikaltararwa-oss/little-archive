"""Which purchase unlocked which account, and which purchases were taken back.

One row per purchase, in `accounts.sqlite3` beside the unlock flag. A purchase is named by what its store calls it (Apple's original
transaction id) or, for Google, by a hash of the purchase token, so the token itself is never kept.

The rules, each in one place here:

* A purchase unlocks the first account that presents a proof of it, and stays bound to that account. The same account presenting
  it again is a restore: nothing changes and it succeeds. A different account is refused.
* Deleting an account releases what it held, so the person can unlock a new account with the same purchase, except a purchase
  the store took back: that stays marked, with no account on it, and can never unlock anyone.
* A refund can arrive before the person ever redeems the purchase. It is recorded the same way, so redeeming it afterwards fails.
* A payment at Tap is started by this server, so it has a row of its own first (`tap_attempts`): which account asked, for how much,
  and the charge Tap made for it. Only a charge with such a row can unlock anyone, and only the account in the row. The row is
  deleted with the account, so the charge of a deleted account can never be presented again. Its `status` is `INITIATED` until Tap
  decides: then `CAPTURED`, or the word Tap gave a payment that ended unpaid. A row whose charge is not decided is never dropped.
* A store's events carry their own time. An older event than the one that last set a purchase's state is ignored, and an event
  is acted on once (the store may send it again).
"""
from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timezone
import sqlite3
from threading import RLock

from .tap import ENDED_UNPAID

SCHEMA = """
CREATE TABLE IF NOT EXISTS purchases(
 provider TEXT NOT NULL, purchase_key TEXT NOT NULL, user_id TEXT NOT NULL DEFAULT '', product_id TEXT NOT NULL DEFAULT '',
 environment TEXT NOT NULL DEFAULT '', state TEXT NOT NULL, first_verified_at TEXT NOT NULL, last_verified_at TEXT NOT NULL,
 state_at INTEGER NOT NULL DEFAULT 0, reason TEXT NOT NULL DEFAULT '', tag_matched INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(provider, purchase_key));
CREATE INDEX IF NOT EXISTS purchases_by_user ON purchases(user_id);
CREATE TABLE IF NOT EXISTS tap_attempts(
 order_ref TEXT PRIMARY KEY, idempotent_ref TEXT NOT NULL, user_id TEXT NOT NULL, charge_id TEXT UNIQUE, amount TEXT NOT NULL, currency TEXT NOT NULL,
 live INTEGER NOT NULL, url TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'INITIATED', created_at INTEGER NOT NULL,
 checks INTEGER NOT NULL DEFAULT 0, next_check_at INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS tap_attempts_by_user ON tap_attempts(user_id, created_at);
CREATE TABLE IF NOT EXISTS purchase_events(provider TEXT NOT NULL, event_id TEXT NOT NULL, received_at INTEGER NOT NULL, PRIMARY KEY(provider, event_id));
"""
EVENT_DAYS = 30


def stamp():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class PurchaseStore:
    def __init__(self, path, clock=None):
        import time
        self.path, self._lock, self.clock = path, RLock(), clock or time.time
        with self._transaction() as c:
            c.executescript(SCHEMA)

    @contextmanager
    def _transaction(self):
        with self._lock:
            conn = sqlite3.connect(self.path, timeout=15)
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA busy_timeout=15000")
            conn.execute("PRAGMA secure_delete=ON")
            try:
                with conn:
                    yield conn
            finally:
                conn.close()

    def claim(self, provider, key, user_id, product_id, environment="", tag_matched=False, at_ms=0):
        """Bind a purchase to an account. Returns 'bound', 'restored', 'other_account' or 'revoked'."""
        with self._transaction() as c:
            c.execute("BEGIN IMMEDIATE")
            row = c.execute("SELECT user_id,state FROM purchases WHERE provider=? AND purchase_key=?", (provider, key)).fetchone()
            now = stamp()
            if row is None:
                c.execute("INSERT INTO purchases(provider,purchase_key,user_id,product_id,environment,state,first_verified_at,last_verified_at,state_at,tag_matched) VALUES(?,?,?,?,?,'active',?,?,?,?)",
                          (provider, key, user_id, product_id, environment, now, now, at_ms, int(tag_matched)))
                return "bound"
            if row["state"] == "revoked":
                return "revoked"
            if row["user_id"] == user_id:
                c.execute("UPDATE purchases SET last_verified_at=? WHERE provider=? AND purchase_key=?", (now, provider, key))
                return "restored"
            if row["user_id"] == "":
                c.execute("UPDATE purchases SET user_id=?,last_verified_at=?,tag_matched=? WHERE provider=? AND purchase_key=?", (user_id, now, int(tag_matched), provider, key))
                return "bound"
            return "other_account"

    def revoke(self, provider, key, at_ms=0, reason=""):
        """The store took this purchase back. Returns (changed, the account it was on, or '' if none). An older event than the last is ignored."""
        with self._transaction() as c:
            c.execute("BEGIN IMMEDIATE")
            row = c.execute("SELECT user_id,state,state_at FROM purchases WHERE provider=? AND purchase_key=?", (provider, key)).fetchone()
            now = stamp()
            if row is None:
                c.execute("INSERT INTO purchases(provider,purchase_key,state,first_verified_at,last_verified_at,state_at,reason) VALUES(?,?,'revoked',?,?,?,?)", (provider, key, now, now, at_ms, reason[:40]))
                return True, ""
            if at_ms < row["state_at"]:
                return False, row["user_id"]
            changed = row["state"] != "revoked"
            c.execute("UPDATE purchases SET state='revoked',state_at=?,reason=?,last_verified_at=? WHERE provider=? AND purchase_key=?", (at_ms, reason[:40], now, provider, key))
            return changed, row["user_id"]

    def reinstate(self, provider, key, at_ms=0):
        """The store reversed a refund. Returns the account the purchase is on, or None when nothing changed."""
        with self._transaction() as c:
            c.execute("BEGIN IMMEDIATE")
            row = c.execute("SELECT user_id,state,state_at FROM purchases WHERE provider=? AND purchase_key=?", (provider, key)).fetchone()
            if row is None or row["state"] != "revoked" or at_ms < row["state_at"]:
                return None
            c.execute("UPDATE purchases SET state='active',state_at=?,reason='',last_verified_at=? WHERE provider=? AND purchase_key=?", (at_ms, stamp(), provider, key))
            return row["user_id"]

    def active_for(self, user_id):
        with self._transaction() as c:
            return [dict(row) for row in c.execute("SELECT provider,product_id,environment,state,first_verified_at,last_verified_at FROM purchases WHERE user_id=? AND state='active' ORDER BY first_verified_at", (user_id,))]

    def listed(self, user_id):
        with self._transaction() as c:
            return [dict(row) for row in c.execute("SELECT provider,product_id,environment,state,first_verified_at,last_verified_at FROM purchases WHERE user_id=? ORDER BY first_verified_at", (user_id,))]

    def holder(self, provider, key):
        with self._transaction() as c:
            row = c.execute("SELECT user_id,state FROM purchases WHERE provider=? AND purchase_key=?", (provider, key)).fetchone()
            return (row["user_id"], row["state"]) if row else None

    def seen(self, provider, event_id):
        """Has this notification been acted on before?"""
        with self._transaction() as c:
            return c.execute("SELECT 1 FROM purchase_events WHERE provider=? AND event_id=?", (provider, event_id)).fetchone() is not None

    def done(self, provider, event_id):
        now = int(self.clock())
        with self._transaction() as c:
            c.execute("INSERT OR IGNORE INTO purchase_events(provider,event_id,received_at) VALUES(?,?,?)", (provider, event_id[:200], now))
            c.execute("DELETE FROM purchase_events WHERE received_at<?", (now - EVENT_DAYS * 86400,))

    def forget(self, user_id):
        """The account was deleted: what it held is released for a new account, except what the store took back."""
        with self._transaction() as c:
            c.execute("DELETE FROM purchases WHERE user_id=? AND state<>'revoked'", (user_id,))
            c.execute("UPDATE purchases SET user_id='' WHERE user_id=?", (user_id,))
            c.execute("DELETE FROM tap_attempts WHERE user_id=?", (user_id,))

    # -- payments started at Tap -------------------------------------------------------------------------------
    def tap_begin(self, order_ref, idempotent_ref, user_id, amount, currency, live):
        """Write down a payment before Tap is asked for it.

        Old attempts are dropped after a month, but only those that can no longer matter: one Tap never made a charge for, and
        one Tap said ended unpaid. A captured charge, and one Tap has not decided, are kept.
        """
        now = int(self.clock())
        with self._transaction() as c:
            c.execute("DELETE FROM tap_attempts WHERE created_at<? AND (charge_id IS NULL OR status IN (%s))" % ",".join("?" * len(ENDED_UNPAID)), (now - EVENT_DAYS * 86400, *sorted(ENDED_UNPAID)))
            c.execute("INSERT INTO tap_attempts(order_ref,idempotent_ref,user_id,amount,currency,live,created_at) VALUES(?,?,?,?,?,?,?)", (order_ref, idempotent_ref, user_id, amount, currency, int(live), now))

    def tap_unattached(self, user_id, amount, currency, live, since):
        """The account's newest attempt, made since `since` for this price, that Tap has not been seen to answer; or None."""
        with self._transaction() as c:
            row = c.execute("SELECT order_ref,idempotent_ref FROM tap_attempts WHERE user_id=? AND charge_id IS NULL AND amount=? AND currency=? AND live=? AND created_at>=? ORDER BY created_at DESC, rowid DESC LIMIT 1",
                            (user_id, amount, currency, int(live), int(since))).fetchone()
            return dict(row) if row else None

    def tap_attach(self, order_ref, charge_id, url):
        with self._transaction() as c:
            c.execute("UPDATE tap_attempts SET charge_id=?,url=? WHERE order_ref=? AND charge_id IS NULL", (charge_id, url, order_ref))

    def tap_attempt(self, charge_id):
        with self._transaction() as c:
            row = c.execute("SELECT * FROM tap_attempts WHERE charge_id=?", (charge_id,)).fetchone()
            return dict(row) if row else None

    def tap_latest(self, user_id):
        """The account's most recent payment that reached Tap, or None."""
        with self._transaction() as c:
            row = c.execute("SELECT * FROM tap_attempts WHERE user_id=? AND charge_id IS NOT NULL ORDER BY created_at DESC, rowid DESC LIMIT 1", (user_id,)).fetchone()
            return dict(row) if row else None

    def tap_status(self, charge_id, status):
        with self._transaction() as c:
            c.execute("UPDATE tap_attempts SET status=? WHERE charge_id=?", (status[:40], charge_id))

    def tap_due(self, user_id):
        """One of the account's charges that Tap has not decided and that it is time to ask about again, else None. Any of them,
        not only the latest: one that was given up on and replaced can still be paid. Asking is spaced out for each charge:
        a minute after the last look, then two, four and so on up to an hour, and not at all once the payment is a month old."""
        now = int(self.clock())
        with self._transaction() as c:
            c.execute("BEGIN IMMEDIATE")
            row = c.execute("SELECT order_ref,charge_id,checks FROM tap_attempts WHERE user_id=? AND charge_id IS NOT NULL AND status='INITIATED' AND next_check_at<=? AND created_at>=? "
                            "ORDER BY next_check_at, rowid LIMIT 1", (user_id, now, now - EVENT_DAYS * 86400)).fetchone()
            if row is None:
                return None
            c.execute("UPDATE tap_attempts SET checks=checks+1,next_check_at=? WHERE order_ref=?", (now + min(3600, 60 * 2 ** min(row["checks"], 6)), row["order_ref"]))
            return row["charge_id"]

    def held_keys(self, provider, user_id):
        """The keys of the active purchases this account holds from one provider."""
        with self._transaction() as c:
            return [row[0] for row in c.execute("SELECT purchase_key FROM purchases WHERE provider=? AND user_id=? AND state='active' ORDER BY first_verified_at, rowid", (provider, user_id))]

    def tap_test_holders(self):
        """Accounts holding an active Tap purchase that was paid for with a test card."""
        with self._transaction() as c:
            return [row[0] for row in c.execute("SELECT DISTINCT user_id FROM purchases WHERE provider='tap' AND environment='test' AND state='active' AND user_id<>''")]

    def purchase(self, provider, key):
        """One purchase's row (`user_id`, `state`, `environment`), or None."""
        with self._transaction() as c:
            row = c.execute("SELECT user_id,state,environment FROM purchases WHERE provider=? AND purchase_key=?", (provider, key)).fetchone()
            return dict(row) if row else None
