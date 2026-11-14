"""The real Google Play client and the push-token check, against stand-ins: an HTTP transport that plays Google, and keys made here.

No request leaves the process. The service account, its key and every token are generated for the test.
"""
import json
from pathlib import Path
import tempfile
import time
import unittest
from urllib.parse import parse_qs

import httpx
import jwt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

from server.identity import IdentityUnavailable, JWKSCache
from server.purchases.google import CERTS_URL, GooglePlayClient, PlayError, PlayPurchase, PushVerifier, decode_push, token_key

EMAIL = "reader@synthetic-project.iam.gserviceaccount.com"
PACKAGE, PRODUCT, TOKEN = "app.littlearchive.mobile", "unlock_full", "synthetic.purchase-token_0123456789"


def make_key():
    return rsa.generate_private_key(public_exponent=65537, key_size=2048)


def pem(key):
    return key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()).decode()


class FakeGoogle:
    """`oauth2.googleapis.com/token` and the two `purchases.products` calls, as far as the client uses them."""

    def __init__(self, key):
        self.key, self.requests, self.answers, self.token_answer = key, [], {}, None
        self.clock = lambda: time.time()

    def __call__(self, request):
        self.requests.append(request)
        if request.url.host == "oauth2.googleapis.com":
            if self.token_answer:
                return httpx.Response(self.token_answer)
            form = parse_qs(request.content.decode())
            assertion = jwt.decode(form["assertion"][0], self.key.public_key(), algorithms=["RS256"], audience="https://oauth2.googleapis.com/token", options={"verify_iat": False, "verify_exp": False})  # the test moves time
            assert form["grant_type"] == ["urn:ietf:params:oauth:grant-type:jwt-bearer"]
            assert assertion["iss"] == EMAIL and assertion["scope"] == "https://www.googleapis.com/auth/androidpublisher" and assertion["exp"] - assertion["iat"] == 3600
            return httpx.Response(200, json={"access_token": "ya29.synthetic-%d" % len([r for r in self.requests if r.url.host == "oauth2.googleapis.com"]), "expires_in": 3600, "token_type": "Bearer"})
        assert request.headers["authorization"].startswith("Bearer ya29.synthetic-")
        key = (request.method, request.url.path.rsplit("/purchases/products/", 1)[-1])
        status, body = self.answers.get(key, (200, {"kind": "androidpublisher#productPurchase", "purchaseTimeMillis": "1900000000000", "purchaseState": 0, "consumptionState": 0, "orderId": "GPA.1234-5678-9012-34567",
                                                    "purchaseType": None, "acknowledgementState": 0, "productId": PRODUCT, "obfuscatedExternalAccountId": "a" * 64, "regionCode": "US", "quantity": 1}))
        return httpx.Response(status, json=body)


