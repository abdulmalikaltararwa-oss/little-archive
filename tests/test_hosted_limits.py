"""Rate limits, concurrency caps, sign-in failure budgets and the checks that run before a request body is read.

The limiters take an injectable clock, so minutes pass without waiting. Requests that must not reach the body reader are made
straight to the ASGI application with a `receive` that records whether it was ever asked for the body.
"""
import asyncio
import json
from pathlib import Path
import sys
import tempfile
from threading import Event, Thread
import time
import unittest
from unittest.mock import patch
from uuid import uuid4

from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent))
from support_hosted import SigningKey, bearer, claims, hosted_app, hosted_config, no_worker_threads  # noqa: E402

from server.limits import Buckets, Gates, client_address, route_class  # noqa: E402


class FakeClock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now


class BucketTests(unittest.TestCase):
    def test_a_burst_then_the_refill_rate(self):
        clock = FakeClock()
        buckets = Buckets(60, burst=5, clock=clock)  # a token a second, five at a time
        self.assertEqual([buckets.take("a") for _ in range(5)], [0.0] * 5)
        wait = buckets.take("a")
        self.assertAlmostEqual(wait, 1.0)
        clock.now += 0.5
        self.assertAlmostEqual(buckets.take("a"), 0.5)
        clock.now += 0.5
        self.assertEqual(buckets.take("a"), 0.0)
        clock.now += 3600
        self.assertEqual([buckets.take("a") for _ in range(5)], [0.0] * 5, "a long quiet spell refills to the burst, no further")
        self.assertGreater(buckets.take("a"), 0)

    def test_keys_are_independent_and_a_price_can_be_more_than_one(self):
        clock = FakeClock()
        buckets = Buckets(60, burst=20, clock=clock)
        self.assertEqual(buckets.take("a", 10), 0.0)
        self.assertEqual(buckets.take("a", 10), 0.0)
        self.assertAlmostEqual(buckets.take("a", 10), 10.0)
        self.assertEqual(buckets.take("b", 10), 0.0, "another key has its own bucket")
        self.assertEqual(buckets.take("c", 500), 0.0, "a price above the burst is capped to it, so it can still be paid")

    def test_memory_is_bounded_and_forgets_the_oldest_key_first(self):
        buckets = Buckets(60, max_keys=100, clock=FakeClock())
        for number in range(10_000):
            buckets.take(f"key-{number}")
        self.assertLessEqual(len(buckets._state), 100)
        self.assertIn("key-9999", buckets._state)
        self.assertNotIn("key-0", buckets._state)

    def test_failures_are_spent_and_only_the_overspend_is_a_wait(self):
        clock = FakeClock()
        failures = Buckets(3 / 10, burst=3, clock=clock)  # three, refilled over ten minutes
        self.assertEqual([failures.spend("ip") for _ in range(3)], [0.0, 0.0, 0.0])
        wait = failures.spend("ip")
        self.assertGreater(wait, 0)
        self.assertLess(wait, 600)
        clock.now += 600
        self.assertEqual(failures.spend("ip"), 0.0)
        for _ in range(1000):
            failures.spend("ip")
        clock.now += 600
        self.assertGreaterEqual(failures.take("ip", 0), 0.0)
        self.assertEqual(Buckets(0).spend("ip"), 0.0, "a rate of zero is off")

    def test_gates_count_per_account_and_overall_and_are_given_back_once(self):
        gates = Gates(per_account=2, overall=3)
        one, why = gates.enter("a")
        two, _ = gates.enter("a")
        self.assertEqual(gates.enter("a"), (None, "account"))
        three, _ = gates.enter("b")
        self.assertEqual(gates.enter("c"), (None, "service"))
        one()
        one()  # a second call is harmless
        self.assertEqual(gates.counts(), (2, {"a": 1, "b": 1}))
        again, why = gates.enter("a")
        self.assertIsNone(why)
        for leave in (two, three, again):
            leave()
        self.assertEqual(gates.counts(), (0, {}))


