"""The provider call the new features share: one schema-constrained JSON answer. Shapes are checked against mock HTTP only;
neither a local model service nor the hosted API is contacted."""
import json
import unittest

import httpx

from server.enrich.understanding import GeminiProvider, OllamaProvider, ProviderError

SCHEMA = {"type": "object", "additionalProperties": False, "required": ["ok"], "properties": {"ok": {"type": "boolean"}}}
KEY = "AIza-SYNTHETIC-KEY-NEVER-REAL"


def client_for(handler):
    return httpx.Client(transport=httpx.MockTransport(handler))


class OllamaCompleteTests(unittest.TestCase):
    def provider(self, handler):
        return OllamaProvider("http://127.0.0.1:11434", "example:4b", client=client_for(handler))

    def test_the_request_carries_the_schema_and_the_answer_is_decoded(self):
        seen = []

        def handler(request):
            seen.append(json.loads(request.content))
            return httpx.Response(200, json={"done": True, "message": {"content": json.dumps({"ok": True})}, "prompt_eval_count": 30, "eval_count": 5})

        answer, usage = self.provider(handler).complete_json("system text", "user text", SCHEMA, max_tokens=500)
        self.assertEqual(answer, {"ok": True})
        self.assertEqual((usage.model_calls, usage.input_tokens, usage.output_tokens), (1, 30, 5))
        body = seen[0]
        self.assertEqual((body["format"], body["stream"], body["think"], body["options"]["temperature"], body["options"]["num_predict"]), (SCHEMA, False, False, 0, 500))
        self.assertEqual([m["role"] for m in body["messages"]], ["system", "user"])

    def test_failures_become_safe_messages(self):
        cases = {
            "an error status": httpx.Response(500, text="secret-body"),
            "an unfinished answer": httpx.Response(200, json={"done": True, "done_reason": "length", "message": {"content": "{}"}}),
            "not json": httpx.Response(200, json={"done": True, "message": {"content": "no json here"}}),
            "no message": httpx.Response(200, json={"done": True}),
        }
        for label, response in cases.items():
            with self.subTest(label):
                with self.assertRaises(ProviderError) as caught:
                    self.provider(lambda request, r=response: r).complete_json("s", "u", SCHEMA)
                self.assertNotIn("secret-body", str(caught.exception))

        def times_out(request):
            raise httpx.ReadTimeout("slow", request=request)
        with self.assertRaises(ProviderError) as caught:
            self.provider(times_out).complete_json("s", "u", SCHEMA)
        self.assertTrue(caught.exception.retryable)


class GeminiCompleteTests(unittest.TestCase):
    def provider(self, handler):
        return GeminiProvider(KEY, "gemini-test-model", client=client_for(handler), sleep=lambda s: None)

    @staticmethod
    def reply(payload, **extra):
        return httpx.Response(200, json={"candidates": [{"content": {"parts": [{"text": json.dumps(payload)}]}, "finishReason": "STOP"}], "usageMetadata": {"promptTokenCount": 40, "candidatesTokenCount": 7}, **extra})

    def test_the_key_travels_in_a_header_and_the_schema_in_the_body(self):
        seen = []

        def handler(request):
            seen.append(request)
            return self.reply({"ok": True})

        answer, usage = self.provider(handler).complete_json("system text", "user text", SCHEMA, max_tokens=300)
        self.assertEqual((answer, usage.input_tokens, usage.output_tokens), ({"ok": True}, 40, 7))
        request = seen[0]
        self.assertNotIn(KEY, str(request.url))
        self.assertEqual(request.headers["x-goog-api-key"], KEY)
        body = json.loads(request.content)
        self.assertEqual(body["generationConfig"]["responseJsonSchema"], SCHEMA)
        self.assertEqual((body["generationConfig"]["temperature"], body["generationConfig"]["maxOutputTokens"]), (0, 300))
        self.assertEqual(body["systemInstruction"]["parts"][0]["text"], "system text")
        self.assertEqual(body["contents"][0]["parts"][0]["text"], "user text")

    def test_one_retry_on_a_busy_service_then_a_clear_refusal(self):
        calls = []

        def busy(request):
            calls.append(1)
            return httpx.Response(429, text="slow down")
        with self.assertRaises(ProviderError) as caught:
            self.provider(busy).complete_json("s", "u", SCHEMA)
        self.assertEqual((len(calls), caught.exception.retryable), (2, True))

        answers = iter([httpx.Response(503, text="x"), self.reply({"ok": False})])
        self.assertEqual(self.provider(lambda request: next(answers)).complete_json("s", "u", SCHEMA)[0], {"ok": False})

    def test_blocked_or_incomplete_answers_are_refused_without_leaking_bodies(self):
        cases = {
            "blocked": httpx.Response(200, json={"promptFeedback": {"blockReason": "SAFETY"}, "candidates": []}),
            "cut off": httpx.Response(200, json={"candidates": [{"content": {"parts": [{"text": "{}"}]}, "finishReason": "MAX_TOKENS"}]}),
            "not json": httpx.Response(200, json={"candidates": [{"content": {"parts": [{"text": "plain words"}]}, "finishReason": "STOP"}]}),
            "rejected": httpx.Response(400, text="key=" + KEY),
        }
        for label, response in cases.items():
            with self.subTest(label):
                with self.assertRaises(ProviderError) as caught:
                    self.provider(lambda request, r=response: r).complete_json("s", "u", SCHEMA)
                self.assertNotIn(KEY, str(caught.exception))


if __name__ == "__main__":
    unittest.main()
