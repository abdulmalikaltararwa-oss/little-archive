"""Per-account metering of AI work on a hosted service: daily and monthly allowances for suggestions, the monthly deep-read
allowance, refunds when work fails or is cancelled, and the answers an app can show.

The model and the transcriber are test doubles. Time is a test clock handed to the entitlement store.
"""
from datetime import datetime, timedelta, timezone
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch
from uuid import uuid4

from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent))
from support_hosted import SigningKey, bearer, claims, fake_model, hosted_app, no_worker_threads, offer_closer_reads  # noqa: E402

from server.entitlements import ATTEMPT_FACTOR, MemoryEntitlements, OwnerEntitlements, SQLiteEntitlements, SuggestionLimits, plan_reservation  # noqa: E402
from server.enrich.understanding import ProviderError  # noqa: E402

MODEL = {"ollama_url": "http://127.0.0.1:1", "ollama_model": "synthetic-model"}


class Clock:
    def __init__(self, moment=datetime(2031, 3, 30, 22, 0, tzinfo=timezone.utc)):
        self.moment = moment

    def __call__(self):
        return self.moment

    def advance(self, **delta):
        self.moment += timedelta(**delta)


def implementations(testcase, clock, **limits):
    folder = tempfile.TemporaryDirectory(prefix="little-archive-meters-")
    testcase.addCleanup(folder.cleanup)
    suggestion_limits = SuggestionLimits(**limits)
    yield MemoryEntitlements(clock=clock, suggestion_limits=suggestion_limits)
    yield SQLiteEntitlements(Path(folder.name) / "accounts.sqlite3", clock=clock, suggestion_limits=suggestion_limits)


class PlanningTests(unittest.TestCase):
    def test_what_fits_and_what_stopped_the_rest(self):
        self.assertEqual(plan_reservation(5, (10, 100), {"daily": 0, "monthly": 0, "attempts": 0}), (5, None))
        self.assertEqual(plan_reservation(5, (10, 100), {"daily": 7, "monthly": 0, "attempts": 7}), (3, "daily"))
        self.assertEqual(plan_reservation(5, (10, 100), {"daily": 0, "monthly": 98, "attempts": 0}), (2, "monthly"))
        self.assertEqual(plan_reservation(5, (10, 100), {"daily": 10, "monthly": 100, "attempts": 10}), (0, "daily"))
        self.assertEqual(plan_reservation(5, (10, 100), {"daily": 4, "monthly": 4, "attempts": 10 * ATTEMPT_FACTOR - 1}), (1, "attempts"))
        self.assertEqual(plan_reservation(5, (0, 100), {"daily": 0, "monthly": 0, "attempts": 0}), (0, "not_included"))
        self.assertEqual(plan_reservation(5, (10, 0), {"daily": 0, "monthly": 0, "attempts": 0}), (0, "not_included"))
        self.assertEqual(plan_reservation(0, (10, 100), {"daily": 10, "monthly": 100, "attempts": 30}), (0, None), "asking for nothing is never refused")


