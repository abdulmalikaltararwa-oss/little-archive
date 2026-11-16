"""Selling the unlock on the web through Tap Payments: starting a payment, and believing only what Tap says became of it.

Everything is synthetic. Tap is a dictionary here, and the real HTTP client talks to a transport that plays Tap's API. These tests
show that this code does what its checks say. They do not show that Tap sends what its documentation describes: no charge was
ever created at Tap, in its sandbox or anywhere else.
"""
from dataclasses import replace
from decimal import Decimal
import hashlib
import hmac
import io
import json
import logging
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch
from uuid import uuid4

from fastapi.testclient import TestClient
import httpx

sys.path.insert(0, str(Path(__file__).resolve().parent))
from support_hosted import SigningKey, bearer, claims, hosted_app, no_worker_threads  # noqa: E402

from server.config import Config  # noqa: E402
from server.purchases.tap import STATUSES, HttpTapClient, TapCharge, TapClient, TapError, amount_text, hashstring, money, page_address, read_charge  # noqa: E402

KEY = "sk_" "test_SyntheticKeyNeverIssuedByTap0123"
PRICE = Decimal("2.500")
BUYER = {"email": "buyer@example.test", "name": "Synthetic Buyer"}


class FakeTap(TapClient):
    """Tap as a dictionary: charge id -> TapCharge. `change` is whatever happened on Tap's page; `down` makes Tap unreachable."""

    def __init__(self, key=KEY, live=False):
        self.key, self.live, self.charges, self.created, self.asked, self.down = key, live, {}, [], [], None

    def create_charge(self, amount, currency, *, order, idempotent, account, name, email, redirect_url, post_url=""):
        if self.down:
            raise TapError(self.down)
        charge_id = "chg_TS" + uuid4().hex
        self.created.append({"id": charge_id, "amount": amount, "currency": currency, "order": order, "idempotent": idempotent, "account": account, "name": name, "email": email,
                             "redirect_url": redirect_url, "post_url": post_url})
        self.charges[charge_id] = TapCharge(id=charge_id, status="INITIATED", amount=amount, currency=currency, live_mode=self.live, order=order, account=account,
                                            url="https://sandbox.payments.tap.company/pay/" + charge_id, payment_reference="pay_" + charge_id[-8:], created="1763300000000")
        return self.charges[charge_id]

    def retrieve_charge(self, charge_id):
        self.asked.append(charge_id)
        if self.down:
            raise TapError(self.down)
        if charge_id not in self.charges:
            raise TapError("not_found")
        return self.charges[charge_id]

    def signed(self, charge, header):
        return hmac.compare_digest(hashstring(self.key, charge), header)

    def change(self, charge_id, **fields):
        self.charges[charge_id] = replace(self.charges[charge_id], **fields)

    def webhook(self, charge_id, key=None, **claimed):
        """The body and `hashstring` header Tap would post for this charge; `claimed` is what a forger would like it to say."""
        charge = replace(self.charges[charge_id], **claimed)
        body = {"object": "charge", "id": charge.id, "status": charge.status, "amount": float(charge.amount), "currency": charge.currency, "live_mode": charge.live_mode,
                "reference": {"order": charge.order, "gateway": charge.gateway_reference, "payment": charge.payment_reference}, "transaction": {"created": charge.created},
                "metadata": {"account_id": charge.account}}
        return json.dumps(body).encode(), {"hashstring": hashstring(key or self.key, charge), "content-type": "application/json"}


class TapCase(unittest.TestCase):
    settings = {"tap_secret_key": KEY, "tap_price": "2.500", "hosted_deep_reads_monthly": 5, "hosted_free_deep_reads_monthly": 1}

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="little-archive-tap-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.enterContext(no_worker_threads())
        self.key, self.tap = SigningKey(), FakeTap()
        self.build()

    def build(self, clients=None, **settings):
        self.app, _ = hosted_app(self.root / "app", self.key, purchase_clients={"tap": self.tap} if clients is None else clients, **{**self.settings, **settings})
        self.client = TestClient(self.app)
        self.client.__enter__()
        self.addCleanup(self.client.__exit__, None, None, None)
        self.service = self.app.state.purchases

    def account(self):
        user = str(uuid4())
        return user, bearer(self.key.sign(claims(user)))

    def start(self, auth, **body):
        return self.client.post("/api/purchases/tap/start", json={**BUYER, **body}, headers=auth)

    def started(self, auth):
        """Start a payment and return the id of the charge Tap made for it."""
        answer = self.start(auth)
        self.assertEqual(answer.status_code, 200, answer.text)
        return self.tap.created[-1]["id"]

    def confirm(self, auth, charge_id):
        return self.client.post("/api/purchases/tap/confirm", json={"tap_id": charge_id}, headers=auth)

    def back(self, charge_id):
        return self.client.get("/api/purchases/tap/return", params={"tap_id": charge_id})

    def notify(self, charge_id, **claimed):
        raw, headers = self.tap.webhook(charge_id, **claimed)
        return self.client.post("/api/purchases/tap/notifications", content=raw, headers=headers)

    def summary(self, auth):
        return self.client.get("/api/account", headers=auth).json()["entitlements"]

    def rows(self, table="purchases"):
        with sqlite3.connect(self.root / "app" / "data" / "accounts.sqlite3") as c:
            c.row_factory = sqlite3.Row
            return [dict(r) for r in c.execute("SELECT * FROM " + table)]

    def refused(self, response, status, code):
        self.assertEqual((response.status_code, response.json().get("code")), (status, code), response.text[:200])


