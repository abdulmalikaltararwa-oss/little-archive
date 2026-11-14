"""The thin-caption rule, the Groq transcriber (fake HTTP), settings, metering and the schema."""
import base64
import json
from pathlib import Path
import sqlite3
from tempfile import TemporaryDirectory
import unittest

import httpx

from server.config import Config
from server.enrich.schema import ENRICH_SCHEMA, ensure_schema
from server.enrich.settings import EnrichSettings
from server.enrich.transcribe import GeminiTranscriber, GroqWhisperTranscriber, clean_transcript, meaningful_letters, transcript_needed
from server.enrich.understanding import ProviderError
from server.enrich.usage import LedgerSink, Metering
from server.storage import Store

KEY = "gsk_SYNTHETIC_KEY_NEVER_REAL"


def video(**extra):
    return {"id": "i1", "content_type": "video", "platform": "instagram", "title": "Saved Instagram post", "caption": "", "evidence": [], **extra}


class ThinCaptionRuleTests(unittest.TestCase):
    def test_a_video_with_hashtags_only_needs_a_transcript(self):
        needed, reason = transcript_needed(video(caption="#fyp #viral @someone https://example.com/x 😂😂"))
        self.assertEqual((needed, reason), (True, "thin_caption"))
        self.assertEqual(transcript_needed(video())[0], True)

    def test_a_descriptive_caption_does_not(self):
        caption = "Sourdough starter, day 5: bubbles at last, so I fed it again and kept it warm"
        self.assertEqual(transcript_needed(video(caption=caption)), (False, "caption_sufficient"))

    def test_caption_and_title_together_count(self):
        item = video(caption="Day five", title="Sourdough starter diary: the long wait for bubbles")
        self.assertEqual(transcript_needed(item), (False, "caption_sufficient"))

    def test_only_videos_and_only_without_a_transcript(self):
        self.assertEqual(transcript_needed(video(content_type="post", platform="web", caption="")), (False, "not_video"))
        self.assertEqual(transcript_needed(video(evidence=[{"kind": "transcript", "text": "Already here."}])), (False, "has_transcript"))
        self.assertEqual(transcript_needed({"content_type": "link", "platform": "web", "caption": ""}, {"kind": "youtube"})[0], True)
        self.assertEqual(transcript_needed({"content_type": "link", "platform": "tiktok", "caption": ""})[0], True)

    def test_counting_ignores_links_tags_mentions_and_emoji_but_not_arabic(self):
        self.assertEqual(meaningful_letters("#tag @name https://example.com/a?b=1 😀"), 0)
        self.assertEqual(meaningful_letters("abc 123"), 6)
        self.assertGreaterEqual(meaningful_letters("وصفة لبنة منزلية بالزعتر سهلة وسريعة جدا للجميع في البيت"), 40)


