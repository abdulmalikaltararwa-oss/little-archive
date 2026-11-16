"""Redeeming a purchase, taking one back, and keeping the account's unlock in step.

`PurchaseService` is the only code that turns a store's proof into an unlock. It calls `Entitlements.set_unlocked`, the seam, and
nothing in the request path does that from what a client says: a client sends a signed proof, this verifies it with the store's own
certificates or API, and only then does the account change.

A payment on the web (Tap) differs in one way: the server starts it, so it knows beforehand which account is paying and how much.
Whoever says a charge was paid (the buyer's browser coming back, Tap's webhook, the account asking), the answer comes from one
function, `settle_tap`: find the payment this server started, ask Tap for the charge, and unlock only if Tap says it was captured,
for that amount, in that currency, for that account. A payment Tap has not decided is never treated as failed, and an account
has one payable charge at a time. A refund made in Tap's dashboard is not followed: an operator takes the
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
from threading import Lock

from .tap import CHARGE_ID, ENDED_UNPAID, OPEN, PAID, TapError, amount_text, read_charge
from ..limits import Refusal, retry_after

log = logging.getLogger("little_archive")
STORE_SOURCES = {"apple", "google", "tap"}
TAP_PRODUCT = "unlock"
TAP_PAGE_SECONDS = 60 * 60    # Tap's page lives 30 minutes; a charge still "open" an hour on has a page nobody can pay on any more
TAP_STUCK_SECONDS = 24 * 3600  # how long a payment Tap will not decide, or cannot be asked about, holds off a new one
TAP_REPLAY_SECONDS = 10 * 60  # how long a charge Tap may or may not have made is asked for again with the same references (its page lives 30 minutes)


class PurchaseService:
    def __init__(self, store, entitlements, *, apple=None, google=None, google_package="", google_product="", google_allow_test=False, push=None,
                 tap=None, tap_amount=None, tap_currency="", tap_redirect="", tap_post="", tap_allow_test=False):
        self.store, self.entitlements = store, entitlements
        self.apple, self.google, self.push = apple, google, push
        self.google_package, self.google_product, self.google_allow_test = google_package, google_product, google_allow_test
        self.tap, self.tap_amount, self.tap_currency, self.tap_redirect, self.tap_post = tap, tap_amount, tap_currency, tap_redirect, tap_post
        self.tap_allow_test = bool(tap_allow_test) or (tap is not None and not tap.live)
        self.pay_page = False  # set when the service is built: is the pay page (pay.py) offered?
        self._tap_locks = [Lock() for _ in range(64)]  # one of these per account, by hash: a fixed number, so it cannot grow

    # -- the unlock follows the purchases --------------------------------------------------
    def _unlock(self, user_id, provider):
        if not self.entitlements.is_unlocked(user_id):  # already unlocked (by an earlier purchase, or by hand): leave who set it alone
            self.entitlements.set_unlocked(user_id, True, source=provider)

    def _relock_if_nothing_holds_it(self, user_id):
        holding = [row for row in self.store.active_for(user_id) if row["provider"] != "tap" or self._tap_counts(row["environment"])] if user_id else []
        if user_id and not holding and self.entitlements.unlock_source(user_id) in STORE_SOURCES:
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
        """Ask Tap. Whatever goes wrong, nothing is decided: the caller is told to try again, never that the payment failed."""
        try:
            return call(*arguments, **named)
        except TapError as problem:
            if problem.kind in {"refused", "not_found"}:
                # 'not_found' for a charge this server made is not an answer about the payment (a key for another account or mode, or Tap's own trouble).
                log.warning("Tap refused a request (%s); nothing was decided.", "create a charge" if problem.kind == "refused" else "read a charge this server started")
            raise self._unavailable("tap", "forbidden" if problem.kind == "forbidden" else "unavailable") from None

    def _tap_counts(self, environment):
        """Does a Tap purchase made in this environment unlock? One paid for with a test card does not, once the key is a live one."""
        return environment != "test" or self.tap_allow_test

    @staticmethod
    def _payment_open():
        return Refusal(409, "A payment for this account is already open. If you paid, the unlock arrives by itself; you do not need to pay twice.", "payment_open")

    def start_tap(self, user_id, name, email):
        """Begin a payment for this account. Returns Tap's hosted page to send the buyer to, or says the account is already unlocked.

        One account has one payment that can still be paid. While the last one is not decided at Tap, no other is made: its
        page is given again while that page can still be open (an hour), and a payment the buyer has taken to their bank, or one
        Tap cannot be asked about, answers 409 `payment_open` or 503. Neither lasts for ever, because a buyer must not be left with
        no way to pay: after an hour of a page nobody paid on, and after a day of anything else undecided, a new charge is made.
        The old one stays on file, so if it is captured after all it still unlocks this account, and is noted for a refund if
        both were paid.
        """
        tap = self._tap()
        with self._tap_locks[hash(user_id) % len(self._tap_locks)]:  # two requests at once must not both find "no payment yet"
            unlocked = {"unlocked": True, "provider": "tap", "status": "unlocked", "url": None}
            if self.entitlements.is_unlocked(user_id):
                return unlocked
            price = amount_text(self.tap_amount, self.tap_currency)
            last = self.store.tap_latest(user_id)
            if last and last["status"] not in ENDED_UNPAID:
                age = self.store.clock() - last["created_at"]
                try:
                    answer, charge = self._settle_tap(last["charge_id"], user_id)
                except Refusal as refusal:
                    over = refusal.code in {"purchase_not_paid", "purchase_revoked", "purchase_wrong_environment"}
                    if not over and age < TAP_STUCK_SECONDS:
                        if refusal.code == "purchase_invalid":
                            raise self._payment_open() from None  # it does not match what was started: for an operator to look at, not to be paid twice
                        raise  # Tap could not be asked: nothing is decided, so nothing new is started
                else:
                    if answer["unlocked"]:
                        return unlocked
                    if charge.status == OPEN and last["url"] and age < TAP_PAGE_SECONDS:
                        return {"unlocked": False, "provider": "tap", "status": "pending", "url": last["url"]}  # at the price it was started at
                    if charge.status != OPEN and age < TAP_STUCK_SECONDS:
                        raise self._payment_open()  # the buyer is at their bank
            # A request Tap may or may not have received (a timeout) is sent again with the same references, so that Tap answers
            # with the charge it already made instead of making a second one. Only while such a charge's page would still be open.
            waiting = self.store.tap_unattached(user_id, price, self.tap_currency, tap.live, self.store.clock() - TAP_REPLAY_SECONDS)
            if waiting:
                order, idempotent = waiting["order_ref"], waiting["idempotent_ref"]
            else:
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
        is always the one the payment was started for. Returns `{unlocked, provider, status: 'active' | 'pending', restored}`:
        `pending` is everything Tap has not decided (the page is open, the buyer is at their bank, a status this code does not
        know). Refuses a payment that ended unpaid (`purchase_not_paid`) and one that is not what was started.
        """
        return self._settle_tap(charge_id, caller)[0]

    def _settle_tap(self, charge_id, caller=None):
        """`settle_tap`, and beside its answer the charge as Tap gave it (None when Tap was not asked)."""
        tap = self._tap()
        attempt = self.store.tap_attempt(charge_id) if isinstance(charge_id, str) and CHARGE_ID.fullmatch(charge_id) else None
        if attempt is None:
            raise self._refuse("invalid")  # not a payment this server started: Tap is not even asked
        user_id = attempt["user_id"]
        if caller is not None and caller != user_id:
            raise self._refuse("other_account")
        held = self.store.purchase("tap", charge_id)
        if held is not None:  # settled before: the answer is on file and stays the same however often it is asked
            if held["state"] == "revoked":
                raise self._refuse("revoked")
            if not self._tap_counts(held["environment"]):
                raise self._refuse("wrong_environment")
            self._unlock(user_id, "tap")  # the purchase and the unlock are two writes: one that was stopped between them is finished here
            return {"unlocked": True, "provider": "tap", "status": "active", "restored": True}, None
        if bool(attempt["live"]) != tap.live:
            raise self._refuse("wrong_environment")  # started with the other kind of key: this key cannot ask about it
        charge = self._ask_tap(tap.retrieve_charge, charge_id)
        if charge.id == charge_id and charge.status in ENDED_UNPAID:
            self.store.tap_status(charge_id, charge.status)
            raise Refusal(409, "That payment was not completed, so nothing was unlocked.", "purchase_not_paid", status=charge.status.lower())
        # Required: the id, the amount and currency written down when the payment was started (this server wrote them itself, from
        # the price configured at that moment, so a price changed while the buyer was paying does not lose what they paid), the
        # mode, and the order reference this server made. Tap's copy of the metadata is refused only when it is there and says
        # something else; a payment is not lost because Tap left it out.
        same = (charge.id == charge_id and (amount_text(charge.amount, charge.currency), charge.currency) == (attempt["amount"], attempt["currency"])
                and charge.live_mode == tap.live and charge.order == attempt["order_ref"]
                and charge.account in (None, user_id) and charge.metadata_order in (None, attempt["order_ref"]))
        if not same:
            log.warning("Tap charge %s does not match the payment that was started for it; nothing was unlocked.", charge_id)
            raise self._refuse("invalid")
        if charge.status != PAID:
            return {"unlocked": False, "provider": "tap", "status": "pending", "restored": False}, charge
        self.store.tap_status(charge_id, PAID)
        outcome = self.store.claim("tap", charge_id, user_id, TAP_PRODUCT, "" if tap.live else "test", True, int(time.time() * 1000))
        if outcome in {"other_account", "revoked"}:
            raise self._refuse(outcome)
        self._unlock(user_id, "tap")
        others = [key for key in self.store.held_keys("tap", user_id) if key != charge_id]
        if others:  # an earlier charge was given up on, a new one made, and then both were paid: the account is unlocked once, and one is owed back
            log.warning("Tap charges %s and %s were both captured for one account; refund one of them by hand in Tap's dashboard.", charge_id, ", ".join(others))
        return {"unlocked": True, "provider": "tap", "status": "active", "restored": outcome == "restored"}, charge

    def tap_notification(self, raw, header):
        """Tap's webhook: the charge as JSON, signed in the `hashstring` header. It is only a prompt to ask Tap about that charge.

        Answers 200 once the charge has been looked at (whatever was found, and for a charge this server never started), 400 for
        a body that is not a charge, 401 for a wrong signature, and 503 when Tap could not be asked, so that Tap sends it again.
        """
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

    def recheck_tap(self, user_id):
        """Look again at this account's payment if Tap has not decided it yet and it is time to. Never raises.

        The buyer's return and Tap's webhook can both be missed (a closed tab, an outage). This is the third way a paid charge is
        noticed: when the account is next seen, at most once a minute at first and less often as the payment ages.
        """
        try:
            if self.tap is not None and self.tap_amount is not None:
                charge_id = self.store.tap_due(user_id)
                if charge_id:
                    self.settle_tap(charge_id)
        except Refusal:
            pass  # ended unpaid, a mismatch (already noted for the operator), or Tap could not be asked: the next look is already scheduled
        except Exception:  # a look at a payment must never fail the request that prompted it
            log.warning("A pending Tap payment could not be re-checked.")

    def apply_tap_environment(self):
        """Keep accounts in step with the kind of key in use (called once, when the service is built).

        A purchase paid for with a test card unlocks while the key is a test key, or while the operator allows it. With a live key
        it does not count: an account that only such a purchase holds open is locked again. Nothing is deleted, so going back
        to a test key, or allowing test purchases, opens it again.
        """
        if self.tap is None:
            return  # Tap is not configured here at all: nothing is decided about what was bought through it
        for user_id in self.store.tap_test_holders():
            if self.tap_allow_test:
                self._unlock(user_id, "tap")
            else:
                self._relock_if_nothing_holds_it(user_id)

    # -- an operator's seam ---------------------------------------------------------------------------------
    def revoke(self, provider, purchase_key, reason="operator"):
        """Take a purchase back by hand (support, a chargeback learned elsewhere). The key is Apple's original transaction id, for Google the token's hash, for Tap the charge id."""
        changed, holder = self.store.revoke(provider, purchase_key, 2 ** 53, reason)
        self._relock_if_nothing_holds_it(holder)
        return changed