class StartTests(TapCase):
    def test_starting_makes_one_charge_for_the_configured_price_and_answers_taps_page(self):
        user, auth = self.account()
        answer = self.start(auth)
        self.assertEqual(answer.status_code, 200, answer.text)
        asked = self.tap.created[0]
        self.assertEqual(answer.json(), {"unlocked": False, "provider": "tap", "status": "pending", "url": "https://sandbox.payments.tap.company/pay/" + asked["id"]})
        self.assertEqual((asked["amount"], asked["currency"], asked["account"], asked["name"], asked["email"]), (PRICE, "KWD", user, "Synthetic Buyer", "buyer@example.test"))
        self.assertEqual((asked["redirect_url"], asked["post_url"]), ("http://testserver/api/purchases/tap/return", "http://testserver/api/purchases/tap/notifications"))
        self.assertRegex(asked["order"], r"^la_[0-9a-f]{24}$", "the order reference is made here, not taken from the request")
        self.assertFalse(self.summary(auth)["unlocked"], "starting a payment unlocks nothing")
        attempt = self.rows("tap_attempts")[0]
        self.assertEqual((attempt["user_id"], attempt["charge_id"], attempt["amount"], attempt["currency"], attempt["status"]), (user, asked["id"], "2.500", "KWD", "INITIATED"))
        self.assertNotIn("buyer@example.test", json.dumps(self.rows("tap_attempts")), "the buyer's email is passed to Tap and not kept")

    def test_an_unlocked_account_is_told_so_and_no_charge_is_made(self):
        user, auth = self.account()
        self.app.state.entitlements.set_unlocked(user, True)
        self.assertEqual(self.start(auth).json(), {"unlocked": True, "provider": "tap", "status": "unlocked", "url": None})
        self.assertEqual((self.tap.created, self.rows("tap_attempts")), ([], []))

    def test_asking_twice_gives_the_page_already_open_and_a_finished_payment_gives_a_new_one(self):
        user, auth = self.account()
        first = self.start(auth).json()["url"]
        self.assertEqual(self.start(auth).json()["url"], first)
        self.assertEqual(len(self.tap.created), 1, "two taps on Buy must not make two charges a person could pay twice")
        self.tap.change(self.tap.created[0]["id"], status="DECLINED")
        second = self.start(auth).json()["url"]
        self.assertNotEqual(second, first)
        self.assertEqual(len({row["idempotent_ref"] for row in self.rows("tap_attempts")}), 2, "each attempt has its own references")

    def test_starting_again_after_paying_in_another_tab_unlocks_instead_of_charging_again(self):
        user, auth = self.account()
        charge = self.started(auth)
        self.tap.change(charge, status="CAPTURED")
        self.assertEqual(self.start(auth).json(), {"unlocked": True, "provider": "tap", "status": "unlocked", "url": None})
        self.assertEqual((len(self.tap.created), self.summary(auth)["unlocked_via"]), (1, "tap"))

    def test_a_charge_that_is_not_the_one_asked_for_is_not_handed_to_the_buyer(self):
        user, auth = self.account()
        original = self.tap.create_charge
        for wrong in ({"amount": Decimal("0.100")}, {"currency": "USD"}, {"live_mode": True}, {"status": "CAPTURED"}, {"order": "someone-elses"}, {"url": ""}):
            with patch.object(self.tap, "create_charge", side_effect=lambda *a, **k: replace(original(*a, **k), **wrong)), self.assertLogs("little_archive", "WARNING"):
                self.refused(self.start(auth), 503, "purchases_unavailable")
        self.assertEqual([row["charge_id"] for row in self.rows("tap_attempts")], [None] * 6)

    def test_the_buyer_details_are_checked_and_nothing_else_is_read_from_the_request(self):
        user, auth = self.account()
        for body in ({"email": "not-an-address"}, {"email": ""}, {"name": "line\nbreak"}, {"amount": "0.100"}, {"currency": "USD"}, {"account_id": str(uuid4())}, {"unlocked": True}):
            self.assertEqual(self.start(auth, **body).status_code, 422, body)
        self.assertEqual(self.tap.created, [])
        self.assertEqual(self.client.post("/api/purchases/tap/start", json={"email": "buyer@example.test"}, headers=auth).status_code, 200, "a name is optional")
        self.assertEqual(self.tap.created[0]["name"], "Little Archive customer")

    def test_when_tap_cannot_be_reached_or_refuses_the_key_the_buyer_is_told_to_try_again(self):
        user, auth = self.account()
        for kind, reason in (("unavailable", "unavailable"), ("forbidden", "forbidden"), ("invalid", "unavailable")):
            self.tap.down = kind
            answer = self.start(auth)
            self.refused(answer, 503, "purchases_unavailable")
            self.assertEqual((answer.json()["provider"], answer.json()["reason"], answer.headers["retry-after"]), ("tap", reason, "30"))


