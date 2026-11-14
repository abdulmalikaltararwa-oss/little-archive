"""Providers (fake HTTP only), evidence labelling, batching, metering and the shared cache."""
import json
from pathlib import Path
import sqlite3
from tempfile import TemporaryDirectory
import unittest

import httpx

from server.enrich.analysis import Analyzer
from server.enrich.cache import ALLOWED, PublicPostCache
from server.enrich.settings import EnrichSettings
from server.enrich.understanding import (CATEGORIES, AnalysisInput, GeminiProvider, OllamaProvider, ProviderError, build_evidence, evidence_note, map_folder,
                                         output_schema, system_prompt, validate_result)
from server.enrich.usage import Metering

GOOD = {"suggested_title": "Sourdough starter, day five", "summary": "The caption describes a sourdough starter showing bubbles on day five.",
        "topics": ["sourdough", "baking"], "content_type": "video", "needs_review": False, "category": "Food & Recipes"}
URL = "https://www.instagram.com/p/SYNTH0001ab/"


def item(**extra):
    base = {"id": "item-1", "title": "Saved Instagram post", "creator": "@example_baker", "caption": "Sourdough starter, day 5: bubbles at last", "evidence": [], "collections": []}
    base.update(extra)
    return base


def client_for(handler):
    return httpx.Client(transport=httpx.MockTransport(handler))


class Recorder:
    def __init__(self):
        self.events = []

    def record(self, event):
        self.events.append(event)

    def of(self, kind):
        return [e for e in self.events if e.kind == kind]


def gemini_answer(payload, **extra):
    return httpx.Response(200, json={"candidates": [{"content": {"parts": [{"text": json.dumps(payload)}]}, "finishReason": "STOP"}],
                                      "usageMetadata": {"promptTokenCount": 321, "candidatesTokenCount": 45, "totalTokenCount": 366}, **extra})


class EvidenceHonestyTests(unittest.TestCase):
    def test_level_follows_the_input_only(self):
        title_only = build_evidence({"title": "Sketches"})
        self.assertEqual((title_only.level, title_only.sources), ("text-only", ["title"]))
        self.assertIn("not read", evidence_note(title_only.sources))
        caption = build_evidence(item())
        self.assertEqual(caption.level, "caption-based")
        self.assertIn("The pictures and video themselves were not seen.", evidence_note(caption.sources))
        spoken = build_evidence(item(evidence=[{"kind": "transcript", "text": "Day five and finally some bubbles."}]))
        self.assertEqual(spoken.level, "transcript-based")
        note = evidence_note(spoken.sources)
        self.assertIn("a transcript of the audio", note)
        self.assertIn("not seen", note)
        self.assertNotIn("watched", note)

    def test_a_transcript_only_appears_when_one_exists(self):
        self.assertNotIn("transcript", build_evidence(item()).source)
        self.assertEqual(build_evidence(item(evidence=[{"kind": "transcript", "text": "Spoken words"}])).source["transcript"], "Spoken words")

    def test_alt_text_is_labelled_as_alt_text_not_as_a_caption(self):
        evidence = build_evidence({"title": "T", "evidence": [{"kind": "thumbnail_alt", "text": "A loaf on a table"}]})
        self.assertEqual(evidence.level, "text-only")
        self.assertIn("alt_text", evidence.sources)
        self.assertNotIn("caption", evidence.sources)

    def test_prompt_states_what_the_model_has_not_seen(self):
        prompt = system_prompt(extended=True)
        for phrase in ("you have not seen", "never write that you watched", "automatic transcription of", "untrusted source text"):
            self.assertIn(phrase, prompt)

    def test_public_mode_leaves_out_private_context(self):
        owned = item(title="Mum's birthday cake plan", notes="SECRET-NOTE call the bakery", collections=[{"name": "My private shelf"}],
                     evidence=[{"kind": "user_text", "text": "SECRET-USER-TEXT"}])
        public = build_evidence(owned, mode="public", manual_title=True)
        text = json.dumps(public.source)
        for private in ("SECRET-NOTE", "My private shelf", "SECRET-USER-TEXT", "Mum's birthday"):
            self.assertNotIn(private, text)
        self.assertEqual(public.sources, ["creator", "caption"])
        full = json.dumps(build_evidence(owned, mode="full", manual_title=True).source)
        for private in ("SECRET-NOTE", "My private shelf", "SECRET-USER-TEXT", "Mum's birthday"):
            self.assertIn(private, full)

    def test_placeholder_titles_are_not_evidence(self):
        self.assertTrue(build_evidence({"title": "Saved Instagram post"}).empty)

    def test_budget_is_enforced_with_transcripts_too(self):
        big = item(caption="c" * 50000, evidence=[{"kind": "transcript", "text": "t" * 90000}], notes="n" * 50000)
        evidence = build_evidence(big)
        self.assertLessEqual(len(json.dumps(evidence.source, ensure_ascii=False)), 14000 + 40)
        self.assertTrue(evidence.truncated)
        self.assertTrue(evidence.source["text_was_truncated"])


