"""The understanding layer through the real API and database, with fake providers and a fake web.

The worker is driven by hand (claim, then process) so every scenario is deterministic and no
thread, network or model service is involved.
"""
from dataclasses import replace
import io
import json
from pathlib import Path
import secrets
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient
import httpx
from PIL import Image

from server.app import create_app
from server.backups import create_backup, restore_backup
from server.config import Config
from server.enrich.cache import PublicPostCache
from server.enrich.netfetch import SafeFetcher
from server.enrich.transcribe import TranscriptResult
from server.enrich.understanding import AnalysisOutcome, GeminiProvider, ProviderError, ProviderUsage
from server.storage import Store

FIXTURES = Path(__file__).parent / "fixtures" / "pages"
REEL = "https://www.instagram.com/reel/SYNTH0001ab/"
POST_URL = "https://www.instagram.com/p/SYNTH0001ab/"
TIKTOK = "https://www.tiktok.com/@example_cook/video/7000000000000000001"
KEY = "AIza-SYNTHETIC-KEY-NEVER-REAL"
MEDIA_BYTES = b"FAKEVIDEO-BYTES-" * 64


def cover_jpeg():
    out = io.BytesIO()
    Image.new("RGB", (16, 16), "tomato").save(out, format="JPEG")
    return out.getvalue()


class FakeProvider:
    name, model = "gemini", "fake-model"

    def __init__(self, *, hosted=True, max_batch=5):
        self.hosted, self.max_batch, self.calls = hosted, max_batch, []

    def identity(self):
        return {"provider": self.name, "model": self.model}

    def analyze(self, batch):
        self.calls.append(batch)
        outcomes = []
        for index, entry in enumerate(batch):
            result = {"suggested_title": f"Real title {entry.key[:4]}", "summary": "A one or two sentence summary.", "topics": ["sourdough", "baking"],
                      "content_type": "video", "needs_review": True, "category": "Food & Recipes"}
            if entry.collections:
                result["collection"] = ""
            outcomes.append(AnalysisOutcome(entry.key, result=result))
        return outcomes, ProviderUsage(1, 100 * len(batch), 20 * len(batch))


class FakeTranscriber:
    name, model = "groq", "whisper-fake"

    def __init__(self, text="Words spoken in the clip about feeding the starter twice a day", fail=None):
        self.calls, self.text, self.fail = [], text, fail

    def transcribe(self, audio, content_type, *, language=None):
        self.calls.append((len(audio), content_type, language))
        if self.fail:
            raise ProviderError(self.fail)
        return TranscriptResult(self.text, "en", 42.0)


class FakeWeb:
    """Routes by Host header and path. Records every request the fetcher makes."""

    def __init__(self):
        self.requests, self.routes = [], {}
        self.routes[("www.instagram.com", "/p/SYNTH0001ab/")] = ("text/html; charset=utf-8", (FIXTURES / "instagram_reel_current.html").read_bytes())
        self.routes[("instagram.fsynth-1.fna.fbcdn.net", "/o1/v/t16/synthetic/example-clip.mp4")] = ("video/mp4", MEDIA_BYTES)
        self.routes[("scontent.cdninstagram.com", "/v/t51.synthetic/example-cover.jpg")] = ("image/jpeg", cover_jpeg())
        self.routes[("www.tiktok.com", "/oembed")] = ("application/json", (FIXTURES / "tiktok_oembed_current.json").read_bytes())
        self.routes[("www.tiktok.com", "/@example_cook/video/7000000000000000001")] = ("text/html", (FIXTURES / "tiktok_page_shell.html").read_bytes())

    def handler(self, request):
        host = request.headers["host"]
        self.requests.append((host, request.url.path))
        found = self.routes.get((host, request.url.path))
        if not found:
            return httpx.Response(404, text="nothing here")
        return httpx.Response(200, headers={"content-type": found[0]}, content=found[1])

    def count(self, host=None, path=None):
        return sum(1 for h, p in self.requests if (host is None or h == host) and (path is None or p == path))

    def fetcher(self):
        return SafeFetcher(resolver=lambda host, port: ["93.184.216.34"], transport=httpx.MockTransport(self.handler))


class Base(unittest.TestCase):
    def setUp(self):
        self.temporary = TemporaryDirectory(prefix="little-archive-enrich-")
        self.password = secrets.token_urlsafe(32)
        self.config = Config(data_dir=Path(self.temporary.name) / "data", admin_password=self.password, public_url="http://testserver", testing=True,
                             ollama_url="http://127.0.0.1:1", ollama_model="synthetic-model")
        self.no_thread = patch("server.jobs.ClassificationWorker.start")
        self.no_thread.start()
        self.app = create_app(self.config)
        self.client = TestClient(self.app)
        self.client.__enter__()
        login = self.client.post("/api/auth/login", json={"password": self.password})
        self.assertEqual(login.status_code, 200)
        self.headers = {"Origin": "http://testserver", "X-CSRF-Token": login.json()["csrf_token"]}
        self.store = self.app.state.store
        self.service = self.app.state.enrichment
        self.worker = self.app.state.worker
        self.web = FakeWeb()
        self.provider = FakeProvider()
        self.transcriber = FakeTranscriber()

    def tearDown(self):
        self.client.__exit__(None, None, None)
        self.no_thread.stop()
        self.temporary.cleanup()

    # -- helpers -----------------------------------------------------------
    def enable(self, *, fetch=True, provider=True, transcriber=True, **settings):
        parts = {"settings": replace(self.service.settings, fetch_enabled=fetch, **settings)}
        parts["fetcher"] = self.web.fetcher() if fetch else None
        parts["provider"] = self.provider if provider else None
        parts["transcriber"] = self.transcriber if transcriber else None
        self.service.configure(**parts)

    def post(self, path, data=None, **kw):
        return self.client.post(path, json=data, headers=self.headers, **kw)

    def delete(self, path):
        return self.client.delete(path, headers=self.headers)

    def item(self, url=REEL, **extra):
        response = self.post("/api/items", {"url": url, **extra})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def get(self, iid):
        return self.client.get("/api/items/" + iid).json()

    def drain(self):
        while True:
            jobs = self.worker._claim()
            if not jobs:
                return
            self.worker._process(jobs)

    def jobs(self):
        return self.client.get("/api/ai/jobs").json()


