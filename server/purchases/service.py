"""Redeeming a purchase, taking one back, and keeping the account's unlock in step.

`PurchaseService` is the only code that turns a store's proof into an unlock. It calls `Entitlements.set_unlocked`, the seam, and
nothing in the request path does that from what a client says: a client sends a signed proof, this verifies it with the store's own
certificates or API, and only then does the account change.

Refunds and revocations arrive three ways, each tested here with stand-ins:

* an App Store Server Notification V2 (REFUND, REVOKE; REFUND_REVERSED undoes a refund);
* a Google real-time notification (a cancelled one-time product, or a voided purchase), which is only a prompt to ask Google again;
* the same account presenting its proof again (a restore) after the purchase was taken back, which is refused.

An account stays unlocked while any of its purchases is active. An unlock an operator set by hand (`source="manual"`) is not
undone by a refund of something else.
"""
from __future__ import annotations

import logging

from .apple import AppleVerificationError
from .google import PlayError, account_tag, token_key
from ..limits import Refusal, retry_after

log = logging.getLogger("little_archive")
STORE_SOURCES = {"apple", "google"}


class PurchaseService:
    def __init__(self, store, entitlements, *, apple=None, google=None, google_package="", google_product="", google_allow_test=False, push=None):
        self.store, self.entitlements = store, entitlements
        self.apple, self.google, self.push = apple, google, push
        self.google_package, self.google_product, self.google_allow_test = google_package, google_product, google_allow_test

    # -- the unlock follows the purchases --------------------------------------------------
    def _unlock(self, user_id, provider):
        if not self.entitlements.is_unlocked(user_id):  # already unlocked (by an earlier purchase, or by hand): leave who set it alone
            self.entitlements.set_unlocked(user_id, True, source=provider)

    def _relock_if_nothing_holds_it(self, user_id):
        if user_id and not self.store.active_for(user_id) and self.entitlements.unlock_source(user_id) in STORE_SOURCES:
            self.entitlements.set_unlocked(user_id, False, source="purchase-ended")

    def purchases(self, user_id):
        return [{"provider": row["provider"], "product_id": row["product_id"], "status": row["state"], "environment": row["environment"]} for row in self.store.listed(user_id)]

    @staticmethod
    def _refuse(kind):
        table = {
            "invalid": (400, "That purchase could not be verified.", "purchase_invalid"),
            "wrong_app": (400, "That purchase is for a different app.", "purchase_wrong_app"),
            "wrong_product": (400, "That purchase is not the unlock.", "purchase_wrong_product"),
            "wrong_environment": (400, "That purchase was made in a test environment this service does not accept.", "purchase_wrong_environment"),
            "other_account": (409, "That purchase already unlocked another account. Sign in to that account, or delete it first.", "purchase_bound_elsewhere"),
            "revoked": (409, "That purchase was refunded or cancelled.", "purchase_revoked"),
        }
        status, detail, code = table[kind]
        return Refusal(status, detail, code)

    def _unavailable(self, provider, why):
        return Refusal(503, "Purchases cannot be checked right now. Try again in a moment.", "purchases_unavailable", headers=retry_after(30), provider=provider, reason=why)

    # -- Apple ---------------------------------------------------------------------------------
    def redeem_apple(self, user_id, signed_transaction):
        if self.apple is None:
            raise self._unavailable("apple", "not_configured")
        try:
            found = self.apple.transaction(signed_transaction)
        except AppleVerificationError as problem:
            raise self._refuse(problem.code) from None
        tag = (found.account_token or "").lower() == user_id.lower()
        if found.revoked:
            self.store.revoke("apple", found.original_transaction_id, found.revoked_ms or 0, "revoked")
            holder = self.store.holder("apple", found.original_transaction_id)
            self._relock_if_nothing_holds_it(holder[0] if holder else "")
            raise self._refuse("revoked")
        outcome = self.store.claim("apple", found.original_transaction_id, user_id, found.product_id, found.environment, tag, found.signed_ms)
        if outcome in {"other_account", "revoked"}:
            raise self._refuse(outcome)
        self._unlock(user_id, "apple")
        return {"unlocked": True, "provider": "apple", "product_id": found.product_id, "status": "active", "restored": outcome == "restored", "environment": found.environment}

    def apple_notification(self, signed_payload):
        if self.apple is None:
            raise self._unavailable("apple", "not_configured")
        try:
            note = self.apple.notification(signed_payload)
        except AppleVerificationError as problem:
            raise self._refuse(problem.code) from None
        if self.store.seen("apple", note.uuid):
            return {"received": True, "action": "duplicate"}
        action, found = "ignored", note.transaction
        if found is not None and found.product_id == self.apple.product_id:
            if note.kind in {"REFUND", "REVOKE"}:
                changed, holder = self.store.revoke("apple", found.original_transaction_id, found.revoked_ms or note.signed_ms, note.kind.lower())
                self._relock_if_nothing_holds_it(holder)
                action = "revoked" if changed else "unchanged"
            elif note.kind == "REFUND_REVERSED":
                holder = self.store.reinstate("apple", found.original_transaction_id, note.signed_ms)
                if holder:
                    self._unlock(holder, "apple")
                action = "reinstated" if holder is not None else "unchanged"
        self.store.done("apple", note.uuid)
        return {"received": True, "action": action, "type": note.kind}

    # -- Google ------------------------------------------------------------------------------------
    def _play(self, token, product=None):
        if self.google is None:
            raise self._unavailable("google", "not_configured")
        try:
            return self.google.get_purchase(self.google_package, product or self.google_product, token)
        except PlayError as problem:
            if problem.kind == "not_found":
                raise self._refuse("invalid") from None
            raise self._unavailable("google", problem.kind) from None

    def redeem_google(self, user_id, product_id, purchase_token):
        if product_id != self.google_product:
            raise self._refuse("wrong_product")
        found = self._play(purchase_token)
        if found.product_id != self.google_product:
            raise self._refuse("wrong_product")
        if found.test and not self.google_allow_test:
            raise self._refuse("wrong_environment")
        key = token_key(purchase_token)
        if found.state == "pending":
            return {"unlocked": False, "provider": "google", "product_id": found.product_id, "status": "pending", "restored": False}
        if found.state == "canceled":
            changed, holder = self.store.revoke("google", key, found.purchased_ms or 0, "canceled")
            self._relock_if_nothing_holds_it(holder)
            raise self._refuse("revoked")
        outcome = self.store.claim("google", key, user_id, found.product_id, "test" if found.test else "", found.account_tag == account_tag(user_id), found.purchased_ms or 0)
        if outcome in {"other_account", "revoked"}:
            raise self._refuse(outcome)
        self._unlock(user_id, "google")
        acknowledged = found.acknowledged
        if not acknowledged:
            try:
                # Google refunds a purchase that is not acknowledged within three days. The app usually does this; so can the server.
                self.google.acknowledge(self.google_package, self.google_product, purchase_token)
                acknowledged = True
            except PlayError:
                log.warning("A Google purchase could not be acknowledged yet; the app can still do it.")
        return {"unlocked": True, "provider": "google", "product_id": found.product_id, "status": "active", "restored": outcome == "restored", "acknowledged": acknowledged}

    def reverify_google(self, purchase_token):
        """Ask Google again about one purchase and apply the answer. The seam for a notification, an operator, or a periodic check.

        Returns 'revoked', 'active', 'pending' or 'unknown' (nothing on file, or Google does not know the token any more).
        """
        key = token_key(purchase_token)
        try:
            found = self._play(purchase_token)
        except Refusal as refusal:
            if refusal.code == "purchase_invalid":
                return "unknown"
            raise
        if found.state == "canceled":
            changed, holder = self.store.revoke("google", key, found.purchased_ms or 0, "canceled")
            self._relock_if_nothing_holds_it(holder)
            return "revoked"
        if found.state == "purchased":
            holder = self.store.reinstate("google", key, found.purchased_ms or 0)
            if holder:
                self._unlock(holder, "google")
            return "active"
        return "pending"

    def google_notification(self, token, envelope):
        """A Pub/Sub push request: `token` is its bearer credential, `envelope` its JSON body. Returns what was done."""
        from .google import decode_push
        if self.push is None or self.google is None:
            raise self._unavailable("google", "not_configured")
        try:
            authentic = self.push.verify(token)
        except Exception:  # signing keys could not be fetched: Google retries
            raise self._unavailable("google", "unavailable") from None
        if not authentic:
            raise Refusal(401, "This notification is not signed for this service.", "notification_unauthenticated", headers={"WWW-Authenticate": "Bearer"})
        message = decode_push(envelope)
        if message is None or message.get("packageName") != self.google_package:
            raise Refusal(400, "That is not a notification for this app.", "notification_invalid")
        event = message["_message_id"] or None
        if event and self.store.seen("google", event):
            return {"received": True, "action": "duplicate"}
        action = "ignored"
        one = message.get("oneTimeProductNotification")
        voided = message.get("voidedPurchaseNotification")
        target = None
        if isinstance(one, dict) and one.get("notificationType") == 2 and one.get("sku") == self.google_product:
            target = one.get("purchaseToken")
        elif isinstance(voided, dict) and voided.get("productType") == 2:
            target = voided.get("purchaseToken")
        if isinstance(target, str) and target:
            # The message says only that something changed; what changed is whatever Google says now.
            action = self.reverify_google(target)
        if event:
            self.store.done("google", event)
        return {"received": True, "action": action}

    # -- an operator's seam ---------------------------------------------------------------------------------
    def revoke(self, provider, purchase_key, reason="operator"):
        """Take a purchase back by hand (support, a chargeback learned elsewhere). The key is Apple's original transaction id, or for Google the token's hash."""
        changed, holder = self.store.revoke(provider, purchase_key, 2 ** 53, reason)
        self._relock_if_nothing_holds_it(holder)
        return changed