class AddressTests(unittest.TestCase):
    @staticmethod
    def scope(peer="203.0.113.9", **headers):
        return {"client": (peer, 5000), "headers": [(name.encode(), value.encode()) for name, value in headers.items()]}

    def test_the_socket_peer_is_the_address_unless_proxies_are_trusted(self):
        forged = self.scope(**{"x-forwarded-for": "198.51.100.7"})
        self.assertEqual(client_address(forged, 0), "203.0.113.9", "X-Forwarded-For is just a header until an operator says a proxy sets it")
        self.assertEqual(client_address({"headers": []}, 0), "unknown")

    def test_only_what_the_trusted_proxies_appended_is_believed(self):
        proxy = self.scope("10.0.0.2", **{"x-forwarded-for": "6.6.6.6, 198.51.100.7"})  # the client wrote the first; one proxy added the second
        self.assertEqual(client_address(proxy, 1), "198.51.100.7")
        two = self.scope("10.0.0.2", **{"x-forwarded-for": "6.6.6.6, 198.51.100.7, 192.0.2.44"})
        self.assertEqual(client_address(two, 2), "198.51.100.7")
        self.assertEqual(client_address(two, 1), "192.0.2.44")
        self.assertEqual(client_address(self.scope("10.0.0.2"), 1), "10.0.0.2", "no header: the proxy itself")
        self.assertEqual(client_address(self.scope("10.0.0.2", **{"x-forwarded-for": "198.51.100.7"}), 2), "10.0.0.2", "fewer entries than proxies: not believed")
        for junk in ("not an address", "<script>", "1.2.3.4:80"):
            self.assertEqual(client_address(self.scope("10.0.0.2", **{"x-forwarded-for": "198.51.100.7, " + junk}), 1), "10.0.0.2", junk)
        self.assertEqual(client_address(self.scope("10.0.0.2", **{"x-forwarded-for": "2001:db8::7"}), 1), "2001:db8::7")

    def test_expensive_routes_are_recognised_by_method_and_exact_path(self):
        for method, path, kind in (("GET", "/api/export", "heavy"), ("GET", "/api/backup", "heavy"), ("POST", "/api/imports/file", "heavy"),
                                   ("POST", "/api/items/abc/thumbnail", "heavy"), ("POST", "/api/items/abc/page", "fetch"), ("POST", "/api/ai/jobs", "ai"),
                                   ("POST", "/api/ai/jobs/xyz/retry", "ai"), ("POST", "/api/items/abc/deep-read", "ai"), ("GET", "/api/items", None),
                                   ("DELETE", "/api/items/abc/thumbnail", None), ("GET", "/api/export/extra", None), ("POST", "/api/items/a/b/thumbnail", None)):
            self.assertEqual(route_class(method, path), kind, method + " " + path)


class HostedLimitCase(unittest.TestCase):
    settings = {}

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="little-archive-limits-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.enterContext(no_worker_threads())
        self.key = SigningKey()
        self.app, _ = hosted_app(self.root, self.key, **self.settings)
        self.clock = FakeClock()
        limits = self.app.state.limits
        for buckets in (limits.by_address, limits.by_account, limits.failures, limits.notifications):
            buckets.clock = self.clock
        self.client = TestClient(self.app)
        self.client.__enter__()
        self.addCleanup(self.client.__exit__, None, None, None)

    def account(self, **changes):
        user = str(uuid4())
        return user, bearer(self.key.sign(claims(user, **changes)))

    def call_asgi(self, method, path, headers, body=b"", declared=None, chunk=None):
        """One request straight to the application. Returns (status, json, how many times the body was asked for, bytes of it handed over)."""
        asked, handed, sent = [], [], []
        size = body if isinstance(body, int) else len(body)  # an int is a body of that many bytes, made a piece at a time so a test does not hold it either
        left = [size]

        async def receive():
            asked.append(1)
            take = min(chunk or size, left[0])
            piece = body[size - left[0]:size - left[0] + take] if isinstance(body, bytes) else b"x" * take
            left[0] -= take
            handed.append(len(piece))
            return {"type": "http.request", "body": piece, "more_body": left[0] > 0}

        async def send(message):
            sent.append(message)
        scope = {"type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1", "method": method, "path": path, "raw_path": path.encode(), "query_string": b"",
                 "headers": [(b"host", b"testserver"), (b"content-length", str(size if declared is None else declared).encode()), *[(k.lower().encode(), v.encode()) for k, v in headers.items()]],
                 "client": ("testclient", 50000), "server": ("testserver", 80), "scheme": "http", "root_path": ""}
        asyncio.run(self.app(scope, receive, send))
        status = next(m["status"] for m in sent if m["type"] == "http.response.start")
        raw = b"".join(m.get("body", b"") for m in sent if m["type"] == "http.response.body")
        return status, json.loads(raw) if raw else None, len(asked), sum(handed)


