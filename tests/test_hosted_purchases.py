"""Verifying the one-time unlock: a StoreKit 2 transaction and a Google Play purchase token, and taking a purchase back.

Everything is synthetic. Apple's chain is generated for each test and shaped like the real one; Google Play is a dictionary. These
tests show that this code does what its checks say. They do not show it accepts what a real store sends: nothing here was ever
signed by Apple or answered by Google.
"""
import base64
import hashlib
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import time
import unittest
from uuid import uuid4

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent))
from support_hosted import SigningKey, bearer, claims, hosted_app, no_worker_threads  # noqa: E402
from support_purchases import BUNDLE, PRODUCT, AppleChain, FakePlay, FakePush, b64, now_ms  # noqa: E402

from server.entitlements import SQLiteEntitlements  # noqa: E402
from server.purchases.apple import APPLE_ROOT_G3_SHA256, APPLE_ROOT_PATH, AppleVerificationError, AppleVerifier, bundled_root  # noqa: E402
from server.purchases.google import account_tag, token_key  # noqa: E402
from server.purchases.store import PurchaseStore  # noqa: E402

TOKEN = "synthetic-purchase-token-0123456789abcdef"


class PurchaseCase(unittest.TestCase):
    settings = {"hosted_deep_reads_monthly": 5, "hosted_free_deep_reads_monthly": 1}

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="little-archive-purchases-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.enterContext(no_worker_threads())
        self.key = SigningKey()
        self.chain, self.play = AppleChain(), FakePlay()
        self.build()

    def build(self, environments=("Production",), app_apple_id=0, **settings):
        apple = AppleVerifier(BUNDLE, PRODUCT, environments, app_apple_id, roots=[self.chain.root_der])
        self.app, _ = hosted_app(self.root / "app", self.key, purchase_clients={"apple": apple, "google": self.play, "push": FakePush()}, **{**self.settings, **settings})
        self.client = TestClient(self.app)
        self.client.__enter__()
        self.addCleanup(self.client.__exit__, None, None, None)
        self.entitlements, self.service, self.libraries = self.app.state.entitlements, self.app.state.purchases, self.app.state.libraries

    def account(self):
        user = str(uuid4())
        return user, bearer(self.key.sign(claims(user)))

    def apple(self, auth, jws):
        return self.client.post("/api/purchases/apple", json={"signed_transaction": jws}, headers=auth)

    def google(self, auth, token=TOKEN, product=PRODUCT):
        return self.client.post("/api/purchases/google", json={"product_id": product, "purchase_token": token}, headers=auth)

    def summary(self, auth):
        return self.client.get("/api/account", headers=auth).json()["entitlements"]

    def rows(self):
        with sqlite3.connect(self.root / "app" / "data" / "accounts.sqlite3") as c:
            c.row_factory = sqlite3.Row
            return [dict(r) for r in c.execute("SELECT * FROM purchases")]

    def refused(self, response, status, code):
        self.assertEqual((response.status_code, response.json().get("code")), (status, code), response.text[:200])


