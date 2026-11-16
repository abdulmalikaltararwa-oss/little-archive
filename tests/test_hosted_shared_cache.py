"""On a multi-account service, the shared cache of public-post results must not tell an account who else saved what,
and a full disk must not be reported as the account's own storage limit.

Everything is synthetic. The model, the page fetcher and the transcriber are test doubles; nothing uses a network.
"""
from collections import namedtuple
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

from server.enrich.cache import HostedCacheView, PublicPostCache  # noqa: E402
from server.enrich.netfetch import FetchResult  # noqa: E402
from server.enrich.urls import classify_url  # noqa: E402

Usage = namedtuple("Usage", "total used free")
MODEL = {"ollama_url": "http://127.0.0.1:1", "ollama_model": "synthetic-model"}
POST = "https://example.com/shared-post"
PAGE = b'<html><head><meta property="og:title" content="A public title"><meta property="og:description" content="Public words about the post"></head></html>'


class CountingFetcher:
    """Answers every page read with the same document, and counts how often the network would have been used."""

    def __init__(self):
        self.calls = 0

    def fetch_html(self, url):
        self.calls += 1
        return FetchResult(url, 200, "text/html", PAGE, 0)

    def fetch_json(self, url):
        raise AssertionError("no oEmbed in this test")

    def fetch_image(self, url, max_bytes=0):
        raise AssertionError("no cover in this test")