class PageTests(Base):
    def test_raw_html_from_the_client_fills_what_is_empty(self):
        item = self.item()
        self.assertEqual(item["title"], "Saved Instagram post")
        html = (FIXTURES / "instagram_reel_current.html").read_text()
        response = self.post(f"/api/items/{item['id']}/page", {"html": html})
        self.assertEqual(response.status_code, 200, response.text)
        saved = response.json()
        self.assertEqual(saved["caption"], "Sourdough starter, day 5: bubbles at last #sourdough #baking")
        self.assertEqual(saved["creator"], "@example_baker")
        self.assertEqual(saved["title"], "Sourdough starter, day 5: bubbles at last")
        self.assertEqual(saved["content_type"], "video")
        self.assertEqual(saved["url"], POST_URL)
        self.assertTrue(saved["preview_url"].startswith("https://scontent.cdninstagram.com/"))
        self.assertIn({"kind": "caption", "text": saved["caption"]}, saved["evidence"])
        self.assertEqual(saved["enrichment"]["page"]["source"], "client_html")
        self.assertTrue(saved["enrichment"]["page"]["has_video"])
        self.assertEqual(self.web.requests, [], "a client-supplied page must not cause any fetching")

    def test_nothing_the_owner_wrote_or_imported_is_overwritten(self):
        item = self.item(title="My own title", caption="My own caption words here", notes="Keep me", tags=["mine"], summary="My summary")
        saved = self.post(f"/api/items/{item['id']}/page", {"html": (FIXTURES / "instagram_reel_current.html").read_text()}).json()
        self.assertEqual((saved["title"], saved["caption"], saved["notes"], saved["summary"], saved["tags"]), ("My own title", "My own caption words here", "Keep me", "My summary", ["mine"]))
        self.assertEqual(saved["creator"], "@example_baker")

    def test_client_extraction_and_oembed_only_paths(self):
        tiktok = self.item(TIKTOK)
        saved = self.post(f"/api/items/{tiktok['id']}/page", {"extraction": {"caption": "Three-ingredient flatbread, no yeast", "creator": "@example_cook", "content_type": "video", "duration_seconds": 38}}).json()
        self.assertEqual((saved["caption"], saved["creator"], saved["content_type"]), ("Three-ingredient flatbread, no yeast", "@example_cook", "video"))
        self.assertEqual(saved["enrichment"]["page"]["source"], "client")
        web = self.item("https://www.youtube.com/watch?v=SYNTHvid001")
        oembed = json.loads((FIXTURES / "youtube_oembed.json").read_text())
        saved = self.post(f"/api/items/{web['id']}/page", {"oembed": oembed}).json()
        self.assertEqual((saved["title"], saved["creator"]), ("Synthetic Walkthrough: Repotting a Monstera (Example Video)", "Example Plant Studio"))

    def test_a_login_wall_or_the_wrong_post_changes_nothing(self):
        item = self.item()
        wall = self.post(f"/api/items/{item['id']}/page", {"html": (FIXTURES / "instagram_login_wall.html").read_text()})
        self.assertEqual(wall.status_code, 422)
        self.assertIn("sign in", wall.json()["detail"])
        other = (FIXTURES / "instagram_reel_current.html").read_text().replace("SYNTH0001ab", "OTHERpost01")
        wrong = self.post(f"/api/items/{item['id']}/page", {"html": other})
        self.assertEqual(wrong.status_code, 422)
        self.assertIn("different post", wrong.json()["detail"])
        wrong_extraction = self.post(f"/api/items/{item['id']}/page", {"extraction": {"caption": "x", "canonical_url": "https://www.instagram.com/p/OTHERpost01/"}})
        self.assertEqual(wrong_extraction.status_code, 422)
        self.assertEqual(self.get(item["id"])["title"], "Saved Instagram post")
        self.assertIsNone(self.get(item["id"])["enrichment"]["page"])

    def test_request_shape_is_validated(self):
        item = self.item()
        url = f"/api/items/{item['id']}/page"
        for body in ({}, {"html": "x", "fetch": True}, {"extraction": {"caption": "x"}, "html": "y"}, {"fetch": True, "extraction": {"caption": "x"}}, {"surprise": 1}, {"extraction": {"caption": "x", "surprise": 1}}, {"oembed": {"pad": "x" * 70000}}):
            with self.subTest(body=str(body)[:50]):
                self.assertEqual(self.post(url, body).status_code, 422)
        self.assertEqual(self.post(url, {"html": "é" * 1_100_000}).status_code, 413)
        self.assertEqual(self.post("/api/items/no-such-item/page", {"extraction": {"caption": "x"}}).status_code, 404)

    def test_auth_and_csrf_are_required(self):
        item = self.item()
        url = f"/api/items/{item['id']}/page"
        with TestClient(self.app) as anonymous:
            self.assertEqual(anonymous.post(url, json={"fetch": True}).status_code, 401)
            self.assertEqual(anonymous.get("/api/enrichment/status").status_code, 401)
            self.assertEqual(anonymous.get("/api/enrichment/usage").status_code, 401)
        self.assertEqual(self.client.post(url, json={"extraction": {"caption": "x"}}).status_code, 403)
        self.assertEqual(self.client.post(f"/api/items/{item['id']}/transcript", json={"text": "x"}).status_code, 403)
        self.assertEqual(self.client.post(f"/api/items/{item['id']}/deep-read").status_code, 403)

    def test_server_side_fetch_is_off_by_default_and_never_reaches_the_network(self):
        item = self.item()
        response = self.post(f"/api/items/{item['id']}/page", {"fetch": True})
        self.assertEqual(response.status_code, 409)
        self.assertIn("turned off", response.json()["detail"])
        self.assertIsNone(self.service.fetcher)
        self.assertFalse(self.client.get("/api/settings").json()["page_fetch_enabled"])

    def test_opt_in_fetch_reads_the_page_and_keeps_a_local_copy_of_the_cover(self):
        self.enable()
        item = self.item()
        saved = self.post(f"/api/items/{item['id']}/page", {"fetch": True})
        self.assertEqual(saved.status_code, 200, saved.text)
        body = saved.json()
        self.assertEqual(body["creator"], "@example_baker")
        self.assertEqual(body["enrichment"]["page"]["source"], "server_fetch")
        self.assertTrue(body["thumbnail_url"].startswith("/api/assets/"))
        cover = self.client.get(body["thumbnail_url"])
        self.assertEqual((cover.status_code, cover.headers["content-type"]), (200, "image/png"))
        self.assertTrue(cover.content.startswith(b"\x89PNG"), "the stored copy is re-encoded, never the downloaded bytes")
        self.assertNotEqual(cover.content, cover_jpeg())
        self.assertEqual(self.web.count(path="/o1/v/t16/synthetic/example-clip.mp4"), 0, "a video is not fetched just to read a page")
        self.assertEqual(self.client.get("/api/enrichment/usage").json()["page_fetches"], 2)

    def test_a_hostile_cover_image_is_dropped_without_failing_the_read(self):
        self.enable()
        self.web.routes[("scontent.cdninstagram.com", "/v/t51.synthetic/example-cover.jpg")] = ("image/jpeg", b"not an image at all")
        item = self.item()
        saved = self.post(f"/api/items/{item['id']}/page", {"fetch": True}).json()
        self.assertIsNone(saved["thumbnail_url"])
        self.assertEqual(saved["creator"], "@example_baker")

    def test_a_refused_destination_never_produces_a_request(self):
        self.enable()
        self.service.fetcher.resolver = lambda host, port: ["10.0.0.7"]
        item = self.item()
        response = self.post(f"/api/items/{item['id']}/page", {"fetch": True})
        self.assertEqual(response.status_code, 502)
        self.assertNotIn("10.0.0.7", response.text)
        self.assertEqual(self.web.requests, [])

    def test_enrichment_is_on_single_reads_only_not_lists_or_exports(self):
        item = self.item()
        self.assertIn("enrichment", self.get(item["id"]))
        self.assertNotIn("enrichment", self.client.get("/api/items").json()["items"][0])
        exported = json.loads(self.client.get("/api/export?format=json").content)
        self.assertNotIn("enrichment", exported["items"][0])