class AppleRedeemTests(PurchaseCase):
    def test_a_verified_transaction_unlocks_the_account_and_says_so(self):
        user, auth = self.account()
        self.assertEqual(self.summary(auth)["deep_reads"]["limit"], 1)
        answer = self.apple(auth, self.chain.transaction())
        self.assertEqual(answer.status_code, 200, answer.text)
        self.assertEqual(answer.json(), {"unlocked": True, "provider": "apple", "product_id": PRODUCT, "status": "active", "restored": False, "environment": "Production"})
        summary = self.summary(auth)
        self.assertEqual((summary["unlocked"], summary["unlocked_via"], summary["deep_reads"]["limit"]), (True, "apple", 5), "the unlock changes what the account may do")
        listed = self.client.get("/api/purchases", headers=auth).json()
        self.assertEqual((listed["unlocked"], listed["purchases"]), (True, [{"provider": "apple", "product_id": PRODUCT, "status": "active", "environment": "Production"}]))
        self.assertNotIn("2000000123456789", json.dumps(listed), "the store's transaction id is not given back")

    def test_presenting_the_same_proof_again_is_a_restore_and_changes_nothing(self):
        user, auth = self.account()
        proof = self.chain.transaction()
        first, again = self.apple(auth, proof), self.apple(auth, proof)
        self.assertEqual((first.json()["restored"], again.status_code, again.json()["restored"]), (False, 200, True))
        newer = self.apple(auth, self.chain.transaction(transactionId="2000000999999999"))  # a later restore delivers the same purchase with a new transaction id
        self.assertEqual((newer.status_code, newer.json()["restored"]), (200, True))
        self.assertEqual(len(self.rows()), 1)
        self.assertEqual(self.client.get("/api/purchases", headers=auth).json()["purchases"][0]["status"], "active")

    def test_a_purchase_unlocks_one_account_and_another_is_refused(self):
        (alice, a), (bob, b) = self.account(), self.account()
        proof = self.chain.transaction()
        self.assertEqual(self.apple(a, proof).status_code, 200)
        self.refused(self.apple(b, proof), 409, "purchase_bound_elsewhere")
        self.assertFalse(self.summary(b)["unlocked"])
        self.assertTrue(self.summary(a)["unlocked"], "and the first account keeps what it paid for")
        self.assertEqual(self.apple(a, proof).status_code, 200)

    def test_deleting_the_account_that_held_a_purchase_frees_it_for_a_new_account(self):
        (alice, a), (bob, b) = self.account(), self.account()
        proof = self.chain.transaction(appAccountToken=alice)  # tagged with the account that bought it
        self.assertEqual(self.apple(a, proof).status_code, 200)
        self.assertEqual(self.client.post("/api/account/delete", json={"confirm": "DELETE"}, headers=a).status_code, 200)
        self.assertEqual(self.rows(), [], "nothing about the purchase is kept once its account is gone")
        again = self.apple(b, proof)
        self.assertEqual((again.status_code, again.json()["restored"]), (200, False), "the person's new account can have what they paid for")
        self.assertEqual(self.rows()[0]["tag_matched"], 0, "the tag named the old account, which is noted, and allowed once the old account is gone")

    def test_a_tag_naming_this_account_is_noted(self):
        user, auth = self.account()
        self.apple(auth, self.chain.transaction(appAccountToken=user.upper()))
        self.assertEqual(self.rows()[0]["tag_matched"], 1)

    def test_family_sharing_and_ordinary_ownership_are_both_accepted(self):
        for kind in ("PURCHASED", "FAMILY_SHARED"):
            user, auth = self.account()
            self.assertEqual(self.apple(auth, self.chain.transaction(originalTransactionId="3" + kind[:3], transactionId="3" + kind[:3], inAppOwnershipType=kind)).status_code, 200, kind)

    def test_a_transaction_the_store_has_refunded_unlocks_nothing_and_is_remembered(self):
        (alice, a), (bob, b) = self.account(), self.account()
        refunded = self.chain.transaction(revocationDate=now_ms() - 1000, revocationReason=0)
        self.refused(self.apple(a, refunded), 409, "purchase_revoked")
        self.assertFalse(self.summary(a)["unlocked"])
        self.refused(self.apple(b, self.chain.transaction()), 409, "purchase_revoked", )  # the same purchase, an older copy without the refund in it
        self.assertEqual([(row["state"], row["user_id"]) for row in self.rows()], [("revoked", "")])

    def test_what_is_not_the_apps_unlock_is_refused_and_says_why(self):
        user, auth = self.account()
        for label, fields, status, code in (
            ("another app", {"bundleId": "com.example.other"}, 400, "purchase_wrong_app"),
            ("another product", {"productId": "unlock_other"}, 400, "purchase_wrong_product"),
            ("a consumable", {"type": "Consumable"}, 400, "purchase_wrong_product"),
            ("a subscription", {"type": "Auto-Renewable Subscription"}, 400, "purchase_wrong_product"),
            ("a sandbox purchase", {"environment": "Sandbox"}, 400, "purchase_wrong_environment"),
            ("an Xcode test purchase", {"environment": "Xcode"}, 400, "purchase_wrong_environment"),
            ("no environment", {"environment": None}, 400, "purchase_invalid"),
            ("no original id", {"originalTransactionId": None}, 400, "purchase_invalid"),
            ("a number for a text field", {"productId": 7}, 400, "purchase_invalid"),
        ):
            with self.subTest(label):
                self.refused(self.apple(auth, self.chain.transaction(**fields)), status, code)
        self.assertFalse(self.summary(auth)["unlocked"])
        self.assertEqual(self.rows(), [])

    def test_sandbox_purchases_are_accepted_only_when_the_operator_says_so(self):
        self.build(environments=("Production", "Sandbox"))
        user, auth = self.account()
        answer = self.apple(auth, self.chain.transaction(environment="Sandbox"))
        self.assertEqual((answer.status_code, answer.json()["environment"]), (200, "Sandbox"))
        _, other = self.account()
        self.refused(self.apple(other, self.chain.transaction(environment="Xcode", originalTransactionId="42")), 400, "purchase_wrong_environment")


