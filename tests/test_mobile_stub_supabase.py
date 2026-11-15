"""The development stand-in for Supabase Auth (mobile/dev/stub_supabase.py) answers the two sign-ins that the phone app adds,
Apple's identity token and Google through the browser with PKCE, the way the real service's source says it does. Synthetic data
only; nothing here touches a real project."""
import base64
import hashlib
import http.client
import importlib.util
import json
import unittest
from pathlib import Path
from threading import Thread
from http.server import ThreadingHTTPServer
from urllib.parse import parse_qs, quote, urlsplit

STUB = Path(__file__).resolve().parents[1] / "mobile" / "dev" / "stub_supabase.py"
KEY = "sb_publishable_synthetic0value0"
CALLBACK = "littlearchive://auth-callback"
RFC_VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"  # RFC 7636, appendix B
RFC_CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"


def challenge_of(verifier):
    return base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()


class StubCase(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location("stub_supabase", STUB)
        self.stub = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.stub)
        handler = self.stub.Handler
        handler.secret, handler.publishable, handler.secret_key, handler.issuer = "j" * 40, KEY, "sb_secret_synthetic0value0", "http://127.0.0.1/auth/v1"
        server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        self.port = server.server_address[1]

    def call(self, method, path, body=None, key=KEY):
        """One request, redirects not followed, as the app's native client does. Returns (status, headers, parsed body)."""
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        headers = {"Content-Type": "application/json", **({"apikey": key} if key else {})}
        connection.request(method, path, body=None if body is None else json.dumps(body), headers=headers)
        reply = connection.getresponse()
        raw = reply.read()
        connection.close()
        try:
            parsed = json.loads(raw) if raw else None
        except ValueError:
            parsed = raw.decode()
        return reply.status, dict(reply.getheaders()), parsed

    def authorize(self, verifier=RFC_VERIFIER, redirect=CALLBACK, method="s256", provider="google", challenge=True):
        query = f"provider={provider}&redirect_to={quote(redirect, safe='')}"
        if challenge:
            query += f"&code_challenge={challenge_of(verifier)}&code_challenge_method={method}"
        return self.call("GET", f"/auth/v1/authorize?{query}", key=None)

    def code_from(self, location):
        parts = urlsplit(location)
        return parse_qs(parts.query)["code"][0]


class RfcVector(unittest.TestCase):
    def test_the_challenge_helper_matches_the_rfc_example(self):
        self.assertEqual(challenge_of(RFC_VERIFIER), RFC_CHALLENGE)