class AddressBudgetTests(HostedLimitCase):
    settings = {"hosted_rate_address_per_minute": 6}

    def test_requests_over_the_address_budget_are_refused_with_a_wait_and_a_code(self):
        user, auth = self.account()
        statuses = [self.client.get("/api/discovery").status_code for _ in range(6)]
        self.assertEqual(statuses, [200] * 6)
        refused = self.client.get("/api/discovery")
        self.assertEqual(refused.status_code, 429)
        self.assertEqual(refused.json()["code"], "rate_limited")
        self.assertEqual(refused.json()["scope"], "address")
        self.assertEqual(refused.headers["retry-after"], "10")
        self.assertEqual(refused.headers["x-content-type-options"], "nosniff", "a refusal carries the same security headers as an answer")
        self.assertEqual(self.client.get("/api/items", headers=auth).status_code, 429, "a signed-in request from the same address is over the same budget")
        self.assertEqual(self.client.get("/api/health").status_code, 200, "the health check is never refused")
        self.clock.now += 10
        self.assertEqual(self.client.get("/api/discovery").status_code, 200)

    def test_a_forged_forwarding_header_does_not_buy_a_fresh_budget(self):
        for number in range(6):
            self.client.get("/api/discovery")
        for forged in ("198.51.100.1", "198.51.100.2, 198.51.100.3", "::1"):
            self.assertEqual(self.client.get("/api/discovery", headers={"X-Forwarded-For": forged}).status_code, 429, forged)


class ProxiedAddressTests(HostedLimitCase):
    settings = {"hosted_rate_address_per_minute": 3, "hosted_trusted_proxy_hops": 1}

    def test_with_a_proxy_in_front_each_client_address_has_its_own_budget(self):
        def get(address, forged=None):
            return self.client.get("/api/discovery", headers={"X-Forwarded-For": (forged + ", " if forged else "") + address}).status_code
        self.assertEqual([get("198.51.100.1") for _ in range(3)], [200] * 3)
        self.assertEqual(get("198.51.100.1"), 429)
        self.assertEqual(get("198.51.100.2"), 200, "another client behind the same proxy")
        self.assertEqual(get("198.51.100.1", forged="198.51.100.77"), 429, "what the client wrote to the left of the proxy's entry changes nothing")


class AccountBudgetTests(HostedLimitCase):
    settings = {"hosted_rate_account_per_minute": 20}

    def test_an_accounts_requests_are_priced_by_what_they_cost(self):
        (alice, a), (bob, b) = self.account(), self.account()
        self.assertEqual(self.client.get("/api/export", headers=a).status_code, 200)  # ten of twenty
        self.assertEqual(self.client.get("/api/export", headers=a).status_code, 200)  # the other ten
        limited = self.client.get("/api/items", headers=a)
        self.assertEqual((limited.status_code, limited.json()["code"], limited.json()["scope"]), (429, "rate_limited", "account"))
        self.assertGreaterEqual(int(limited.headers["retry-after"]), 1)
        self.assertEqual(self.client.get("/api/export", headers=b).status_code, 200, "another account is not affected")
        self.assertEqual(self.client.get("/api/auth/me", headers=a).status_code, 200, "public routes carry no account")
        self.clock.now += 60
        self.assertEqual(self.client.get("/api/items", headers=a).status_code, 200)

    def test_a_refused_request_did_nothing(self):
        user, auth = self.account()
        for _ in range(2):
            self.client.get("/api/export", headers=auth)
        self.assertEqual(self.client.post("/api/items", json={"url": "https://example.com/x"}, headers=auth).status_code, 429)
        self.clock.now += 60
        self.assertEqual(self.client.get("/api/items", headers=auth).json()["total"], 0)