class SharedCacheThroughTheApi(Base):
    def test_the_second_save_of_the_same_public_post_is_not_fetched_or_analysed_again(self):
        cache = PublicPostCache(Path(self.temporary.name) / "cache.sqlite3")
        self.enable(cache_enabled=True)
        self.service.configure(cache=cache)
        first = self.item()
        with self.store.transaction() as c:
            other_id, _ = self.store.apply_item(c, {"url": POST_URL}, account="other-account")
        self.post(f"/api/items/{first['id']}/page", {"fetch": True})
        self.post(f"/api/items/{other_id}/page", {"fetch": True})
        self.assertEqual(self.web.count(host="www.instagram.com"), 1)
        self.post("/api/ai/jobs", {"ids": [first["id"], other_id]})
        self.drain()
        self.assertEqual(len(self.provider.calls), 1)
        self.assertEqual(sum(len(call) for call in self.provider.calls), 1, "one model call for one distinct public text")
        totals = self.client.get("/api/enrichment/usage").json()
        self.assertEqual((totals["model_calls"], totals["cache_hits"]), (1, 2))  # the page read and the analysis
        self.assertEqual(self.get(first["id"])["ai"]["suggested_title"], self.get(other_id)["ai"]["suggested_title"])

    def test_nothing_private_reaches_the_shared_cache_file(self):
        cache = PublicPostCache(Path(self.temporary.name) / "cache.sqlite3")
        self.enable(cache_enabled=True)
        self.service.configure(cache=cache)
        item = self.item(notes="SECRET-NOTE-FROM-OWNER", tags=["secret-tag"])
        self.post("/api/collections", {"name": "SECRET-SHELF"})
        self.post(f"/api/items/{item['id']}/page", {"fetch": True})
        self.post("/api/ai/jobs", {"ids": [item["id"]]})
        self.drain()
        self.assertEqual(self.jobs()["counts"]["completed"], 1)
        sent = json.dumps([entry.evidence.source for call in self.provider.calls for entry in call])
        self.assertNotIn("SECRET-NOTE", sent)
        raw = (Path(self.temporary.name) / "cache.sqlite3").read_bytes().decode("latin-1")
        for private in ("SECRET-NOTE", "secret-tag", "SECRET-SHELF", item["id"], "suggested_folder"):
            self.assertNotIn(private, raw)