class AllowanceTests(unittest.TestCase):
    def test_daily_and_monthly_allowances_for_each_kind_of_account(self):
        clock = Clock()
        for store in implementations(self, clock, free_daily=3, free_monthly=5, unlocked_daily=10, unlocked_monthly=12):
            with self.subTest(store=type(store).__name__):
                clock.moment = datetime(2031, 3, 30, 22, 0, tzinfo=timezone.utc)
                free, paid = str(uuid4()), str(uuid4())
                store.set_unlocked(paid, True, source="synthetic")
                first = store.reserve_suggestions(free, 2)
                self.assertEqual((first.granted, first.blocked), (2, None))
                second = store.reserve_suggestions(free, 4)
                self.assertEqual((second.granted, second.wanted, second.blocked), (1, 4, "daily"), "a request is granted as far as the room goes")
                self.assertEqual(second.suggestions["daily"], {"period": "2031-03-30", "used": 3, "limit": 3, "remaining": 0, "resets_at": "2031-03-31T00:00:00+00:00"})
                self.assertEqual(second.suggestions["monthly"]["resets_at"], "2031-04-01T00:00:00+00:00")
                self.assertEqual(store.reserve_suggestions(free, 1).granted, 0)
                self.assertEqual(store.reserve_suggestions(paid, 100).granted, 10, "an unlocked account has its own, larger, daily limit")
                self.assertEqual(store.reserve_suggestions(paid, 100).granted, 0)
                clock.advance(hours=3)  # past midnight UTC: a new day, the same month
                self.assertEqual(store.suggestions(free)["daily"]["used"], 0)
                third = store.reserve_suggestions(free, 4)
                self.assertEqual((third.granted, third.blocked), (2, "monthly"), "the month had five, three are gone")
                self.assertEqual(store.suggestions(free)["monthly"]["remaining"], 0)
                fourth = store.reserve_suggestions(paid, 100)
                self.assertEqual((fourth.granted, fourth.blocked), (2, "monthly"), "twelve in the month, ten used yesterday")
                clock.advance(days=1)  # April
                self.assertEqual(store.suggestions(free)["monthly"], {"period": "2031-04", "used": 0, "limit": 5, "remaining": 5, "resets_at": "2031-05-01T00:00:00+00:00"})
                self.assertEqual(store.reserve_suggestions(free, 3).granted, 3, "a new month starts every count again")

    def test_an_allowance_of_zero_means_the_unlock_is_what_includes_it(self):
        for store in implementations(self, Clock(), free_daily=0, free_monthly=0, unlocked_daily=5, unlocked_monthly=50):
            with self.subTest(store=type(store).__name__):
                user = str(uuid4())
                reservation = store.reserve_suggestions(user, 3)
                self.assertEqual((reservation.granted, reservation.blocked), (0, "not_included"))
                store.set_unlocked(user, True, source="synthetic")
                self.assertEqual(store.reserve_suggestions(user, 3).granted, 3)

    def test_failed_work_is_given_back_but_not_without_end(self):
        for store in implementations(self, Clock(), free_daily=4, free_monthly=100):
            with self.subTest(store=type(store).__name__):
                user = str(uuid4())
                total = 0
                for attempt in range(40):
                    granted = store.reserve_suggestions(user, 1).granted
                    if not granted:
                        break
                    total += granted
                    store.refund_suggestions(user, 1)  # every one of them fails
                self.assertEqual(total, 4 * ATTEMPT_FACTOR, "failures are refunded from the counts, not from the attempts that stop endless retries")
                self.assertEqual(store.suggestions(user)["daily"]["used"], 0)
                self.assertEqual(store.reserve_suggestions(user, 1).blocked, "attempts")
                self.assertEqual(store.suggestions(user)["monthly"]["used"], 0)

    def test_a_reservation_that_was_never_used_gives_back_the_attempt_too(self):
        for store in implementations(self, Clock(), free_daily=4, free_monthly=100):
            with self.subTest(store=type(store).__name__):
                user = str(uuid4())
                for _ in range(30):  # "analyse everything" over a library that has nothing left to do
                    granted = store.reserve_suggestions(user, 4).granted
                    store.refund_suggestions(user, granted, unspent=True)
                self.assertEqual(store.reserve_suggestions(user, 4).granted, 4, "doing nothing cannot use up what real work needs")

    def test_refunds_never_go_below_zero_and_are_validated(self):
        for store in implementations(self, Clock()):
            with self.subTest(store=type(store).__name__):
                user = str(uuid4())
                store.refund_suggestions(user, 5)
                store.refund_deep_reads(user, 5)
                self.assertEqual(store.suggestions(user)["daily"]["used"], 0)
                self.assertEqual(store.deep_reads(user)["used"], 0)
                for bad in (-1, 1.5, True, "1", None):
                    with self.assertRaises(ValueError, msg=repr(bad)):
                        store.reserve_suggestions(user, bad)
                    with self.assertRaises(ValueError, msg=repr(bad)):
                        store.refund_suggestions(user, bad)

    def test_deep_read_refunds_return_one_to_this_months_count(self):
        for store in implementations(self, Clock()):
            with self.subTest(store=type(store).__name__):
                user = str(uuid4())
                store.set_unlocked(user, True, source="synthetic")
                self.assertTrue(store.consume_deep_reads(user, 3))
                store.refund_deep_reads(user, 1)
                self.assertEqual(store.deep_reads(user)["used"], 2)
                store.refund_deep_reads(user, 9)
                self.assertEqual(store.deep_reads(user)["used"], 0)

    def test_counts_are_stored_under_a_hash_and_survive_a_restart(self):
        with tempfile.TemporaryDirectory() as folder:
            path, user = Path(folder) / "accounts.sqlite3", str(uuid4())
            SQLiteEntitlements(path, clock=Clock()).reserve_suggestions(user, 7)
            again = SQLiteEntitlements(path, clock=Clock())
            self.assertEqual(again.suggestions(user)["daily"]["used"], 7)
            self.assertEqual(again.suggestions(str(uuid4()))["daily"]["used"], 0)
            with sqlite3.connect(path) as c:
                dump = "\n".join(c.iterdump())
            self.assertNotIn(user, dump, "usage is counted under a hash of the account, never under its id")
            again.set_unlocked(user, True, source="apple")
            self.assertEqual(again.unlock_source(user), "apple")
            again.forget(user)
            self.assertIsNone(again.unlock_source(user))
            self.assertEqual(again.suggestions(user)["daily"]["used"], 7, "deleting an account does not refill the day")

    def test_a_self_hosted_owner_is_never_metered(self):
        owner = OwnerEntitlements()
        reservation = owner.reserve_suggestions(None, 10_000)
        self.assertEqual((reservation.granted, reservation.blocked), (10_000, None))
        self.assertIsNone(owner.suggestions(None)["daily"]["limit"])
        self.assertEqual(owner.unlock_source(None), "owner")