class SignInFailureTests(HostedLimitCase):
    settings = {"hosted_rate_auth_failures": 5}

    def forged(self):
        return {"Authorization": "Bearer " + SigningKey().sign(claims(str(uuid4())))}  # a well-formed token from a key the server does not know

    def test_forged_tokens_use_up_a_budget_and_then_are_told_to_wait(self):
        for number in range(5):
            self.assertEqual(self.client.get("/api/items", headers=self.forged()).status_code, 401, number)
        sixth = self.client.get("/api/items", headers=self.forged())
        self.assertEqual((sixth.status_code, sixth.json()["code"]), (429, "auth_rate_limited"))
        self.assertGreaterEqual(int(sixth.headers["retry-after"]), 1)
        user, auth = self.account()
        self.assertEqual(self.client.get("/api/items", headers=auth).status_code, 200, "a valid token is never refused for what others did from the same address")
        self.clock.now += 120  # five failures refill over ten minutes: one every two, and the refused attempt left one owing
        self.assertEqual(self.client.get("/api/items", headers=self.forged()).status_code, 429, "the debt is paid off before anything is allowed again")
        self.clock.now += 1200
        self.assertEqual(self.client.get("/api/items", headers=self.forged()).status_code, 401, "the budget refills")

    def test_a_token_that_has_merely_expired_is_not_a_failed_attempt(self):
        user, expired = self.account(exp=int(time.time()) - 600, iat=int(time.time()) - 4000)
        for _ in range(20):
            self.assertEqual(self.client.get("/api/items", headers=expired).status_code, 401)
        self.assertEqual(self.client.get("/api/items", headers=self.forged()).status_code, 401, "a phone refreshing its token costs nothing")

    def test_no_token_at_all_is_not_a_failed_attempt_either(self):
        for _ in range(20):
            self.assertEqual(self.client.get("/api/items").status_code, 401)
        self.assertEqual(self.client.get("/api/items", headers=self.forged()).status_code, 401)

    def test_the_budget_is_spent_by_requests_with_bodies_too(self):
        for number in range(5):
            self.assertEqual(self.client.post("/api/items", json={"url": "https://example.com/x"}, headers=self.forged()).status_code, 401, number)
        self.assertEqual(self.client.post("/api/items", json={"url": "https://example.com/x"}, headers=self.forged()).status_code, 429)
        self.assertEqual(self.client.get("/api/items", headers=self.forged()).status_code, 429, "one budget for both")

    def test_a_deleted_accounts_token_is_not_a_forgery(self):
        user, auth = self.account()
        self.assertEqual(self.client.get("/api/items", headers=auth).status_code, 200)
        self.app.state.libraries.delete(user)
        for _ in range(20):
            self.assertEqual(self.client.get("/api/items", headers=auth).status_code, 401)
        self.assertEqual(self.client.get("/api/items", headers=self.forged()).status_code, 401)


