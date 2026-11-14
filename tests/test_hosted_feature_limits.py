"""Caps on what recipe cards, places and ask-your-archive can spend on a hosted service, and the storage a guided import stages.

Model calls and geocoder requests made for those features are charged to the account through the same mechanism as ordinary
suggestions (a daily and a monthly allowance, refunds for failures, 402/429 answers with a `code` and a `limit`). The model and
the geocoder are test doubles; nothing touches a network.
"""
from datetime import datetime, timedelta, timezone
from pathlib import Path
import sqlite3
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
from support_features import Hosted, SelfHosted, StubProvider  # noqa: E402
from test_feature_places import BAKERY, FakeGeocoderWorld  # noqa: E402

from server.enrich.understanding import ProviderError  # noqa: E402
from server.entitlements import FEATURE_LIMITS, MemoryEntitlements, SQLiteEntitlements, SuggestionLimits  # noqa: E402

RECIPE_TEXT = "Pancakes. Ingredients: 2 cups flour, 2 eggs, 1 cup milk. Mix everything and fry in a pan until golden."
PLACE_TEXT = "Best bakery in Portville: Harbour Bakery on Quay Street."
EMPTY = {"is_recipe": False, "reason": "none", "ingredients": [], "steps": []}


def model(system, user):
    """A model that finds nothing, in the shape each feature asks for."""
    if system.startswith("You list the real-world places"):
        return {"places": []}
    if system.startswith("You answer a question"):
        return {"answerable": False, "answer": "", "citations": []}
    return EMPTY


class Clock:
    def __init__(self, moment=datetime(2031, 3, 30, 22, 0, tzinfo=timezone.utc)):
        self.moment = moment

    def __call__(self):
        return self.moment


class FamilyTests(unittest.TestCase):
    def stores(self):
        import tempfile
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        clock = Clock()
        kwargs = {"suggestion_limits": SuggestionLimits(25, 300, 200, 3000), "feature_limits": SuggestionLimits(2, 4, 3, 5)}
        return clock, (MemoryEntitlements(clock=clock, **kwargs), SQLiteEntitlements(Path(folder.name) / "accounts.sqlite3", clock=clock, **kwargs))

    def test_the_two_families_are_counted_apart_with_limits_of_their_own(self):
        clock, stores = self.stores()
        for store in stores:
            with self.subTest(store=type(store).__name__):
                user = "user-" + type(store).__name__
                self.assertEqual(store.reserve_suggestions(user, 10).granted, 10)
                free = store.reserve_feature_calls(user, 5)
                self.assertEqual((free.granted, free.blocked), (2, "daily"), "feature calls have their own, smaller, limit and are not touched by suggestions")
                self.assertEqual(store.suggestions(user)["daily"]["used"], 10)
                self.assertEqual(store.feature_calls(user)["daily"], {"period": "2031-03-30", "used": 2, "limit": 2, "remaining": 0, "resets_at": "2031-03-31T00:00:00+00:00"})
                store.set_unlocked(user, True, source="synthetic")
                self.assertEqual(store.reserve_feature_calls(user, 5).granted, 1, "unlocked: three a day, two used")
                store.refund_feature_calls(user, 2)
                self.assertEqual(store.feature_calls(user)["daily"]["used"], 1)
                self.assertEqual(store.suggestions(user)["daily"]["used"], 10, "a feature refund does not touch suggestions")
                clock.moment += timedelta(hours=3)
                self.assertEqual(store.feature_calls(user)["daily"]["used"], 0)
                self.assertEqual(store.reserve_feature_calls(user, 9).blocked, "daily")
                self.assertEqual(store.feature_calls(user)["monthly"]["used"], 4)
                clock.moment -= timedelta(hours=3)

    def test_failures_do_not_give_the_attempt_back_and_a_reservation_never_used_does(self):
        clock, stores = self.stores()
        for store in stores:
            user = "u-" + type(store).__name__
            store.set_unlocked(user, True, source="synthetic")
            total = 0
            for _ in range(40):
                if not store.reserve_feature_calls(user, 1).granted:
                    break
                total += 1
                store.refund_feature_calls(user, 1)
            self.assertEqual(total, 3 * 3, "attempts stop at three times the daily limit however many fail")
            other = "o-" + type(store).__name__
            store.set_unlocked(other, True, source="synthetic")
            for _ in range(20):
                store.refund_feature_calls(other, store.reserve_feature_calls(other, 3).granted, unspent=True)
            self.assertEqual(store.reserve_feature_calls(other, 3).granted, 3)

    def test_the_defaults_make_the_features_part_of_the_unlock(self):
        self.assertEqual((FEATURE_LIMITS.free_daily, FEATURE_LIMITS.free_monthly, FEATURE_LIMITS.unlocked_daily, FEATURE_LIMITS.unlocked_monthly), (0, 0, 100, 1500))


