"""Redeeming a purchase, taking one back, and keeping the account's unlock in step.

`PurchaseService` is the only code that turns a store's proof into an unlock. It calls `Entitlements.set_unlocked`, the seam, and
nothing in the request path does that from what a client says: a client sends a signed proof, this verifies it with the store's own
certificates or API, and only then does the account change.

A payment on the web (Tap) differs in one way: the server starts it, so it knows beforehand which account is paying and how much.
Whoever says a charge was paid (the buyer's browser coming back, Tap's webhook, the account asking), the answer comes from one
function, `settle_tap`: find the payment this server started, ask Tap for the charge, and unlock only if Tap says it was captured,
for that amount, in that currency, for that account. A refund made in Tap's dashboard is not followed: an operator takes the
purchase back with `revoke("tap", charge_id)`.

Refunds and revocations arrive three ways, each tested here with stand-ins:

* an App Store Server Notification V2 (REFUND, REVOKE; REFUND_REVERSED undoes a refund);
* a Google real-time notification (a cancelled one-time product, or a voided purchase), which is only a prompt to ask Google again;
* the same account presenting its proof again (a restore) after the purchase was taken back, which is refused.

An account stays unlocked while any of its purchases is active. An unlock an operator set by hand (`source="manual"`) is not
undone by a refund of something else.
"""
from __future__ import annotations

import logging
import secrets
import time

from .apple import AppleVerificationError
from .google import PlayError, account_tag, token_key
from .tap import CHARGE_ID, OPEN, PAID, STATUSES, TapError, amount_text, read_charge
from ..limits import Refusal, retry_after

log = logging.getLogger("little_archive")
STORE_SOURCES = {"apple", "google", "tap"}
TAP_PRODUCT = "unlock"
TAP_REUSE_SECONDS = 20 * 60  # Tap keeps a hosted page open for 30 minutes unless told otherwise; an older one is not handed out again