class GroqTests(unittest.TestCase):
    def transcriber(self, handler):
        return GroqWhisperTranscriber(KEY, "whisper-large-v3-turbo", client=httpx.Client(transport=httpx.MockTransport(handler)))

    def test_request_shape_and_result(self):
        seen = []

        def handler(request):
            seen.append(request)
            return httpx.Response(200, json={"text": "  Day five,\n\n and finally bubbles.  ", "language": "english", "duration": 12.34})
        result = self.transcriber(handler).transcribe(b"\x00\x01audio", "video/mp4", language="en")
        request = seen[0]
        self.assertEqual(str(request.url), "https://api.groq.com/openai/v1/audio/transcriptions")
        self.assertEqual(request.headers["authorization"], "Bearer " + KEY)
        body = request.content
        for expected in (b'name="model"', b"whisper-large-v3-turbo", b'name="response_format"', b"verbose_json", b'name="language"', b'filename="audio.mp4"', b"\x00\x01audio"):
            self.assertIn(expected, body)
        self.assertNotIn(KEY.encode(), body)
        self.assertEqual(result.text, "Day five,\n\nand finally bubbles.")
        self.assertEqual(result.seconds, 12.3)

    def test_duration_falls_back_to_the_last_segment(self):
        result = self.transcriber(lambda r: httpx.Response(200, json={"text": "hi", "segments": [{"end": 3.0}, {"end": 7.5}]})).transcribe(b"x", "audio/mpeg")
        self.assertEqual(result.seconds, 7.5)
        self.assertIsNone(self.transcriber(lambda r: httpx.Response(200, json={"text": "hi"})).transcribe(b"x", "audio/mpeg").seconds)

    def test_filenames_never_come_from_remote_names(self):
        seen = []
        self.transcriber(lambda r: (seen.append(r.content), httpx.Response(200, json={"text": "x"}))[1]).transcribe(b"x", "application/x-evil; charset=x")
        self.assertIn(b'filename="audio.mp4"', seen[0])

    def test_failures_are_sanitised_and_marked_retryable_where_sensible(self):
        for status, retryable, fragment in ((400, False, "rejected"), (401, False, "rejected"), (413, False, "larger"), (429, True, "limiting"), (500, True, "unavailable")):
            with self.subTest(status=status), self.assertRaises(ProviderError) as caught:
                self.transcriber(lambda r, status=status: httpx.Response(status, text=f"SECRET-BODY {KEY}")).transcribe(b"x", "video/mp4")
            self.assertIn(fragment, str(caught.exception))
            self.assertNotIn("SECRET-BODY", str(caught.exception))
            self.assertNotIn(KEY, str(caught.exception))
            self.assertEqual(caught.exception.retryable, retryable)
        for bad in (httpx.Response(200, text="not json"), httpx.Response(200, json={"text": 5}), httpx.Response(200, json=[1])):
            with self.subTest(bad=bad.text[:10]), self.assertRaises(ProviderError):
                self.transcriber(lambda r, bad=bad: bad).transcribe(b"x", "video/mp4")
        with self.assertRaises(ProviderError):
            self.transcriber(lambda r: httpx.Response(200, json={"text": "x"})).transcribe(b"", "video/mp4")

    def test_timeouts_and_connection_errors(self):
        for exc in (httpx.ReadTimeout("slow"), httpx.ConnectError("down")):
            with self.subTest(exc=type(exc).__name__), self.assertRaises(ProviderError) as caught:
                self.transcriber(lambda r, exc=exc: (_ for _ in ()).throw(exc)).transcribe(b"x", "video/mp4")
            self.assertTrue(caught.exception.retryable)

    def test_key_is_not_in_the_representation(self):
        self.assertNotIn(KEY, repr(self.transcriber(lambda r: httpx.Response(200, json={"text": "x"}))))

    def test_transcript_cleaning(self):
        self.assertEqual(clean_transcript("a\x00b  c\n\n d"), "ab c\n\nd")
        self.assertEqual(len(clean_transcript("x" * 50000)), 20000)
        self.assertEqual(clean_transcript(None), "")