class TranscriptTests(Base):
    def test_client_transcript_is_evidence_and_is_searchable_with_its_location(self):
        item = self.item(title="Starter diary")
        spoken = "Today I feed the levain twice, then wait for the doubling."
        saved = self.post(f"/api/items/{item['id']}/transcript", {"text": spoken, "language": "en", "seconds": 61}).json()
        self.assertIn({"kind": "transcript", "text": spoken}, saved["evidence"])
        self.assertEqual(saved["enrichment"]["transcript"], {"source": "client", "language": "en", "seconds": 61.0, "chars": len(spoken)})
        hits = self.client.get("/api/items", params={"q": "levain"}).json()["items"]
        self.assertEqual([(h["id"], h["match_in"]) for h in hits], [(item["id"], ["transcript"])])
        self.assertEqual(self.client.get("/api/items", params={"q": "doubling levain"}).json()["total"], 1)
        removed = self.delete(f"/api/items/{item['id']}/transcript").json()
        self.assertEqual(removed["evidence"], [])
        self.assertIsNone(removed["enrichment"]["transcript"])
        self.assertEqual(self.client.get("/api/items", params={"q": "levain"}).json()["total"], 0)

    def test_search_says_where_each_word_was_found(self):
        item = self.item(title="Starter diary", caption="Sourdough caption words", notes="Remember the bakery", tags=["fermenting"], summary="Weekly bread plan")
        self.post(f"/api/items/{item['id']}/transcript", {"text": "Spoken about hydration levels"})
        cases = {"diary": ["title"], "caption": ["caption"], "hydration": ["transcript"], "bakery": ["notes"], "fermenting": ["tags"], "weekly": ["summary"], "sourdough hydration": ["caption", "transcript"]}
        for query, where in cases.items():
            with self.subTest(query=query):
                hit = self.client.get("/api/items", params={"q": query}).json()["items"]
                self.assertEqual([h["match_in"] for h in hit], [where])
        self.assertNotIn("match_in", self.client.get("/api/items").json()["items"][0])

    def test_arabic_transcripts_are_found_with_normalised_letters(self):
        item = self.item()
        self.post(f"/api/items/{item['id']}/transcript", {"text": "نضيف الزعتر إلى اللبنة ونحرّك جيدا"})
        hit = self.client.get("/api/items", params={"q": "الى اللبنة"}).json()["items"]
        self.assertEqual([h["match_in"] for h in hit], [["transcript"]])

    def test_a_transcript_survives_a_source_refresh_and_a_portable_round_trip(self):
        item = self.item(caption="First caption")
        self.post(f"/api/items/{item['id']}/transcript", {"text": "Words from the audio track"})
        with self.store.transaction() as c:
            self.store.apply_item(c, {"url": POST_URL, "caption": "Edited caption at the source", "thumbnail_alt": "A loaf"}, account="default")
        refreshed = self.get(item["id"])
        kinds = {e["kind"]: e["text"] for e in refreshed["evidence"]}
        self.assertEqual(kinds["transcript"], "Words from the audio track")
        self.assertEqual(kinds["caption"], "Edited caption at the source")
        exported = self.client.get("/api/export?format=json").content
        with TemporaryDirectory() as other:
            config = Config(data_dir=Path(other), admin_password=self.password, public_url="http://testserver", testing=True)
            other_app = create_app(config)
            with TestClient(other_app) as other_client:
                login = other_client.post("/api/auth/login", json={"password": self.password})
                headers = {"Origin": "http://testserver", "X-CSRF-Token": login.json()["csrf_token"]}
                imported = other_client.post("/api/imports/file?filename=export.json", content=exported, headers=headers)
                self.assertEqual(imported.status_code, 200, imported.text)
                found = other_client.get("/api/items", params={"q": "audio track"}).json()
                self.assertEqual(found["total"], 1)
                self.assertEqual(found["items"][0]["match_in"], ["transcript"])

    def test_validation(self):
        item = self.item()
        url = f"/api/items/{item['id']}/transcript"
        for body in ({}, {"text": ""}, {"text": "x" * 20001}, {"text": "ok", "source": "elsewhere"}, {"text": "ok", "extra": 1}, {"text": "ok", "seconds": -1}):
            with self.subTest(body=str(body)[:40]):
                self.assertEqual(self.post(url, body).status_code, 422)
        self.assertEqual(self.post(url, {"text": "\x00\x07‮"}).status_code, 422)
        self.assertEqual(self.post("/api/items/nope/transcript", {"text": "x"}).status_code, 404)
        self.assertEqual(self.delete("/api/items/nope/transcript").status_code, 404)