class AppleChainTests(PurchaseCase):
    """Every way the signature or the certificates can be wrong must end in 'could not be verified', and in nothing unlocked."""

    TOO_SHORT_OR_LONG = {"two parts", "four parts", "empty parts", "an enormous token"}  # turned away by the request's own size rules, before any checking

    def assert_invalid(self, auth, proof, label):
        answer = self.apple(auth, proof)
        if label in self.TOO_SHORT_OR_LONG:
            self.assertEqual(answer.status_code, 422, label)
        else:
            self.assertEqual((answer.status_code, answer.json().get("code")), (400, "purchase_invalid"), label)
        self.assertNotIn("traceback", answer.text.lower())
        return answer

    def test_none_of_these_unlocks_anything(self):
        user, auth = self.account()
        good = self.chain.transaction()
        head, body, sig = good.split(".")
        other = AppleChain()
        forged_payload = json.loads(base64.urlsafe_b64decode(body + "=="))
        forged_payload["productId"] = PRODUCT
        wrong_curve = AppleChain(leaf_curve=ec.SECP384R1())
        proofs = {
            "tampered payload": f"{head}.{b64(json.dumps({**forged_payload, 'originalTransactionId': '1'}).encode())}.{sig}",
            "signed by a key that is not the leaf's": self.chain.sign(forged_payload, key=other.leaf_key),
            "a chain from a root that is not trusted": other.transaction(),
            "a signature of the wrong length": self.chain.sign(forged_payload, raw_signature=b"\x01" * 63),
            "a signature of zeros": self.chain.sign(forged_payload, raw_signature=b"\x00" * 64),
            "alg none": self.chain.sign(forged_payload, header={"alg": "none"}),
            "alg HS256": self.chain.sign(forged_payload, header={"alg": "HS256"}),
            "alg ES384": self.chain.sign(forged_payload, header={"alg": "ES384"}),
            "a critical header": self.chain.sign(forged_payload, header={"crit": ["exp"], "exp": 1}),
            "no certificates": self.chain.sign(forged_payload, header={"x5c": None}),
            "two certificates": self.chain.sign(forged_payload, header={"x5c": self.chain.x5c()[:2]}),
            "four certificates": self.chain.sign(forged_payload, header={"x5c": self.chain.x5c() + self.chain.x5c()[:1]}),
            "certificates that are not certificates": self.chain.sign(forged_payload, header={"x5c": ["AAAA", "BBBB", "CCCC"]}),
            "certificates in the wrong order": self.chain.sign(forged_payload, header={"x5c": list(reversed(self.chain.x5c()))}),
            "the root replaced by another": self.chain.sign(forged_payload, header={"x5c": self.chain.x5c()[:2] + [other.x5c()[2]]}),
            "the leaf of another chain": self.chain.sign(forged_payload, header={"x5c": [other.x5c()[0]] + self.chain.x5c()[1:]}),
            "a leaf with the wrong kind of key": wrong_curve.transaction(),
            "not a JWS": "not a jws at all, just words" * 3,
            "two parts": "aaaa.bbbb",
            "four parts": "aaaa.bbbb.cccc.dddd",
            "empty parts": "..",
            "non-ascii": "é" * 50 + ".b.c",
            "garbage json": f"{b64(b'{not json')}.{b64(b'{}')}.{b64(b'x' * 64)}",
            "a header that is a list": f"{b64(b'[]')}.{b64(b'{}')}.{b64(b'x' * 64)}",
            "a payload that is a list": f"{b64(json.dumps({'alg': 'ES256', 'x5c': self.chain.x5c()}).encode())}.{b64(b'[]')}.{b64(b'x' * 64)}",
            "an enormous token": good + "A" * 20000,
        }
        for label, proof in proofs.items():
            with self.subTest(label):
                self.assert_invalid(auth, proof, label)
        self.assertFalse(self.summary(auth)["unlocked"])
        self.assertEqual(self.rows(), [])

    def test_certificates_that_break_the_rules_of_the_chain_are_refused(self):
        user, auth = self.account()
        broken = {
            "a leaf without Apple's marker": AppleChain(leaf_marker=False),
            "an intermediate without Apple's marker": AppleChain(intermediate_marker=False),
            "an intermediate that may not sign certificates": AppleChain(intermediate_ca=False),
            "a leaf that may sign certificates": AppleChain(leaf_ca=True),
            "a leaf not issued by the intermediate (by name)": AppleChain(issuer_name_for_leaf="Somebody Else"),
            "a leaf already expired when signed": AppleChain(leaf_until=__import__("datetime").datetime.now(__import__("datetime").timezone.utc) - __import__("datetime").timedelta(days=30)),
            "a leaf not yet valid when signed": AppleChain(leaf_from=__import__("datetime").datetime.now(__import__("datetime").timezone.utc) + __import__("datetime").timedelta(days=30)),
        }
        for label, chain in broken.items():
            with self.subTest(label):
                self.build()  # a verifier that trusts this test's root; the chain under test shares none of the others' keys
                verifier = AppleVerifier(BUNDLE, PRODUCT, roots=[chain.root_der])
                with self.assertRaises(AppleVerificationError) as caught:
                    verifier.transaction(chain.transaction())
                self.assertEqual(caught.exception.code, "invalid")

    def test_a_transaction_signed_while_the_leaf_was_valid_is_still_good_after_it_expired(self):
        from datetime import datetime, timedelta, timezone
        chain = AppleChain(leaf_until=datetime.now(timezone.utc) - timedelta(days=30), leaf_from=datetime.now(timezone.utc) - timedelta(days=400))
        verifier = AppleVerifier(BUNDLE, PRODUCT, roots=[chain.root_der])
        signed_then = int((datetime.now(timezone.utc) - timedelta(days=100)).timestamp() * 1000)
        found = verifier.transaction(chain.transaction(signedDate=signed_then, purchaseDate=signed_then))
        self.assertEqual(found.product_id, PRODUCT)
        with self.assertRaises(AppleVerificationError):
            verifier.transaction(chain.transaction())  # signed now, by a leaf that has expired

    def test_a_date_in_the_future_is_refused_and_a_weak_certificate_signature_too(self):
        user, auth = self.account()
        self.assert_invalid(auth, self.chain.transaction(signedDate=now_ms() + 3_600_000), "an hour ahead")
        weak = AppleChain(hash_algorithm=hashes.SHA224())  # a certificate signature below SHA-256 is not accepted
        verifier = AppleVerifier(BUNDLE, PRODUCT, roots=[weak.root_der])
        with self.assertRaises(AppleVerificationError):
            verifier.transaction(weak.transaction())

    def test_this_servers_real_verifier_trusts_apples_root_and_not_a_test_root(self):
        self.assertEqual(hashlib.sha256(bundled_root()).hexdigest(), APPLE_ROOT_G3_SHA256)
        self.assertEqual(APPLE_ROOT_G3_SHA256, "63343abfb89a6a03ebb57e9b3f5fa7be7c4f5c756f3017b3a8c488c3653e9179", "the value Apple publishes for Apple Root CA - G3")
        real = AppleVerifier(BUNDLE, PRODUCT)
        with self.assertRaises(AppleVerificationError) as caught:
            real.transaction(self.chain.transaction())
        self.assertEqual(caught.exception.code, "invalid")
        # And the application as built from configuration alone (no stand-ins) refuses it the same way.
        with tempfile.TemporaryDirectory() as folder, no_worker_threads():
            app, _ = hosted_app(Path(folder), self.key)
            with TestClient(app) as client:
                user, auth = self.account()
                self.assertEqual(client.post("/api/purchases/apple", json={"signed_transaction": self.chain.transaction()}, headers=auth).json()["code"], "purchase_invalid")
                self.assertEqual(client.post("/api/purchases/google", json={"product_id": PRODUCT, "purchase_token": TOKEN}, headers=auth).json()["code"], "purchases_unavailable")

    def test_a_changed_root_file_is_not_trusted(self):
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as folder:
            other = Path(folder) / "root.cer"
            other.write_bytes(self.chain.root_der)
            with patch("server.purchases.apple.APPLE_ROOT_PATH", other), self.assertRaises(ValueError):
                bundled_root()
        self.assertTrue(APPLE_ROOT_PATH.is_file())

    def test_the_bundled_certificate_is_apples_root_ca_g3(self):
        from cryptography import x509
        certificate = x509.load_der_x509_certificate(bundled_root())
        self.assertEqual(certificate.subject.rfc4514_string(), "C=US,O=Apple Inc.,OU=Apple Certification Authority,CN=Apple Root CA - G3")
        self.assertEqual(certificate.issuer, certificate.subject)
        self.assertEqual(certificate.public_key().curve.name, "secp384r1")
        self.assertEqual(certificate.not_valid_after_utc.year, 2039)
        certificate.public_key().verify(certificate.signature, certificate.tbs_certificate_bytes, ec.ECDSA(certificate.signature_hash_algorithm))  # self-signed, and the signature holds