class GeminiTranscriberTests(unittest.TestCase):
    GKEY = "AIza-SYNTHETIC-KEY-NEVER-REAL"

    def transcriber(self, handler):
        return GeminiTranscriber(self.GKEY, "gemini-3.5-flash-lite", client=httpx.Client(transport=httpx.MockTransport(handler)))

    @staticmethod
    def answer(payload, finish="STOP"):
        return {"candidates": [{"content": {"parts": [{"text": json.dumps(payload)}]}, "finishReason": finish}]}

    def test_request_shape_and_result(self):
        seen = []

        def handler(request):
            seen.append(request)
            return httpx.Response(200, json=self.answer({"text": "  Boil the pasta.\n\n Save the water.  ", "language": "en"}))
        result = self.transcriber(handler).transcribe(b"\x00\x01media", "video/mp4; codecs=avc1", language="en")
        request = seen[0]
        self.assertEqual(str(request.url), "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent")
        self.assertEqual(request.headers["x-goog-api-key"], self.GKEY)
        self.assertNotIn(self.GKEY, str(request.url))
        self.assertNotIn(self.GKEY.encode(), request.content)
        body = json.loads(request.content)
        part = body["contents"][0]["parts"][0]["inlineData"]
        self.assertEqual((part["mimeType"], base64.b64decode(part["data"])), ("video/mp4", b"\x00\x01media"))
        prompt = body["systemInstruction"]["parts"][0]["text"]
        for phrase in ("exactly as they are said", "Do not summarize, translate", "expected to be in en"):
            self.assertIn(phrase, prompt)
        self.assertEqual(body["generationConfig"]["temperature"], 0)
        self.assertEqual((result.text, result.language, result.seconds), ("Boil the pasta.\n\nSave the water.", "en", None))

    def test_unknown_media_types_are_sent_as_video_and_silence_is_empty(self):
        seen = []

        def handler(request):
            seen.append(json.loads(request.content))
            return httpx.Response(200, json=self.answer({"text": "", "language": ""}))
        self.assertEqual(self.transcriber(handler).transcribe(b"x", "application/octet-stream").text, "")
        self.assertEqual(seen[0]["contents"][0]["parts"][0]["inlineData"]["mimeType"], "video/mp4")
        self.assertNotIn("expected to be in", seen[0]["systemInstruction"]["parts"][0]["text"])

    def test_oversize_and_empty_audio_never_reach_the_service(self):
        def handler(request):
            raise AssertionError("no request expected")
        with self.assertRaisesRegex(ProviderError, "larger than"):
            self.transcriber(handler).transcribe(b"x" * (GeminiTranscriber.MAX_INLINE_BYTES + 1), "video/mp4")
        with self.assertRaisesRegex(ProviderError, "no audio"):
            self.transcriber(handler).transcribe(b"", "video/mp4")

    def test_failures_are_safe_messages_without_the_key_or_the_body(self):
        cases = [
            (httpx.Response(429, text="quota " + self.GKEY), "limiting", True),
            (httpx.Response(503, text="down"), "unavailable", True),
            (httpx.Response(400, text="bad key " + self.GKEY), "rejected", False),
            (httpx.Response(200, text="not json"), "unusable", False),
            (httpx.Response(200, json={"promptFeedback": {"blockReason": "SAFETY"}}), "declined", False),
            (httpx.Response(200, json=self.answer({"text": "cut"}, finish="MAX_TOKENS")), "cut short", False),
            (httpx.Response(200, json=self.answer({"words": "x"})), "unusable", False),
        ]
        for response, phrase, retryable in cases:
            with self.assertRaises(ProviderError) as caught:
                self.transcriber(lambda r, response=response: response).transcribe(b"x", "audio/mpeg")
            self.assertIn(phrase, str(caught.exception))
            self.assertNotIn(self.GKEY, str(caught.exception))
            self.assertEqual(caught.exception.retryable, retryable)

        def timeout(request):
            raise httpx.ReadTimeout("slow", request=request)
        with self.assertRaisesRegex(ProviderError, "timed out"):
            self.transcriber(timeout).transcribe(b"x", "audio/mpeg")
        self.assertNotIn(self.GKEY, repr(GeminiTranscriber(self.GKEY, "gemini-3.5-flash-lite")))
        with self.assertRaises(ProviderError):
            GeminiTranscriber("", "gemini-3.5-flash-lite")