class ValidationTests(unittest.TestCase):
    def test_extended_results_coerce_unknown_category_and_collection(self):
        result = validate_result({**GOOD, "category": "Nonsense", "collection": "Not mine"}, extended=True, collections=("Recipes",))
        self.assertEqual((result["category"], result["collection"]), ("Other", ""))

    def test_unknown_or_missing_fields_are_rejected(self):
        for bad in ({**GOOD, "shell": "x"}, {k: v for k, v in GOOD.items() if k != "category"}, "text", [], None, {**GOOD, "topics": ["a"] * 9}, {**GOOD, "suggested_title": "  "}):
            with self.subTest(bad=str(bad)[:40]), self.assertRaises(ProviderError):
                validate_result(bad, extended=True)

    def test_schema_lists_the_fixed_taxonomy_and_the_owners_collections(self):
        schema = output_schema(extended=True, collections=("Recipes", "Trips"))
        self.assertEqual(schema["properties"]["category"]["enum"], list(CATEGORIES))
        self.assertEqual(schema["properties"]["collection"]["enum"], ["", "Recipes", "Trips"])
        self.assertFalse(schema["additionalProperties"])
        self.assertNotIn("collection", output_schema(extended=True)["properties"])


class OllamaProviderTests(unittest.TestCase):
    def answer(self, content=GOOD):
        return {"done": True, "done_reason": "stop", "message": {"content": json.dumps(content)}, "prompt_eval_count": 410, "eval_count": 60}

    def test_request_shape_and_usage(self):
        seen = []

        def handler(request):
            seen.append(json.loads(request.content))
            return httpx.Response(200, json=self.answer({**GOOD, "collection": ""}))
        provider = OllamaProvider("http://127.0.0.1:11434", "example:4b", client=client_for(handler))
        evidence = build_evidence(item())
        outcomes, usage = provider.analyze([AnalysisInput("a", evidence, True, ("Recipes",))])
        request = seen[0]
        self.assertEqual((request["stream"], request["think"]), (False, False))
        self.assertNotIn("tools", request)
        self.assertEqual(request["format"]["properties"]["category"]["enum"], list(CATEGORIES))
        self.assertIn("collection", request["format"]["properties"])
        self.assertEqual(usage.model_calls, 1)
        self.assertEqual((usage.input_tokens, usage.output_tokens), (410, 60))
        self.assertEqual(outcomes[0].result["category"], "Food & Recipes")

    def test_one_item_per_request_and_larger_context_for_long_inputs(self):
        sizes = []
        legacy = {k: v for k, v in GOOD.items() if k != "category"}
        provider = OllamaProvider("http://127.0.0.1:11434", "m", client=client_for(lambda r: (sizes.append(json.loads(r.content)["options"]["num_ctx"]), httpx.Response(200, json=self.answer(legacy)))[1]))
        with self.assertRaises(ProviderError):
            provider.analyze([AnalysisInput("a", build_evidence(item())), AnalysisInput("b", build_evidence(item()))])
        provider.analyze([AnalysisInput("a", build_evidence(item(evidence=[{"kind": "transcript", "text": "x" * 8000}], caption="word " * 600)), extended=False)])
        self.assertEqual(sizes, [8192])