class AppleNotificationTests(PurchaseCase):
    def notify(self, signed):
        return self.client.post("/api/purchases/apple/notifications", json={"signedPayload": signed})

    def test_a_refund_takes_the_unlock_back_and_a_reversal_gives_it_back(self):
        user, auth = self.account()
        self.apple(auth, self.chain.transaction())
        refunded = self.chain.transaction(revocationDate=now_ms(), revocationReason=1)
        answer = self.notify(self.chain.notification("REFUND", transaction=refunded, uuid="n-1"))
        self.assertEqual((answer.status_code, answer.json()), (200, {"received": True, "action": "revoked", "type": "REFUND"}))
        summary = self.summary(auth)
        self.assertEqual((summary["unlocked"], summary["deep_reads"]["limit"]), (False, 1), "back to the free allowance")
        self.refused(self.apple(auth, self.chain.transaction()), 409, "purchase_revoked")
        self.assertEqual(self.client.get("/api/purchases", headers=auth).json()["purchases"][0]["status"], "revoked")
        reversed_ = self.notify(self.chain.notification("REFUND_REVERSED", transaction=self.chain.transaction(), uuid="n-2"))
        self.assertEqual(reversed_.json()["action"], "reinstated")
        self.assertTrue(self.summary(auth)["unlocked"])
        self.assertEqual(self.apple(auth, self.chain.transaction()).json()["restored"], True)

    def test_a_notification_is_acted_on_once(self):
        user, auth = self.account()
        self.apple(auth, self.chain.transaction())
        note = self.chain.notification("REFUND", transaction=self.chain.transaction(revocationDate=now_ms()), uuid="n-once")
        self.assertEqual(self.notify(note).json()["action"], "revoked")
        self.assertEqual(self.notify(note).json(), {"received": True, "action": "duplicate"})
        self.assertEqual(self.notify(self.chain.notification("REFUND", transaction=self.chain.transaction(revocationDate=now_ms()), uuid="n-other")).json()["action"], "unchanged")

    def test_a_refund_that_arrives_before_the_purchase_is_redeemed_still_stops_it(self):
        user, auth = self.account()
        self.notify(self.chain.notification("REFUND", transaction=self.chain.transaction(revocationDate=now_ms()), uuid="n-early"))
        self.refused(self.apple(auth, self.chain.transaction()), 409, "purchase_revoked")
        self.assertFalse(self.summary(auth)["unlocked"])

    def test_events_older_than_the_last_one_do_not_undo_it(self):
        user, auth = self.account()
        self.apple(auth, self.chain.transaction())
        self.notify(self.chain.notification("REFUND", transaction=self.chain.transaction(revocationDate=now_ms()), uuid="n-a"))
        old = self.chain.sign({"notificationType": "REFUND_REVERSED", "notificationUUID": "n-old", "signedDate": now_ms() - 10 * 86_400_000,
                               "data": {"bundleId": BUNDLE, "environment": "Production", "signedTransactionInfo": self.chain.transaction()}})
        self.assertEqual(self.notify(old).json()["action"], "unchanged")
        self.assertFalse(self.summary(auth)["unlocked"])

    def test_another_purchase_keeps_the_account_unlocked_and_so_does_a_hand_made_unlock(self):
        user, auth = self.account()
        self.apple(auth, self.chain.transaction())
        self.google_play_purchase = self.play.add(TOKEN)
        self.assertEqual(self.google(auth).status_code, 200)
        self.notify(self.chain.notification("REFUND", transaction=self.chain.transaction(revocationDate=now_ms()), uuid="n-1"))
        self.assertTrue(self.summary(auth)["unlocked"], "the Google purchase still holds the unlock")
        other, other_auth = self.account()
        self.entitlements.set_unlocked(other, True, source="manual")
        self.apple(other_auth, self.chain.transaction(originalTransactionId="77", transactionId="77"))
        self.assertEqual(self.summary(other_auth)["unlocked_via"], "manual", "who set the unlock is not rewritten")
        self.notify(self.chain.notification("REFUND", transaction=self.chain.transaction(originalTransactionId="77", transactionId="77", revocationDate=now_ms()), uuid="n-2"))
        self.assertTrue(self.summary(other_auth)["unlocked"], "a refund does not undo what an operator granted")

    def test_other_kinds_are_acknowledged_and_ignored(self):
        for number, kind in enumerate(("ONE_TIME_CHARGE", "TEST", "REFUND_DECLINED", "CONSUMPTION_REQUEST", "DID_RENEW", "SOMETHING_NEW_FROM_APPLE")):
            answer = self.notify(self.chain.notification(kind, uuid=f"n-{number}"))
            self.assertEqual((answer.status_code, answer.json()["action"]), (200, "ignored"), kind)
        user, auth = self.account()
        self.apple(auth, self.chain.transaction())
        self.notify(self.chain.notification("REFUND_DECLINED", transaction=self.chain.transaction(), uuid="n-declined"))
        self.assertTrue(self.summary(auth)["unlocked"])

    def test_forged_foreign_and_oversized_notifications_are_refused(self):
        other = AppleChain()
        for label, signed in (("another root", other.notification("REFUND", transaction=other.transaction(revocationDate=now_ms()))),
                              ("another app", self.chain.sign({"notificationType": "REFUND", "notificationUUID": "x", "signedDate": now_ms(), "data": {"bundleId": "com.example.other", "environment": "Production"}})),
                              ("sandbox", self.chain.sign({"notificationType": "REFUND", "notificationUUID": "x", "signedDate": now_ms(), "data": {"bundleId": BUNDLE, "environment": "Sandbox"}})),
                              ("not signed", "notajws.notajws.notajws"), ("a transaction of another app inside", self.chain.notification("REFUND", transaction=self.chain.transaction(bundleId="com.example.other", revocationDate=now_ms())))):
            with self.subTest(label):
                self.assertEqual(self.notify(signed).status_code, 400, label)
        self.assertEqual(self.client.post("/api/purchases/apple/notifications", json={}).status_code, 422)
        self.assertEqual(self.client.post("/api/purchases/apple/notifications", content=b"x" * 200_000, headers={"Content-Type": "application/json"}).status_code, 413)
        self.assertEqual(self.client.post("/api/purchases/apple/notifications", json={"signedPayload": "a" * 20000}).status_code, 422)

    def test_the_app_id_is_checked_when_one_is_configured(self):
        self.build(app_apple_id=1234567890)
        user, auth = self.account()
        self.apple(auth, self.chain.transaction())
        right = self.chain.notification("REFUND", transaction=self.chain.transaction(revocationDate=now_ms()), uuid="n-r")
        self.assertEqual(self.notify(right).status_code, 200)
        wrong = self.chain.sign({"notificationType": "REFUND", "notificationUUID": "n-w", "signedDate": now_ms(), "data": {"bundleId": BUNDLE, "environment": "Production", "appAppleId": 42}})
        self.assertEqual(self.notify(wrong).status_code, 400)

    def test_the_notification_route_has_its_own_budget_per_address(self):
        statuses = [self.client.post("/api/purchases/apple/notifications", json={"signedPayload": "x" * 30}).status_code for _ in range(70)]
        self.assertEqual(statuses.count(400), 60)
        self.assertEqual(set(statuses[60:]), {429})


