"""The pay page of a hosted server (/pay): when it exists, what it carries, and the requests its script makes.

No browser runs here. The page and its two files are read as text, and the sign-in and payment the script performs are made
by hand against the development stand-in for Supabase Auth (mobile/dev/stub_supabase.py) and a dictionary standing in for Tap.
What a browser does with the page (its layout, focus, the trip to Google and back) was not exercised by these tests.
"""
import http.client
import importlib.util
from http.server import ThreadingHTTPServer
import json
from pathlib import Path
import re
import sys
import tempfile
from threading import Thread
import unittest
from uuid import uuid4

from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent))
from support_hosted import SigningKey, bearer, claims, hosted_app, no_worker_threads  # noqa: E402
from test_hosted_tap import KEY as TAP_KEY, FakeTap  # noqa: E402

from server.config import Config  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
PUBLISHABLE = "sb_publishable_synthetic0value0xxxxxxxx"
SERVICE_KEY = "sb_secret_synthetic0test0value0not0real0"
JWT_SECRET = "j" * 40
SITE = "https://abdulmalikaltararwa-oss.github.io/little-archive"


class PayCase(unittest.TestCase):
    settings = {"tap_secret_key": TAP_KEY, "tap_price": "2.500", "supabase_publishable_key": PUBLISHABLE, "supabase_service_key": SERVICE_KEY}

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="little-archive-pay-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.enterContext(no_worker_threads())
        self.key, self.tap = SigningKey(), FakeTap()
        self.build()

    def build(self, clients=None, **settings):
        self.app, _ = hosted_app(self.root / uuid4().hex, self.key, purchase_clients={"tap": self.tap} if clients is None else clients, **{**self.settings, **settings})
        self.client = TestClient(self.app)
        self.client.__enter__()
        self.addCleanup(self.client.__exit__, None, None, None)