class GoogleThroughTheBrowser(StubCase):
    def approve(self, **options):
        self.stub.Handler.google_mode = "approve"
        status, headers, _ = self.authorize(**options)
        self.assertEqual(status, 302)
        return headers["Location"]

    def test_authorize_needs_no_key_and_goes_straight_back_with_a_code_when_approved(self):
        location = self.approve()
        self.assertTrue(location.startswith(CALLBACK + "?code="), location)

    def test_the_code_is_traded_with_the_verifier_for_a_session_and_is_good_once(self):
        code = self.code_from(self.approve())
        status, _, session = self.call("POST", "/auth/v1/token?grant_type=pkce", {"auth_code": code, "code_verifier": RFC_VERIFIER})
        self.assertEqual(status, 200)
        self.assertEqual(session["user"]["email"], "google.reader@example.test")
        self.assertTrue(session["access_token"] and session["refresh_token"])
        status, _, again = self.call("POST", "/auth/v1/token?grant_type=pkce", {"auth_code": code, "code_verifier": RFC_VERIFIER})
        self.assertEqual((status, again["error_code"]), (404, "flow_state_not_found"))

    def test_the_same_account_comes_back_the_second_time(self):
        first = self.call("POST", "/auth/v1/token?grant_type=pkce", {"auth_code": self.code_from(self.approve()), "code_verifier": RFC_VERIFIER})[2]
        second = self.call("POST", "/auth/v1/token?grant_type=pkce", {"auth_code": self.code_from(self.approve()), "code_verifier": RFC_VERIFIER})[2]
        self.assertEqual(first["user"]["id"], second["user"]["id"])

    def test_a_code_without_the_verifier_that_made_the_challenge_is_useless(self):
        code = self.code_from(self.approve())
        status, _, body = self.call("POST", "/auth/v1/token?grant_type=pkce", {"auth_code": code, "code_verifier": "x" * 64})
        self.assertEqual((status, body["error_code"]), (400, "bad_code_verifier"))
        status, _, body = self.call("POST", "/auth/v1/token?grant_type=pkce", {"auth_code": code, "code_verifier": ""})
        self.assertEqual((status, body["error_code"]), (400, "validation_failed"))
        status, _, body = self.call("POST", "/auth/v1/token?grant_type=pkce", {"auth_code": "never-issued", "code_verifier": RFC_VERIFIER})
        self.assertEqual((status, body["error_code"]), (404, "flow_state_not_found"))

    def test_a_code_expires(self):
        self.stub.Handler.code_ttl = -1
        code = self.code_from(self.approve())
        status, _, body = self.call("POST", "/auth/v1/token?grant_type=pkce", {"auth_code": code, "code_verifier": RFC_VERIFIER})
        self.assertEqual((status, body["error_code"]), (422, "flow_state_expired"))

    def test_the_method_is_lower_case_s256_or_plain_and_the_challenge_has_a_legal_shape(self):
        self.stub.Handler.google_mode = "approve"
        for method in ("s256", "S256", "plain"):
            self.assertEqual(self.authorize(method=method)[0], 302, method)
        status, _, body = self.authorize(method="md5")
        self.assertEqual((status, body["error_code"]), (400, "validation_failed"))
        status, _, body = self.call("GET", f"/auth/v1/authorize?provider=google&redirect_to={quote(CALLBACK, safe='')}&code_challenge=short&code_challenge_method=s256", key=None)
        self.assertEqual((status, body["error_code"]), (400, "validation_failed"))
        status, _, body = self.call("GET", f"/auth/v1/authorize?provider=google&redirect_to={quote(CALLBACK, safe='')}&code_challenge={RFC_CHALLENGE}", key=None)
        self.assertEqual((status, body["error_code"]), (400, "validation_failed"))

    def test_a_check_without_pkce_values_is_answered_with_a_redirect_and_makes_nothing_to_trade(self):
        status, headers, _ = self.authorize(challenge=False)
        self.assertEqual(status, 302)
        self.assertNotIn(CALLBACK, headers["Location"])
        self.assertEqual(self.stub.CODES, {})

    def test_a_redirect_carries_the_small_html_body_the_real_service_sends(self):
        status, headers, body = self.authorize(challenge=False)
        self.assertEqual(status, 302)
        self.assertIn("text/html", headers["Content-Type"])
        self.assertGreater(int(headers["Content-Length"]), 0)
        self.assertIn("Found", body)
        self.assertIn(headers["Location"].replace("&", "&amp;"), body)

    def test_settings_lists_which_providers_are_on_wants_the_key_and_starts_no_sign_in(self):
        status, _, body = self.call("GET", "/auth/v1/settings")
        self.assertEqual(status, 200)
        self.assertEqual(body["external"], {"apple": True, "google": True, "email": True})
        self.assertEqual(self.stub.FLOWS, {}, "asking leaves nothing behind")
        self.stub.Handler.providers_off = {"google"}
        self.addCleanup(setattr, self.stub.Handler, "providers_off", set())
        self.assertEqual(self.call("GET", "/auth/v1/settings")[2]["external"], {"apple": True, "google": False, "email": True})
        self.assertEqual(self.call("GET", "/auth/v1/settings", key=None)[0], 401)
        self.assertEqual(self.call("GET", "/auth/v1/settings", key="sb_publishable_another0value0")[0], 401)

    def test_the_account_chooser_parameter_reaches_the_stand_in_google_and_only_when_it_is_sent(self):
        base = f"provider=google&redirect_to={quote(CALLBACK, safe='')}&code_challenge={RFC_CHALLENGE}&code_challenge_method=s256"
        status, headers, _ = self.call("GET", f"/auth/v1/authorize?{base}&prompt=select_account", key=None)
        self.assertEqual(status, 302)
        self.assertIn("Choose an account", self.call("GET", headers["Location"], key=None)[2])
        _, headers, _ = self.call("GET", f"/auth/v1/authorize?{base}", key=None)
        self.assertNotIn("Choose an account", self.call("GET", headers["Location"], key=None)[2])

    def test_a_provider_that_is_switched_off_answers_the_400_the_real_service_gives(self):
        self.stub.Handler.providers_off = {"google"}
        status, _, body = self.authorize()
        self.assertEqual((status, body["error_code"], body["msg"]), (400, "validation_failed", "Unsupported provider: provider is not enabled"))
        self.assertEqual(self.authorize(challenge=False)[0], 400)

    def test_a_redirect_that_is_not_on_the_allow_list_goes_to_the_site_url(self):
        location = self.approve(redirect="littlearchive://somewhere-else")
        self.assertTrue(location.startswith("http://localhost:3000?code="), location)
        self.assertNotIn("somewhere-else", location)

    def test_when_asked_the_stand_in_google_shows_a_page_and_the_links_finish_the_sign_in(self):
        status, headers, _ = self.authorize()
        self.assertEqual(status, 302)
        self.assertTrue(headers["Location"].startswith("/stand-in-google?state="))
        status, _, page = self.call("GET", headers["Location"], key=None)
        self.assertEqual(status, 200)
        self.assertIn("Continue as google.reader@example.test", page)
        state = parse_qs(urlsplit(headers["Location"]).query)["state"][0]
        status, headers, _ = self.call("GET", f"/stand-in-google/approve?state={state}", key=None)
        self.assertEqual(status, 302)
        self.assertTrue(headers["Location"].startswith(CALLBACK + "?code="))
        # A state is good once.
        self.assertEqual(self.call("GET", f"/stand-in-google/approve?state={state}", key=None)[0], 400)

    def test_cancelling_goes_back_with_an_error_in_the_query_and_the_fragment_like_the_real_service(self):
        status, headers, _ = self.authorize()
        state = parse_qs(urlsplit(headers["Location"]).query)["state"][0]
        status, headers, _ = self.call("GET", f"/stand-in-google/deny?state={state}", key=None)
        self.assertEqual(status, 302)
        parts = urlsplit(headers["Location"])
        self.assertEqual(f"{parts.scheme}://{parts.netloc}", CALLBACK)
        self.assertEqual(parse_qs(parts.query)["error"], ["access_denied"])
        self.assertEqual(parse_qs(parts.fragment)["error"], ["access_denied"])
        self.assertNotIn("code", parse_qs(parts.query))

    def test_a_google_session_refreshes_and_the_account_can_be_deleted_like_any_other(self):
        self.stub.Handler.google_mode = "approve"
        session = self.call("POST", "/auth/v1/token?grant_type=pkce", {"auth_code": self.code_from(self.approve()), "code_verifier": RFC_VERIFIER})[2]
        status, _, renewed = self.call("POST", "/auth/v1/token?grant_type=refresh_token", {"refresh_token": session["refresh_token"]})
        self.assertEqual((status, renewed["user"]["id"]), (200, session["user"]["id"]))
        status, _, _ = self.call("DELETE", f"/auth/v1/admin/users/{session['user']['id']}", key="sb_secret_synthetic0value0")
        self.assertEqual(status, 200)
        self.assertEqual(self.stub.USERS, {})

    def test_a_password_cannot_be_used_on_an_account_that_has_none(self):
        self.stub.Handler.google_mode = "approve"
        self.call("POST", "/auth/v1/token?grant_type=pkce", {"auth_code": self.code_from(self.approve()), "code_verifier": RFC_VERIFIER})
        status, _, body = self.call("POST", "/auth/v1/token?grant_type=password", {"email": "google:stand-in-google-user", "password": ""})
        self.assertEqual((status, body["error_code"]), (400, "invalid_credentials"))

    def test_the_token_routes_still_want_the_publishable_key(self):
        status, _, _ = self.call("POST", "/auth/v1/token?grant_type=pkce", {"auth_code": "x", "code_verifier": "y"}, key=None)
        self.assertEqual(status, 401)