class DeepReadTests(Base):
    def test_reports_why_a_closer_read_is_not_possible(self):
        item = self.item()
        for kwargs, reason in (({"transcriber": False}, "transcription_not_configured"), ({"fetch": False}, "page_fetch_disabled")):
            with self.subTest(reason=reason):
                self.enable(**kwargs)
                deep = self.get(item["id"])["enrichment"]["deep_read"]
                self.assertEqual((deep["available"], deep["reason"]), (False, reason))
                response = self.post(f"/api/items/{item['id']}/deep-read")
                self.assertEqual(response.status_code, 409)
        self.enable()
        self.assertTrue(self.get(item["id"])["enrichment"]["deep_read"]["available"])

    def test_deep_read_transcribes_in_memory_then_analyses_from_the_transcript(self):
        self.enable()
        item = self.item(caption="#fyp")
        self.assertEqual(self.post(f"/api/items/{item['id']}/deep-read").json(), {"queued": 1})
        queued = self.jobs()
        self.assertEqual(queued["counts"]["queued"], 1)
        self.assertEqual(self.get(item["id"])["enrichment"]["deep_read"]["state"], "queued")
        self.assertEqual(self.post(f"/api/items/{item['id']}/deep-read").status_code, 409, "asking twice must not queue it twice")
        self.drain()
        done = self.get(item["id"])
        self.assertEqual(self.jobs()["counts"]["completed"], 1)
        self.assertEqual(self.transcriber.calls, [(len(MEDIA_BYTES), "video/mp4", "en")] if False else self.transcriber.calls)
        self.assertEqual(len(self.transcriber.calls), 1)
        self.assertEqual(self.transcriber.calls[0][:2], (len(MEDIA_BYTES), "video/mp4"))
        self.assertEqual(done["enrichment"]["transcript"]["source"], "groq")
        self.assertEqual(done["enrichment"]["deep_read"], {"available": False, "reason": "already_has_transcript", "state": "", "error": ""})
        self.assertEqual(done["ai"]["evidence_level"], "transcript-based")
        self.assertIn("audio was transcribed", done["ai"]["evidence_note"])
        self.assertIn("transcript", done["ai"]["evidence_sources"])
        # The job was re-keyed to the evidence it analysed, so accepting still works.
        self.assertEqual(self.post(f"/api/items/{item['id']}/ai/accept").status_code, 200)
        # The video is never kept: no file in the library holds its bytes.
        for path in Path(self.temporary.name).rglob("*"):
            if path.is_file():
                self.assertNotIn(b"FAKEVIDEO-BYTES", path.read_bytes(), str(path))
        totals = self.client.get("/api/enrichment/usage").json()
        self.assertEqual((totals["transcriptions"], totals["deep_reads"], totals["audio_seconds"], totals["model_calls"]), (1, 1, 42.0, 1))
        self.assertGreater(totals["bytes_fetched"], len(MEDIA_BYTES))

    def test_a_failed_deep_read_says_why_and_does_not_call_the_model(self):
        self.enable()
        item = self.item(TIKTOK)
        self.post(f"/api/items/{item['id']}/deep-read")
        self.drain()
        failed = self.get(item["id"])
        self.assertEqual(failed["enrichment"]["deep_read"]["state"], "failed")
        self.assertIn("device", failed["enrichment"]["deep_read"]["error"])
        job = self.jobs()["jobs"][0]
        self.assertEqual(job["status"], "failed")
        self.assertIn("device", job["error"])
        self.assertEqual((self.provider.calls, self.transcriber.calls), ([], []))
        self.assertTrue(failed["enrichment"]["deep_read"]["available"], "it can be asked for again")

    def test_a_provider_failure_is_reported_without_leaking_anything(self):
        self.enable()
        self.transcriber.fail = "The transcription service rejected the request; check the API key and model name."
        item = self.item()
        self.post(f"/api/items/{item['id']}/deep-read")
        self.drain()
        self.assertIn("rejected", self.jobs()["jobs"][0]["error"])
        self.assertEqual(self.provider.calls, [])

    def test_cancelling_during_the_audio_step_cannot_be_undone_by_a_late_result(self):
        self.enable()
        item = self.item(caption="#fyp")
        self.post(f"/api/items/{item['id']}/deep-read")
        real = self.service.transcribe_item

        def cancel_midway(job_item, deep):
            self.assertEqual(self.post("/api/ai/jobs/cancel").json(), {"cancelled": 1})
            return real(job_item, deep=deep)
        with patch.object(self.service, "transcribe_item", side_effect=cancel_midway):
            self.drain()
        self.assertEqual(self.jobs()["counts"], {"queued": 0, "running": 0, "completed": 0, "failed": 0, "cancelled": 1})
        self.assertEqual(self.provider.calls, [])
        self.assertIsNone(self.get(item["id"])["ai"])

    def test_only_a_transcript_is_made_when_no_ai_provider_is_configured(self):
        self.enable(provider=False)
        item = self.item()
        self.assertTrue(self.worker.enabled())
        self.post(f"/api/items/{item['id']}/deep-read")
        self.drain()
        self.assertEqual(self.jobs()["counts"]["completed"], 1)
        self.assertEqual(self.get(item["id"])["enrichment"]["transcript"]["source"], "groq")
        self.assertEqual(self.post("/api/ai/jobs", {"ids": [item["id"]]}).status_code, 503)

    def test_a_transcript_from_the_server_is_cached_but_a_client_supplied_video_link_is_not(self):
        cache = PublicPostCache(Path(self.temporary.name) / "cache.sqlite3")
        self.enable(cache_enabled=True)
        self.service.configure(cache=cache)
        trusted = self.item()
        self.post(f"/api/items/{trusted['id']}/deep-read")
        self.drain()
        self.assertEqual(cache.stats().get("transcript"), 1)
        # A different person saving the same post is served the cached transcript: no download, no provider call.
        with self.store.transaction() as c:
            other_id, _ = self.store.apply_item(c, {"url": POST_URL}, account="other-account")
        self.post(f"/api/items/{other_id}/deep-read")
        self.drain()
        self.assertEqual(len(self.transcriber.calls), 1)
        self.assertEqual(self.get(other_id)["enrichment"]["transcript"]["source"], "cache")
        # A video link that only a client supplied is fetched for its owner but never cached for others.
        cache.get  # keep the instance referenced
        fresh = PublicPostCache(Path(self.temporary.name) / "fresh.sqlite3")
        self.service.configure(cache=fresh)
        with self.store.transaction() as c:
            client_id, _ = self.store.apply_item(c, {"url": POST_URL}, account="third-account")
        self.post(f"/api/items/{client_id}/page", {"extraction": {"caption": "#fyp", "video_url": "https://instagram.fsynth-1.fna.fbcdn.net/o1/v/t16/synthetic/example-clip.mp4"}})
        self.post(f"/api/items/{client_id}/deep-read")
        self.drain()
        self.assertEqual(len(self.transcriber.calls), 2)
        self.assertNotIn("transcript", fresh.stats())

    def test_automatic_transcription_follows_the_thin_caption_rule_and_the_operator_setting(self):
        self.enable()
        thin = self.item(caption="#fyp #baking")
        rich = self.item("https://www.instagram.com/reel/SYNTH0003ef/", caption="A long enough description of what happens in this clip for a title")
        self.post("/api/ai/jobs", {"ids": [thin["id"], rich["id"]]})
        self.drain()
        self.assertEqual(len(self.transcriber.calls), 1, "only the thin-caption video needed audio")
        self.assertEqual(self.get(thin["id"])["ai"]["evidence_level"], "transcript-based")
        self.assertEqual(self.get(rich["id"])["ai"]["evidence_level"], "caption-based")
        totals = self.client.get("/api/enrichment/usage").json()
        self.assertEqual(totals["deep_reads"], 0, "automatic transcription is not an explicit deep read")
        # With automatic transcription off the same save is analysed from its caption alone.
        self.provider.calls.clear()
        self.transcriber.calls.clear()
        self.enable(transcribe_auto=False)
        other = self.item("https://www.instagram.com/reel/SYNTH0004gh/", caption="#fyp")
        self.post("/api/ai/jobs", {"ids": [other["id"]]})
        self.drain()
        self.assertEqual(self.transcriber.calls, [])
        self.assertEqual(self.get(other["id"])["ai"]["evidence_level"], "caption-based")
        self.assertTrue(self.get(other["id"])["enrichment"]["transcript_needed"], "the rule still says a transcript would help")

    def test_a_failed_automatic_attempt_falls_back_to_the_text_and_is_not_repeated(self):
        self.enable()
        item = self.item(TIKTOK)
        self.post(f"/api/items/{item['id']}/page", {"extraction": {"caption": "#fyp", "content_type": "video"}})
        self.post("/api/ai/jobs", {"ids": [item["id"]]})
        self.drain()
        done = self.get(item["id"])
        self.assertEqual(done["ai"]["evidence_level"], "caption-based")
        self.assertEqual(done["enrichment"]["deep_read"]["state"], "failed")
        self.assertEqual(self.web.count(path="/oembed"), 1)
        self.post(f"/api/items/{item['id']}/transcript", {"text": "x" * 10})
        self.delete(f"/api/items/{item['id']}/transcript")
        self.post("/api/ai/jobs", {"ids": [item["id"]]})
        self.drain()
        self.assertEqual(self.web.count(path="/oembed"), 1, "an automatic attempt that failed is not retried silently")