class GooglePlayClientTests(unittest.TestCase):
    def setUp(self):
        self.key = make_key()
        self.google = FakeGoogle(self.key)
        self.now = [time.time()]
        self.client = GooglePlayClient({"type": "service_account", "client_email": EMAIL, "private_key": pem(self.key)}, transport=httpx.MockTransport(self.google), clock=lambda: self.now[0])

    def calls(self, host):
        return [r for r in self.google.requests if r.url.host == host]

    def test_a_purchase_is_read_with_a_token_obtained_by_the_service_accounts_signed_request(self):
        purchase = self.client.get_purchase(PACKAGE, PRODUCT, TOKEN)
        self.assertEqual(purchase, PlayPurchase(product_id=PRODUCT, state="purchased", order_id="GPA.1234-5678-9012-34567", acknowledged=False, test=False, account_tag="a" * 64, purchased_ms=1900000000000))
        asked = self.calls("androidpublisher.googleapis.com")[0]
        self.assertEqual((asked.method, asked.url.path), ("GET", f"/androidpublisher/v3/applications/{PACKAGE}/purchases/products/{PRODUCT}/tokens/{TOKEN}"))
        self.assertEqual(asked.headers["authorization"], "Bearer ya29.synthetic-1")

    def test_the_access_token_is_reused_until_shortly_before_it_runs_out(self):
        self.client.get_purchase(PACKAGE, PRODUCT, TOKEN)
        self.now[0] += 3000
        self.client.get_purchase(PACKAGE, PRODUCT, TOKEN)
        self.assertEqual(len(self.calls("oauth2.googleapis.com")), 1)
        self.now[0] += 600
        self.client.get_purchase(PACKAGE, PRODUCT, TOKEN)
        self.assertEqual(len(self.calls("oauth2.googleapis.com")), 2, "renewed a minute before it ended")

    def test_acknowledging_posts_to_the_acknowledge_action(self):
        self.client.acknowledge(PACKAGE, PRODUCT, TOKEN)
        sent = self.calls("androidpublisher.googleapis.com")[0]
        self.assertEqual((sent.method, sent.url.path.rsplit("/", 1)[-1]), ("POST", f"{TOKEN}:acknowledge"))

    def test_each_state_google_reports(self):
        for code, state in ((0, "purchased"), (1, "canceled"), (2, "pending")):
            self.google.answers[("GET", f"{PRODUCT}/tokens/{TOKEN}")] = (200, {"purchaseState": code, "acknowledgementState": 1, "orderId": "GPA.1", "productId": PRODUCT, "purchaseType": 0})
            found = self.client.get_purchase(PACKAGE, PRODUCT, TOKEN)
            self.assertEqual((found.state, found.acknowledged, found.test), (state, True, True))

    def test_what_google_answers_other_than_a_purchase(self):
        path = ("GET", f"{PRODUCT}/tokens/{TOKEN}")
        for status, kind in ((400, "not_found"), (404, "not_found"), (410, "not_found"), (401, "forbidden"), (403, "forbidden"), (429, "unavailable"), (500, "unavailable"), (503, "unavailable"), (302, "unavailable"), (418, "unavailable")):
            self.google.answers[path] = (status, {"error": {"message": "secret detail " + KEY_MARK}})
            with self.assertRaises(PlayError) as caught:
                self.client.get_purchase(PACKAGE, PRODUCT, TOKEN)
            self.assertEqual(caught.exception.kind, kind, status)
            self.assertNotIn(KEY_MARK, str(caught.exception))
        for body in ({"purchaseState": 9, "acknowledgementState": 0}, {"purchaseState": 0, "acknowledgementState": 5}, {"purchaseState": 0, "acknowledgementState": 0, "orderId": 7}, []):
            self.google.answers[path] = (200, body)
            with self.assertRaises(PlayError) as caught:
                self.client.get_purchase(PACKAGE, PRODUCT, TOKEN)
            self.assertEqual(caught.exception.kind, "unavailable", str(body))

    def test_a_refused_access_token_request_is_forbidden_and_a_down_one_is_unavailable(self):
        for status, kind in ((400, "forbidden"), (401, "forbidden"), (403, "forbidden"), (500, "unavailable")):
            self.google.token_answer, self.client._token = status, None
            with self.assertRaises(PlayError) as caught:
                self.client.get_purchase(PACKAGE, PRODUCT, TOKEN)
            self.assertEqual(caught.exception.kind, kind, status)

    def test_a_401_from_the_api_drops_the_access_token_so_the_next_call_gets_a_new_one(self):
        self.client.get_purchase(PACKAGE, PRODUCT, TOKEN)
        self.google.answers[("GET", f"{PRODUCT}/tokens/{TOKEN}")] = (401, {})
        with self.assertRaises(PlayError):
            self.client.get_purchase(PACKAGE, PRODUCT, TOKEN)
        del self.google.answers[("GET", f"{PRODUCT}/tokens/{TOKEN}")]
        self.client.get_purchase(PACKAGE, PRODUCT, TOKEN)
        self.assertEqual(len(self.calls("oauth2.googleapis.com")), 2)

    def test_names_that_could_change_the_address_are_refused_before_any_request(self):
        for package, product, token in (("a/b", PRODUCT, TOKEN), (PACKAGE, "../x", TOKEN), (PACKAGE, PRODUCT, "tok/../x"), (PACKAGE, PRODUCT, "tok?x=1"), (PACKAGE, PRODUCT, ""), (PACKAGE, PRODUCT, "t" * 3000), (PACKAGE, "p" * 200, TOKEN)):
            with self.assertRaises(PlayError) as caught:
                self.client.get_purchase(package, product, token)
            self.assertEqual(caught.exception.kind, "not_found")
        self.assertEqual(self.google.requests, [])

    def test_a_network_failure_is_unavailable_and_says_nothing_else(self):
        def down(request):
            raise httpx.ConnectError("refused for " + KEY_MARK)
        client = GooglePlayClient({"client_email": EMAIL, "private_key": pem(self.key)}, transport=httpx.MockTransport(down))
        with self.assertRaises(PlayError) as caught:
            client.get_purchase(PACKAGE, PRODUCT, TOKEN)
        self.assertEqual(caught.exception.kind, "unavailable")
        self.assertNotIn(KEY_MARK, repr(caught.exception.__cause__) + str(caught.exception))

    def test_the_key_is_never_shown_and_the_token_address_can_only_be_googles(self):
        text = repr(self.client) + str(self.client) + repr(vars(self.client).keys())
        self.assertNotIn("PRIVATE KEY", text)
        self.assertIn(EMAIL, repr(self.client))
        elsewhere = GooglePlayClient({"client_email": EMAIL, "private_key": pem(self.key), "token_uri": "https://evil.example.com/token"}, transport=httpx.MockTransport(self.google))
        self.assertEqual(elsewhere._uri, "https://oauth2.googleapis.com/token")
        own = GooglePlayClient({"client_email": EMAIL, "private_key": pem(self.key), "token_uri": "https://oauth2.googleapis.com/token"})
        self.assertEqual(own._uri, "https://oauth2.googleapis.com/token")
        for bad in ({}, {"client_email": EMAIL}, {"client_email": "", "private_key": pem(self.key)}, {"client_email": EMAIL, "private_key": "not a key"}):
            with self.assertRaises(ValueError):
                GooglePlayClient(bad)

    def test_credentials_come_from_a_file_and_a_bad_file_does_not_reveal_what_is_in_it(self):
        with tempfile.TemporaryDirectory() as folder:
            good = Path(folder) / "play.json"
            good.write_text(json.dumps({"type": "service_account", "client_email": EMAIL, "private_key": pem(self.key)}))
            self.assertIsInstance(GooglePlayClient.from_file(good), GooglePlayClient)
            for label, content in (("not json", "{" + KEY_MARK), ("a list", "[1]"), ("another kind of key", json.dumps({"type": "authorized_user", "client_email": EMAIL, "private_key": KEY_MARK})),
                                   ("no key", json.dumps({"client_email": EMAIL})), ("too large", "x" * 70_000)):
                bad = Path(folder) / "bad.json"
                bad.write_text(content)
                with self.assertRaises(ValueError, msg=label) as caught:
                    GooglePlayClient.from_file(bad)
                self.assertNotIn(KEY_MARK, str(caught.exception) + repr(caught.exception.__cause__))
            with self.assertRaises(ValueError):
                GooglePlayClient.from_file(Path(folder) / "missing.json")