class AppleIdentityToken(StubCase):
    NONCE = "a-raw-nonce-only-the-app-knows"

    def sign_in(self, token=None, nonce=NONCE, **claims):
        token = token or self.stub.apple_token(self.stub.sha256_hex(self.NONCE), **claims)
        body = {"provider": "apple", "id_token": token}
        if nonce is not None:
            body["nonce"] = nonce
        return self.call("POST", "/auth/v1/token?grant_type=id_token", body)

    def test_a_token_whose_nonce_is_the_hex_sha256_of_the_raw_one_gives_a_session(self):
        status, _, session = self.sign_in(email="reader@example.test")
        self.assertEqual(status, 200)
        self.assertEqual(session["user"]["email"], "reader@example.test")
        claims = self.stub.token_claims(session["access_token"])
        self.assertEqual((claims["role"], claims["aud"], claims["is_anonymous"]), ("authenticated", "authenticated", False))

    def test_an_identity_with_no_email_is_still_an_account_and_its_email_is_empty(self):
        status, _, session = self.sign_in()
        self.assertEqual(status, 200)
        self.assertEqual(session["user"]["email"], "")
        self.assertEqual(self.stub.token_claims(session["access_token"])["email"], "")
        again = self.sign_in()[2]
        self.assertEqual(again["user"]["id"], session["user"]["id"])

    def test_the_raw_nonce_must_hash_to_the_one_in_the_token(self):
        status, _, body = self.sign_in(nonce="some-other-nonce")
        self.assertEqual((status, body["error_description"]), (400, "Nonces mismatch"))
        # The hash itself is not the nonce: the project hashes what it is given.
        status, _, body = self.sign_in(nonce=self.stub.sha256_hex(self.NONCE))
        self.assertEqual(status, 400)

    def test_a_nonce_on_one_side_only_is_refused(self):
        self.assertEqual(self.sign_in(nonce=None)[0], 400)
        token = self.stub.apple_token("")
        status, _, body = self.sign_in(token=token)
        self.assertEqual((status, "either both exist" in body["error_description"]), (400, True))

    def test_the_audience_must_be_a_bundle_id_in_the_apple_settings(self):
        status, _, body = self.sign_in(audience="com.example.other")
        self.assertEqual(status, 400)
        self.assertIn("Unacceptable audience", body["error_description"])

    def test_a_provider_that_is_switched_off_answers_provider_disabled(self):
        self.stub.Handler.providers_off = {"apple"}
        status, _, body = self.sign_in()
        self.assertEqual((status, body["error_code"]), (400, "provider_disabled"))

    def test_garbage_is_refused_and_a_key_is_needed(self):
        self.assertEqual(self.sign_in(token="not-a-token")[0], 400)
        status, _, _ = self.call("POST", "/auth/v1/token?grant_type=id_token", {"provider": "apple", "id_token": "x"}, key=None)
        self.assertEqual(status, 401)


if __name__ == "__main__":
    unittest.main()