class SettingsTests(unittest.TestCase):
    def test_the_transcription_provider_is_chosen_by_name(self):
        gemini = {"LA_AI_PROVIDER": "gemini", "LA_GEMINI_API_KEY": KEY}
        # Having a Gemini key for titles does not send audio anywhere until transcription names it.
        self.assertEqual(self.build(gemini).transcription_provider, "")
        chosen = self.build({**gemini, "LA_TRANSCRIBE_PROVIDER": "gemini", "LA_GEMINI_TRANSCRIBE_MODEL": "gemini-3.5-flash"})
        self.assertEqual((chosen.transcription_provider, chosen.gemini_transcribe_model), ("gemini", "gemini-3.5-flash"))
        self.assertEqual(chosen.public()["transcription_provider"], "gemini")
        # A Groq key alone keeps meaning Groq, and can be switched off or overridden by name.
        self.assertEqual(self.build({"LA_GROQ_API_KEY": KEY}).transcription_provider, "groq")
        self.assertEqual(self.build({"LA_GROQ_API_KEY": KEY, "LA_TRANSCRIBE_PROVIDER": "none"}).transcription_provider, "")
        self.assertEqual(self.build({**gemini, "LA_GROQ_API_KEY": KEY, "LA_TRANSCRIBE_PROVIDER": "gemini"}).transcription_provider, "gemini")
        for values, message in (({"LA_TRANSCRIBE_PROVIDER": "gemini"}, "needs LA_GEMINI_API_KEY"), ({"LA_TRANSCRIBE_PROVIDER": "groq"}, "needs LA_GROQ_API_KEY"),
                                ({"LA_TRANSCRIBE_PROVIDER": "whisper"}, "groq, gemini or none"), ({**gemini, "LA_TRANSCRIBE_PROVIDER": "gemini", "LA_GEMINI_TRANSCRIBE_MODEL": "bad model"}, "model name")):
            with self.assertRaisesRegex(ValueError, message):
                self.build(values)

    def build(self, values, **config):
        return EnrichSettings.from_env(values, Config(data_dir=Path("/tmp/x"), **config)).validate()

    def test_defaults_are_conservative(self):
        settings = self.build({})
        self.assertFalse(settings.fetch_enabled)
        self.assertFalse(settings.cache_enabled)
        self.assertEqual((settings.ai_provider, settings.transcription_provider), ("", ""))
        self.assertEqual(settings.public()["page_fetch_enabled"], False)

    def test_ollama_is_the_provider_when_it_is_configured(self):
        settings = self.build({}, ollama_url="http://127.0.0.1:11434", ollama_model="m")
        self.assertEqual((settings.ai_provider, settings.ai_model, settings.ai_hosted), ("ollama", "m", False))
        self.assertEqual(self.build({"LA_AI_PROVIDER": "none"}, ollama_url="http://127.0.0.1:11434", ollama_model="m").ai_provider, "")

    def test_a_hosted_key_never_activates_by_itself(self):
        with self.assertRaisesRegex(ValueError, "LA_AI_PROVIDER"):
            self.build({"LA_GEMINI_API_KEY": KEY})
        with self.assertRaisesRegex(ValueError, "LA_AI_PROVIDER"):
            self.build({"LA_GEMINI_API_KEY": KEY}, ollama_url="http://127.0.0.1:11434", ollama_model="m")
        with self.assertRaisesRegex(ValueError, "needs LA_GEMINI_API_KEY"):
            self.build({"LA_AI_PROVIDER": "gemini"})
        settings = self.build({"LA_AI_PROVIDER": "gemini", "LA_GEMINI_API_KEY": KEY, "LA_AI_BATCH_SIZE": "5"})
        self.assertEqual((settings.ai_provider, settings.ai_hosted, settings.ai_batch_size), ("gemini", True, 5))
        self.assertEqual(settings.public()["ai_batch_size"], 5)

    def test_public_view_has_no_secrets_or_private_locations(self):
        settings = self.build({"LA_AI_PROVIDER": "gemini", "LA_GEMINI_API_KEY": KEY, "LA_GROQ_API_KEY": KEY + "2", "LA_PUBLIC_CACHE": "yes", "LA_PUBLIC_CACHE_PATH": "/srv/shared/cache.sqlite3"})
        shown = json.dumps(settings.public())
        for secret in (KEY, "/srv/shared", "cache.sqlite3"):
            self.assertNotIn(secret, shown)
        self.assertEqual(settings.public()["transcription_provider"], "groq")

    def test_bad_values_are_rejected_with_clear_messages(self):
        for values, pattern in (
            ({"LA_AI_PROVIDER": "openai"}, "ollama, gemini or none"), ({"LA_FETCH_ENABLED": "maybe"}, "true or false"), ({"LA_AI_BATCH_SIZE": "0"}, "between"),
            ({"LA_AI_BATCH_SIZE": "many"}, "number"), ({"LA_FETCH_MAX_BYTES": "9999999999"}, "between"), ({"LA_PUBLIC_CACHE_PATH": "relative/cache.db"}, "absolute"),
            ({"LA_GROQ_API_KEY": KEY, "LA_GROQ_MODEL": "../evil"}, "model name"), ({"LA_FETCH_CONTACT": "a\nb"}, "control"),
            ({"LA_AI_PROVIDER": "gemini", "LA_GEMINI_API_KEY": KEY, "LA_GEMINI_MODEL": "a b"}, "model name"),
        ):
            with self.subTest(values=values), self.assertRaisesRegex(ValueError, pattern):
                self.build(values)

    def test_no_cache_path_inside_the_public_web_directory(self):
        web = Path(__file__).resolve().parent.parent / "web" / "cache.sqlite3"
        with self.assertRaisesRegex(ValueError, "web directory"):
            self.build({"LA_PUBLIC_CACHE_PATH": str(web)})