class FeatureLimitCase(unittest.TestCase):
    settings = {"hosted_feature_calls_daily_unlocked": 3, "hosted_feature_calls_monthly_unlocked": 4}

    def setUp(self):
        self.h = Hosted(**self.settings)
        self.addCleanup(self.h.close)
        self.clock = Clock()
        self.h.app.state.entitlements.clock = self.clock
        self.a = self.h.account()
        self.item = self.a.add_item("https://example.com/pancakes", title="Pancakes", caption=RECIPE_TEXT)
        self.place = self.a.add_item("https://example.com/bakery", title="Bakery", caption=PLACE_TEXT)

    def calls(self, account=None):
        account = account or self.a
        return account.ok("GET", "/api/account")["entitlements"]["feature_calls"]

    def extract_recipe(self, account=None, item=None, **body):
        account = account or self.a
        return account.call("POST", f"/api/items/{item or self.item}/recipe/extract", json={"method": "ai", "force": True, **body})

    def extract_places(self, account=None, item=None, **body):
        account = account or self.a
        return account.call("POST", f"/api/items/{item or self.place}/places/extract", json={"method": "ai", "force": True, **body})

    def ask(self, account=None):
        return (account or self.a).call("POST", "/api/ask", json={"question": "Which pancakes did I save?"})