class PayPageTests(PayCase):
    def test_the_page_is_served_with_the_price_and_what_a_browser_needs_to_sign_in(self):
        page = self.client.get("/pay")
        self.assertEqual((page.status_code, page.headers["content-type"], page.headers["cache-control"]), (200, "text/html; charset=utf-8", "no-store"))
        for part in ('<html lang="en">', 'data-supabase-url="https://synthetic-project.supabase.test"', f'data-supabase-key="{PUBLISHABLE}"', "Pay 2.500 KWD", '<p class="price">2.500 <small>KWD</small></p>',
                     "one payment · once · no subscription", f'href="{SITE}/privacy.html"', f'href="{SITE}/terms.html"', '<label for="email">Email</label>', '<label for="password">Password</label>',
                     'id="error" role="alert"', 'id="status" role="status"', "shows the ways to pay it supports", "Little Archive never sees your card"):
            self.assertIn(part, page.text)

    def test_the_policy_allows_no_inline_code_and_connections_only_here_and_to_the_sign_in_project(self):
        page = self.client.get("/pay")
        self.assertEqual(page.headers["content-security-policy"],
                         "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self' https://synthetic-project.supabase.test; "
                         "form-action 'self'; frame-ancestors 'none'; base-uri 'none'")
        self.assertEqual((page.headers["x-frame-options"], page.headers["x-content-type-options"], page.headers["referrer-policy"]), ("DENY", "nosniff", "no-referrer"))
        self.assertEqual(re.findall(r"<script[^>]*>", page.text), ['<script src="/pay/pay.js" defer>'], "one script, from this server")
        self.assertEqual(re.findall(r"<link[^>]*>", page.text), ['<link rel="stylesheet" href="/pay/pay.css">'])
        for inline in ("<style", " style=", " onclick", " onsubmit", "javascript:"):
            self.assertNotIn(inline, page.text)
        outside = [address for address in re.findall(r'(?:src|href|action)="([^"]+)"', page.text) if not address.startswith(("/pay", "#", SITE + "/"))]
        self.assertEqual(outside, [], "nothing is loaded from anywhere else")

    def test_its_script_and_stylesheet_are_served_from_fixed_addresses(self):
        script, style = self.client.get("/pay/pay.js"), self.client.get("/pay/pay.css")
        self.assertEqual((script.status_code, script.headers["content-type"], style.status_code, style.headers["content-type"]), (200, "text/javascript; charset=utf-8", 200, "text/css; charset=utf-8"))
        self.assertEqual(script.content, (ROOT / "server" / "purchases" / "web" / "pay.js").read_bytes())
        for call in ("/auth/v1/token?grant_type=password", "/auth/v1/token?grant_type=pkce", "/auth/v1/authorize?", "/auth/v1/settings", "'/api/account'", "'/api/purchases/tap/start'", "credentials: 'omit'"):
            self.assertIn(call, script.text)
        for absent in ("localStorage", "document.cookie", "innerHTML", "eval(", "amount"):
            self.assertNotIn(absent, re.sub(r"^\s*//.*$", "", script.text, flags=re.M), absent)
        self.assertEqual(re.findall(r"sessionStorage\.\w+\((\w+)", script.text), ["VERIFIER", "VERIFIER", "VERIFIER"], "the one thing kept between pages is the PKCE verifier")
        self.assertNotIn("@import", style.text)
        self.assertNotIn("url(", style.text)
        self.assertIn("prefers-color-scheme: dark", style.text)

    def test_no_secret_reaches_the_page_or_its_files(self):
        said = "".join(self.client.get(path).text for path in ("/pay", "/pay/pay.js", "/pay/pay.css"))
        for secret in (TAP_KEY, SERVICE_KEY, "sb_secret_", "sk_test_", "sk_live_", "service_role"):
            self.assertNotIn(secret, said)

    def test_it_is_the_only_page_and_exists_only_while_a_buyer_could_finish(self):
        for path in ("/", "/index.html", "/share", "/pay/pay.html", "/pay/../server/config.py", "/unlock"):
            self.assertEqual(self.client.get(path).status_code, 404, path)
        self.assertEqual(self.client.post("/pay", data={"email": "a@example.test", "password": "x"}).status_code, 405, "the form is never sent to this server")
        for off in ({"supabase_publishable_key": ""}, {"tap_secret_key": "", "tap_price": ""}):
            self.build(clients={}, **off)
            for path in ("/pay", "/pay/pay.js", "/pay/pay.css"):
                self.assertEqual(self.client.get(path).status_code, 404, (off, path))

    def test_a_self_hosted_server_has_no_pay_page(self):
        from server.app import create_app
        with tempfile.TemporaryDirectory() as folder:
            app = create_app(Config(data_dir=Path(folder) / "data", admin_password="a-self-hosted-owner-password", public_url="http://testserver", testing=True))
            with TestClient(app) as owner:
                for path in ("/pay", "/pay/pay.js", "/pay/pay.css"):
                    self.assertEqual(owner.get(path).status_code, 404, path)

    def test_the_page_tap_sends_a_buyer_back_to_leads_back_here(self):
        user = str(uuid4())
        auth = bearer(self.key.sign(claims(user)))
        self.client.post("/api/purchases/tap/start", json={"email": "buyer@example.test"}, headers=auth)
        charge = self.tap.created[0]["id"]
        waiting = self.client.get("/api/purchases/tap/return", params={"tap_id": charge})
        self.assertIn('<link rel="stylesheet" href="/pay/pay.css">', waiting.text)
        self.assertIn('<a href="/pay">Back to the pay page</a>', waiting.text)
        self.tap.change(charge, status="DECLINED")
        self.assertIn('<a href="/pay">Start again on the pay page</a>', self.client.get("/api/purchases/tap/return", params={"tap_id": charge}).text)
        self.build(supabase_publishable_key="")
        plain = self.client.get("/api/purchases/tap/return", params={"tap_id": "chg_TS" + "a" * 32})
        self.assertNotIn("/pay", plain.text, "with the pay page off, nothing points at it")

    def test_nothing_in_the_phone_app_or_the_interface_leads_to_paying_on_the_web(self):
        found = []
        for folder in (ROOT / "mobile" / "src", ROOT / "ui" / "src", ROOT / "mobile" / "ios" / "App" / "App", ROOT / "mobile" / "android" / "app" / "src"):
            for path in folder.rglob("*"):
                if path.is_file() and path.suffix in {".js", ".mjs", ".ts", ".tsx", ".jsx", ".css", ".html", ".json", ".swift", ".java", ".kt", ".xml", ".plist"}:
                    text = path.read_text(encoding="utf-8", errors="ignore")
                    if re.search(r"""['"`/]pay(?:['"`/?#]|$)""", text, flags=re.M) or "purchases/tap" in text or "tap.company" in text:
                        found.append(str(path.relative_to(ROOT)))
        self.assertEqual(found, [], "store rules: the apps carry no link or button to the web payment")