class GoogleRedeemTests(PurchaseCase):
    def test_a_verified_purchase_unlocks_the_account_and_is_acknowledged(self):
        user, auth = self.account()
        self.play.add(TOKEN, account_tag=account_tag(user))
        answer = self.google(auth)
        self.assertEqual((answer.status_code, answer.json()), (200, {"unlocked": True, "provider": "google", "product_id": PRODUCT, "status": "active", "restored": False, "acknowledged": True}))
        self.assertEqual(self.play.acknowledged, [TOKEN])
        self.assertEqual((self.summary(auth)["unlocked"], self.summary(auth)["unlocked_via"]), (True, "google"))
        self.assertEqual(self.rows()[0]["tag_matched"], 1)
        again = self.google(auth)
        self.assertEqual((again.status_code, again.json()["restored"]), (200, True))
        self.assertEqual(self.play.acknowledged, [TOKEN], "a purchase that is already acknowledged is not acknowledged again")

    def test_the_token_itself_is_never_stored(self):
        user, auth = self.account()
        self.play.add(TOKEN)
        self.google(auth)
        self.assertEqual(self.rows()[0]["purchase_key"], hashlib.sha256(TOKEN.encode()).hexdigest())
        for path in (self.root / "app" / "data").rglob("*"):
            if path.is_file():
                self.assertNotIn(TOKEN.encode(), path.read_bytes(), path.name)

    def test_a_purchase_belongs_to_one_account(self):
        (alice, a), (bob, b) = self.account(), self.account()
        self.play.add(TOKEN)
        self.assertEqual(self.google(a).status_code, 200)
        self.refused(self.google(b), 409, "purchase_bound_elsewhere")
        self.assertFalse(self.summary(b)["unlocked"])

    def test_a_payment_that_has_not_completed_unlocks_nothing_yet(self):
        user, auth = self.account()
        self.play.add(TOKEN, state="pending")
        answer = self.google(auth)
        self.assertEqual((answer.status_code, answer.json()["unlocked"], answer.json()["status"]), (202, False, "pending"))
        self.assertFalse(self.summary(auth)["unlocked"])
        self.play.add(TOKEN, state="purchased")
        self.assertEqual(self.google(auth).status_code, 200, "and it can be redeemed when it completes")

    def test_a_cancelled_purchase_is_refused_and_remembered(self):
        (alice, a), (bob, b) = self.account(), self.account()
        self.play.add(TOKEN, state="canceled")
        self.refused(self.google(a), 409, "purchase_revoked")
        self.play.add(TOKEN, state="purchased")
        self.refused(self.google(b), 409, "purchase_revoked")

    def test_what_google_does_not_recognise_or_cannot_say(self):
        user, auth = self.account()
        self.refused(self.google(auth, "a-token-google-has-never-seen"), 400, "purchase_invalid")
        self.refused(self.google(auth, product="unlock_other"), 400, "purchase_wrong_product")
        self.play.add(TOKEN, product_id="unlock_other")
        self.refused(self.google(auth), 400, "purchase_wrong_product")
        for kind in ("unavailable", "forbidden"):
            self.play.fail(TOKEN, kind)
            answer = self.google(auth)
            self.refused(answer, 503, "purchases_unavailable")
            self.assertEqual((answer.json()["provider"], answer.json()["reason"], answer.headers["retry-after"]), ("google", kind, "30"))
        self.assertFalse(self.summary(auth)["unlocked"])
        for bad in ({"product_id": PRODUCT}, {"purchase_token": TOKEN}, {"product_id": PRODUCT, "purchase_token": "short"}, {"product_id": PRODUCT, "purchase_token": TOKEN, "unlocked": True},
                    {"product_id": "", "purchase_token": TOKEN}, {"product_id": PRODUCT, "purchase_token": "x" * 3000}):
            self.assertEqual(self.client.post("/api/purchases/google", json=bad, headers=auth).status_code, 422, str(bad)[:40])

    def test_licence_tester_purchases_are_not_real_ones_unless_allowed(self):
        user, auth = self.account()
        self.play.add(TOKEN, test=True)
        self.refused(self.google(auth), 400, "purchase_wrong_environment")
        self.build(google_allow_test_purchases=True)
        user, auth = self.account()
        self.assertEqual(self.google(auth).status_code, 200)

    def test_an_acknowledgement_that_fails_does_not_fail_the_unlock(self):
        user, auth = self.account()
        self.play.add(TOKEN)
        original = self.play.acknowledge

        def failing(*args):
            from server.purchases.google import PlayError
            raise PlayError("unavailable")
        self.play.acknowledge = failing
        answer = self.google(auth)
        self.assertEqual((answer.status_code, answer.json()["unlocked"], answer.json()["acknowledged"]), (200, True, False))
        self.play.acknowledge = original

    def test_without_a_service_account_google_is_reported_as_not_set_up(self):
        self.build()
        self.service.google = None
        user, auth = self.account()
        answer = self.google(auth)
        self.refused(answer, 503, "purchases_unavailable")
        self.assertEqual(answer.json()["reason"], "not_configured")