class GeminiProviderTests(unittest.TestCase):
    KEY = "AIza-SYNTHETIC-KEY-NEVER-REAL"

    def provider(self, handler, **kwargs):
        return GeminiProvider(self.KEY, "gemini-test-model", client=client_for(handler), sleep=lambda s: None, **kwargs)

    def test_request_carries_the_key_in_a_header_only(self):
        seen = []

        def handler(request):
            seen.append(request)
            return gemini_answer(GOOD)
        outcomes, usage = self.provider(handler).analyze([AnalysisInput("a", build_evidence(item()))])
        request = seen[0]
        self.assertEqual(request.url.path, "/v1beta/models/gemini-test-model:generateContent")
        self.assertEqual(request.headers["x-goog-api-key"], self.KEY)
        self.assertNotIn(self.KEY, str(request.url))
        self.assertNotIn(self.KEY, request.content.decode())
        body = json.loads(request.content)
        self.assertEqual(body["generationConfig"]["responseMimeType"], "application/json")
        self.assertEqual(body["generationConfig"]["responseJsonSchema"]["properties"]["category"]["enum"], list(CATEGORIES))
        self.assertNotIn("tools", body)
        self.assertIn("untrusted source text", body["systemInstruction"]["parts"][0]["text"])
        self.assertEqual((usage.model_calls, usage.input_tokens, usage.output_tokens), (1, 321, 45))
        self.assertEqual(outcomes[0].result["suggested_title"], "Sourdough starter, day five")

    def test_errors_never_echo_the_response_or_the_key(self):
        for status, fragment in ((400, "rejected"), (401, "rejected"), (403, "rejected"), (404, "rejected"), (429, "limiting"), (503, "unavailable")):
            provider = self.provider(lambda r, status=status: httpx.Response(status, json={"error": {"message": f"bad key {self.KEY} SECRET-BODY"}}))
            with self.subTest(status=status), self.assertRaises(ProviderError) as caught:
                provider.analyze([AnalysisInput("a", build_evidence(item()))])
            self.assertIn(fragment, str(caught.exception))
            self.assertNotIn("SECRET-BODY", str(caught.exception))
            self.assertNotIn(self.KEY, str(caught.exception))
            self.assertEqual(caught.exception.retryable, status in {429, 503})

    def test_transient_failure_is_retried_once_then_succeeds(self):
        calls = []

        def handler(request):
            calls.append(1)
            return httpx.Response(429, headers={"retry-after": "2"}) if len(calls) == 1 else gemini_answer(GOOD)
        outcomes, _ = self.provider(handler).analyze([AnalysisInput("a", build_evidence(item()))])
        self.assertEqual(len(calls), 2)
        self.assertIsNotNone(outcomes[0].result)

    def test_blocked_incomplete_and_malformed_answers_are_rejected(self):
        cases = {
            "blocked": httpx.Response(200, json={"promptFeedback": {"blockReason": "SAFETY"}}),
            "no candidates": httpx.Response(200, json={"candidates": []}),
            "cut off": httpx.Response(200, json={"candidates": [{"content": {"parts": [{"text": "{"}]}, "finishReason": "MAX_TOKENS"}]}),
            "not json": httpx.Response(200, json={"candidates": [{"content": {"parts": [{"text": "{broken"}]}, "finishReason": "STOP"}]}),
            "wrong shape": httpx.Response(200, json=["x"]),
            "unknown field": gemini_answer({**GOOD, "shell_command": "echo bad"}),
        }
        for name, response in cases.items():
            with self.subTest(name=name), self.assertRaises(ProviderError):
                self.provider(lambda r, response=response: response).analyze([AnalysisInput("a", build_evidence(item()))])

    def test_the_key_never_shows_in_representations(self):
        self.assertNotIn(self.KEY, repr(self.provider(lambda r: gemini_answer(GOOD))))
        settings = EnrichSettings(ai_provider="gemini", gemini_api_key=self.KEY, groq_api_key="gsk-SYNTHETIC")
        self.assertNotIn(self.KEY, repr(settings))
        self.assertNotIn("gsk-SYNTHETIC", repr(settings))
        self.assertNotIn(self.KEY, json.dumps(settings.public()))

    def test_model_names_cannot_inject_into_the_url(self):
        for model in ("../x", "a b", "m?key=1", "", "a/b"):
            with self.subTest(model=model), self.assertRaises(ProviderError):
                GeminiProvider(self.KEY, model)

    def test_batched_call_is_one_request_with_per_item_validation(self):
        seen = []

        def handler(request):
            seen.append(json.loads(request.content))
            return gemini_answer({"results": [{"id": "a", **GOOD}, {"id": "b", **{**GOOD, "topics": ["x"] * 9}}, {"id": "ghost", **GOOD}]})
        outcomes, usage = self.provider(handler).analyze([AnalysisInput(k, build_evidence(item(caption=f"Caption {k}"))) for k in "abc"])
        self.assertEqual(len(seen), 1)
        self.assertEqual(usage.model_calls, 1)
        body = seen[0]
        self.assertIn("results", body["generationConfig"]["responseJsonSchema"]["properties"])
        self.assertIn("independent items", body["systemInstruction"]["parts"][0]["text"])
        sent = json.loads(body["contents"][0]["parts"][0]["text"])
        self.assertEqual([entry["id"] for entry in sent["items"]], ["a", "b", "c"])
        self.assertEqual([(o.key, o.result is not None) for o in outcomes], [("a", True), ("b", False), ("c", False)])
        self.assertEqual(outcomes[2].error, "The model did not answer for this item.")


