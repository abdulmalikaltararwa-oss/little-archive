"""What each account may spend, asked of the entitlement store and answered as `Refusal`s an app can show.

Three things cost the operator real money when an account asks for them: a closer read (a transcript, then a
suggestion), an ordinary AI suggestion, and a feature call (a model call or geocoder request made for a recipe card, a place or
an answer). The first two are charged when the work is queued and given back when it fails before it produced anything (see
`tenancy.AccountWorker.adopt`); a feature call is charged just before it is made and given back if it fails (`CallGuard`).
A request that is refused queues and does nothing.
"""
from __future__ import annotations

from .limits import Refusal, retry_after
from datetime import datetime, timezone

DEEP_READ_UNLOCK = "Deep reads come with the full unlock."
# What each family is called in a message, in a code and when it is not part of the free tier.
FAMILY_TEXT = {
    "suggestions": {"what": "AI suggestions", "code": "suggestions", "feature": "suggestions"},
    "features": {"what": "recipe, place and ask requests", "code": "feature_calls", "feature": None},
}
MESSAGES = {
    "daily": "Today's {what} are used ({used} of {limit}). They start again at {resets} UTC.",
    "monthly": "This month's {what} are used ({used} of {limit}). They start again on {resets} UTC.",
    "attempts": "Too many {what} have been tried today, including ones that did not work out. Try again tomorrow.",
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

    # -- feature calls: the model and geocoder requests behind recipes, places and ask
    def features_open_to_free(self):
        """True when an operator gave unlocked-only features an allowance for accounts that have not unlocked."""
        free = getattr(self.entitlements, "feature_limits", None)
        return bool(free and free.free_daily > 0 and free.free_monthly > 0)

    def charge_feature_call(self, user_id, feature):
        """One model call or geocoder request for `feature` (recipes, places or ask), or a refusal."""
        reservation = self.entitlements.reserve_feature_calls(user_id, 1)
        if reservation.granted:
            return
        raise self.refusal_for(reservation, 1, family="features", feature=feature, unlocked=self.entitlements.is_unlocked(user_id))

    def refund_feature_call(self, user_id, unspent=False):
        self.entitlements.refund_feature_calls(user_id, 1, unspent=unspent)

    def _wait(self, stamp):
        return _seconds_until(stamp, getattr(self.entitlements, "clock", None))

    def _reset(self, scope):
        return self.entitlements.suggestions("-")[scope]["resets_at"] if scope in ("daily", "monthly") else None

    def limited(self, reservation, skipped, unlocked=False):
        """The `limit` object that tells an app which allowance stopped some work, and when it starts again.

        An allowance of zero is "part of the unlock" for an account that has not unlocked; for one that has, it is a limit that
        is already reached (an operator who sets an unlocked account's allowance to zero has turned the thing off), and reads as one.
        """
        blocked = reservation.blocked
        if blocked is None:
            return None
        if blocked == "not_included" and unlocked:
            blocked = "daily"
        if blocked == "not_included":
            return {"scope": "not_included", "skipped": skipped}
        if blocked == "attempts":
            return {"scope": "attempts", "skipped": skipped, "resets_at": reservation.report["daily"]["resets_at"]}
        return {"scope": blocked, "skipped": skipped, **reservation.report[blocked]}

    def refusal_for(self, reservation, skipped, family="suggestions", feature=None, unlocked=False):
        """The error for a request that could not do anything at all because of an allowance."""
        words = FAMILY_TEXT[family]
        limit = self.limited(reservation, skipped, unlocked)
        if limit["scope"] == "not_included":
            name = feature or words["feature"] or "this"
            return Refusal(402, f"{words['what'].capitalize()} come with the full unlock.", "unlock_required", feature=name)
        if limit["scope"] == "attempts":
            return Refusal(429, MESSAGES["attempts"].format(what=words["what"]), f"{words['code']}_attempts_limit", headers=retry_after(self._wait(limit["resets_at"])), limit=limit)
        text = MESSAGES[limit["scope"]].format(what=words["what"], used=limit["used"], limit=limit["limit"],
                                               resets=limit["resets_at"][:16].replace("T", " ") if limit["scope"] == "daily" else limit["resets_at"][:10])
        return Refusal(429, text, f"{words['code']}_{limit['scope']}_limit", headers=retry_after(self._wait(limit["resets_at"])), limit=limit)


class CallGuard:
    """What a hosted account's understanding service calls before each model call or geocoder request it makes for a feature.

    `before(feature)` charges one feature call or raises the refusal an app can show; `failed()` gives it back when the provider
    could not be reached or answered with something unusable. The service finds it as `service.call_guard`; a self-hosted service
    has none, so nothing there is ever counted or refused.
    """

    def __init__(self, meters, user_id):
        self.meters, self.user_id = meters, user_id

    def before(self, feature):
        self.meters.charge_feature_call(self.user_id, feature)

    def failed(self):
        self.meters.refund_feature_call(self.user_id)