class SettleTests(TapCase):
    def test_a_captured_charge_unlocks_the_account_that_started_it_and_says_so(self):
        user, auth = self.account()
        self.assertEqual(self.summary(auth)["deep_reads"]["limit"], 1)
        charge = self.started(auth)
        waiting = self.back(charge)
        self.assertEqual(waiting.status_code, 200)
        self.assertIn("Payment not confirmed yet", waiting.text)
        self.assertFalse(self.summary(auth)["unlocked"], "coming back before paying unlocks nothing")
        self.tap.change(charge, status="CAPTURED")
        page = self.back(charge)
        self.assertEqual((page.status_code, page.headers["content-type"]), (200, "text/html; charset=utf-8"))
        self.assertIn("<h1>Payment received</h1>", page.text)
        summary = self.summary(auth)
        self.assertEqual((summary["unlocked"], summary["unlocked_via"], summary["deep_reads"]["limit"]), (True, "tap", 5), "the unlock changes what the account may do")
        listed = self.client.get("/api/purchases", headers=auth).json()
        self.assertEqual((listed["unlocked"], listed["unlocked_via"], listed["purchases"]), (True, "tap", [{"provider": "tap", "product_id": "unlock", "status": "active", "environment": "test"}]))
        self.assertNotIn(charge, json.dumps(listed), "Tap's charge id is not given back")

    def test_the_account_can_ask_for_itself_and_is_told_to_wait_while_tap_has_not_finished(self):
        user, auth = self.account()
        charge = self.started(auth)
        waiting = self.confirm(auth, charge)
        self.assertEqual((waiting.status_code, waiting.json()), (202, {"unlocked": False, "provider": "tap", "status": "pending", "restored": False}))
        self.tap.change(charge, status="CAPTURED")
        self.assertEqual(self.confirm(auth, charge).json(), {"unlocked": True, "provider": "tap", "status": "active", "restored": False})

    def test_the_return_page_is_plain_and_says_nothing_it_was_sent(self):
        user, auth = self.account()
        charge = self.started(auth)
        self.tap.change(charge, status="CAPTURED")
        page = self.back(charge)
        for part in ('<html lang="en">', "<title>Payment received - Little Archive</title>", '<meta name="viewport"', "go back to Little Archive"):
            self.assertIn(part, page.text)
        for absent in (charge, user, "<script", "<style", "style=", "http://", "https://", KEY):
            self.assertNotIn(absent, page.text)
        self.assertEqual((page.headers["cache-control"], page.headers["x-frame-options"]), ("no-store", "DENY"))
        self.assertIn("script-src 'self'", page.headers["content-security-policy"])
        hostile = self.client.get("/api/purchases/tap/return", params={"tap_id": "<script>alert(1)</script>"})
        self.assertEqual(hostile.status_code, 404)
        self.assertNotIn("alert", hostile.text)

    def test_a_charge_for_another_amount_currency_account_order_or_mode_unlocks_nobody(self):
        other, o = self.account()
        for wrong in ({"amount": Decimal("0.100")}, {"amount": Decimal("2.501")}, {"currency": "USD", "amount": Decimal("2.50")}, {"currency": "BHD"}, {"account": other}, {"account": ""},
                      {"order": "la_" + "0" * 24}, {"live_mode": True}, {"id": "chg_TS" + "f" * 32}):
            user, auth = self.account()
            charge = self.started(auth)
            self.tap.change(charge, status="CAPTURED", **wrong)
            with self.assertLogs("little_archive", "WARNING") as noted:
                self.refused(self.confirm(auth, charge), 400, "purchase_invalid")
                self.assertIn("Payment not found", self.back(charge).text)
                self.assertEqual(self.notify(charge).json(), {"received": True, "action": "ignored"})
            self.assertIn("does not match", noted.output[0], "noted for the operator")
            self.assertNotIn(user, "".join(noted.output))
            self.assertFalse(self.summary(auth)["unlocked"], wrong)
        self.assertEqual((self.summary(o)["unlocked"], self.rows()), (False, []))

    def test_only_captured_is_paid(self):
        user, auth = self.account()
        for status in sorted(STATUSES - {"CAPTURED", "INITIATED"}) + ["A_WORD_TAP_ADDS_LATER", "captured"]:
            charge = self.started(auth)
            self.tap.change(charge, status=status)
            answer = self.confirm(auth, charge)
            self.refused(answer, 409, "purchase_not_paid")
            self.assertEqual(answer.json()["status"], status.lower() if status in STATUSES else "unknown")
            page = self.back(charge)
            self.assertEqual(page.status_code, 200)
            self.assertIn("Payment not completed", page.text)
        self.assertEqual((self.summary(auth)["unlocked"], self.rows()), (False, []))

    def test_the_same_charge_twice_unlocks_once_and_never_a_second_account(self):
        (alice, a), (bob, b) = self.account(), self.account()
        charge = self.started(a)
        self.tap.change(charge, status="CAPTURED")
        self.assertEqual(self.confirm(a, charge).json()["restored"], False)
        asked = len(self.tap.asked)
        again = self.confirm(a, charge)
        self.assertEqual((again.status_code, again.json()), (200, {"unlocked": True, "provider": "tap", "status": "active", "restored": True}))
        self.assertIn("Payment received", self.back(charge).text)
        self.assertEqual(self.notify(charge).json(), {"received": True, "action": "unlocked"})
        self.assertEqual((len(self.rows()), len(self.tap.asked)), (1, asked), "once settled, the answer is on file and Tap is not asked again")
        self.refused(self.confirm(b, charge), 409, "purchase_bound_elsewhere")
        self.assertFalse(self.summary(b)["unlocked"], "presenting someone else's charge unlocks nothing")
        self.assertEqual(self.rows()[0]["user_id"], alice)

    def test_another_account_cannot_claim_a_charge_before_its_buyer_does(self):
        (alice, a), (bob, b) = self.account(), self.account()
        charge = self.started(a)
        self.tap.change(charge, status="CAPTURED")
        before = len(self.tap.asked)
        self.refused(self.confirm(b, charge), 409, "purchase_bound_elsewhere")
        self.assertEqual((len(self.tap.asked), self.rows()), (before, []))
        self.back(charge)  # whoever opens the return address, the account that started the payment is the one unlocked
        self.assertEqual((self.summary(a)["unlocked"], self.summary(b)["unlocked"]), (True, False))

    def test_a_charge_this_server_never_started_is_not_even_asked_about(self):
        user, auth = self.account()
        foreign = "chg_TS" + "a" * 32
        self.tap.charges[foreign] = TapCharge(id=foreign, status="CAPTURED", amount=PRICE, currency="KWD", live_mode=False, order="la_" + "1" * 24, account=user)
        self.refused(self.confirm(auth, foreign), 400, "purchase_invalid")
        self.assertEqual(self.back(foreign).status_code, 404)
        self.assertEqual(self.notify(foreign).json()["action"], "ignored")
        for shape in ("", "chg_", "tok_" + "a" * 32, "chg_" + "a" * 200, "chg_TS/../x"):
            self.assertEqual(self.back(shape).status_code, 404, shape)
            self.assertIn(self.confirm(auth, shape).status_code, {400, 422}, shape)
        self.assertEqual((self.tap.asked, self.summary(auth)["unlocked"]), ([], False))

    def test_the_unlock_survives_a_restart(self):
        user, auth = self.account()
        charge = self.started(auth)
        self.tap.change(charge, status="CAPTURED")
        self.back(charge)
        self.build()
        self.assertEqual((self.summary(auth)["unlocked"], self.summary(auth)["unlocked_via"]), (True, "tap"))
        self.assertEqual(self.confirm(auth, charge).json()["restored"], True)
        self.assertEqual(len(self.rows()), 1)

    def test_a_payment_started_before_a_restart_can_still_be_settled_after_it(self):
        user, auth = self.account()
        charge = self.started(auth)
        self.build()
        self.tap.change(charge, status="CAPTURED")
        self.assertEqual(self.notify(charge).json(), {"received": True, "action": "unlocked"})
        self.assertTrue(self.summary(auth)["unlocked"])

    def test_a_price_changed_while_the_buyer_is_paying_does_not_strand_what_they_paid(self):
        user, auth = self.account()
        charge = self.started(auth)
        self.build(tap_price="3.000")
        self.tap.change(charge, status="CAPTURED")
        self.assertEqual(self.confirm(auth, charge).status_code, 200, "the charge is for the price written down when the payment was started")
        other, o = self.account()
        self.start(o)
        self.assertEqual(self.tap.created[-1]["amount"], Decimal("3.000"), "a new payment is at the new price")

    def test_when_tap_cannot_be_asked_nothing_is_decided(self):
        user, auth = self.account()
        charge = self.started(auth)
        self.tap.change(charge, status="CAPTURED")
        self.tap.down = "unavailable"
        answer = self.confirm(auth, charge)
        self.refused(answer, 503, "purchases_unavailable")
        self.assertEqual(answer.headers["retry-after"], "30")
        page = self.back(charge)
        self.assertEqual(page.status_code, 503)
        self.assertIn("could not be checked", page.text)
        self.assertEqual(self.notify(charge).status_code, 503, "so that Tap sends the notification again")
        self.tap.down = None
        self.assertEqual(self.notify(charge).json()["action"], "unlocked")

    def test_an_operator_can_take_a_tap_purchase_back(self):
        user, auth = self.account()
        charge = self.started(auth)
        self.tap.change(charge, status="CAPTURED")
        self.confirm(auth, charge)
        self.assertTrue(self.service.revoke("tap", charge, "refunded in the dashboard"))
        self.assertFalse(self.summary(auth)["unlocked"])
        self.refused(self.confirm(auth, charge), 409, "purchase_revoked")
        self.assertIn("Payment not found", self.back(charge).text)
        self.assertFalse(self.summary(auth)["unlocked"])

    def test_a_hand_made_unlock_keeps_its_name_and_a_deleted_accounts_charge_is_gone(self):
        user, auth = self.account()
        charge = self.started(auth)
        self.app.state.entitlements.set_unlocked(user, True, source="manual")
        self.tap.change(charge, status="CAPTURED")
        self.confirm(auth, charge)
        self.assertEqual(self.summary(auth)["unlocked_via"], "manual")
        self.assertEqual(self.client.post("/api/account/delete", json={"confirm": "DELETE"}, headers=auth).status_code, 200)
        self.assertEqual((self.rows(), self.rows("tap_attempts")), ([], []), "nothing about the payment is kept once its account is gone")
        self.assertEqual(self.back(charge).status_code, 404)
        self.assertFalse(self.app.state.entitlements.is_unlocked(user))