KEY_MARK = "SYNTHETIC-SECRET-MARK"


class PushVerifierTests(unittest.TestCase):
    AUDIENCE, ACCOUNT = "https://archive.synthetic.example/api/purchases/google/notifications", "push@synthetic-project.iam.gserviceaccount.com"

    def setUp(self):
        self.key = make_key()
        jwk = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(self.key.public_key()))
        self.asked = []
        self.document = {"keys": [{**jwk, "kid": "k1", "alg": "RS256", "use": "sig"}]}
        self.keys = JWKSCache(CERTS_URL, fetch=lambda url: (self.asked.append(url), self.document)[1])
        self.verifier = PushVerifier(self.AUDIENCE, self.ACCOUNT, keys=self.keys)

    def token(self, key=None, kid="k1", algorithm="RS256", **changes):
        moment = int(time.time())
        claims = {"iss": "https://accounts.google.com", "aud": self.AUDIENCE, "email": self.ACCOUNT, "email_verified": True, "iat": moment - 5, "exp": moment + 3000, "sub": "1234567890"}
        claims.update(changes)
        return jwt.encode({k: v for k, v in claims.items() if v is not None}, key or self.key, algorithm=algorithm, headers={"kid": kid})

    def test_a_token_google_signed_for_this_endpoint_as_this_account_is_accepted(self):
        self.assertTrue(self.verifier.verify(self.token()))
        self.assertTrue(self.verifier.verify(self.token(iss="accounts.google.com")))
        self.assertEqual(self.asked, [CERTS_URL], "the keys were fetched from Google's published address, once")

    def test_everything_else_is_refused(self):
        other = make_key()
        for label, token in (("wrong audience", self.token(aud="https://elsewhere.example/")), ("wrong issuer", self.token(iss="https://evil.example")),
                             ("another service account", self.token(email="other@synthetic-project.iam.gserviceaccount.com")), ("unverified email", self.token(email_verified=False)),
                             ("no email verified claim", self.token(email_verified=None)), ("expired", self.token(exp=int(time.time()) - 600, iat=int(time.time()) - 4000)),
                             ("no expiry", self.token(exp=None)), ("a key Google does not publish", self.token(key=other)), ("an unknown key id", self.token(kid="zzz")),
                             ("signed with the public key as an HMAC secret", jwt.encode({"iss": "https://accounts.google.com", "aud": self.AUDIENCE, "email": self.ACCOUNT, "email_verified": True,
                                                                                        "iat": int(time.time()), "exp": int(time.time()) + 600}, "x" * 40, algorithm="HS256", headers={"kid": "k1"})),
                             ("no signature", jwt.encode({"iss": "https://accounts.google.com", "aud": self.AUDIENCE, "email": self.ACCOUNT, "email_verified": True, "exp": int(time.time()) + 600, "iat": 1}, None, algorithm="none", headers={"kid": "k1"})),
                             ("garbage", "not.a.token"), ("empty", ""), ("not a string", None), ("enormous", "a." * 10000 + "b")):
            with self.subTest(label):
                self.assertFalse(self.verifier.verify(token), label)

    def test_when_google_s_keys_cannot_be_fetched_the_caller_is_told_to_try_again(self):
        def down(url):
            raise OSError("synthetic outage")
        verifier = PushVerifier(self.AUDIENCE, self.ACCOUNT, keys=JWKSCache(CERTS_URL, fetch=down))
        with self.assertRaises(IdentityUnavailable):
            verifier.verify(self.token())

    def test_it_will_not_be_built_half_configured(self):
        for audience, account in (("", self.ACCOUNT), (self.AUDIENCE, ""), ("", "")):
            with self.assertRaises(ValueError):
                PushVerifier(audience, account)
        self.assertIsInstance(PushVerifier(self.AUDIENCE, self.ACCOUNT).keys, JWKSCache)


class EnvelopeTests(unittest.TestCase):
    def test_only_a_well_formed_push_message_is_read(self):
        import base64
        good = {"message": {"data": base64.b64encode(json.dumps({"packageName": PACKAGE, "testNotification": {"version": "1.0"}}).encode()).decode(), "messageId": "123"}}
        self.assertEqual(decode_push(good)["_message_id"], "123")
        for bad in ({}, {"message": None}, {"message": {"data": 5}}, {"message": {"data": "***"}}, {"message": {"data": base64.b64encode(b"[]").decode()}}, [], None,
                    {"message": {"data": base64.b64encode(b"{}").decode(), "messageId": 5}}):
            self.assertIsNone(decode_push(bad), str(bad)[:40])

    def test_the_key_stored_for_a_token_is_its_hash(self):
        self.assertEqual(len(token_key(TOKEN)), 64)
        self.assertNotIn(TOKEN, token_key(TOKEN))
        self.assertNotEqual(token_key(TOKEN), token_key(TOKEN + "x"))


if __name__ == "__main__":
    unittest.main()