class ModelCallCapTests(FeatureLimitCase):
    def test_every_model_call_for_any_feature_comes_out_of_one_allowance(self):
        provider = self.a.use(StubProvider(model))
        self.assertEqual(self.extract_recipe().status_code, 200)
        self.assertEqual(self.extract_places().status_code, 200)
        self.assertEqual(self.ask().status_code, 200)
        self.assertEqual(len(provider.calls), 3)
        self.assertEqual((self.calls()["daily"]["used"], self.calls()["monthly"]["used"]), (3, 3))
        refused = self.ask()
        body = refused.json()
        self.assertEqual((refused.status_code, body["code"]), (429, "feature_calls_daily_limit"))
        self.assertIn("3 of 3", body["detail"])
        self.assertEqual((body["limit"]["scope"], body["limit"]["used"], body["limit"]["limit"], body["limit"]["resets_at"]), ("daily", 3, 3, "2031-03-31T00:00:00+00:00"))
        self.assertEqual(refused.headers["retry-after"], str(2 * 3600))
        self.assertEqual(len(provider.calls), 3, "a refused request never reached the model")
        for call in (self.extract_recipe, self.extract_places):
            self.assertEqual(call().json()["code"], "feature_calls_daily_limit")
        self.clock.moment += timedelta(hours=3)
        self.assertEqual(self.ask().status_code, 200, "tomorrow there is room again")
        monthly = self.ask()
        self.assertEqual((monthly.status_code, monthly.json()["code"]), (429, "feature_calls_monthly_limit"))
        self.assertEqual(monthly.json()["limit"]["resets_at"], "2031-04-01T00:00:00+00:00")

    def test_what_costs_nothing_is_not_charged(self):
        provider = self.a.use(StubProvider(model))
        for _ in range(6):
            self.assertEqual(self.extract_recipe(method="rules").status_code, 200)
            self.assertEqual(self.extract_places(method="rules").status_code, 200)
            self.a.ok("GET", f"/api/items/{self.item}/recipe")
            self.a.ok("GET", f"/api/items/{self.place}/places")
            self.a.ok("GET", "/api/places")
            self.a.ok("GET", "/api/recipes")
        self.assertEqual(provider.calls, [])
        self.assertEqual(self.calls()["daily"]["used"], 0, "reading, editing and extraction by rules or page data are free")

    def test_without_a_model_nothing_is_called_so_nothing_is_charged(self):
        answer = self.ask()
        self.assertEqual(answer.status_code, 200)
        self.assertEqual(self.calls()["daily"]["used"], 0)
        self.assertEqual(self.extract_recipe().json()["code"], "ai_not_configured", "and the refusal is the one it always was")

    def test_a_call_that_fails_or_answers_nonsense_is_given_back(self):
        provider = self.a.use(StubProvider([ProviderError("The model is down.", retryable=True), "not a json object", ProviderError("down again"), EMPTY]))
        for expect in ("ai_failed", "ai_invalid"):
            refused = self.extract_recipe()
            self.assertEqual((refused.status_code, refused.json()["code"]), (502, expect))
            self.assertEqual(self.calls()["daily"]["used"], 0, "nothing was produced, so nothing was spent")
        self.assertEqual(self.extract_places().status_code, 502)
        self.assertEqual(self.calls()["daily"]["used"], 0)
        self.assertEqual(self.extract_recipe().status_code, 200)
        self.assertEqual(self.calls()["daily"]["used"], 1)
        self.assertEqual(len(provider.calls), 4)

    def test_an_unexpected_failure_in_the_provider_is_given_back_too(self):
        self.a.use(StubProvider([RuntimeError("something unforeseen")]))
        from fastapi.testclient import TestClient
        with TestClient(self.h.app, raise_server_exceptions=False) as quiet:
            answer = quiet.post(f"/api/items/{self.item}/recipe/extract", json={"method": "ai", "force": True}, headers=self.a.headers)
        self.assertEqual(answer.status_code, 500)
        self.assertEqual(self.calls()["daily"]["used"], 0)

    def test_failures_cannot_be_repeated_without_end(self):
        self.a.use(StubProvider(lambda system, user: ProviderError("down")))
        statuses = []
        for _ in range(20):
            response = self.extract_recipe()
            statuses.append(response.status_code)
            if response.status_code == 429:
                break
        self.assertEqual(statuses.count(502), 9)
        self.assertEqual(response.json()["code"], "feature_calls_attempts_limit")

    def test_each_account_has_its_own_allowance_and_a_free_one_is_locked_out(self):
        other = self.h.account()
        other_item = other.add_item("https://example.com/other", title="Other", caption=RECIPE_TEXT)
        for account in (self.a, other):
            account.use(StubProvider(model))
        for _ in range(3):
            self.assertEqual(self.extract_recipe().status_code, 200)
        self.assertEqual(self.extract_recipe().status_code, 429)
        self.assertEqual(self.extract_recipe(other, other_item).status_code, 200, "another account is not affected")
        free = self.h.account(unlocked=False)
        locked = free.call("POST", "/api/ask", json={"question": "Anything saved about pancakes?"})
        self.assertEqual((locked.status_code, locked.json()["code"], locked.json()["feature"]), (402, "unlock_required", "ask"))
        self.assertEqual(free.ok("GET", "/api/features")["ask"]["locked"], True)

    def test_an_unlocked_account_with_a_zero_allowance_is_told_the_limit_is_reached_not_to_unlock(self):
        self.h.app.state.entitlements.feature_limits = SuggestionLimits(0, 0, 0, 0)
        self.a.use(StubProvider(model))
        refused = self.ask()
        self.assertEqual((refused.status_code, refused.json()["code"]), (429, "feature_calls_daily_limit"))
        self.assertEqual((refused.json()["limit"]["used"], refused.json()["limit"]["limit"]), (0, 0))