class NotificationTests(TapCase):
    def test_a_signed_notification_prompts_a_look_at_tap_and_the_unlock_follows_what_tap_says(self):
        user, auth = self.account()
        charge = self.started(auth)
        self.assertEqual(self.notify(charge).json(), {"received": True, "action": "pending"})
        self.tap.change(charge, status="CAPTURED")
        answer = self.notify(charge)
        self.assertEqual((answer.status_code, answer.json()), (200, {"received": True, "action": "unlocked"}))
        self.assertEqual(self.summary(auth)["unlocked_via"], "tap")

    def test_a_forged_notification_unlocks_nothing(self):
        user, auth = self.account()
        charge = self.started(auth)
        asked = len(self.tap.asked)
        raw, headers = self.tap.webhook(charge, status="CAPTURED")
        for bad in ({"hashstring": "0" * 64}, {"hashstring": ""}, {"hashstring": "not-hex"}, {"hashstring": headers["hashstring"][:-1]}):
            self.refused(self.client.post("/api/purchases/tap/notifications", content=raw, headers={**headers, **bad}), 401, "notification_unauthenticated")
        self.refused(self.client.post("/api/purchases/tap/notifications", content=raw, headers={"content-type": "application/json"}), 401, "notification_unauthenticated")
        raw, headers = self.tap.webhook(charge, key="sk_" "test_SomeoneElsesKey000000000000", status="CAPTURED")
        self.refused(self.client.post("/api/purchases/tap/notifications", content=raw, headers=headers), 401, "notification_unauthenticated")
        raw, headers = self.tap.webhook(charge)
        tampered = raw.replace(b'"INITIATED"', b'"CAPTURED"')
        self.refused(self.client.post("/api/purchases/tap/notifications", content=tampered, headers=headers), 401, "notification_unauthenticated")
        self.assertEqual(len(self.tap.asked), asked, "an unsigned notification does not even make the server ask Tap")
        self.assertFalse(self.summary(auth)["unlocked"])

    def test_a_correctly_signed_body_is_still_not_believed(self):
        user, auth = self.account()
        charge = self.started(auth)
        answer = self.notify(charge, status="CAPTURED")  # signed with the right key, saying paid, while Tap says the charge is still open
        self.assertEqual(answer.json(), {"received": True, "action": "pending"})
        self.assertFalse(self.summary(auth)["unlocked"])

    def test_what_is_not_a_charge_is_refused(self):
        for raw in (b"", b"not json", b"[]", b'{"id": "chg_TS0123456789"}', json.dumps({"object": "refund", "id": "chg_TS0123456789", "status": "CAPTURED", "amount": 2.5, "currency": "KWD", "live_mode": False}).encode(),
                    json.dumps({"id": "chg_TS0123456789", "status": "CAPTURED", "amount": 2.5001, "currency": "KWD", "live_mode": False}).encode()):
            self.refused(self.client.post("/api/purchases/tap/notifications", content=raw, headers={"hashstring": "0" * 64, "content-type": "application/json"}), 400, "notification_invalid")
        big = self.client.post("/api/purchases/tap/notifications", content=b"x" * (129 * 1024), headers={"hashstring": "0" * 64})
        self.assertEqual(big.status_code, 413)

    def test_the_notification_route_shares_the_stores_budget_per_address(self):
        statuses = [self.client.post("/api/purchases/tap/notifications", content=b"{}", headers={"hashstring": "0" * 64}).status_code for _ in range(200)]
        self.assertEqual(set(statuses[:60]), {400})
        self.assertIn(429, statuses, "sixty a minute from one address, as for the stores' notifications")