class AnalysisThroughTheApiTests(Base):
    def test_suggestions_carry_labels_a_folder_and_accepting_files_the_save(self):
        self.enable(fetch=False, transcriber=False)
        item = self.item(caption="Sourdough starter, day 5")
        self.assertEqual(self.post("/api/ai/jobs", {"ids": [item["id"]]}).json(), {"queued": 1, "matched": 1, "unchanged": 0})
        self.drain()
        suggested = self.get(item["id"])
        ai = suggested["ai"]
        self.assertEqual((ai["category"], ai["suggested_folder"], ai["provider"], ai["model"], ai["evidence_level"]), ("Food & Recipes", "Food & Recipes", "gemini", "fake-model", "caption-based"))
        self.assertIn("pictures and video themselves were not seen", ai["evidence_note"])
        accepted = self.post(f"/api/items/{item['id']}/ai/accept").json()
        self.assertEqual(accepted["title"], ai["suggested_title"])
        self.assertEqual([(c["name"], c["kind"]) for c in accepted["collections"]], [("Food & Recipes", "local")])
        self.assertEqual({t["name"] for t in self.client.get("/api/tags").json()["tags"]}, {"sourdough", "baking"})

    def test_an_existing_collection_is_preferred_and_a_manual_title_is_kept(self):
        self.enable(fetch=False, transcriber=False)
        mine = self.post("/api/collections", {"name": "My Recipes"}).json()
        item = self.item(title="Title I wrote myself", caption="Sourdough starter, day 5")
        self.post("/api/ai/jobs", {"ids": [item["id"]]})
        self.drain()
        accepted = self.post(f"/api/items/{item['id']}/ai/accept").json()
        self.assertEqual(accepted["title"], "Title I wrote myself")
        self.assertEqual([c["id"] for c in accepted["collections"]], [mine["id"]])
        self.assertEqual([c["name"] for c in self.client.get("/api/collections").json()["collections"]], ["My Recipes"], "no duplicate collection is created")

    def test_dismissing_files_nothing(self):
        self.enable(fetch=False, transcriber=False)
        item = self.item(caption="Sourdough starter, day 5")
        self.post("/api/ai/jobs", {"ids": [item["id"]]})
        self.drain()
        dismissed = self.post(f"/api/items/{item['id']}/ai/dismiss").json()
        self.assertEqual((dismissed["ai"], dismissed["collections"]), (None, []))

    def test_an_unknown_or_deleted_folder_is_not_invented_on_acceptance(self):
        self.enable(fetch=False, transcriber=False)
        item = self.item(caption="Sourdough starter, day 5")
        self.post("/api/ai/jobs", {"ids": [item["id"]]})
        self.drain()
        with self.store.transaction() as c:
            ai = json.loads(c.execute("SELECT ai FROM items WHERE id=?", (item["id"],)).fetchone()[0])
            ai["suggested_folder"] = "A collection that was deleted"
            c.execute("UPDATE items SET ai=? WHERE id=?", (json.dumps(ai), item["id"]))
        self.assertEqual(self.post(f"/api/items/{item['id']}/ai/accept").json()["collections"], [])

    def test_several_saves_go_to_the_model_in_one_call(self):
        self.enable(fetch=False, transcriber=False)
        ids = [self.item(f"https://example.com/batch/{n}", caption=f"Caption number {n} with some words")["id"] for n in range(5)]
        self.assertEqual(self.post("/api/ai/jobs", {"ids": ids}).json()["queued"], 5)
        self.drain()
        self.assertEqual([len(call) for call in self.provider.calls], [5])
        self.assertEqual(self.jobs()["counts"]["completed"], 5)
        totals = self.client.get("/api/enrichment/usage").json()
        self.assertEqual((totals["model_calls"], totals["input_tokens"], totals["output_tokens"]), (1, 500, 100))

    def test_a_hosted_provider_receives_no_private_context_by_default(self):
        self.enable(fetch=False, transcriber=False)
        self.post("/api/collections", {"name": "SECRET-SHELF"})
        item = self.item(caption="Sourdough starter, day 5", notes="SECRET-NOTE")
        self.post("/api/ai/jobs", {"ids": [item["id"]]})
        self.drain()
        seen = json.dumps([entry.evidence.source for call in self.provider.calls for entry in call])
        self.assertNotIn("SECRET-NOTE", seen)
        self.assertNotIn("SECRET-SHELF", seen)
        self.assertIn("Sourdough", seen)
        self.assertTrue(self.client.get("/api/settings").json()["ai_hosted"])

    def test_the_local_provider_keeps_the_original_full_context(self):
        self.provider = FakeProvider(hosted=False, max_batch=1)
        self.provider.name = "ollama"
        self.enable(fetch=False, transcriber=False)
        item = self.item(caption="Sourdough starter, day 5", notes="My note about it")
        self.post("/api/ai/jobs", {"ids": [item["id"]]})
        self.drain()
        self.assertIn("My note about it", json.dumps(self.provider.calls[0][0].evidence.source))

    def test_changing_notes_offers_a_fresh_suggestion_and_stale_ones_cannot_be_accepted(self):
        self.enable(fetch=False, transcriber=False)
        item = self.item(caption="Sourdough starter, day 5")
        self.post("/api/ai/jobs", {"ids": [item["id"]]})
        self.drain()
        self.client.patch("/api/items/" + item["id"], json={"notes": "A new note"}, headers=self.headers)
        self.assertEqual(self.post(f"/api/items/{item['id']}/ai/accept").status_code, 409)
        self.assertEqual(self.post("/api/ai/jobs", {"ids": [item["id"]]}).json()["queued"], 1)

    def test_changing_the_provider_invalidates_earlier_suggestions(self):
        self.enable(fetch=False, transcriber=False)
        item = self.item(caption="Sourdough starter, day 5")
        self.post("/api/ai/jobs", {"ids": [item["id"]]})
        self.drain()
        self.provider.model = "another-model"
        self.assertEqual(self.post("/api/ai/jobs", {"ids": [item["id"]]}).json()["queued"], 1)

    def test_without_a_provider_the_original_503_still_applies(self):
        self.service.configure(provider=None)
        item = self.item(caption="x words")
        self.assertEqual(self.post("/api/ai/jobs", {"ids": [item["id"]]}).status_code, 503)
        self.assertFalse(self.client.get("/api/settings").json()["ai_enabled"])