class PurchaseService:
    def __init__(self, store, entitlements, *, apple=None, google=None, google_package="", google_product="", google_allow_test=False, push=None,
                 tap=None, tap_amount=None, tap_currency="", tap_redirect="", tap_post=""):
        self.store, self.entitlements = store, entitlements
        self.apple, self.google, self.push = apple, google, push
        self.google_package, self.google_product, self.google_allow_test = google_package, google_product, google_allow_test
        self.tap, self.tap_amount, self.tap_currency, self.tap_redirect, self.tap_post = tap, tap_amount, tap_currency, tap_redirect, tap_post

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

    # -- Tap ---------------------------------------------------------------------------------------
    def _tap(self):
        if self.tap is None or self.tap_amount is None:
            raise self._unavailable("tap", "not_configured")
        return self.tap

    def _ask_tap(self, call, *arguments, **named):
        try:
            return call(*arguments, **named)
        except TapError as problem:
            if problem.kind == "not_found":
                raise self._refuse("invalid") from None
            raise self._unavailable("tap", "forbidden" if problem.kind == "forbidden" else "unavailable") from None

    def start_tap(self, user_id, name, email):
        """Begin a payment for this account. Returns Tap's hosted page to send the buyer to, or says the account is already unlocked."""
        tap = self._tap()
        unlocked = {"unlocked": True, "provider": "tap", "status": "unlocked", "url": None}
        if self.entitlements.is_unlocked(user_id):
            return unlocked
        price = amount_text(self.tap_amount, self.tap_currency)
        last = self.store.tap_latest(user_id)
        if last and last["status"] == OPEN:
            # Asking twice must not make two charges a person could pay twice. The last payment is looked at first: if it was paid
            # after all, that is the answer; if its page is still fresh and open at Tap, that page is given again.
            try:
                if self.settle_tap(last["charge_id"], user_id)["unlocked"]:
                    return unlocked
                if (last["amount"], last["currency"]) == (price, self.tap_currency) and self.store.clock() - last["created_at"] < TAP_REUSE_SECONDS:
                    return {"unlocked": False, "provider": "tap", "status": "pending", "url": last["url"]}
            except Refusal as refusal:
                if refusal.code not in {"purchase_not_paid", "purchase_invalid"}:  # that payment ended unpaid: start another
                    raise
        order, idempotent = "la_" + secrets.token_hex(12), secrets.token_hex(16)
        self.store.tap_begin(order, idempotent, user_id, price, self.tap_currency, tap.live)
        charge = self._ask_tap(tap.create_charge, self.tap_amount, self.tap_currency, order=order, idempotent=idempotent, account=user_id, name=name, email=email,
                               redirect_url=self.tap_redirect, post_url=self.tap_post)
        if (charge.status, charge.amount, charge.currency, charge.live_mode, charge.order) != (OPEN, self.tap_amount, self.tap_currency, tap.live, order) or not charge.url:
            log.warning("Tap answered a new charge that is not the one asked for; the buyer was not sent to it.")
            raise self._unavailable("tap", "unavailable")
        self.store.tap_attach(order, charge.id, charge.url)
        return {"unlocked": False, "provider": "tap", "status": "pending", "url": charge.url}

    def settle_tap(self, charge_id, caller=None):
        """What became of a charge, by asking Tap, and the unlock if it was paid. The one place a Tap payment unlocks an account.

        `caller` is the signed-in account when one is asking; the buyer's return and Tap's webhook have none. The account unlocked
        is always the one the payment was started for. Returns `{unlocked, provider, status: 'active' | 'pending', restored}` and
        refuses everything else.
        """
        tap = self._tap()
        attempt = self.store.tap_attempt(charge_id) if isinstance(charge_id, str) and CHARGE_ID.fullmatch(charge_id) else None
        if attempt is None:
            raise self._refuse("invalid")  # not a payment this server started: Tap is not even asked
        user_id = attempt["user_id"]
        if caller is not None and caller != user_id:
            raise self._refuse("other_account")
        held = self.store.holder("tap", charge_id)
        if held is not None:  # settled before: the answer is on file and stays the same however often it is asked
            if held[1] == "revoked":
                raise self._refuse("revoked")
            return {"unlocked": True, "provider": "tap", "status": "active", "restored": True}
        charge = self._ask_tap(tap.retrieve_charge, charge_id)
        # The amount and currency are the ones written down when the payment was started (the configured price at that moment), so
        # a price changed while a buyer is on Tap's page does not strand a payment made at the price they were shown.
        same = (charge.id == charge_id and charge.currency == attempt["currency"] and amount_text(charge.amount, charge.currency) == attempt["amount"]
                and charge.live_mode == tap.live == bool(attempt["live"]) and charge.order == attempt["order_ref"] and charge.account == user_id)
        if not same:
            log.warning("A Tap charge does not match the payment that was started for it; nothing was unlocked.")
            raise self._refuse("invalid")
        if charge.status == OPEN:
            return {"unlocked": False, "provider": "tap", "status": "pending", "restored": False}
        self.store.tap_status(charge_id, charge.status)
        if charge.status != PAID:
            raise Refusal(409, "That payment was not completed, so nothing was unlocked.", "purchase_not_paid", status=charge.status.lower() if charge.status in STATUSES else "unknown")
        outcome = self.store.claim("tap", charge_id, user_id, TAP_PRODUCT, "" if tap.live else "test", True, int(time.time() * 1000))
        if outcome in {"other_account", "revoked"}:
            raise self._refuse(outcome)
        self._unlock(user_id, "tap")
        return {"unlocked": True, "provider": "tap", "status": "active", "restored": outcome == "restored"}

    def tap_notification(self, raw, header):
        """Tap's webhook: the charge as JSON, signed in the `hashstring` header. It is only a prompt to ask Tap about that charge."""
        tap = self._tap()
        try:
            charge = read_charge(raw)
        except TapError:
            raise Refusal(400, "That is not a notification for this service.", "notification_invalid") from None
        if not tap.signed(charge, header):
            raise Refusal(401, "This notification is not signed for this service.", "notification_unauthenticated")
        try:
            answer = self.settle_tap(charge.id)
        except Refusal as refusal:
            if refusal.status_code == 503:
                raise  # Tap could not be asked: answer so that it sends the notification again
            return {"received": True, "action": "ignored"}
        return {"received": True, "action": "unlocked" if answer["unlocked"] else "pending"}

    # -- an operator's seam ---------------------------------------------------------------------------------
    def revoke(self, provider, purchase_key, reason="operator"):
        """Take a purchase back by hand (support, a chargeback learned elsewhere). The key is Apple's original transaction id, for Google the token's hash, for Tap the charge id."""
        changed, holder = self.store.revoke(provider, purchase_key, 2 ** 53, reason)
        self._relock_if_nothing_holds_it(holder)
        return changed