class SwitchedOffTests(TapCase):
    def test_without_a_key_every_tap_route_says_it_is_not_set_up_and_nothing_is_unlocked(self):
        self.build(clients={}, tap_secret_key="", tap_price="")
        self.assertIsNone(self.service.tap)
        user, auth = self.account()
        for answer in (self.start(auth), self.confirm(auth, "chg_TS" + "a" * 32), self.client.post("/api/purchases/tap/notifications", content=b"{}", headers={"hashstring": "0" * 64})):
            self.refused(answer, 503, "purchases_unavailable")
            self.assertEqual((answer.json()["provider"], answer.json()["reason"]), ("tap", "not_configured"))
        self.assertEqual(self.back("chg_TS" + "a" * 32).status_code, 503)
        self.assertEqual((self.summary(auth)["unlocked"], self.rows("tap_attempts")), (False, []))

    def test_the_routes_need_sign_in_and_answer_404_to_a_self_hosted_server(self):
        for path in ("/api/purchases/tap/start", "/api/purchases/tap/confirm"):
            self.assertEqual(self.client.post(path, json={}).status_code, 401, path)
        from server.app import create_app
        with tempfile.TemporaryDirectory() as folder:
            app = create_app(Config(data_dir=Path(folder) / "data", admin_password="a-self-hosted-owner-password", public_url="http://testserver", testing=True))
            with TestClient(app) as owner:
                login = owner.post("/api/auth/devices", json={"password": "a-self-hosted-owner-password", "name": "Phone"}).json()
                headers = {"Authorization": "Bearer " + login["token"]}
                for method, path in (("POST", "/api/purchases/tap/start"), ("POST", "/api/purchases/tap/confirm"), ("GET", "/api/purchases/tap/return"), ("POST", "/api/purchases/tap/notifications")):
                    self.assertEqual(owner.request(method, path, json={}, headers=headers).status_code, 404, "self-hosted: " + path)
                    self.assertEqual(owner.request(method, path, json={}).status_code, 404, "self-hosted, anonymous: " + path)


class SecretTests(TapCase):
    def test_the_key_is_in_no_answer_no_log_line_and_no_description_of_the_configuration(self):
        seen = io.StringIO()
        handler = logging.StreamHandler(seen)
        logging.getLogger().addHandler(handler)
        self.addCleanup(logging.getLogger().removeHandler, handler)
        previous = logging.getLogger().level
        logging.getLogger().setLevel(logging.DEBUG)
        self.addCleanup(logging.getLogger().setLevel, previous)

        def tap_api(request):
            if request.method == "POST":
                sent = json.loads(request.content)
                return httpx.Response(200, json={"object": "charge", "id": "chg_TS0123456789abcdef", "status": "INITIATED", "amount": sent["amount"], "currency": sent["currency"], "live_mode": False,
                                                 "reference": sent["reference"], "metadata": sent["metadata"], "transaction": {"url": "https://sandbox.payments.tap.company/pay/x", "created": "1"}})
            return httpx.Response(500, text="upstream failure")

        self.build(clients={"tap": HttpTapClient(KEY, transport=httpx.MockTransport(tap_api))})
        (user, auth), (other, o) = self.account(), self.account()
        charge = "chg_TS0123456789abcdef"
        answers = [self.start(auth), self.start(auth), self.confirm(auth, charge), self.confirm(o, charge), self.back(charge), self.back("chg_TS" + "9" * 20),
                   self.client.post("/api/purchases/tap/notifications", content=b'{"object":"charge","id":"chg_TS0123456789abcdef","status":"CAPTURED","amount":2.5,"currency":"KWD","live_mode":false}', headers={"hashstring": "0" * 64}),
                   self.client.get("/api/purchases", headers=auth), self.client.get("/api/account", headers=auth), self.client.get("/api/health"), self.client.get("/api/discovery")]
        self.assertEqual([a.status_code for a in answers[:7]], [200, 503, 503, 409, 503, 404, 401])
        said = "\n".join(a.text + repr(dict(a.headers)) for a in answers) + seen.getvalue() + repr(self.app.state.config if hasattr(self.app.state, "config") else "") + repr(self.service.tap) + repr(vars(self.service.tap).keys())
        config = Config.from_env({"LA_MODE": "hosted", "LA_SUPABASE_URL": "https://p.supabase.test", "LA_DATA_DIR": str(self.root / "elsewhere"), "LA_TAP_SECRET_KEY": KEY, "LA_TAP_PRICE": "2.500"})
        said += repr(config) + str(config)
        self.assertEqual(config.tap_secret_key, KEY)
        self.assertNotIn(KEY, said)
        self.assertNotIn(KEY[8:], said)
        self.assertIn("HttpTapClient(test key)", said)

    def test_doctor_says_only_whether_tap_is_set_up(self):
        from server.diagnostics import diagnose
        environment = {"LA_MODE": "hosted", "LA_SUPABASE_URL": "https://synthetic-project.supabase.test", "LA_DATA_DIR": str(self.root / "doctor"), "LA_PUBLIC_URL": "http://localhost:8787",
                       "LA_SUPABASE_SERVICE_KEY": "sb_secret_synthetic0test0value0not0real0"}

        def row(**more):
            with patch("httpx.Client", side_effect=AssertionError("Network was not requested")):
                result = diagnose(env_file=self.root / "absent.env", environment={**environment, **more})
            return next(r for r in result["checks"] if r["id"] == "tap_payments"), json.dumps(result)

        off, _ = row()
        self.assertEqual((off["status"], off["code"]), ("passed", "tap_not_configured"))
        on, printed = row(LA_TAP_SECRET_KEY=KEY, LA_TAP_PRICE="2.500")
        self.assertEqual((on["status"], on["code"], set(on)), ("passed", "tap_configured", {"id", "status", "code", "summary"}))
        self.assertNotIn(KEY, printed)
        self.assertNotIn("2.500", printed)
        with patch("httpx.Client", side_effect=AssertionError("Network was not requested")):
            bad = json.dumps(diagnose(env_file=self.root / "absent.env", environment={**environment, "LA_TAP_SECRET_KEY": KEY + "!", "LA_TAP_PRICE": "2.500"}))
        self.assertNotIn(KEY, bad)