class FreeAllowanceTests(FeatureLimitCase):
    settings = {"hosted_feature_calls_daily_unlocked": 3, "hosted_feature_calls_monthly_unlocked": 4, "hosted_feature_calls_daily_free": 1, "hosted_feature_calls_monthly_free": 2}

    def test_an_operator_who_gives_free_accounts_an_allowance_opens_the_features_to_them_and_caps_it(self):
        free = self.h.account(unlocked=False)
        item = free.add_item("https://example.com/free-pancakes", title="Pancakes", caption=RECIPE_TEXT)
        free.use(StubProvider(model))
        self.assertEqual(free.ok("GET", "/api/features")["recipes"]["locked"], False)
        self.assertEqual(free.call("POST", f"/api/items/{item}/recipe/extract", json={"method": "ai", "force": True}).status_code, 200)
        refused = free.call("POST", f"/api/items/{item}/recipe/extract", json={"method": "ai", "force": True})
        self.assertEqual((refused.status_code, refused.json()["code"]), (429, "feature_calls_daily_limit"))
        self.assertEqual(free.ok("GET", "/api/account")["entitlements"]["feature_calls"]["daily"]["limit"], 1)
        self.assertEqual(self.a.ok("GET", "/api/account")["entitlements"]["feature_calls"]["daily"]["limit"], 3)


class GeocoderCapTests(FeatureLimitCase):
    def setUp(self):
        super().setUp()
        self.world = FakeGeocoderWorld({"Harbour Bakery, 12 Quay Street, Portville, Examplia": BAKERY})
        self.a.service.geocoder = self.world.geocoder()
        self.place_item = self.a.add_item("https://example.com/geo", title="Bakery")
        self.a.ok("PUT", f"/api/items/{self.place_item}/places", json={"places": [{"name": "Harbour Bakery", "kind": "bakery", "address": "12 Quay Street", "city": "Portville", "country": "Examplia"}]})

    def geocode(self):
        return self.a.call("POST", f"/api/items/{self.place_item}/places/geocode", json={})

    def test_a_request_to_the_geocoder_is_charged_and_an_answer_from_its_cache_is_not(self):
        self.assertEqual(self.geocode().status_code, 200)
        self.assertEqual((len(self.world.requests), self.calls()["daily"]["used"]), (1, 1))
        self.a.ok("DELETE", f"/api/items/{self.place_item}/places/edits")
        self.a.ok("PUT", f"/api/items/{self.place_item}/places", json={"places": [{"name": "Harbour Bakery", "kind": "bakery", "address": "12 Quay Street", "city": "Portville", "country": "Examplia"}]})
        self.assertEqual(self.geocode().status_code, 200)
        self.assertEqual((len(self.world.requests), self.calls()["daily"]["used"]), (1, 1), "the second answer came from the cache: no request, no charge")

    def test_a_geocoder_that_fails_gives_the_charge_back_and_a_spent_allowance_stops_the_request(self):
        self.world.status = 503
        self.assertEqual(self.geocode().status_code, 502)
        self.assertEqual(self.calls()["daily"]["used"], 0)
        self.world.status = 200
        self.h.app.state.entitlements.reserve_feature_calls(self.a.user, 3)  # use the day's allowance up by other means
        refused = self.geocode()
        self.assertEqual((refused.status_code, refused.json()["code"]), (429, "feature_calls_daily_limit"))
        self.assertEqual(len(self.world.requests), 1, "the refused request never reached the geocoder (the earlier failure is the one request)")


class GateTests(FeatureLimitCase):
    def test_a_geocoding_request_is_one_at_a_time_per_account_and_the_place_is_given_back(self):
        gates = self.h.app.state.limits.gates["geocode"]
        held = gates.enter(self.a.user)[0]
        refused = self.a.call("POST", f"/api/items/{self.place}/places/geocode", json={})
        self.assertEqual((refused.status_code, refused.json()["code"], refused.json()["scope"]), (429, "too_many_concurrent", "account"))
        self.assertEqual(self.a.call("POST", f"/api/items/{self.place}/places/extract", json={"method": "rules"}).status_code, 429)
        self.assertEqual(self.a.call("POST", f"/api/items/{self.item}/recipe/extract", json={"method": "rules"}).status_code, 200, "recipes have their own place")
        held()
        self.assertEqual(self.a.call("POST", f"/api/items/{self.place}/places/extract", json={"method": "rules"}).status_code, 200)
        self.assertEqual(gates.counts(), (0, {}))

    def test_asking_costs_more_of_the_request_budget_than_a_read(self):
        from server.limits import COSTS, route_class
        self.assertEqual((COSTS[route_class("POST", "/api/ask")], COSTS[route_class("POST", "/api/items/i/recipe/extract")], COSTS[route_class("POST", "/api/imports/archives/r/finish")]), (3, 5, 10))


