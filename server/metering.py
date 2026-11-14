"""What each account may spend, asked of the entitlement store and answered as `Refusal`s an app can show.

Two things cost the operator real money when an account asks for them: a closer read (a transcript, then a
suggestion) and an ordinary AI suggestion. Both are charged when the work is queued and given back when the
work fails before it produced anything (see `tenancy.AccountWorker.adopt`). A request that is refused queues nothing.
"""
from __future__ import annotations

from .limits import Refusal, retry_after
from datetime import datetime, timezone

DEEP_READ_UNLOCK = "Deep reads come with the full unlock."
MESSAGES = {
    "daily": "Today's AI suggestions are used ({used} of {limit}). They start again at {resets} UTC.",
    "monthly": "This month's AI suggestions are used ({used} of {limit}). They start again on {resets} UTC.",
    "attempts": "Too many AI suggestions have been tried today, including ones that did not work out. Try again tomorrow.",
}


def _seconds_until(stamp, clock=None):
    """Whole seconds from now (by the entitlement store's clock, which tests move) until `stamp`; at least one."""
    try:
        return max(1, int(((datetime.fromisoformat(stamp) - (clock() if clock else datetime.now(timezone.utc))).total_seconds())))
    except (TypeError, ValueError):
        return 3600


class AccountMeters:
    def __init__(self, entitlements):
        self.entitlements = entitlements

    # -- the unlock -------------------------------------------------------------------
    def require_unlock(self, user_id, feature):
        """For a feature that is part of the one-time unlock. Raises 402 with `code: unlock_required` and the feature's name."""
        if not self.entitlements.is_unlocked(user_id):
            raise Refusal(402, f"{feature} comes with the full unlock.", "unlock_required", feature=feature)

    # -- deep reads: monthly ------------------------------------------------------------
    def charge_deep_read(self, user_id):
        """A closer read is the metered operation: one from this month's allowance, or a refusal."""
        deep = self.entitlements.deep_reads(user_id)
        if not deep["limit"] and not self.entitlements.is_unlocked(user_id):
            raise Refusal(402, DEEP_READ_UNLOCK, "unlock_required", feature="deep_reads")
        if not self.entitlements.consume_deep_reads(user_id, 1):
            used = self.entitlements.deep_reads(user_id)
            raise Refusal(429, f"This month's deep-read allowance is used ({used['used']} of {used['limit']}). It resets on the first of the month, UTC.", "deep_reads_exhausted",
                          headers=retry_after(self._wait(self._reset("monthly"))), limit={"scope": "monthly", **used})

    def refund_deep_read(self, user_id, count=1):
        if count:
            self.entitlements.refund_deep_reads(user_id, count)

    # -- suggestions: daily and monthly --------------------------------------------------
    def reserve_suggestions(self, user_id, wanted):
        return self.entitlements.reserve_suggestions(user_id, wanted)

    def refund_suggestions(self, user_id, count, unspent=False):
        if count:
            self.entitlements.refund_suggestions(user_id, count, unspent=unspent)

    def _wait(self, stamp):
        return _seconds_until(stamp, getattr(self.entitlements, "clock", None))

    def _reset(self, scope):
        return self.entitlements.suggestions("-")[scope]["resets_at"] if scope in ("daily", "monthly") else None

    def limited(self, reservation, skipped):
        """The `limit` object that tells an app which allowance stopped some suggestions, and when it starts again."""
        blocked = reservation.blocked
        if blocked is None:
            return None
        if blocked == "not_included":
            return {"scope": "not_included", "skipped": skipped}
        if blocked == "attempts":
            return {"scope": "attempts", "skipped": skipped, "resets_at": reservation.suggestions["daily"]["resets_at"]}
        return {"scope": blocked, "skipped": skipped, **reservation.suggestions[blocked]}

    def refusal_for(self, reservation, skipped):
        """The error for a request that could not queue anything at all because of an allowance."""
        limit = self.limited(reservation, skipped)
        if limit["scope"] == "not_included":
            return Refusal(402, "AI suggestions come with the full unlock.", "unlock_required", feature="suggestions")
        if limit["scope"] == "attempts":
            return Refusal(429, MESSAGES["attempts"], "suggestions_attempts_limit", headers=retry_after(self._wait(limit["resets_at"])), limit=limit)
        text = MESSAGES[limit["scope"]].format(used=limit["used"], limit=limit["limit"], resets=limit["resets_at"][:16].replace("T", " ") if limit["scope"] == "daily" else limit["resets_at"][:10])
        return Refusal(429, text, f"suggestions_{limit['scope']}_limit", headers=retry_after(self._wait(limit["resets_at"])), limit=limit)