class HostedMeterCase(unittest.TestCase):
    settings = {**MODEL, "hosted_suggestions_daily_free": 3, "hosted_suggestions_monthly_free": 5,
                "hosted_suggestions_daily_unlocked": 6, "hosted_suggestions_monthly_unlocked": 8,
                "hosted_deep_reads_monthly": 3, "hosted_free_deep_reads_monthly": 0}

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="little-archive-hosted-meters-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.enterContext(no_worker_threads())
        self.key = SigningKey()
        self.app, _ = hosted_app(self.root, self.key, accounts_allow_ai=True, **self.settings)
        self.clock = Clock()
        self.app.state.entitlements.clock = self.clock
        self.client = TestClient(self.app)
        self.client.__enter__()
        self.addCleanup(self.client.__exit__, None, None, None)
        self.libraries, self.entitlements = self.app.state.libraries, self.app.state.entitlements

    def account(self):
        user = str(uuid4())
        return user, bearer(self.key.sign(claims(user)))

    def items(self, auth, count, name="item"):
        return [self.client.post("/api/items", json={"url": f"https://example.com/{name}/{n}", "title": f"{name} {n}", "caption": "Text to classify."}, headers=auth).json()["id"] for n in range(count)]

    def queue(self, auth, ids):
        return self.client.post("/api/ai/jobs", json={"ids": ids}, headers=auth)

    def used(self, auth):
        entitlements = self.client.get("/api/account", headers=auth).json()["entitlements"]
        return entitlements["suggestions"]["daily"]["used"], entitlements["suggestions"]["monthly"]["used"], entitlements["deep_reads"]["used"]

    def drain(self, model=None):
        seen = []
        with (model or fake_model(seen)):
            while self.app.state.worker.step():
                pass
        return seen