class GoogleNotificationTests(PurchaseCase):
    def envelope(self, payload, message_id="m-1", package=None):
        data = {"version": "1.0", "packageName": package or "app.littlearchive.mobile", "eventTimeMillis": str(now_ms()), **payload}
        return {"message": {"data": base64.b64encode(json.dumps(data).encode()).decode(), "messageId": message_id}, "subscription": "projects/p/subscriptions/s"}

    def push(self, body, token="valid-push-token"):
        return self.client.post("/api/purchases/google/notifications", json=body, headers={"Authorization": "Bearer " + token} if token else {})

    def redeemed(self):
        user, auth = self.account()
        self.play.add(TOKEN)
        self.assertEqual(self.google(auth).status_code, 200)
        return user, auth

    def test_a_voided_purchase_prompts_a_fresh_look_and_the_unlock_ends(self):
        user, auth = self.redeemed()
        self.play.add(TOKEN, state="canceled", acknowledged=True)
        answer = self.push(self.envelope({"voidedPurchaseNotification": {"purchaseToken": TOKEN, "orderId": "GPA.1", "productType": 2, "refundType": 1}}))
        self.assertEqual((answer.status_code, answer.json()), (200, {"received": True, "action": "revoked"}))
        self.assertFalse(self.summary(user and auth)["unlocked"])
        self.assertEqual([call[0] for call in self.play.calls][-1], "get", "Google was asked; the message alone was not believed")

    def test_a_message_that_says_cancelled_while_google_says_purchased_changes_nothing(self):
        user, auth = self.redeemed()
        answer = self.push(self.envelope({"oneTimeProductNotification": {"version": "1.0", "notificationType": 2, "purchaseToken": TOKEN, "sku": PRODUCT}}))
        self.assertEqual(answer.json()["action"], "active")
        self.assertTrue(self.summary(auth)["unlocked"], "whatever a push message claims, Google's own answer decides")

    def test_a_cancelled_one_time_product_ends_it_and_a_later_purchase_state_restores_it(self):
        user, auth = self.redeemed()
        self.play.add(TOKEN, state="canceled")
        self.assertEqual(self.push(self.envelope({"oneTimeProductNotification": {"notificationType": 2, "purchaseToken": TOKEN, "sku": PRODUCT}}, "m-a")).json()["action"], "revoked")
        self.play.add(TOKEN, state="purchased", acknowledged=True)
        self.assertEqual(self.service.reverify_google(TOKEN), "active")
        self.assertTrue(self.summary(auth)["unlocked"])
        self.play.add(TOKEN, state="canceled")
        self.assertEqual(self.service.reverify_google(TOKEN), "revoked")
        self.assertFalse(self.summary(auth)["unlocked"])
        self.assertEqual(self.service.reverify_google("a-token-google-has-never-seen"), "unknown")
        self.play.add(TOKEN, state="pending")
        self.assertEqual(self.service.reverify_google(TOKEN), "pending")

    def test_other_messages_are_acknowledged_and_ignored_and_each_is_acted_on_once(self):
        user, auth = self.redeemed()
        for number, payload in enumerate(({"testNotification": {"version": "1.0"}}, {"oneTimeProductNotification": {"notificationType": 1, "purchaseToken": TOKEN, "sku": PRODUCT}},
                                          {"subscriptionNotification": {"notificationType": 4, "purchaseToken": TOKEN}}, {"voidedPurchaseNotification": {"purchaseToken": TOKEN, "productType": 1}},
                                          {"oneTimeProductNotification": {"notificationType": 2, "purchaseToken": TOKEN, "sku": "some_other_product"}}, {})):
            self.assertEqual(self.push(self.envelope(payload, f"ignored-{number}")).json(), {"received": True, "action": "ignored"}, str(payload)[:50])
        asked = len(self.play.calls)
        self.play.add(TOKEN, state="canceled")
        voided = self.envelope({"voidedPurchaseNotification": {"purchaseToken": TOKEN, "productType": 2}}, "m-dup")
        self.assertEqual(self.push(voided).json()["action"], "revoked")
        self.assertEqual(self.push(voided).json(), {"received": True, "action": "duplicate"})
        self.assertEqual(len(self.play.calls), asked + 1, "the repeat did not ask Google again")

    def test_a_notification_must_be_signed_by_google_for_this_service(self):
        user, auth = self.redeemed()
        self.play.add(TOKEN, state="canceled")
        body = self.envelope({"voidedPurchaseNotification": {"purchaseToken": TOKEN, "productType": 2}})
        for label, token in (("no token", None), ("a wrong token", "forged"), ("a token for another audience", "valid-push-token-but-for-another-audience")):
            with self.subTest(label):
                answer = self.push(body, token)
                self.assertEqual(answer.status_code, 401, label)
                self.assertEqual(answer.headers["www-authenticate"], "Bearer")
        self.assertTrue(self.summary(auth)["unlocked"])
        self.assertEqual(self.client.post("/api/purchases/google/notifications", json=body, headers={"Authorization": "Basic Zm9vOmJhcg=="}).status_code, 401)

    def test_a_message_for_another_app_or_that_is_not_a_message_is_refused(self):
        self.assertEqual(self.push(self.envelope({"testNotification": {"version": "1.0"}}, package="com.example.other")).status_code, 400)
        for body in ({}, {"message": {}}, {"message": {"data": "!!!not base64"}}, {"message": {"data": base64.b64encode(b"[1,2]").decode()}}, {"message": {"data": base64.b64encode(b"nope").decode()}}):
            self.assertEqual(self.push(body).status_code, 400, str(body)[:40])

    def test_when_google_cannot_be_asked_the_push_is_answered_so_it_is_sent_again(self):
        user, auth = self.redeemed()
        self.play.fail(TOKEN, "unavailable")
        answer = self.push(self.envelope({"voidedPurchaseNotification": {"purchaseToken": TOKEN, "productType": 2}}, "m-retry"))
        self.refused(answer, 503, "purchases_unavailable")
        self.play.add(TOKEN, state="canceled")
        self.assertEqual(self.push(self.envelope({"voidedPurchaseNotification": {"purchaseToken": TOKEN, "productType": 2}}, "m-retry")).json()["action"], "revoked", "the same message succeeds the second time")

    def test_without_the_notification_settings_the_route_says_so(self):
        self.service.push = None
        self.refused(self.push(self.envelope({"testNotification": {}})), 503, "purchases_unavailable")


