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
        for part in ('<html lang="en">', 'data-supabase-url="https://synthetic-project.supabase.test"', f'data-supabase-key="{PUBLISHABLE}"', "Pay 2.500 KWD", '<p class="price"><bdi><small>KWD</small> 2.500</bdi></p>',
                     "one payment · once · no subscription", f'href="{SITE}/privacy.html"', f'href="{SITE}/terms.html"', '<label for="email">Email</label>', '<label for="password">Password</label>',
                     'id="error" role="alert"', 'id="status" role="status"', "shows the ways to pay it supports", "Little Archive never sees your card", "Nothing is charged until you confirm there",
                     "free, forever", "the unlock adds", "<li>KNET</li>", "<li>Apple Pay</li>", "<li>Card</li>"):
            self.assertIn(part, page.text)
        self.assertNotIn("{", page.text, "nothing of the template is left unfilled")

    def test_every_state_the_script_shows_is_in_the_page_and_only_the_offer_is_open_at_first(self):
        page, script = self.client.get("/pay").text, self.client.get("/pay/pay.js").text
        self.assertIn("var VIEWS = ['signin', 'offer', 'open', 'done'];", script)
        for view, title in (("offer", "Pay once, keep it."), ("signin", "Sign in to pay"), ("open", "A payment is already open"), ("done", "Everything is open")):
            hidden = "" if view == "offer" else " hidden"
            self.assertIn(f'<section id="{view}" aria-labelledby="{view}-title"{hidden}>', page)
            self.assertIn(f'<h1 id="{view}-title" tabindex="-1">{title}</h1>', page, "the script moves the keyboard's focus to each view's heading")
        self.assertEqual(len(re.findall(r"<h1[ >]", page)), 4)
        # Signed out, the offer's button leads to the sign-in view; the Pay button and who is signed in appear only with a sign-in.
        for part in ('<button type="button" class="btn primary lg" id="pay" hidden>Pay 2.500 KWD</button>', '<p class="signed" id="signed" hidden>', 'id="begin">', 'id="back">', 'id="check">Check again</button>',
                     'id="google" hidden>Continue with Google</button>', 'id="signout">Sign out</button>', "you do not need to pay twice", "<noscript>"):
            self.assertIn(part, page)
        for said in ("That sign-in is not valid here. Sign in again.", "That email and password do not match an account.", "Google did not finish signing you in. Try again.",
                     "Paying on the web is not switched on for this service yet. Nothing was charged.", "The payment could not be started just now. Nothing was charged. Try again in a moment.",
                     "No payment has been confirmed yet. If you already paid, wait a minute and check again before paying a second time.", "Taking you to Tap Payments.", "Checking your account.", "Signing in."):
            self.assertIn(said, script)
        for button in re.findall(r"<button[^>]*>", page):
            self.assertIn('type="', button, "every control is a real button, reachable from the keyboard")
        self.assertNotIn('tabindex="0"', page)
        self.assertNotIn("<div role=", page)

    def test_the_price_is_the_configured_one_in_the_currency_s_own_places(self):
        for settings, price, button in (({"tap_price": "3"}, "<small>KWD</small> 3.000", "Pay 3.000 KWD"), ({"tap_price": "3.000"}, "<small>KWD</small> 3.000", "Pay 3.000 KWD"),
                                        ({"tap_price": "9.5", "tap_currency": "USD"}, "<small>USD</small> 9.50", "Pay 9.50 USD"), ({"tap_price": "0.750", "tap_currency": "BHD"}, "<small>BHD</small> 0.750", "Pay 0.750 BHD")):
            self.build(**settings)
            page = self.client.get("/pay").text
            self.assertIn(f'<p class="price"><bdi>{price}</bdi></p>', page, settings)
            self.assertIn(f">{button}</button>", page, settings)
        for name in ("pay.html", "pay.js"):
            written = (ROOT / "server" / "purchases" / "web" / name).read_text(encoding="utf-8")
            for figure in ("3.000", "2.500", "KWD", "KD "):
                self.assertNotIn(figure, written, name + " carries no price or currency of its own")

    def test_the_seller_is_named_beside_the_pay_button_only_when_the_operator_set_one(self):
        self.assertNotIn("Sold by", self.client.get("/pay").text, "no seller is invented")
        self.build(seller_name="Example Trading Co. W.L.L.")
        page = self.client.get("/pay").text
        self.assertIn('<p class="legal">Sold by Example Trading Co. W.L.L.</p>', page)
        offer = page[page.index('<section id="offer"'):page.index('<section id="signin"')]
        self.assertLess(offer.index('id="pay"'), offer.index("Sold by"), "in the offer, after the Pay button")
        self.build(seller_name='Noor & Sons <script>alert(1)</script> "x"')
        page = self.client.get("/pay").text
        self.assertIn("Sold by Noor &amp; Sons &lt;script&gt;alert(1)&lt;/script&gt; &quot;x&quot;</p>", page)
        self.assertNotIn("<script>alert", page)
        self.build(seller_name="{price} {0} {supabase_key}")
        self.assertIn("Sold by {price} {0} {supabase_key}</p>", self.client.get("/pay").text, "a name is text, never part of the template")

    def test_the_refund_and_agreement_lines_link_the_public_site_and_lose_only_their_links_without_one(self):
        page = self.client.get("/pay").text
        offer = page[page.index('<section id="offer"'):page.index('<section id="signin"')]
        for line in (f'<p class="legal">14-day refund: <a href="{SITE}/terms.html#refunds">write to us</a>.</p>',
                     f'<p class="legal">By paying you agree to the <a href="{SITE}/terms.html">Terms</a> and <a href="{SITE}/privacy.html">Privacy policy</a>.</p>'):
            self.assertIn(line, offer)
            self.assertLess(offer.index('id="pay"'), offer.index(line))
        self.assertIn('<h2 id="refunds">Refunds</h2>', (ROOT / "web" / "terms.html").read_text(encoding="utf-8"), "the section the refund line points at exists")
        self.assertIn(f'<li><a href="{SITE}/support.html">Support</a></li>', page)
        self.build(public_site_url="https://archive.example/site")
        self.assertIn('href="https://archive.example/site/terms.html#refunds"', self.client.get("/pay").text)
        self.build(public_site_url="")
        bare = self.client.get("/pay")
        self.assertEqual(bare.status_code, 200, "the page is still served")
        for line in ('<p class="legal">14-day refund: write to us.</p>', '<p class="legal">By paying you agree to the Terms and Privacy policy.</p>', "Pay 2.500 KWD"):
            self.assertIn(line, bare.text)
        self.assertEqual(re.findall(r'href="([^"]+)"', bare.text), ["/pay/pay.css", "#main"], "no link without an address to point it at")
        self.assertNotIn("<footer", bare.text)

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
        self.assertIn('<a class="btn primary lg" href="/pay">Back to the pay page</a>', waiting.text)
        self.assertIn('<p class="notice petal">Your payment is still being confirmed.', waiting.text)
        self.tap.change(charge, status="DECLINED")
        declined = self.client.get("/api/purchases/tap/return", params={"tap_id": charge}).text
        self.assertIn('<a class="btn primary lg" href="/pay">Start again on the pay page</a>', declined)
        self.assertIn('<p class="notice err">The payment was not completed, so nothing was unlocked.</p>', declined)
        style = self.client.get("/pay/pay.css").text
        for rule in ("main.returned", ".notice.petal", ".notice.err", ".notice.sage", ".whisper"):
            self.assertIn(rule, style, "the return page is styled by this stylesheet")
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
        self.assertEqual((config.supabase_publishable_key, config.public_site_url, config.tap_allow_test_purchases, config.seller_name), ("", SITE, False, ""))
        config = Config.from_env(self.values(LA_SUPABASE_PUBLISHABLE_KEY=PUBLISHABLE, LA_PUBLIC_SITE_URL="https://archive.example/site/", LA_TAP_ALLOW_TEST_PURCHASES="true", LA_SELLER_NAME="  Example Trading Co. W.L.L. "))
        config.validate()
        self.assertEqual((config.supabase_publishable_key, config.public_site_url, config.tap_allow_test_purchases, config.seller_name), (PUBLISHABLE, "https://archive.example/site", True, "Example Trading Co. W.L.L."))
        Config.from_env(self.values(LA_SELLER_NAME="شركة مثال للتجارة")).validate()
        for bad in ("Two\nlines", "x" * 121, "Bell\x07"):
            with self.assertRaises(ValueError, msg=repr(bad)):
                Config.from_env(self.values(LA_SELLER_NAME=bad)).validate()
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