class DoctorTests(unittest.TestCase):
    """`doctor` validates the new settings without network access and without printing values."""

    def report(self, environment):
        from unittest.mock import patch
        from server.diagnostics import diagnose
        with TemporaryDirectory() as root, patch("server.diagnostics.metadata.version", return_value="1.0.0"):
            base = {"LA_ADMIN_PASSWORD": "a-long-test-password-123", "LA_DATA_DIR": str(Path(root) / "data"), "LA_PUBLIC_URL": "http://localhost:8787"}
            return diagnose(env_file=Path(root) / "missing.env", environment={**base, **environment})

    def row(self, report):
        return next(r for r in report["checks"] if r["id"] == "understanding")

    def test_defaults_are_valid_and_report_what_is_on(self):
        row = self.row(self.report({}))
        self.assertEqual((row["status"], row["details"]), ("passed", {"page_fetch": False, "ai_provider": "none", "transcription": False, "shared_cache": False}))

    def test_enabled_features_are_reported_without_secrets(self):
        report = self.report({"LA_FETCH_ENABLED": "true", "LA_AI_PROVIDER": "gemini", "LA_GEMINI_API_KEY": KEY, "LA_GROQ_API_KEY": KEY + "x"})
        self.assertEqual(self.row(report)["details"], {"page_fetch": True, "ai_provider": "gemini", "transcription": True, "shared_cache": False})
        self.assertNotIn(KEY, json.dumps(report))

    def test_a_bad_setting_blocks_before_start_and_names_the_setting_only(self):
        report = self.report({"LA_GEMINI_API_KEY": KEY})
        row = self.row(report)
        self.assertEqual((row["status"], row["code"], report["status"], report["exit_code"]), ("failed", "understanding_configuration_invalid", "blocked", 1))
        self.assertIn("LA_AI_PROVIDER", row["next_action"])
        self.assertNotIn(KEY, json.dumps(report))