class OperatorAndStoreTests(PurchaseCase):
    def test_an_operator_can_take_a_purchase_back_and_it_stays_taken_back(self):
        user, auth = self.account()
        self.apple(auth, self.chain.transaction())
        self.assertTrue(self.service.revoke("apple", "2000000123456789", "chargeback"))
        self.assertFalse(self.summary(auth)["unlocked"])
        self.assertFalse(self.service.revoke("apple", "2000000123456789"), "doing it twice changes nothing")
        self.refused(self.apple(auth, self.chain.transaction()), 409, "purchase_revoked")
        undo = self.chain.notification("REFUND_REVERSED", transaction=self.chain.transaction(), uuid="n-undo")
        self.assertEqual(self.client.post("/api/purchases/apple/notifications", json={"signedPayload": undo}).json()["action"], "unchanged", "a store's older word does not override an operator's")

    def test_claims_races_and_forgetting(self):
        with tempfile.TemporaryDirectory() as folder:
            store = PurchaseStore(Path(folder) / "accounts.sqlite3")
            self.assertEqual(store.claim("apple", "1", "alice", PRODUCT), "bound")
            self.assertEqual(store.claim("apple", "1", "alice", PRODUCT), "restored")
            self.assertEqual(store.claim("apple", "1", "bob", PRODUCT), "other_account")
            self.assertEqual(store.claim("google", "1", "bob", PRODUCT), "bound", "the same key at another store is another purchase")
            self.assertEqual(store.revoke("apple", "1", 50, "refund"), (True, "alice"))
            self.assertEqual(store.revoke("apple", "1", 10, "older"), (False, "alice"))
            self.assertEqual(store.claim("apple", "1", "alice", PRODUCT), "revoked")
            self.assertIsNone(store.reinstate("apple", "1", 10), "an older reversal is ignored")
            self.assertEqual(store.reinstate("apple", "1", 60), "alice")
            store.forget("alice")
            self.assertEqual(store.claim("apple", "1", "carol", PRODUCT), "bound", "released with its account")
            store.revoke("apple", "1", 99, "refund")
            store.forget("carol")
            self.assertEqual(store.holder("apple", "1"), ("", "revoked"), "a purchase taken back stays taken back with nobody on it")
            self.assertEqual(store.claim("apple", "1", "dave", PRODUCT), "revoked")
            self.assertFalse(store.seen("apple", "e"))
            store.done("apple", "e")
            self.assertTrue(store.seen("apple", "e"))
            self.assertFalse(store.seen("google", "e"))

    def test_nothing_in_a_request_other_than_a_proof_changes_an_unlock(self):
        user, auth = self.account()
        for path, body in (("/api/purchases", {"unlocked": True}), ("/api/purchases/apple", {"unlocked": True, "provider": "apple"}), ("/api/purchases/google", {"unlocked": True})):
            self.assertIn(self.client.post(path, json=body, headers=auth).status_code, {405, 422})
        self.assertFalse(self.summary(auth)["unlocked"])

    def test_the_routes_need_sign_in_and_answer_404_to_a_self_hosted_server(self):
        for method, path in (("GET", "/api/purchases"), ("POST", "/api/purchases/apple"), ("POST", "/api/purchases/google")):
            self.assertEqual(self.client.request(method, path, json={}).status_code, 401, path)
        from server.app import create_app
        from server.config import Config
        with tempfile.TemporaryDirectory() as folder:
            app = create_app(Config(data_dir=Path(folder) / "data", admin_password="a-self-hosted-owner-password", public_url="http://testserver", testing=True))
            with TestClient(app) as owner:
                login = owner.post("/api/auth/devices", json={"password": "a-self-hosted-owner-password", "name": "Phone"}).json()
                headers = {"Authorization": "Bearer " + login["token"]}
                for method, path in (("GET", "/api/purchases"), ("POST", "/api/purchases/apple"), ("POST", "/api/purchases/google"),
                                     ("POST", "/api/purchases/apple/notifications"), ("POST", "/api/purchases/google/notifications")):
                    self.assertEqual(owner.request(method, path, json={}, headers=headers).status_code, 404, "self-hosted: " + path)
                    self.assertEqual(owner.request(method, path, json={}).status_code, 404, "self-hosted, anonymous: " + path)
                self.assertTrue(owner.get("/api/account", headers=headers).json()["entitlements"]["unlocked"], "a self-hosted library is never gated")