class AnalyzerTests(unittest.TestCase):
    def setUp(self):
        self.temp = TemporaryDirectory()
        self.meter = Metering()
        self.recorder = Recorder()
        self.meter.add_sink(self.recorder)

    def tearDown(self):
        self.temp.cleanup()

    def gemini(self, handler, max_batch=8):
        return GeminiProvider("k-synthetic", "gemini-test-model", max_batch=max_batch, client=client_for(handler), sleep=lambda s: None)

    def analyzer(self, provider, *, cache=False, **settings):
        store = PublicPostCache(Path(self.temp.name) / "cache.sqlite3") if cache else None
        return Analyzer(provider, EnrichSettings(ai_provider=provider.name, cache_enabled=cache, **settings), cache=store, meter=self.meter), store

    @staticmethod
    def echo(request):
        body = json.loads(request.content)
        sent = json.loads(body["contents"][0]["parts"][0]["text"])
        entries = sent["items"] if "items" in sent else [{"id": None}]
        if "items" not in sent:
            return gemini_answer(GOOD)
        return gemini_answer({"results": [{"id": e["id"], **GOOD, "suggested_title": "Title for " + e["id"]} for e in entries]})

    def test_batching_groups_items_up_to_the_providers_limit(self):
        calls = []
        provider = self.gemini(lambda r: (calls.append(json.loads(json.loads(r.content)["contents"][0]["parts"][0]["text"])), self.echo(r))[1], max_batch=2)
        analyzer, _ = self.analyzer(provider, ai_batch_size=2)
        prepared = [analyzer.prepare(f"k{i}", item(id=f"i{i}", caption=f"Caption number {i} with enough words")) for i in range(5)]
        outcomes = analyzer.run(prepared)
        self.assertEqual(len(calls), 3)
        self.assertEqual([len(c["items"]) if "items" in c else 1 for c in calls], [2, 2, 1])
        self.assertEqual({k: o.result["suggested_title"] for k, o in outcomes.items()}["k3"], "Title for k3")
        events = self.recorder.of("model_call")
        self.assertEqual([(e.model_calls, e.items) for e in events], [(1, 2), (1, 2), (1, 1)])
        self.assertTrue(all(e.input_tokens == 321 and e.output_tokens == 45 for e in events))
        self.assertEqual(events[2].item_id, "i4")
        self.assertIsNone(events[0].item_id)

    def test_a_bad_answer_for_one_item_is_retried_on_its_own(self):
        calls = []

        def handler(request):
            body = json.loads(json.loads(request.content)["contents"][0]["parts"][0]["text"])
            calls.append(body)
            if "items" in body:
                return gemini_answer({"results": [{"id": "a", **GOOD}, {"id": "b", "suggested_title": ""}]})
            return gemini_answer(GOOD)
        analyzer, _ = self.analyzer(self.gemini(handler))
        outcomes = analyzer.run([analyzer.prepare("a", item(id="i1")), analyzer.prepare("b", item(id="i2", caption="Another caption with words"))])
        self.assertEqual(len(calls), 2)
        self.assertTrue(all(o.result for o in outcomes.values()))
        self.assertEqual(len(self.recorder.of("model_call")), 2)

    def test_a_rate_limit_fails_the_batch_without_hammering_the_service(self):
        calls = []
        analyzer, _ = self.analyzer(self.gemini(lambda r: (calls.append(1), httpx.Response(429))[1]))
        outcomes = analyzer.run([analyzer.prepare(k, item(id=k, caption=f"Caption {k} with several words")) for k in "ab"])
        self.assertEqual(len(calls), 2)  # one attempt plus one retry, for the whole batch
        self.assertTrue(all(o.error and "limiting" in o.error for o in outcomes.values()))

    def test_results_carry_labels_computed_from_the_input(self):
        analyzer, _ = self.analyzer(self.gemini(lambda r: gemini_answer({**GOOD, "evidence_level": "video-based"} if False else GOOD)))
        plain = analyzer.run([analyzer.prepare("a", item())])["a"].result
        self.assertEqual(plain["evidence_level"], "caption-based")
        spoken = analyzer.run([analyzer.prepare("b", item(evidence=[{"kind": "transcript", "text": "Words that were said aloud in the clip."}]))])["b"].result
        self.assertEqual(spoken["evidence_level"], "transcript-based")
        self.assertIn("transcript", spoken["evidence_sources"])
        self.assertIn("audio was transcribed", spoken["evidence_note"])
        self.assertEqual(plain["provider"], "gemini")

    def test_hosted_providers_get_public_text_only_unless_the_operator_opts_in(self):
        sent = []
        provider = self.gemini(lambda r: (sent.append(r.content.decode()), gemini_answer(GOOD))[1])
        private = item(notes="SECRET-NOTE", collections=[{"name": "SECRET-SHELF"}])
        analyzer, _ = self.analyzer(provider)
        analyzer.run([analyzer.prepare("a", private, local_collections=("SECRET-SHELF",))])
        self.assertNotIn("SECRET-NOTE", sent[0])
        self.assertNotIn("SECRET-SHELF", sent[0])
        opted, _ = self.analyzer(provider, share_private_context=True)
        self.assertEqual(opted.mode, "full")
        opted.run([opted.prepare("a", private, local_collections=("SECRET-SHELF",))])
        self.assertIn("SECRET-NOTE", sent[1])
        self.assertIn("SECRET-SHELF", sent[1])

    def test_a_local_provider_keeps_the_full_context_unless_the_cache_is_on(self):
        provider = OllamaProvider("http://127.0.0.1:11434", "m", client=client_for(lambda r: httpx.Response(200, json={"done": True, "message": {"content": json.dumps(GOOD)}})))
        self.assertEqual(Analyzer(provider, EnrichSettings(ai_provider="ollama")).mode, "full")
        self.assertEqual(Analyzer(provider, EnrichSettings(ai_provider="ollama", cache_enabled=True)).mode, "public")

    def test_the_model_can_choose_among_the_owners_collections_in_full_mode(self):
        provider = OllamaProvider("http://127.0.0.1:11434", "m", client=client_for(lambda r: httpx.Response(200, json={"done": True, "message": {"content": json.dumps({**GOOD, "collection": "Bread"})}})))
        analyzer = Analyzer(provider, EnrichSettings(ai_provider="ollama"), meter=self.meter)
        prepared = analyzer.prepare("a", item(), local_collections=("Bread", "Trips"))
        self.assertEqual(prepared.offered, ("Bread", "Trips"))
        self.assertEqual(analyzer.run([prepared])["a"].result["suggested_folder"], "Bread")

    def test_folder_comes_from_the_fixed_taxonomy_or_a_matching_collection(self):
        self.assertEqual(map_folder("Food & Recipes", ["sourdough"], []), "Food & Recipes")
        self.assertEqual(map_folder("Food & Recipes", [], ["My Recipes", "Trips"]), "My Recipes")
        self.assertEqual(map_folder("Food & Recipes", [], ["food & recipes"]), "food & recipes")
        self.assertEqual(map_folder("Other", ["x"], ["Trips"]), "")
        self.assertEqual(map_folder("Travel & Places", ["lisbon", "trip"], ["Gym", "Lisbon trip 2026"]), "Lisbon trip 2026")
        self.assertEqual(map_folder("Humor & Memes", [], ["Gym"]), "Humor & Memes")

    def test_no_provider_is_a_clear_error_not_a_crash(self):
        analyzer = Analyzer(None, EnrichSettings(), meter=self.meter)
        outcome = analyzer.run([analyzer.prepare("a", item())])["a"]
        self.assertIn("No AI provider", outcome.error)
        self.assertEqual(analyzer.run([analyzer.prepare("b", {"id": "x", "title": "Saved Web link"})])["b"].error, "There is not enough text evidence to classify this item.")