class FakeTapApi:
    """Stands in for https://api.tap.company: records each request and answers a charge."""

    def __init__(self):
        self.requests, self.status, self.changes, self.raw = [], 200, {}, None

    def __call__(self, request):
        self.requests.append(request)
        if self.raw is not None:
            return httpx.Response(self.status, content=self.raw)
        charge = {"object": "charge", "id": "chg_TS0123456789abcdef", "status": "INITIATED", "amount": 2.5, "currency": "KWD", "live_mode": False, "threeDSecure": True,
                  "reference": {"order": "la_order", "transaction": "la_order", "idempotent": "idem", "gateway": "", "payment": "4516251234"}, "metadata": {"account_id": "account-1"},
                  "transaction": {"created": "1763300000000", "url": "https://sandbox.payments.tap.company/pay/chg_TS0123456789abcdef", "expiry": {"period": 30, "type": "MINUTE"}},
                  "customer": {"first_name": "Synthetic", "email": "buyer@example.test"}, "source": {"object": "source", "id": "src_all"}, **self.changes}
        return httpx.Response(self.status, json=charge)


class HttpTapClientTests(unittest.TestCase):
    def setUp(self):
        self.api = FakeTapApi()
        self.client = HttpTapClient(KEY, transport=httpx.MockTransport(self.api))

    def create(self, client=None, **changes):
        named = {"order": "la_order", "idempotent": "idem", "account": "account-1", "name": "Synthetic", "email": "buyer@example.test", "redirect_url": "https://archive.example/api/purchases/tap/return",
                 "post_url": "https://archive.example/api/purchases/tap/notifications", **changes}
        return (client or self.client).create_charge(PRICE, "KWD", **named)

    def test_a_charge_is_created_on_taps_hosted_page_with_every_method_and_the_amount_as_a_number(self):
        charge = self.create()
        self.assertEqual((charge.id, charge.status, charge.amount, charge.currency, charge.live_mode, charge.order, charge.account), ("chg_TS0123456789abcdef", "INITIATED", PRICE, "KWD", False, "la_order", "account-1"))
        self.assertEqual(charge.url, "https://sandbox.payments.tap.company/pay/chg_TS0123456789abcdef")
        sent = self.api.requests[0]
        self.assertEqual((sent.method, str(sent.url), sent.headers["authorization"], sent.headers["content-type"]), ("POST", "https://api.tap.company/v2/charges", "Bearer " + KEY, "application/json"))
        self.assertIn(b'"amount": 2.500,', sent.content, "three decimals for KWD, as a JSON number")
        body = json.loads(sent.content)
        self.assertEqual(body, {"amount": 2.5, "currency": "KWD", "customer_initiated": True, "threeDSecure": True, "save_card": False, "description": "Little Archive unlock", "source": {"id": "src_all"},
                                "reference": {"order": "la_order", "transaction": "la_order", "idempotent": "idem"}, "metadata": {"account_id": "account-1"},
                                "customer": {"first_name": "Synthetic", "email": "buyer@example.test"}, "redirect": {"url": "https://archive.example/api/purchases/tap/return"},
                                "post": {"url": "https://archive.example/api/purchases/tap/notifications"}})

    def test_the_webhook_is_left_out_for_a_loopback_server_and_a_merchant_is_named_when_configured(self):
        self.create(post_url="")
        self.assertNotIn("post", json.loads(self.api.requests[0].content))
        self.create(client=HttpTapClient(KEY, merchant_id="599424", transport=httpx.MockTransport(self.api)))
        self.assertEqual(json.loads(self.api.requests[1].content)["merchant"], {"id": "599424"})

    def test_a_page_that_is_not_taps_is_never_handed_to_a_buyer(self):
        for url in ("https://tap.company.example/pay/x", "http://sandbox.payments.tap.company/pay/x", "https://sandbox.payments.tap.company/", "https://user@sandbox.payments.tap.company/pay/x",
                    "https://sandbox.payments.tap.company:8443/pay/x", "https://kw.payments.tap.company/pay/x", "javascript:alert(1)", "", None):
            self.api.changes = {"transaction": {"url": url, "created": "1"}}
            with self.assertRaises(TapError, msg=url) as caught:
                self.create()
            self.assertEqual(caught.exception.kind, "invalid")
        self.assertEqual(page_address("https://kw.payments.tap.company/pay/x", True), "https://kw.payments.tap.company/pay/x", "the live page, for a live key")
        self.assertIsNone(page_address("https://sandbox.payments.tap.company/pay/x", True))

    def test_a_charge_is_read_by_its_id_and_a_name_that_could_change_the_address_is_refused_first(self):
        self.api.changes = {"status": "CAPTURED", "amount": "2.500"}
        charge = self.client.retrieve_charge("chg_TS0123456789abcdef")
        self.assertEqual((charge.status, charge.amount, charge.payment_reference, charge.created), ("CAPTURED", PRICE, "4516251234", "1763300000000"))
        self.assertEqual((self.api.requests[0].method, str(self.api.requests[0].url)), ("GET", "https://api.tap.company/v2/charges/chg_TS0123456789abcdef"))
        for bad in ("chg_../refunds", "chg_TS012345?x=1", "", "tok_TS0123456789"):
            with self.assertRaises(TapError) as caught:
                self.client.retrieve_charge(bad)
            self.assertEqual(caught.exception.kind, "not_found")
        self.assertEqual(len(self.api.requests), 1)

    def test_what_tap_answers_other_than_a_charge(self):
        for status, kind in ((401, "forbidden"), (403, "forbidden"), (404, "not_found"), (400, "not_found"), (429, "unavailable"), (500, "unavailable"), (302, "unavailable")):
            self.api.status = status
            with self.assertRaises(TapError) as caught:
                self.client.retrieve_charge("chg_TS0123456789abcdef")
            self.assertEqual(caught.exception.kind, kind, status)
        self.api.status = 400
        with self.assertRaises(TapError) as caught:
            self.create()
        self.assertEqual(caught.exception.kind, "forbidden", "a refused create is the key's or the account's doing")
        self.api.status = 200
        for raw in (b"not json", b"[]", b"{}", b'{"id":"chg_TS0123456789abcdef","status":"CAPTURED","amount":"lots","currency":"KWD","live_mode":false}',
                    b'{"id":"chg_TS0123456789abcdef","status":"CAPTURED","amount":2.5,"currency":"XXX","live_mode":false}', b'{"id":"chg_TS0123456789abcdef","status":"CAPTURED","amount":2.5,"currency":"KWD","live_mode":"no"}',
                    b'{"id":"chg_TS0123456789abcdef","status":"CAPTURED","amount":true,"currency":"KWD","live_mode":false}', b'{"id":"chg_TS0123456789abcdef","status":"CAPTURED","amount":-2.5,"currency":"KWD","live_mode":false}'):
            self.api.raw = raw
            with self.assertRaises(TapError, msg=raw) as caught:
                self.client.retrieve_charge("chg_TS0123456789abcdef")
            self.assertEqual(caught.exception.kind, "invalid")
        self.api.raw = b" " * (65 * 1024)
        with self.assertRaises(TapError) as caught:
            self.client.retrieve_charge("chg_TS0123456789abcdef")
        self.assertEqual(caught.exception.kind, "unavailable", "an answer larger than a charge could be is not read to the end")

    def test_a_network_failure_is_unavailable_and_says_nothing_of_the_key(self):
        def broken(request):
            raise httpx.ConnectError("could not connect with " + request.headers["authorization"])
        client = HttpTapClient(KEY, transport=httpx.MockTransport(broken))
        with self.assertRaises(TapError) as caught:
            client.retrieve_charge("chg_TS0123456789abcdef")
        self.assertEqual(caught.exception.kind, "unavailable")
        self.assertIsNone(caught.exception.__cause__)
        self.assertNotIn(KEY, repr(caught.exception) + str(caught.exception) + repr(client))
        for bad in ("", "pk_test_SyntheticKeyNeverIssuedByTap0123", "sk_prod_x", KEY + "\n", None):
            with self.assertRaises(ValueError) as refused:
                HttpTapClient(bad)
            self.assertNotIn(str(bad) if bad else "sk_", str(refused.exception).replace("sk_test_ or sk_live_", ""))
        self.assertTrue(HttpTapClient("sk_" "live_SyntheticKeyNeverIssuedByTap0123").live)

    def test_the_hashstring_is_taps_formula_with_the_amount_in_three_decimals(self):
        charge = read_charge(b'{"id":"chg_TS0123456789abcdef","status":"CAPTURED","amount":2.5,"currency":"KWD","live_mode":false,"reference":{"payment":"4516251234"},"transaction":{"created":"1763300000000"}}')
        text = "x_idchg_TS0123456789abcdefx_amount2.500x_currencyKWDx_gateway_referencex_payment_reference4516251234x_statusCAPTUREDx_created1763300000000"
        expected = hmac.new(KEY.encode(), text.encode(), hashlib.sha256).hexdigest()
        self.assertEqual(hashstring(KEY, charge), expected)
        self.assertTrue(self.client.signed(charge, expected))
        self.assertTrue(self.client.signed(charge, expected.upper()))
        for bad in (expected[:-1] + ("0" if expected[-1] != "0" else "1"), "", None, expected + "00", hashstring("sk_" "test_AnotherKey0000000000", charge)):
            self.assertFalse(self.client.signed(charge, bad))
        dollars = read_charge(b'{"id":"chg_TS0123456789abcdef","status":"CAPTURED","amount":9.9,"currency":"USD","live_mode":true}')
        self.assertEqual(amount_text(dollars.amount, "USD"), "9.90")