class StagedImportQuotaTests(unittest.TestCase):
    """A guided import's staged file is the account's data on the service's disk, so it counts toward the storage quota."""
    settings = {"hosted_storage_quota_mb": 1}

    def setUp(self):
        self.h = Hosted(**self.settings)
        self.addCleanup(self.h.close)
        self.a = self.h.account()

    def used(self):
        return self.a.ok("GET", "/api/account")["storage"]["used_bytes"]

    def start(self, size):
        return self.a.call("POST", "/api/imports/archives", json={"platform": "instagram", "filename": "export.zip", "size_bytes": size})

    def test_staged_pieces_count_while_they_exist_and_stop_counting_when_the_import_is_cancelled(self):
        before = self.used()
        created = self.start(600_000)
        self.assertEqual(created.status_code, 200, created.text)
        job = created.json()
        chunk = job["upload"]["chunk_size"]
        self.assertEqual(self.a.call("PUT", f"/api/imports/archives/{job['id']}/chunks/0", content=b"\0" * chunk).status_code, 200)
        self.assertEqual(self.a.call("PUT", f"/api/imports/archives/{job['id']}/chunks/1", content=b"\0" * chunk).status_code, 200)
        after = self.used()
        self.assertGreaterEqual(after - before, 2 * chunk, "two pieces on disk are two pieces of the account's storage")
        self.assertEqual(self.h.library(self.a).staged_bytes(), 2 * chunk)
        self.assertEqual(self.a.call("DELETE", f"/api/imports/archives/{job['id']}").status_code, 200)
        self.assertEqual(self.h.library(self.a).staged_bytes(), 0)
        self.assertLess(self.used() - before, 4096)

    def test_a_file_that_cannot_fit_is_refused_before_a_piece_is_sent(self):
        refused = self.start(1_100_000)
        body = refused.json()
        self.assertEqual((refused.status_code, body["code"]), (507, "storage_full"))
        self.assertIn("Delete items", body["detail"])
        self.assertEqual(self.a.ok("GET", "/api/imports/archives")["imports"], [], "nothing was started")

    def test_pieces_stop_being_taken_when_the_account_is_full(self):
        job = self.start(700_000).json()
        chunk = job["upload"]["chunk_size"]
        self.assertEqual(self.a.call("PUT", f"/api/imports/archives/{job['id']}/chunks/0", content=b"\0" * chunk).status_code, 200)
        for number in range(60):  # fill what is left of the quota with notes
            if self.a.call("POST", "/api/items", json={"url": f"https://example.com/fill/{number}", "notes": "word " * 3900}).status_code != 200:
                break
        refused = self.a.call("PUT", f"/api/imports/archives/{job['id']}/chunks/1", content=b"\0" * chunk)
        self.assertEqual(refused.status_code, 507)
        self.assertIn("storage limit", refused.json()["detail"])
        self.assertEqual(self.a.call("DELETE", f"/api/imports/archives/{job['id']}").status_code, 200, "and cancelling still works, which frees the room")
        self.assertEqual(self.h.library(self.a).staged_bytes(), 0)

    def test_the_staged_files_go_with_the_account(self):
        job = self.start(300_000).json()
        self.a.call("PUT", f"/api/imports/archives/{job['id']}/chunks/0", content=b"\0" * job["upload"]["chunk_size"])
        directory = self.h.app.state.libraries.users / self.a.user
        self.assertTrue((directory / "imports").exists())
        self.assertEqual(self.a.call("POST", "/api/account/delete", json={"confirm": "DELETE"}).status_code, 200)
        self.assertFalse(directory.exists())

    def test_a_self_hosted_library_reports_staged_bytes_and_has_no_quota_to_refuse_with(self):
        harness = SelfHosted()
        self.addCleanup(harness.close)
        account = harness.account()
        created = account.call("POST", "/api/imports/archives", json={"platform": "instagram", "filename": "export.zip", "size_bytes": 600_000})
        self.assertEqual(created.status_code, 200)
        self.assertIsNone(account.ok("GET", "/api/account")["storage"]["quota_bytes"])


if __name__ == "__main__":
    unittest.main()