class BeforeTheBodyTests(HostedLimitCase):
    def test_a_request_with_a_body_is_refused_before_the_body_is_kept_unless_it_is_signed_in(self):
        import tracemalloc
        user, auth = self.account()
        big = 6 * 1024 * 1024
        for label, headers in (("no credential", {}), ("a forged token", {"Authorization": "Bearer " + SigningKey().sign(claims(str(uuid4())))}),
                               ("malformed", {"Authorization": "Bearer nonsense"}), ("another scheme", {"Authorization": "Basic Zm9vOmJhcg=="}),
                               ("two bearer values", {"Authorization": "Bearer a, Bearer b"})):
            with self.subTest(label):
                tracemalloc.start()
                try:
                    status, body, asked, handed = self.call_asgi("POST", "/api/imports/file", headers, body=big, chunk=64 * 1024)
                    peak = tracemalloc.get_traced_memory()[1]
                finally:
                    tracemalloc.stop()
                self.assertEqual(status, 401, label)
                self.assertLess(peak, 2 * 1024 * 1024, "six megabytes were read and dropped, not held (the body list alone would have been six)")
        # What the client was still sending was read and dropped (so a client mid-upload gets its 401 rather than a reset) but only up to what the route may take.
        status, body, asked, handed = self.call_asgi("POST", "/api/imports/file", {}, body=big, chunk=64 * 1024)
        self.assertEqual((status, handed <= 8 * 1024 + 64 * 1024), (401, True), "with no credential at all, no more than a form's worth is even read")
        forged = {"Authorization": "Bearer " + SigningKey().sign(claims(str(uuid4())))}
        status, body, asked, handed = self.call_asgi("POST", "/api/imports/file", forged, body=big, chunk=64 * 1024)
        self.assertEqual((status, handed <= 8 * 1024 * 1024 + 64 * 1024), (401, True))
        status, body, asked, handed = self.call_asgi("POST", "/api/items", {**auth, "Content-Type": "application/json"}, body=json.dumps({"url": "https://example.com/signed-in"}).encode())
        self.assertEqual((status, asked > 0), (200, True))

    def test_the_routes_that_answer_404_in_hosted_mode_still_do(self):
        for path in ("/api/auth/login", "/api/auth/devices", "/api/extension/imports"):
            status, body, asked, handed = self.call_asgi("POST", path, {}, body=b"{}")
            self.assertEqual(status, 404, path)

    def test_a_signed_in_request_is_verified_once(self):
        user, auth = self.account()
        identity = self.app.state.identity
        with patch.object(identity, "verify", wraps=identity.verify) as verify:
            self.assertEqual(self.client.post("/api/items", json={"url": "https://example.com/once"}, headers=auth).status_code, 200)
            self.assertEqual(verify.call_count, 1, "the guard verified it, and the route used that result")
            self.assertEqual(self.client.get("/api/items", headers=auth).status_code, 200)
            self.assertEqual(verify.call_count, 2)

    def test_a_body_that_stalls_or_trickles_is_cut_off(self):
        user, auth = self.account()

        async def stalled(receive_after):
            sent = []

            async def receive():
                await asyncio.sleep(receive_after)
                return {"type": "http.request", "body": b"x", "more_body": True}

            async def send(message):
                sent.append(message)
            scope = {"type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1", "method": "POST", "path": "/api/items", "raw_path": b"/api/items", "query_string": b"",
                     "headers": [(b"host", b"testserver"), (b"authorization", auth["Authorization"].encode()), (b"content-length", b"500")], "client": ("testclient", 1),
                     "server": ("testserver", 80), "scheme": "http", "root_path": ""}
            await self.app(scope, receive, send)
            return next(m["status"] for m in sent if m["type"] == "http.response.start")
        with patch("server.app.BODY_IDLE_SECONDS", 0.05):
            self.assertEqual(asyncio.run(stalled(5)), 408)
        with patch("server.app.BODY_IDLE_SECONDS", 1), patch("server.app.BODY_SECONDS", 0.2):
            self.assertEqual(asyncio.run(stalled(0.1)), 408, "arriving, but too slowly to ever finish")


class Holds:
    """Makes chosen accounts' exports stop part-way until they are released, while every other account's goes straight through."""

    def __init__(self):
        from server.storage import Store
        self.real, self.pairs = Store.export_items, {}

    def add(self, user):
        self.pairs[user] = (Event(), Event())
        return self.pairs[user]

    def patched(self):
        def slow(store, c=None):
            pair = self.pairs.get(store.tenant)
            if pair and not pair[1].is_set():
                pair[0].set()
                if not pair[1].wait(20):
                    raise AssertionError("never released")
            return self.real(store, c)
        return patch("server.storage.Store.export_items", slow)