class MeteringAndSchemaTests(unittest.TestCase):
    def setUp(self):
        self.temp = TemporaryDirectory()
        self.store = Store(Config(data_dir=Path(self.temp.name), admin_password="a-long-test-password-123", testing=True))
        ensure_schema(self.store)

    def tearDown(self):
        self.temp.cleanup()

    def test_schema_is_additive_idempotent_and_leaves_existing_tables_alone(self):
        before = self.table_sql("items")
        ensure_schema(self.store)
        ensure_schema(self.store)
        self.assertEqual(before, self.table_sql("items"))
        with self.store.transaction() as c:
            names = {r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            self.assertEqual(c.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()[0], "1")
            self.assertEqual(c.execute("SELECT value FROM meta WHERE key='enrich_schema_version'").fetchone()[0], "1")
        self.assertTrue({"item_enrichment", "enrich_usage"} <= names)

    def table_sql(self, name):
        with self.store.transaction() as c:
            return c.execute("SELECT sql FROM sqlite_master WHERE name=?", (name,)).fetchone()[0]

    def test_deleting_an_item_removes_its_enrichment_but_not_the_usage_history(self):
        with self.store.transaction() as c:
            iid, _ = self.store.apply_item(c, {"url": "https://example.com/a", "title": "A"})
            c.execute("INSERT INTO item_enrichment(item_id,updated_at) VALUES(?,?)", (iid, "2026-11-14T00:00:00+00:00"))
        sink = LedgerSink(self.store)
        sink.record(Metering().record(kind="model_call", tier="understand", provider="gemini", model="m", item_id=iid, model_calls=1))
        with self.store.transaction() as c:
            c.execute("DELETE FROM items WHERE id=?", (iid,))
            self.assertEqual(c.execute("SELECT count(*) FROM item_enrichment").fetchone()[0], 0)
            self.assertEqual(c.execute("SELECT count(*) FROM enrich_usage").fetchone()[0], 1)

    def test_ledger_totals_what_each_tier_reports(self):
        sink = LedgerSink(self.store)
        meter = Metering(sink)
        meter.record(kind="page_fetch", tier="read", item_id="a", bytes_fetched=1500)
        meter.record(kind="page_read", tier="read", item_id="a")
        meter.record(kind="model_call", tier="understand", provider="gemini", model="m", items=3, model_calls=1, input_tokens=900, output_tokens=120)
        meter.record(kind="model_call", tier="understand", provider="gemini", model="m", item_id="b", model_calls=1, input_tokens=100, output_tokens=20)
        meter.record(kind="transcription", tier="transcribe", provider="groq", model="w", item_id="c", audio_seconds=42.5, deep_read=True)
        meter.record(kind="cache_hit", tier="understand", item_id="d", cache_hit=True)
        totals = sink.totals()
        self.assertEqual((totals["model_calls"], totals["input_tokens"], totals["output_tokens"]), (2, 1000, 140))
        self.assertEqual((totals["audio_seconds"], totals["transcriptions"], totals["deep_reads"]), (42.5, 1, 1))
        self.assertEqual((totals["page_fetches"], totals["page_reads"], totals["cache_hits"], totals["bytes_fetched"]), (1, 1, 1, 1500))
        self.assertEqual({(p["provider"], p["kind"]) for p in totals["by_provider"]}, {("gemini", "model_call"), ("groq", "transcription")})
        self.assertEqual(sink.totals(since="2999-01-01")["model_calls"], 0)

    def test_a_failing_sink_never_breaks_the_pipeline_and_bad_events_are_refused(self):
        class Broken:
            def record(self, event):
                raise RuntimeError("billing down")
        seen = []

        class Good:
            def record(self, event):
                seen.append(event)
        meter = Metering(Broken(), Good())
        with self.assertLogs("little_archive.enrich", level="WARNING") as logged:
            event = meter.record(kind="model_call", tier="understand", model_calls=1)
        self.assertIn("usage sink failed", logged.output[0])
        self.assertNotIn("billing down", logged.output[0])
        self.assertEqual(seen, [event])
        self.assertTrue(event.at)
        with self.assertRaises(ValueError):
            meter.record(kind="payment", tier="understand")

    def test_interrupted_deep_reads_do_not_look_pending_forever(self):
        with self.store.transaction() as c:
            iid, _ = self.store.apply_item(c, {"url": "https://example.com/b", "title": "B"})
            c.execute("INSERT INTO item_enrichment(item_id,deep_read_state,updated_at) VALUES(?,'queued','2026-11-14T00:00:00+00:00')", (iid,))
        ensure_schema(self.store)
        with self.store.transaction() as c:
            row = c.execute("SELECT deep_read_state,deep_read_error FROM item_enrichment WHERE item_id=?", (iid,)).fetchone()
        self.assertEqual(row[0], "failed")
        self.assertIn("interrupted", row[1])

    def test_the_schema_text_only_creates_tables_that_are_missing(self):
        self.assertNotIn("DROP", ENRICH_SCHEMA.upper())
        self.assertNotIn("ALTER", ENRICH_SCHEMA.upper())
        with sqlite3.connect(":memory:") as db:
            db.executescript("CREATE TABLE items(id TEXT PRIMARY KEY); CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT); CREATE TABLE ai_jobs(item_id TEXT, status TEXT);")
            db.executescript(ENRICH_SCHEMA)
            db.executescript(ENRICH_SCHEMA)


if __name__ == "__main__":
    unittest.main()