class UpgradeTests(Base):
    def test_a_suggestion_from_before_this_change_is_shown_but_must_be_regenerated(self):
        self.enable(fetch=False, transcriber=False)
        item = self.item(caption="Sourdough starter, day 5")
        old = {"suggested_title": "Old title", "summary": "Old summary.", "topics": ["bread"], "content_type": "video", "needs_review": True,
               "evidence_level": "caption-based", "model": "old-model", "created_at": "2026-01-01T00:00:00+00:00", "input_hash": "0" * 64, "evidence_snapshot": []}
        with self.store.transaction() as c:
            c.execute("UPDATE items SET ai=? WHERE id=?", (json.dumps(old), item["id"]))
        shown = self.get(item["id"])
        self.assertEqual((shown["ai"]["suggested_title"], shown["ai"].get("suggested_folder")), ("Old title", None))
        self.assertEqual(self.post(f"/api/items/{item['id']}/ai/accept").status_code, 409)
        self.assertEqual(self.post(f"/api/items/{item['id']}/ai/dismiss").json()["ai"], None)
        self.assertEqual(self.post("/api/ai/jobs", {"ids": [item["id"]]}).json()["queued"], 1)


class BuiltFromTheEnvironmentTests(unittest.TestCase):
    def config(self, root, **extra):
        return Config(data_dir=Path(root), admin_password="a-long-test-password-123", public_url="http://localhost:8787", **extra)

    def test_a_real_configuration_reads_the_environment(self):
        import os
        env = {"LA_FETCH_ENABLED": "true", "LA_FETCH_CONTACT": "https://archive.example.org/contact", "LA_AI_PROVIDER": "gemini", "LA_GEMINI_API_KEY": KEY,
               "LA_GEMINI_MODEL": "gemini-test-model", "LA_AI_BATCH_SIZE": "3", "LA_GROQ_API_KEY": "gsk-SYNTHETIC", "LA_PUBLIC_CACHE": "true"}
        with TemporaryDirectory() as root, patch.dict(os.environ, env):
            service = create_app(self.config(root)).state.enrichment
            self.assertTrue(service.fetch_enabled)
            self.assertTrue(service.fetcher.user_agent.endswith("; +https://archive.example.org/contact)"))
            self.assertEqual((service.provider.name, service.provider.model, service.provider.max_batch), ("gemini", "gemini-test-model", 3))
            self.assertEqual(service.transcriber.name, "groq")
            self.assertTrue((Path(root) / "cache" / "public-posts.sqlite3").is_file())
            self.assertEqual(service.analyzer().mode, "public")
            self.assertNotIn(KEY, repr(service.settings) + repr(service.provider))

    def test_a_testing_configuration_ignores_the_process_environment(self):
        import os
        with TemporaryDirectory() as root, patch.dict(os.environ, {"LA_FETCH_ENABLED": "true", "LA_GROQ_API_KEY": "gsk-SYNTHETIC", "LA_GEMINI_API_KEY": KEY}):
            service = create_app(self.config(root, testing=True)).state.enrichment
            self.assertFalse(service.fetch_enabled)
            self.assertIsNone(service.transcriber)
            self.assertIsNone(service.provider)

    def test_everything_is_off_by_default(self):
        import os
        with TemporaryDirectory() as root, patch.dict(os.environ, {}, clear=True):
            service = create_app(self.config(root)).state.enrichment
            self.assertEqual((service.fetch_enabled, service.provider, service.transcriber, service.cache), (False, None, None, None))
            self.assertFalse(service.worker.enabled())
            self.assertFalse((Path(root) / "cache").exists())

    def test_misconfiguration_stops_the_server_with_a_clear_message(self):
        import os
        for env, pattern in (({"LA_GEMINI_API_KEY": KEY}, "LA_AI_PROVIDER"), ({"LA_AI_PROVIDER": "gemini"}, "LA_GEMINI_API_KEY"), ({"LA_FETCH_ENABLED": "sometimes"}, "true or false")):
            with self.subTest(env=list(env)), TemporaryDirectory() as root, patch.dict(os.environ, env, clear=True):
                with self.assertRaisesRegex(ValueError, pattern):
                    create_app(self.config(root))


class SecretsAndSettingsTests(Base):
    def test_a_hosted_key_never_appears_in_any_response_or_job_error(self):
        handler_calls = []

        def handler(request):
            handler_calls.append(request)
            return httpx.Response(400, json={"error": {"message": f"API key not valid: {KEY}"}})
        gemini = GeminiProvider(KEY, "gemini-test-model", client=httpx.Client(transport=httpx.MockTransport(handler)), sleep=lambda s: None)
        self.enable(fetch=False, transcriber=False)
        self.service.configure(provider=gemini, settings=replace(self.service.settings, ai_provider="gemini", gemini_api_key=KEY, groq_api_key="gsk-SYNTHETIC"))
        item = self.item(caption="Sourdough starter, day 5")
        self.post("/api/ai/jobs", {"ids": [item["id"]]})
        self.drain()
        responses = [self.client.get(path).text for path in ("/api/settings", "/api/enrichment/status", "/api/enrichment/usage", "/api/ai/jobs", f"/api/items/{item['id']}", "/api/items", "/api/export?format=json")]
        for text in responses:
            self.assertNotIn(KEY, text)
            self.assertNotIn("gsk-SYNTHETIC", text)
        job = self.jobs()["jobs"][0]
        self.assertEqual(job["status"], "failed")
        self.assertIn("rejected", job["error"])
        self.assertEqual(len(handler_calls), 1)
        self.assertEqual(handler_calls[0].headers["x-goog-api-key"], KEY)

    def test_settings_and_status_describe_the_configuration_honestly(self):
        self.enable(fetch=True)
        settings = self.client.get("/api/settings").json()
        self.assertEqual((settings["ai_enabled"], settings["ai_provider"], settings["ai_hosted"], settings["ai_model"]), (True, "gemini", True, "fake-model"))
        self.assertEqual((settings["page_fetch_enabled"], settings["transcription_available"], settings["shared_cache_enabled"]), (True, True, False))
        status = self.client.get("/api/enrichment/status").json()
        self.assertEqual(status["page"]["server_fetch"], True)
        self.assertEqual(status["analysis"]["evidence_mode"], "public")
        self.assertEqual(status["transcription"]["provider"], "groq")
        self.assertTrue(status["deep_read"]["available"])

    def test_the_original_settings_contract_still_holds_by_default(self):
        settings = self.client.get("/api/settings").json()
        for key in ("remote_previews", "ai_enabled", "ai_model", "ai_available"):
            self.assertIn(key, settings)
        self.assertEqual((settings["ai_provider"], settings["ai_model"]), ("ollama", "synthetic-model"))
        self.assertFalse(settings["ai_hosted"])
        self.assertFalse(settings["page_fetch_enabled"])