class ConcurrencyTests(HostedLimitCase):
    settings = {"hosted_heavy_per_account": 1, "hosted_heavy_overall": 2}

    def start(self, auth, results):
        def run():
            try:
                with TestClient(self.app) as client:
                    results.append(client.get("/api/export", headers=auth).status_code)
            except BaseException as error:  # a failure in the thread must show up in the test, not vanish with it
                results.append(repr(error))
        thread = Thread(target=run, daemon=True)
        thread.start()
        return thread

    def test_one_account_cannot_run_more_than_its_share_and_the_place_is_given_back(self):
        (alice, a), (bob, b) = self.account(), self.account()
        holds = Holds()
        entered, release = holds.add(alice)
        results = []
        with holds.patched():
            first = self.start(a, results)
            self.assertTrue(entered.wait(10))
            refused = self.client.get("/api/export", headers=a)
            self.assertEqual((refused.status_code, refused.json()["code"], refused.json()["scope"]), (429, "too_many_concurrent", "account"))
            self.assertEqual(refused.headers["retry-after"], "2")
            self.assertEqual(self.client.get("/api/backup", headers=a).status_code, 429, "exports and backups share the account's place")
            self.assertEqual(self.client.post("/api/imports/file?filename=x.csv", content=b"url\nhttps://example.com/x\n", headers=a).status_code, 429, "and so do imports")
            self.assertEqual(self.client.get("/api/export", headers=b).status_code, 200, "another account has its own place, and its own library lock")
            release.set()
            first.join(10)
        self.assertEqual(results, [200])
        self.assertEqual(self.app.state.limits.gates["heavy"].counts(), (0, {}), "every place was given back")
        self.assertEqual(self.client.get("/api/export", headers=a).status_code, 200)

    def test_the_service_as_a_whole_says_it_is_busy(self):
        (alice, a), (bob, b), (carol, c) = self.account(), self.account(), self.account()
        holds = Holds()
        (entered_a, release_a), (entered_b, release_b) = holds.add(alice), holds.add(bob)
        results = []
        with holds.patched():
            first, second = self.start(a, results), self.start(b, results)
            self.assertTrue(entered_a.wait(10) and entered_b.wait(10))
            busy = self.client.get("/api/export", headers=c)
            self.assertEqual((busy.status_code, busy.json()["code"]), (503, "server_busy"))
            self.assertEqual(busy.headers["retry-after"], "5")
            self.assertEqual(self.client.get("/api/items", headers=c).status_code, 200, "requests that are not expensive are not turned away")
            release_a.set(), release_b.set()
            first.join(10), second.join(10)
        self.assertEqual(sorted(results), [200, 200])
        self.assertEqual(self.client.get("/api/export", headers=c).status_code, 200)

    def test_a_request_that_fails_gives_its_place_back(self):
        user, auth = self.account()
        with patch("server.storage.Store.export_items", side_effect=RuntimeError("boom")), TestClient(self.app, raise_server_exceptions=False) as quiet:
            self.assertEqual(quiet.get("/api/export", headers=auth).status_code, 500)
            self.assertEqual(quiet.get("/api/export", headers=auth).status_code, 500, "the second is a failure of its own, not a refusal for want of a place")
        self.assertEqual(self.app.state.limits.gates["heavy"].counts(), (0, {}))

    def test_page_reading_by_the_server_has_its_own_small_cap(self):
        user, auth = self.account()
        item = self.client.post("/api/items", json={"url": "https://example.com/p"}, headers=auth).json()["id"]
        gates = self.app.state.limits.gates["fetch"]
        held = [gates.enter(user)[0], gates.enter(user)[0]]
        refused = self.client.post(f"/api/items/{item}/page", json={"fetch": True}, headers=auth)
        self.assertEqual((refused.status_code, refused.json()["code"]), (429, "too_many_concurrent"))
        for leave in held:
            leave()
        self.assertEqual(self.client.post(f"/api/items/{item}/page", json={"extraction": {"title": "Fine"}}, headers=auth).status_code, 200)


class SelfHostedIsUntouchedTests(unittest.TestCase):
    def test_a_self_hosted_server_has_no_request_limits(self):
        from server.app import create_app
        from server.config import Config
        with tempfile.TemporaryDirectory() as folder:
            app = create_app(Config(data_dir=Path(folder) / "data", admin_password="a-self-hosted-owner-password", public_url="http://testserver", testing=True, device_token_idle_days=0))
            self.assertIsNone(app.state.limits)
            self.assertIsNone(app.state.meters)
            with TestClient(app) as client:
                self.assertTrue(all(client.get("/api/discovery").status_code == 200 for _ in range(1500)))


class BodyBeforeCredentialsTests(unittest.TestCase):
    """A self-hosted server also does not hold megabytes in memory for a request that carries nothing that could be a credential."""

    def setUp(self):
        from server.app import create_app
        from server.config import Config
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        app = create_app(Config(data_dir=Path(self.folder.name) / "data", admin_password="a-self-hosted-owner-password", public_url="http://testserver", testing=True))
        self.client = TestClient(app)
        self.client.__enter__()
        self.addCleanup(self.client.__exit__, None, None, None)

    def test_without_a_credential_only_a_form_sized_body_is_taken(self):
        body = b"url\n" + b"https://example.com/x\n" * 20_000  # about 440 KB
        self.assertEqual(self.client.post("/api/imports/file?filename=big.csv", content=body).status_code, 413)
        self.assertEqual(self.client.post("/api/imports/file?filename=small.csv", content=b"url\nhttps://example.com/x\n").status_code, 401)
        self.assertEqual(self.client.post("/api/imports/file?filename=big.csv", content=body, headers={"Authorization": "Bearer lad_not-a-real-token"}).status_code, 401,
                         "a request that names a credential is judged by it; the body limit then is the route's own")
        self.assertEqual(self.client.post("/api/items", content=b"x" * 9000, headers={"Content-Type": "application/json"}).status_code, 413)


if __name__ == "__main__":
    unittest.main()