class PayFlowTests(unittest.TestCase):
    """The requests pay.js makes, in its order, made by hand: sign in at the stand-in for Supabase, then the two calls to this server."""

    def setUp(self):
        spec = importlib.util.spec_from_file_location("stub_supabase", ROOT / "mobile" / "dev" / "stub_supabase.py")
        self.stub = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.stub)
        self.stub.USERS.clear()
        server = ThreadingHTTPServer(("127.0.0.1", 0), self.stub.Handler)
        self.supabase = "http://127.0.0.1:%d" % server.server_address[1]
        self.stub.Handler.secret, self.stub.Handler.publishable, self.stub.Handler.secret_key, self.stub.Handler.issuer = JWT_SECRET, PUBLISHABLE, SERVICE_KEY, self.supabase + "/auth/v1"
        Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        self.temporary = tempfile.TemporaryDirectory(prefix="little-archive-pay-flow-")
        self.addCleanup(self.temporary.cleanup)
        self.enterContext(no_worker_threads())
        self.tap = FakeTap()
        self.app, _ = hosted_app(Path(self.temporary.name), purchase_clients={"tap": self.tap}, supabase_url=self.supabase, supabase_jwt_issuer=self.supabase + "/auth/v1", supabase_jwt_secret=JWT_SECRET,
                                 supabase_publishable_key=PUBLISHABLE, tap_secret_key=TAP_KEY, tap_price="2.500")
        self.client = TestClient(self.app)
        self.client.__enter__()
        self.addCleanup(self.client.__exit__, None, None, None)

    def supabase_call(self, path, body, key=PUBLISHABLE):
        connection = http.client.HTTPConnection("127.0.0.1", int(self.supabase.rsplit(":", 1)[1]), timeout=5)
        connection.request("POST", path, body=json.dumps(body), headers={"Content-Type": "application/json", "Accept": "application/json", "apikey": key})
        reply = connection.getresponse()
        parsed = json.loads(reply.read() or b"null")
        connection.close()
        return reply.status, parsed

    def test_sign_in_then_start_sends_the_browser_to_tap_and_a_captured_payment_unlocks_that_account(self):
        page = self.client.get("/pay")
        self.assertIn(f'data-supabase-url="{self.supabase}"', page.text)
        self.assertIn(f"connect-src 'self' {self.supabase};", page.headers["content-security-policy"])
        self.assertEqual(self.supabase_call("/auth/v1/signup", {"email": "noor@example.test", "password": "a-long-enough-password"})[0], 200)
        refused, _ = self.supabase_call("/auth/v1/token?grant_type=password", {"email": "noor@example.test", "password": "not-the-password"})
        self.assertEqual(refused, 400)
        status, session = self.supabase_call("/auth/v1/token?grant_type=password", {"email": "noor@example.test", "password": "a-long-enough-password"})
        self.assertEqual((status, session["user"]["email"]), (200, "noor@example.test"))
        auth = bearer(session["access_token"])
        account = self.client.get("/api/account", headers=auth)
        self.assertEqual((account.status_code, account.json()["entitlements"]["unlocked"], account.json()["user_id"]), (200, False, session["user"]["id"]))
        started = self.client.post("/api/purchases/tap/start", json={"email": session["user"]["email"]}, headers=auth)
        self.assertEqual(started.status_code, 200, started.text)
        self.assertTrue(started.json()["url"].startswith("https://checkout.payments.tap.company?mode=page&token="), "where the script sends the browser")
        asked = self.tap.created[0]
        self.assertEqual((asked["account"], asked["email"], str(asked["amount"]), asked["redirect_url"]), (session["user"]["id"], "noor@example.test", "2.500", "http://testserver/api/purchases/tap/return"))
        self.tap.change(asked["id"], status="CAPTURED")
        back = self.client.get("/api/purchases/tap/return", params={"tap_id": asked["id"]})
        self.assertIn("Payment received", back.text)
        self.assertEqual(self.client.get("/api/account", headers=auth).json()["entitlements"]["unlocked_via"], "tap")
        again = self.client.post("/api/purchases/tap/start", json={"email": session["user"]["email"]}, headers=auth)
        self.assertEqual(again.json(), {"unlocked": True, "provider": "tap", "status": "unlocked", "url": None}, "the page then says everything is open")

    def test_without_a_sign_in_the_page_can_start_nothing(self):
        for headers in ({}, bearer("not-a-token"), {"apikey": PUBLISHABLE}):
            self.assertEqual(self.client.post("/api/purchases/tap/start", json={"email": "noor@example.test"}, headers=headers).status_code, 401)
        self.assertEqual(self.tap.created, [])