class SuggestionAllowanceTests(HostedMeterCase):
    def test_a_free_account_is_cut_short_then_refused_with_what_an_app_needs_to_say_so(self):
        user, auth = self.account()
        ids = self.items(auth, 5)
        partly = self.queue(auth, ids)
        self.assertEqual(partly.status_code, 200, partly.text)
        body = partly.json()
        self.assertEqual((body["queued"], body["matched"], body["skipped"], body["unchanged"]), (3, 5, 2, 0))
        self.assertEqual(body["limit"]["scope"], "daily")
        self.assertEqual((body["limit"]["used"], body["limit"]["limit"], body["limit"]["remaining"]), (3, 3, 0))
        self.assertEqual(body["limit"]["resets_at"], "2031-03-31T00:00:00+00:00")
        self.assertEqual(self.client.get("/api/ai/jobs", headers=auth).json()["counts"]["queued"], 3)
        refused = self.queue(auth, ids[3:])
        self.assertEqual(refused.status_code, 429)
        answer = refused.json()
        self.assertEqual(answer["code"], "suggestions_daily_limit")
        self.assertIn("3 of 3", answer["detail"])
        self.assertEqual(answer["limit"]["scope"], "daily")
        self.assertEqual(refused.headers["retry-after"], str(2 * 3600), "two hours until midnight UTC on the test clock")
        self.assertEqual(self.client.get("/api/ai/jobs", headers=auth).json()["counts"]["queued"], 3, "a refused request queues nothing")
        self.clock.advance(hours=3)
        again = self.queue(auth, ids[3:])
        self.assertEqual((again.status_code, again.json()["queued"]), (200, 2), "tomorrow they are available again")
        self.assertEqual(self.used(auth)[:2], (2, 5))
        monthly = self.queue(auth, self.items(auth, 1, "more"))
        self.assertEqual((monthly.status_code, monthly.json()["code"]), (429, "suggestions_monthly_limit"))
        self.assertEqual(monthly.json()["limit"]["resets_at"], "2031-04-01T00:00:00+00:00")
        self.assertIn("2031-04-01", monthly.json()["detail"])

    def test_items_that_already_have_a_suggestion_cost_nothing(self):
        user, auth = self.account()
        ids = self.items(auth, 3)
        self.assertEqual(self.queue(auth, ids).json()["queued"], 3)
        for _ in range(10):
            again = self.queue(auth, ids)
            self.assertEqual((again.status_code, again.json()), (200, {"queued": 0, "matched": 3, "unchanged": 3}), "asking again for the same items is not an attempt")
        self.assertEqual(self.used(auth)[:2], (3, 3))
        self.drain()
        self.assertEqual(self.client.get("/api/ai/jobs", headers=auth).json()["counts"]["completed"], 3)
        self.assertEqual(self.queue(auth, ids).status_code, 200, "finished work is not charged again either")
        self.assertEqual(self.used(auth)[:2], (3, 3))

    def test_a_free_tier_with_no_suggestions_says_it_is_part_of_the_unlock(self):
        self.app.state.entitlements.suggestion_limits = SuggestionLimits(0, 0, 6, 8)
        user, auth = self.account()
        ids = self.items(auth, 2)
        refused = self.queue(auth, ids)
        self.assertEqual(refused.status_code, 402)
        self.assertEqual((refused.json()["code"], refused.json()["feature"]), ("unlock_required", "suggestions"))
        self.assertNotIn("retry-after", refused.headers)
        self.entitlements.set_unlocked(user, True, source="synthetic")
        self.assertEqual(self.queue(auth, ids).json()["queued"], 2)

    def test_unlocking_raises_the_limits_and_the_two_accounts_are_counted_apart(self):
        (alice, a), (bob, b) = self.account(), self.account()
        self.entitlements.set_unlocked(bob, True, source="synthetic")
        mine, his = self.items(a, 8, "alice"), self.items(b, 8, "bob")
        self.assertEqual(self.queue(a, mine).json()["queued"], 3)
        self.assertEqual(self.queue(b, his).json()["queued"], 6)
        self.assertEqual(self.client.get("/api/account", headers=b).json()["entitlements"]["suggestions"]["monthly"]["limit"], 8)
        self.assertEqual(self.client.get("/api/account", headers=a).json()["entitlements"]["suggestions"]["monthly"]["limit"], 5)
        self.assertEqual(self.used(a)[:2], (3, 3))

    def test_a_job_that_fails_gives_its_suggestion_back(self):
        user, auth = self.account()
        ids = self.items(auth, 3)
        self.queue(auth, ids)
        self.assertEqual(self.used(auth)[:2], (3, 3))
        self.drain(patch("server.enrich.understanding.OllamaProvider.analyze", autospec=True, side_effect=ProviderError("The model is down.")))
        self.assertEqual(self.client.get("/api/ai/jobs", headers=auth).json()["counts"]["failed"], 3)
        self.assertEqual(self.used(auth)[:2], (0, 0), "nothing was produced, so nothing was spent")
        self.assertEqual(self.queue(auth, ids).json()["queued"], 3, "a retry is charged again, and is allowed")
        self.drain()
        self.assertEqual(self.used(auth)[:2], (3, 3), "work that produced a suggestion stays spent")

    def test_failures_cannot_be_repeated_without_end(self):
        user, auth = self.account()
        ids = self.items(auth, 1)
        outcomes = []
        for _ in range(20):
            response = self.queue(auth, ids)
            outcomes.append(response.status_code)
            if response.status_code != 200:
                break
            self.drain(patch("server.enrich.understanding.OllamaProvider.analyze", autospec=True, side_effect=ProviderError("down")))
        self.assertEqual(outcomes.count(200), 3 * ATTEMPT_FACTOR)
        self.assertEqual(outcomes[-1], 429)
        stopped = self.queue(auth, ids)
        self.assertEqual(stopped.json()["code"], "suggestions_attempts_limit")
        self.assertEqual(self.used(auth)[:2], (0, 0))

    def test_cancelling_gives_back_what_was_still_waiting_and_a_closer_read_can_be_asked_for_again(self):
        user, auth = self.account()
        self.entitlements.set_unlocked(user, True, source="synthetic")
        offer_closer_reads(self.libraries.open(user))
        ids = self.items(auth, 4)
        self.queue(auth, ids[:3])
        self.assertEqual(self.client.post(f"/api/items/{ids[3]}/deep-read", headers=auth).json(), {"queued": 1})
        self.assertEqual(self.used(auth), (3, 3, 1))
        self.assertEqual(self.client.get("/api/items/" + ids[3], headers=auth).json()["enrichment"]["deep_read"]["state"], "queued")
        self.assertEqual(self.client.post("/api/ai/jobs/cancel", headers=auth).json(), {"cancelled": 4})
        self.assertEqual(self.used(auth), (0, 0, 0))
        self.assertEqual(self.client.get("/api/items/" + ids[3], headers=auth).json()["enrichment"]["deep_read"]["state"], "", "nothing is left looking as if it is in progress")
        self.assertEqual(self.client.post(f"/api/items/{ids[3]}/deep-read", headers=auth).json(), {"queued": 1})
        self.assertEqual(self.client.post("/api/ai/jobs/cancel", headers=auth).json(), {"cancelled": 1})
        self.assertEqual(self.client.post("/api/ai/jobs/cancel", headers=auth).json(), {"cancelled": 0})
        self.assertEqual(self.used(auth)[2], 0, "and cancelling twice gives back nothing twice")

    def test_a_job_that_had_started_when_it_was_cancelled_is_not_given_back(self):
        user, auth = self.account()
        ids = self.items(auth, 2)
        self.queue(auth, ids)
        library = self.libraries.open(user)
        with library.transaction() as c:
            c.execute("UPDATE ai_jobs SET status='running' WHERE item_id=?", (ids[0],))
        self.assertEqual(self.client.post("/api/ai/jobs/cancel", headers=auth).json(), {"cancelled": 2})
        self.assertEqual(self.used(auth)[:2], (1, 1), "the one that was waiting came back; the one that had started was spent")

    def test_retrying_a_failed_job_is_charged_and_refused_when_the_day_is_used(self):
        user, auth = self.account()
        ids = self.items(auth, 4)
        self.queue(auth, ids[:1])
        self.drain(patch("server.enrich.understanding.OllamaProvider.analyze", autospec=True, side_effect=ProviderError("down")))
        job = self.client.get("/api/ai/jobs", headers=auth).json()["jobs"][0]
        self.assertEqual(self.queue(auth, ids[1:]).json()["queued"], 3)
        refused = self.client.post(f"/api/ai/jobs/{job['id']}/retry", headers=auth)
        self.assertEqual((refused.status_code, refused.json()["code"]), (429, "suggestions_daily_limit"))
        self.drain()
        self.assertEqual(self.client.get("/api/ai/jobs", headers=auth).json()["counts"], {"queued": 0, "running": 0, "completed": 3, "failed": 1, "cancelled": 0})

    def test_the_account_summary_shows_the_allowances(self):
        user, auth = self.account()
        summary = self.client.get("/api/account", headers=auth).json()["entitlements"]
        self.assertEqual(summary["suggestions"]["daily"], {"period": "2031-03-30", "used": 0, "limit": 3, "remaining": 3, "resets_at": "2031-03-31T00:00:00+00:00"})
        self.assertEqual(summary["suggestions"]["monthly"], {"period": "2031-03", "used": 0, "limit": 5, "remaining": 5, "resets_at": "2031-04-01T00:00:00+00:00"})
        self.assertEqual((summary["unlocked"], summary["unlocked_via"]), (False, None))
        self.entitlements.set_unlocked(user, True, source="apple")
        summary = self.client.get("/api/account", headers=auth).json()["entitlements"]
        self.assertEqual((summary["unlocked"], summary["unlocked_via"]), (True, "apple"))
        self.assertEqual(summary["suggestions"]["daily"]["limit"], 6)