class PurchaseSettingsTests(unittest.TestCase):
    def values(self, **extra):
        return {"LA_MODE": "hosted", "LA_SUPABASE_URL": "https://p.supabase.test", "LA_SUPABASE_JWT_SECRET": "s" * 40, "LA_DATA_DIR": "/tmp/x", "LA_PUBLIC_URL": "http://localhost:8787",
                "LA_SUPABASE_SERVICE_KEY": "sb_secret_synthetic0value0xxxxxxxx", **extra}

    def test_the_defaults_are_the_placeholders_the_documentation_names(self):
        from server.config import Config
        config = Config.from_env(self.values())
        config.validate()
        self.assertEqual((config.apple_bundle_id, config.apple_product_id, config.apple_environments, config.apple_app_id), ("app.littlearchive.mobile", "unlock_full", "Production", 0))
        self.assertEqual((config.google_package_name, config.google_product_id, config.google_service_account_file, config.google_allow_test_purchases), ("app.littlearchive.mobile", "unlock_full", "", False))

    def test_values_are_read_and_checked(self):
        from server.config import Config
        config = Config.from_env(self.values(LA_APPLE_BUNDLE_ID="com.example.app", LA_APPLE_PRODUCT_ID="full.unlock", LA_APPLE_ENVIRONMENTS="Production, Sandbox", LA_APPLE_APP_ID="1234567890",
                                             LA_GOOGLE_PACKAGE_NAME="com.example.app", LA_GOOGLE_PRODUCT_ID="full_unlock", LA_GOOGLE_ALLOW_TEST_PURCHASES="true"))
        config.validate()
        self.assertEqual((config.apple_bundle_id, config.apple_environments, config.apple_app_id, config.google_allow_test_purchases), ("com.example.app", "Production, Sandbox", 1234567890, True))
        for key, bad in (("LA_APPLE_BUNDLE_ID", "has space"), ("LA_APPLE_PRODUCT_ID", "../x"), ("LA_APPLE_ENVIRONMENTS", "Xcode"), ("LA_APPLE_ENVIRONMENTS", "Production,Staging"),
                         ("LA_APPLE_APP_ID", "abc"), ("LA_GOOGLE_PACKAGE_NAME", "bad/name"), ("LA_GOOGLE_RTDN_AUDIENCE", "https://x.example/api"), ("LA_GOOGLE_SERVICE_ACCOUNT_FILE", "relative/key.json")):
            with self.assertRaises(ValueError, msg=key + "=" + bad):
                Config.from_env(self.values(**{key: bad})).validate()
        with self.assertRaises(ValueError):  # a pair, and it needs the service account file
            Config.from_env(self.values(LA_GOOGLE_RTDN_AUDIENCE="https://x.example/api", LA_GOOGLE_RTDN_SERVICE_ACCOUNT="push@p.iam.gserviceaccount.com")).validate()
        Config.from_env(self.values(LA_GOOGLE_RTDN_AUDIENCE="https://x.example/api", LA_GOOGLE_RTDN_SERVICE_ACCOUNT="push@p.iam.gserviceaccount.com", LA_GOOGLE_SERVICE_ACCOUNT_FILE="/etc/little-archive/play.json")).validate()

    def test_a_key_file_inside_the_source_tree_is_refused(self):
        from server.config import Config
        inside = str(Path(__file__).resolve().parents[1] / "play-key.json")
        with self.assertRaises(ValueError) as caught:
            Config.from_env(self.values(LA_GOOGLE_SERVICE_ACCOUNT_FILE=inside)).validate()
        self.assertIn("outside the source tree", str(caught.exception))
        self.assertNotIn(inside, repr(Config.from_env(self.values(LA_GOOGLE_SERVICE_ACCOUNT_FILE=inside))))


if __name__ == "__main__":
    unittest.main()
