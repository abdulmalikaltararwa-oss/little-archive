"""Finishing an account's deletion at the identity provider, and not forgetting to.

`POST /api/account/delete` removes the library (see tenancy.LibraryManager.delete) and then the person's Supabase sign-in. The
order is chosen so that nothing is left half done without the server knowing:

1. The intent is written to `accounts.sqlite3` (`auth_deletions`) before anything is removed. It holds the account id until the
   sign-in is gone, and is then deleted (with secure_delete on, so no remnant is left).
2. The library is deleted. Its own steps are completed at the next start if the process dies part-way.
3. Supabase is asked to delete the user. If that fails, the request answers `202` and says so: the library is gone, the sign-in is
   not yet, and it will be retried. The retry runs on its own thread with a growing pause (30 s, doubling, at most an hour) and at
   every start, until Supabase confirms. A user that Supabase says does not exist counts as deleted, so every step is safe to repeat.
4. When a retry succeeds it deletes the library again. If the person signed in again in the meantime, that created a new, empty
   library; it goes with the sign-in.

Why the library first and the sign-in second: the other order, if it failed after the sign-in was gone, would leave a library nobody
can reach and the server could not tell. This order can fail only by leaving a sign-in that still works and that the server
knows about and keeps retrying.
"""
from __future__ import annotations

import logging
import sqlite3
import time

from .supabase_admin import AdminUnavailable

log = logging.getLogger("little_archive")
FIRST_WAIT, LONGEST_WAIT = 30, 3600


def wait_for_attempt(attempts):
    return min(FIRST_WAIT * 2 ** max(0, attempts - 1), LONGEST_WAIT)


class AuthDeletions:
    def __init__(self, libraries, admin, clock=time.time):
        self.libraries, self.admin, self.clock = libraries, admin, clock

    def request(self, user_id):
        """Record that this account's sign-in must be deleted. Safe to repeat."""
        with self.libraries._accounts() as c:
            c.execute("INSERT OR IGNORE INTO auth_deletions(user_id,requested_at,next_attempt_at) VALUES(?,?,0)", (user_id, int(self.clock())))

    def attempt(self, user_id, sweep=False):
        """Ask Supabase to delete the user. Returns 'done' (and forgets the account id) or 'pending'.

        `sweep=True` (a retry) also deletes any library the account has by now, since the sign-in it belonged to is gone.
        """
        try:
            self.admin.delete_user(user_id)
        except AdminUnavailable as problem:
            attempts = self._failed(user_id, problem.reason)
            if problem.reason == "key_refused":
                log.error("Supabase refused the secret key, so a deleted account's sign-in could not be deleted. It will be retried; check LA_SUPABASE_SERVICE_KEY.")
            else:
                log.warning("A deleted account's sign-in could not be deleted yet (%s, attempt %d). It will be retried.", problem.reason, attempts)
            return "pending"
        with self.libraries._accounts() as c:
            c.execute("DELETE FROM auth_deletions WHERE user_id=?", (user_id,))
        if sweep:
            try:
                self.libraries.delete(user_id)
            except Exception:
                log.warning("A library created after its account was deleted could not be removed; it holds nothing and will be removed with the next deletion.")
        return "done"

    def _failed(self, user_id, reason):
        with self.libraries._accounts() as c:
            row = c.execute("SELECT attempts FROM auth_deletions WHERE user_id=?", (user_id,)).fetchone()
            attempts = (row[0] if row else 0) + 1
            c.execute("UPDATE auth_deletions SET attempts=?,next_attempt_at=?,last_error=? WHERE user_id=?", (attempts, int(self.clock()) + wait_for_attempt(attempts), reason[:40], user_id))
        return attempts

    def due(self):
        with self.libraries._accounts() as c:
            return [row[0] for row in c.execute("SELECT user_id FROM auth_deletions WHERE next_attempt_at<=? ORDER BY requested_at", (int(self.clock()),))]

    def tick(self):
        """Retry every deletion whose time has come. Returns how many finished."""
        finished = 0
        for user_id in self.due():
            try:
                # The library part is repeated too: a crash may have left it unfinished.
                self.libraries.delete(user_id)
            except Exception:
                pass
            if self.attempt(user_id, sweep=True) == "done":
                finished += 1
        return finished

    def pending(self):
        """What is waiting, without the account ids: how many, and the reasons they gave."""
        with self.libraries._accounts() as c:
            return [{"attempts": row[0], "last_error": row[1]} for row in c.execute("SELECT attempts,last_error FROM auth_deletions ORDER BY requested_at")]