class DeepReadRefundTests(HostedMeterCase):
    def setUp(self):
        super().setUp()
        self.user, self.auth = self.account()
        self.entitlements.set_unlocked(self.user, True, source="synthetic")
        self.library = self.libraries.open(self.user)
        offer_closer_reads(self.library)
        self.item = self.items(self.auth, 1)[0]

    def ask(self):
        return self.client.post(f"/api/items/{self.item}/deep-read", headers=self.auth)

    def test_a_closer_read_that_fails_before_it_has_the_words_is_given_back(self):
        self.assertEqual(self.ask().json(), {"queued": 1})
        self.assertEqual(self.used(self.auth)[2], 1)
        self.drain()  # the stand-in has no page to read, so the closer read fails
        item = self.client.get("/api/items/" + self.item, headers=self.auth).json()
        self.assertEqual(item["enrichment"]["deep_read"]["state"], "failed")
        self.assertEqual(self.used(self.auth)[2], 0)
        self.assertEqual(self.ask().json(), {"queued": 1}, "and it may be asked for again")

    def test_a_closer_read_that_produced_the_words_stays_spent_even_if_the_suggestion_after_it_fails(self):
        service = self.library.enrichment
        service.transcribe_item = lambda item, deep: service.set_transcript(item["id"], "Words that were said in the clip.", source="synthetic")
        self.ask()
        self.drain(patch("server.enrich.understanding.OllamaProvider.analyze", autospec=True, side_effect=ProviderError("down")))
        self.assertEqual(self.client.get("/api/ai/jobs", headers=self.auth).json()["counts"]["failed"], 1)
        self.assertEqual(self.client.get("/api/items/" + self.item, headers=self.auth).json()["enrichment"]["transcript"]["chars"], 33)
        self.assertEqual(self.used(self.auth)[2], 1, "the person has the transcript; the read was done")
        self.assertEqual(self.used(self.auth)[:2], (0, 0), "and a deep read is not also a suggestion")

    def test_a_refused_closer_read_charges_nothing_and_says_why(self):
        self.entitlements.set_unlocked(self.user, False)
        refused = self.ask()
        self.assertEqual((refused.status_code, refused.json()["code"], refused.json()["feature"]), (402, "unlock_required", "deep_reads"))
        self.assertEqual(refused.json()["detail"], "Deep reads come with the full unlock.")
        self.entitlements.set_unlocked(self.user, True)
        for number in range(3):
            self.assertEqual(self.client.post(f"/api/items/{self.items(self.auth, 1, f'x{number}')[0]}/deep-read", headers=self.auth).status_code, 200)
        over = self.ask()
        self.assertEqual((over.status_code, over.json()["code"]), (429, "deep_reads_exhausted"))
        self.assertEqual((over.json()["limit"]["scope"], over.json()["limit"]["used"], over.json()["limit"]["limit"]), ("monthly", 3, 3))
        self.assertEqual(over.headers["retry-after"], str(int((datetime(2031, 4, 1, tzinfo=timezone.utc) - self.clock()).total_seconds())))


if __name__ == "__main__":
    unittest.main()