class MoneyTests(unittest.TestCase):
    def test_an_amount_is_exact_and_has_its_currencys_decimals(self):
        self.assertEqual([str(money(value, "KWD")) for value in ("2.5", "2.500", "2", 2.5, Decimal("0.100"))], ["2.500", "2.500", "2.000", "2.500", "0.100"])
        self.assertEqual(str(money("9.9", "USD")), "9.90")
        for value, currency in (("2.5001", "KWD"), ("9.999", "USD"), ("0", "KWD"), ("-1", "KWD"), ("abc", "KWD"), ("", "KWD"), ("NaN", "KWD"), ("Infinity", "KWD"), ("1e9", "KWD"), ("2.5", "XXX"), (None, "KWD")):
            self.assertIsNone(money(value, currency), (value, currency))


class TapSettingsTests(unittest.TestCase):
    def values(self, **extra):
        return {"LA_MODE": "hosted", "LA_SUPABASE_URL": "https://p.supabase.test", "LA_SUPABASE_JWT_SECRET": "s" * 40, "LA_DATA_DIR": "/tmp/x", "LA_PUBLIC_URL": "http://localhost:8787",
                "LA_SUPABASE_SERVICE_KEY": "sb_secret_synthetic0value0xxxxxxxx", **extra}

    def test_tap_is_off_by_default(self):
        config = Config.from_env(self.values())
        config.validate()
        self.assertEqual((config.tap_secret_key, config.tap_price, config.tap_currency, config.tap_return_url, config.tap_merchant_id), ("", "", "KWD", "", ""))

    def test_values_are_read_and_checked(self):
        config = Config.from_env(self.values(LA_TAP_SECRET_KEY=KEY, LA_TAP_PRICE="2.500", LA_TAP_CURRENCY="kwd", LA_TAP_RETURN_URL="https://archive.example/paid", LA_TAP_MERCHANT_ID="599424"))
        config.validate()
        self.assertEqual((config.tap_price, config.tap_currency, config.tap_return_url, config.tap_merchant_id), ("2.500", "KWD", "https://archive.example/paid", "599424"))
        Config.from_env(self.values(LA_TAP_SECRET_KEY=KEY, LA_TAP_PRICE="9.99", LA_TAP_CURRENCY="USD")).validate()
        Config.from_env(self.values(LA_TAP_SECRET_KEY=KEY, LA_TAP_PRICE="0.100")).validate()
        for bad in ({"LA_TAP_PRICE": "2.5001"}, {"LA_TAP_PRICE": "0.099"}, {"LA_TAP_PRICE": "0"}, {"LA_TAP_PRICE": "-2"}, {"LA_TAP_PRICE": "two"}, {"LA_TAP_PRICE": "2,500"}, {"LA_TAP_PRICE": "2.5e0"},
                    {"LA_TAP_PRICE": "9.999", "LA_TAP_CURRENCY": "USD"}, {"LA_TAP_CURRENCY": "XXX"}, {"LA_TAP_CURRENCY": "fils"}, {"LA_TAP_PRICE": ""}, {"LA_TAP_SECRET_KEY": ""},
                    {"LA_TAP_SECRET_KEY": "pk_test_SyntheticKeyNeverIssuedByTap0123"}, {"LA_TAP_SECRET_KEY": KEY + " extra"}, {"LA_TAP_SECRET_KEY": "sk_test_short"},
                    {"LA_TAP_RETURN_URL": "http://archive.example/paid"}, {"LA_TAP_RETURN_URL": "https://archive.example/paid?x=1"}, {"LA_TAP_RETURN_URL": "https://user:pw@archive.example/paid"},
                    {"LA_TAP_RETURN_URL": "paid.html"}, {"LA_TAP_MERCHANT_ID": "has space"}):
            with self.assertRaises(ValueError, msg=bad) as caught:
                Config.from_env(self.values(**{"LA_TAP_SECRET_KEY": KEY, "LA_TAP_PRICE": "2.500", **bad})).validate()
            self.assertNotIn(KEY, str(caught.exception), "a message about the configuration never repeats the key")
        self.assertNotIn(KEY, repr(Config.from_env(self.values(LA_TAP_SECRET_KEY=KEY, LA_TAP_PRICE="2.500"))))

    def test_a_configured_server_builds_the_real_client_and_a_loopback_one_asks_for_no_webhook(self):
        from server.purchases.build import build_purchases
        from server.entitlements import MemoryEntitlements

        class Libraries:
            on_delete = []

        with tempfile.TemporaryDirectory() as folder:
            Libraries.accounts_path = Path(folder) / "accounts.sqlite3"
            config = Config.from_env(self.values(LA_TAP_SECRET_KEY=KEY, LA_TAP_PRICE="2.5"))
            service = build_purchases(config, MemoryEntitlements(), Libraries, {"apple": None})
            self.assertIsInstance(service.tap, HttpTapClient)
            self.assertEqual((service.tap_amount, service.tap_currency, service.tap_redirect, service.tap_post), (PRICE, "KWD", "http://localhost:8787/api/purchases/tap/return", ""))
            public = Config.from_env(self.values(LA_TAP_SECRET_KEY=KEY, LA_TAP_PRICE="2.5", LA_PUBLIC_URL="https://archive.example", LA_TAP_RETURN_URL="https://archive.example/paid"))
            service = build_purchases(public, MemoryEntitlements(), Libraries, {"apple": None})
            self.assertEqual((service.tap_redirect, service.tap_post), ("https://archive.example/paid", "https://archive.example/api/purchases/tap/notifications"))


if __name__ == "__main__":
    unittest.main()