class PaySettingsTests(unittest.TestCase):
    def values(self, **extra):
        return {"LA_MODE": "hosted", "LA_SUPABASE_URL": "https://p.supabase.test", "LA_DATA_DIR": "/tmp/x", "LA_PUBLIC_URL": "http://localhost:8787", "LA_SUPABASE_SERVICE_KEY": SERVICE_KEY, **extra}

    @staticmethod
    def legacy(role):
        import base64
        part = lambda document: base64.urlsafe_b64encode(json.dumps(document).encode()).rstrip(b"=").decode()  # noqa: E731
        return ".".join((part({"alg": "HS256", "typ": "JWT"}), part({"iss": "supabase", "ref": "synthetic", "role": role, "iat": 1, "exp": 2}), "c2lnbmF0dXJl"))

    def test_the_defaults_and_what_is_read(self):
        config = Config.from_env(self.values())
        config.validate()
        self.assertEqual((config.supabase_publishable_key, config.public_site_url, config.tap_allow_test_purchases), ("", SITE, False))
        config = Config.from_env(self.values(LA_SUPABASE_PUBLISHABLE_KEY=PUBLISHABLE, LA_PUBLIC_SITE_URL="https://archive.example/site/", LA_TAP_ALLOW_TEST_PURCHASES="true"))
        config.validate()
        self.assertEqual((config.supabase_publishable_key, config.public_site_url, config.tap_allow_test_purchases), (PUBLISHABLE, "https://archive.example/site", True))
        Config.from_env(self.values(LA_SUPABASE_PUBLISHABLE_KEY=self.legacy("anon"))).validate()

    def test_a_key_that_could_be_a_secret_is_refused_because_the_page_shows_it(self):
        for bad in (SERVICE_KEY, "sb_secret_another0synthetic0value0000", self.legacy("service_role"), self.legacy("authenticated"), "a.b.c", "sb_publishable_x", "sb_publishable_has space0000000000", "plain-text-of-some-length-000000"):
            with self.assertRaises(ValueError, msg=bad) as caught:
                Config.from_env(self.values(LA_SUPABASE_PUBLISHABLE_KEY=bad)).validate()
            self.assertNotIn(bad, str(caught.exception))
        for bad in ("http://archive.example", "https://archive.example/?x=1", "https://user@archive.example", 'https://archive.example/"><script>', "archive.example"):
            with self.assertRaises(ValueError, msg=bad):
                Config.from_env(self.values(LA_PUBLIC_SITE_URL=bad)).validate()
        with self.assertRaises(ValueError):  # a self-hosted server has no Supabase project
            Config.from_env({"LA_DATA_DIR": "/tmp/x", "LA_ADMIN_PASSWORD": "a-self-hosted-owner-password", "LA_SUPABASE_PUBLISHABLE_KEY": PUBLISHABLE}).validate()

    def test_doctor_says_whether_the_pay_page_is_on(self):
        from server.diagnostics import diagnose
        with tempfile.TemporaryDirectory() as folder:
            environment = {**self.values(), "LA_DATA_DIR": str(Path(folder) / "data")}

            def row(**more):
                result = diagnose(env_file=Path(folder) / "absent.env", environment={**environment, **more})
                return next(r for r in result["checks"] if r["id"] == "pay_page")["code"], json.dumps(result)

            self.assertEqual(row()[0], "pay_page_off")
            self.assertEqual(row(LA_TAP_SECRET_KEY=TAP_KEY, LA_TAP_PRICE="2.500")[0], "pay_page_off")
            code, printed = row(LA_TAP_SECRET_KEY=TAP_KEY, LA_TAP_PRICE="2.500", LA_SUPABASE_PUBLISHABLE_KEY=PUBLISHABLE)
            self.assertEqual(code, "pay_page_on")
            self.assertNotIn(TAP_KEY, printed)
            self.assertNotIn(SERVICE_KEY, printed)


if __name__ == "__main__":
    unittest.main()