class RealWorkerThreadTests(unittest.TestCase):
    """The same worker, but started by the application's own lifespan and left to run by itself."""

    def setUp(self):
        self.temporary = TemporaryDirectory(prefix="little-archive-thread-")
        self.password = secrets.token_urlsafe(32)
        config = Config(data_dir=Path(self.temporary.name), admin_password=self.password, public_url="http://testserver", testing=True,
                        ollama_url="http://127.0.0.1:1", ollama_model="synthetic-model")
        self.app = create_app(config)
        self.client = TestClient(self.app)
        self.client.__enter__()
        login = self.client.post("/api/auth/login", json={"password": self.password})
        self.headers = {"Origin": "http://testserver", "X-CSRF-Token": login.json()["csrf_token"]}

    def tearDown(self):
        self.client.__exit__(None, None, None)
        self.temporary.cleanup()

    def wait_for(self, status, count=1, seconds=10):
        import time
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            counts = self.client.get("/api/ai/jobs").json()["counts"]
            if counts[status] >= count:
                return counts
            time.sleep(0.05)
        self.fail(f"jobs never reached {status}: {counts}")

    def queue(self, n):
        ids = [self.client.post("/api/items", json={"url": f"https://example.com/thread/{i}", "caption": f"Caption {i} with several words"}, headers=self.headers).json()["id"] for i in range(n)]
        return ids, self.client.post("/api/ai/jobs", json={"ids": ids}, headers=self.headers)

    def test_the_background_thread_analyses_queued_saves_in_batches(self):
        provider = FakeProvider()
        self.app.state.enrichment.configure(provider=provider)
        ids, queued = self.queue(7)
        self.assertEqual(queued.json()["queued"], 7)
        self.wait_for("completed", 7)
        self.assertEqual(sum(len(call) for call in provider.calls), 7)
        self.assertLessEqual(max(len(call) for call in provider.calls), 5)
        self.assertTrue(all(self.client.get(f"/api/items/{i}").json()["ai"]["category"] == "Food & Recipes" for i in ids))

    def test_a_provider_that_raises_fails_the_job_without_wedging_the_queue(self):
        class Broken(FakeProvider):
            def analyze(self, batch):
                raise RuntimeError("boom SECRET-DETAIL")
        provider = Broken(max_batch=1)
        self.app.state.enrichment.configure(provider=provider)
        with self.assertLogs("little_archive.enrich", level="WARNING") as logged:
            self.queue(2)
            counts = self.wait_for("failed", 2)
        self.assertTrue(all("SECRET-DETAIL" not in line for line in logged.output))
        self.assertEqual(counts["running"], 0)
        errors = [j["error"] for j in self.client.get("/api/ai/jobs").json()["jobs"]]
        self.assertTrue(all("SECRET-DETAIL" not in e and e for e in errors))
        working = FakeProvider()
        self.app.state.enrichment.configure(provider=working)
        retry = self.client.post("/api/ai/jobs/" + self.client.get("/api/ai/jobs").json()["jobs"][0]["id"] + "/retry", headers=self.headers)
        self.assertEqual(retry.json(), {"queued": 1})
        self.wait_for("completed", 1)


class BackupCompatibilityTests(unittest.TestCase):
    def test_backups_restore_with_or_without_the_understanding_tables(self):
        with TemporaryDirectory() as root:
            root = Path(root)
            config = Config(data_dir=root / "with", admin_password="a-long-test-password-123", public_url="http://testserver", testing=True)
            app = create_app(config)
            store = app.state.store
            with store.transaction() as c:
                iid, _ = store.apply_item(c, {"url": POST_URL, "caption": "Hello there"})
            app.state.enrichment.set_transcript(iid, "Words from the audio", source="client")
            app.state.enrichment.meter.record(kind="model_call", tier="understand", model_calls=1)
            temporary, archive = create_backup(store)
            try:
                manifest = restore_backup(archive, root / "restored-with")
            finally:
                temporary.cleanup()
            self.assertEqual(manifest["items"], 1)
            import sqlite3
            with sqlite3.connect(root / "restored-with" / "library.sqlite3") as db:
                self.assertEqual(db.execute("SELECT transcript_source FROM item_enrichment").fetchone()[0], "client")
                self.assertEqual(db.execute("SELECT count(*) FROM enrich_usage").fetchone()[0], 1)
                self.assertIn("transcript", db.execute("SELECT evidence FROM items").fetchone()[0])
            # A library created before this change has none of those tables and must restore too.
            old = Store(Config(data_dir=root / "old", admin_password="a-long-test-password-123", public_url="http://testserver", testing=True))
            with old.transaction() as c:
                old.apply_item(c, {"url": POST_URL, "caption": "Old library"})
            temporary, archive = create_backup(old)
            try:
                self.assertEqual(restore_backup(archive, root / "restored-old")["items"], 1)
            finally:
                temporary.cleanup()
            restored = create_app(Config(data_dir=root / "restored-old", admin_password="a-long-test-password-123", public_url="http://testserver", testing=True))
            with TestClient(restored) as client:
                self.assertEqual(client.get("/api/health").status_code, 200)

    def test_deleting_an_item_removes_its_enrichment(self):
        with TemporaryDirectory() as root:
            app = create_app(Config(data_dir=Path(root), admin_password="a-long-test-password-123", public_url="http://testserver", testing=True))
            store, service = app.state.store, app.state.enrichment
            with store.transaction() as c:
                iid, _ = store.apply_item(c, {"url": POST_URL})
            service.set_transcript(iid, "Some words", source="client")
            with store.transaction() as c:
                c.execute("DELETE FROM items WHERE id=?", (iid,))
                self.assertEqual(c.execute("SELECT count(*) FROM item_enrichment").fetchone()[0], 0)


if __name__ == "__main__":
    unittest.main()