class SharedCacheTests(unittest.TestCase):
    def setUp(self):
        self.temp = TemporaryDirectory()
        self.meter, self.recorder = Metering(), Recorder()
        self.meter.add_sink(self.recorder)
        self.calls = []
        self.path = Path(self.temp.name) / "cache.sqlite3"
        self.cache = PublicPostCache(self.path)
        provider = GeminiProvider("k-synthetic", "gemini-test-model", client=client_for(self.handler), sleep=lambda s: None)
        self.analyzer = Analyzer(provider, EnrichSettings(ai_provider="gemini", cache_enabled=True), cache=self.cache, meter=self.meter)

    def tearDown(self):
        self.temp.cleanup()

    def handler(self, request):
        self.calls.append(request.content.decode())
        return gemini_answer(GOOD)

    def analyse(self, who, **extra):
        prepared = self.analyzer.prepare("job", item(id=who, **extra), local_collections=extra.pop("mine", ()), cache_url=URL)
        return self.analyzer.run([prepared])["job"]

    def test_a_public_post_is_analysed_once_for_everyone(self):
        first = self.analyse("alice-item")
        second = self.analyse("bob-item")
        self.assertFalse(first.cache_hit)
        self.assertTrue(second.cache_hit)
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(second.result["suggested_title"], first.result["suggested_title"])
        self.assertEqual(len(self.recorder.of("cache_hit")), 1)
        self.assertEqual(self.recorder.of("cache_hit")[0].model_calls, 0)

    def test_the_cache_holds_nothing_private(self):
        private = dict(notes="SECRET-NOTE-ALICE", tags=["private-tag"], favorite=True, status="to_revisit", collections=[{"name": "ALICE-PRIVATE-SHELF"}], saved_by="alice@example.com", source_account="alice-account")
        prepared = self.analyzer.prepare("job", item(id="alice-item", title="Alice's own title", **private), local_collections=("ALICE-PRIVATE-SHELF",), cache_url=URL)
        self.assertNotIn("SECRET-NOTE-ALICE", self.calls and self.calls[0] or "")
        outcome = self.analyzer.run([prepared])["job"]
        self.assertTrue(outcome.result)
        self.assertNotIn("SECRET-NOTE-ALICE", self.calls[0])
        with sqlite3.connect(self.path) as db:
            rows = db.execute("SELECT url,kind,input_hash,payload FROM public_posts").fetchall()
        self.assertEqual(len(rows), 1)
        dump = json.dumps(rows) + self.path.read_bytes().decode("latin-1")
        for private_text in ("SECRET-NOTE-ALICE", "private-tag", "ALICE-PRIVATE-SHELF", "alice@example.com", "alice-account", "alice-item", "to_revisit", "suggested_folder"):
            self.assertNotIn(private_text, dump)
        self.assertLessEqual(set(json.loads(rows[0][3])), ALLOWED["analysis"])

    def test_the_owner_specific_folder_is_added_after_the_cache(self):
        alice = self.analyse("a", mine=())
        bob_prepared = self.analyzer.prepare("job", item(id="b"), local_collections=("Sourdough Recipes",), cache_url=URL)
        bob = self.analyzer.run([bob_prepared])["job"]
        self.assertTrue(bob.cache_hit)
        self.assertEqual(alice.result["suggested_folder"], "Food & Recipes")
        self.assertEqual(bob.result["suggested_folder"], "Sourdough Recipes")

    def test_a_client_cannot_poison_what_others_are_shown(self):
        self.analyse("honest")
        # Someone submits different text for the same URL: no hit, so no way to overwrite another person's result.
        forged = self.analyze_with(caption="Buy cheap pills at example.invalid")
        self.assertFalse(forged.cache_hit)
        self.assertEqual(len(self.calls), 2)
        again = self.analyse("later-honest")
        self.assertTrue(again.cache_hit)

    def analyze_with(self, **extra):
        return self.analyzer.run([self.analyzer.prepare("job", item(id="forger", **extra), cache_url=URL)])["job"]

    def test_entries_expire_and_unknown_kinds_are_refused(self):
        from datetime import datetime, timedelta, timezone
        now = {"t": datetime(2026, 11, 14, tzinfo=timezone.utc)}
        cache = PublicPostCache(Path(self.temp.name) / "ttl.sqlite3", ttl_days=1, clock=lambda: now["t"])
        cache.put(URL, "transcript", {"text": "hello", "language": "en"})
        self.assertEqual(cache.get(URL, "transcript")["text"], "hello")
        now["t"] += timedelta(days=2)
        self.assertIsNone(cache.get(URL, "transcript"))
        with self.assertRaises(ValueError):
            cache.put(URL, "notes", {"text": "x"})
        with self.assertRaises(ValueError):
            cache.get(URL, "notes")

    def test_writes_drop_every_field_that_is_not_allowlisted(self):
        self.cache.put(URL, "extraction", {"caption": "public", "notes": "secret", "tags": ["x"], "owner": "alice", "collections": ["y"]})
        stored = self.cache.get(URL, "extraction")
        self.assertEqual(stored, {"caption": "public"})
        self.assertFalse(self.cache.put(URL, "extraction", {"notes": "only secrets"}))
        self.assertFalse(self.cache.put(URL, "transcript", {"text": "x" * 70000}))

    def test_provider_or_prompt_changes_do_not_reuse_old_results(self):
        self.analyse("a")
        other = GeminiProvider("k-synthetic", "another-model", client=client_for(self.handler), sleep=lambda s: None)
        analyzer = Analyzer(other, EnrichSettings(ai_provider="gemini", cache_enabled=True), cache=self.cache, meter=self.meter)
        self.assertFalse(analyzer.run([analyzer.prepare("job", item(id="x"), cache_url=URL)])["job"].cache_hit)

    def test_without_a_cache_url_nothing_is_stored(self):
        self.analyzer.run([self.analyzer.prepare("job", item(id="z"), cache_url=None)])
        self.assertEqual(self.cache.stats(), {})


if __name__ == "__main__":
    unittest.main()