class SharedCacheCase(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="little-archive-sharedcache-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.enterContext(no_worker_threads())
        self.shared = self.root / "shared-cache.sqlite3"
        environment = {"LA_PUBLIC_CACHE": "true", "LA_PUBLIC_CACHE_PATH": str(self.shared)}
        self.enterContext(patch("server.tenancy.understanding_environment", return_value=environment))
        self.key = SigningKey()
        self.app, _ = hosted_app(self.root, self.key, accounts_allow_ai=True, **MODEL)
        self.client = TestClient(self.app)
        self.client.__enter__()
        self.addCleanup(self.client.__exit__, None, None, None)
        self.libraries, self.entitlements = self.app.state.libraries, self.app.state.entitlements

    def account(self):
        user = str(uuid4())
        return user, bearer(self.key.sign(claims(user)))

    def ok(self, auth, method, path, data=None, **kwargs):
        response = self.client.request(method, path, headers=auth, **({"json": data} if data is not None else {}), **kwargs)
        self.assertEqual(response.status_code, 200, response.text[:300])
        return response

    def save(self, auth, url=POST):
        return self.ok(auth, "POST", "/api/items", {"url": url, "title": "Shared post", "caption": "Words that both accounts saved from one public post."}).json()["id"]

    def drain(self):
        seen = []
        with fake_model(seen):
            while self.app.state.worker.step():
                pass
        return seen


class SharedCacheTests(SharedCacheCase):
    def test_the_cache_is_on_and_each_account_gets_the_hosted_view_of_it(self):
        user, auth = self.account()
        self.ok(auth, "GET", "/api/items")
        service = self.libraries.open(user).enrichment
        self.assertIsInstance(service.cache, HostedCacheView)
        self.assertTrue(self.ok(auth, "GET", "/api/settings").json()["shared_cache_enabled"])

    def test_the_view_never_reads_or_writes_page_details(self):
        inner = PublicPostCache(self.root / "view.sqlite3")
        view = HostedCacheView(inner)
        self.assertFalse(view.put(POST, "extraction", {"title": "t", "usable": True}))
        inner.put(POST, "extraction", {"title": "t", "usable": True})
        self.assertIsNone(view.get(POST, "extraction"))
        self.assertTrue(view.put(POST, "transcript", {"text": "spoken", "language": "en"}))
        self.assertEqual(view.get(POST, "transcript")["text"], "spoken")
        self.assertEqual(inner.stats(), {"extraction": 1, "transcript": 1})

    def test_a_second_account_reading_the_same_post_makes_its_own_request(self):
        (alice, a), (bob, b) = self.account(), self.account()
        fetchers = {}
        for user, auth in ((alice, a), (bob, b)):
            item = self.save(auth)
            library = self.libraries.open(user)
            fetchers[user] = CountingFetcher()
            library.enrichment.configure(fetcher=fetchers[user])
            library.enrichment.update_settings(fetch_enabled=True)
            self.ok(auth, "POST", f"/api/items/{item}/page", {"fetch": True})
        self.assertEqual((fetchers[alice].calls, fetchers[bob].calls), (1, 1), "an instant answer would have told Bob that Alice had saved it")
        with sqlite3.connect(self.shared) as c:
            self.assertEqual(c.execute("SELECT count(*) FROM public_posts WHERE kind='extraction'").fetchone()[0], 0, "page details are not stored in the shared file at all")

    def test_what_one_account_can_read_back_is_the_same_whether_or_not_another_account_did_the_work(self):
        (alice, a), (bob, b) = self.account(), self.account()
        self.ok(a, "POST", "/api/ai/jobs", {"ids": [self.save(a)]})
        seen = self.drain()
        self.assertEqual(len(seen), 1, "the model was asked once")
        self.ok(b, "POST", "/api/ai/jobs", {"ids": [self.save(b)]})
        seen = self.drain()
        self.assertEqual(seen, [], "Bob's suggestion came from the shared cache: the model was not asked again")
        first, second = self.ok(a, "GET", "/api/enrichment/usage").json(), self.ok(b, "GET", "/api/enrichment/usage").json()
        self.assertEqual(second, first, "the counters cannot tell a hit from a miss")
        self.assertEqual((second["cache_hits"], second["model_calls"], second["input_tokens"], second["bytes_fetched"]), (0, 1, 0, 0))
        title = lambda auth: self.ok(auth, "GET", "/api/items").json()["items"][0]["ai"]["suggested_title"]
        self.assertEqual(title(a), title(b), "and the shared answer itself is the point of the cache")
        with sqlite3.connect(self.root / "data" / "users" / bob / "library.sqlite3") as c:
            self.assertEqual(c.execute("SELECT count(*) FROM enrich_usage WHERE cache_hit=1").fetchone()[0], 0, "not even the stored rows say 'cache'")

    def test_a_transcript_that_came_from_the_cache_does_not_say_so(self):
        (alice, a), (bob, b) = self.account(), self.account()
        item = self.save(b)
        library = self.libraries.open(bob)
        offer_closer_reads(library)
        self.entitlements.set_unlocked(bob, True, source="synthetic-purchase")
        library.enrichment.cache.put(classify_url(POST).canonical, "transcript", {"text": "Words somebody else already had transcribed.", "language": "en", "seconds": 12.0, "provider": "synthetic", "model": "m"})
        self.ok(b, "POST", f"/api/items/{item}/deep-read")
        self.drain()
        shown = self.ok(b, "GET", "/api/items/" + item).json()["enrichment"]["transcript"]
        self.assertEqual(shown["source"], "synthetic", "named after this server's transcriber, as for any transcript it made")
        self.assertNotEqual(shown["source"], "cache")
        self.assertEqual(shown["chars"], len("Words somebody else already had transcribed."))
        with sqlite3.connect(self.root / "data" / "users" / bob / "library.sqlite3") as c:
            self.assertEqual(c.execute("SELECT transcript_source FROM item_enrichment WHERE item_id=?", (item,)).fetchone()[0], "cache", "the hook, not the data, is what hides it")


class FullDiskTests(SharedCacheCase):
    def full(self):
        error = sqlite3.OperationalError("database or disk is full")
        error.sqlite_errorcode = sqlite3.SQLITE_FULL
        return error

    def disk_with(self, free):
        """The volume as the server sees it, with this many bytes free."""
        return patch("server.storage.shutil.disk_usage", return_value=Usage(10**12, 10**12 - free, free))

    def test_a_full_disk_is_not_reported_as_the_accounts_storage_limit(self):
        user, auth = self.account()
        self.save(auth, "https://example.com/before")
        with patch("server.storage.Store.apply_item", side_effect=self.full()), self.disk_with(0), self.assertLogs("little_archive", "ERROR") as logged:
            refused = self.client.post("/api/items", json={"url": "https://example.com/secret-path?token=abc", "title": "A private title"}, headers=auth)
        self.assertEqual(refused.status_code, 503)
        self.assertEqual(refused.headers["retry-after"], "300")
        self.assertNotIn("storage limit", refused.json()["detail"])
        self.assertNotIn("Delete items", refused.json()["detail"], "deleting items would not help, so it is not suggested")
        text = " ".join(logged.output)
        self.assertIn("no room left", text)
        for private in (user, "secret-path", "A private title", "abc"):
            self.assertNotIn(private, text, "the operator is told the disk is full, not whose request it was")
        self.assertEqual(self.ok(auth, "GET", "/api/items").json()["total"], 1, "nothing was half-written")

    def test_reaching_the_accounts_own_ceiling_is_still_a_507_that_says_what_to_do(self):
        user, auth = self.account()
        self.save(auth)
        with patch("server.storage.Store.apply_item", side_effect=self.full()), self.disk_with(50 * 1024**3):
            refused = self.client.post("/api/items", json={"url": "https://example.com/more"}, headers=auth)
        self.assertEqual(refused.status_code, 507)
        self.assertIn("storage limit", refused.json()["detail"])

    def test_how_much_room_is_judged_from_the_volume_and_not_from_the_error(self):
        user, auth = self.account()
        self.save(auth)
        store = self.libraries.open(user)
        for free, full in ((0, True), (1024 * 1024 - 1, True), (1024 * 1024, False), (10 * 1024**3, False)):
            with self.disk_with(free):
                self.assertEqual(store.disk_is_full(), full, free)
        with patch("server.storage.shutil.disk_usage", side_effect=OSError("gone")):
            self.assertFalse(store.disk_is_full(), "an unreadable volume is not evidence of a full one")

    def test_other_database_errors_are_not_mistaken_for_either(self):
        user, auth = self.account()
        locked = sqlite3.OperationalError("database is locked")
        locked.sqlite_errorcode = sqlite3.SQLITE_BUSY
        with patch("server.storage.Store.apply_item", side_effect=locked), TestClient(self.app, raise_server_exceptions=False) as quiet:
            self.assertEqual(quiet.post("/api/items", json={"url": "https://example.com/x"}, headers=auth).status_code, 500)


if __name__ == "__main__":
    unittest.main()
