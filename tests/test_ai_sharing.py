"""The owner's AI sharing permission, enforced by the server (server/enrich/sharing.py).

Without ``ai_sharing_allowed`` nothing is sent to a hosted model, to a transcription service, or (on a hosted service) to
the operator's model: the routes refuse with ``ai_permission_required`` and the stub provider is never called. A self-hosted
server with a local model keeps working without it. The queue and worker side of the same rule is in test_enrich_api.py
(``SharingPermissionTests``) for a self-hosted library; the hosted worker, which serves every account from one thread, is here.
"""
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from uuid import uuid4

from fastapi.testclient import TestClient

from server.enrich.sharing import allowed, leaves_server
from server.enrich.understanding import AnalysisOutcome, ProviderUsage
from support_features import Hosted, SelfHosted, StubProvider
from support_hosted import SigningKey, bearer, claims, hosted_app, no_worker_threads, offer_closer_reads

MODEL = {"ollama_url": "http://127.0.0.1:1", "ollama_model": "synthetic-model"}
RECIPE_TEXT = "Pancakes. Ingredients: 2 cups flour, 2 eggs, 1 cup milk."
PLACE_TEXT = "Best bakery in Portville: Harbour Bakery on Quay Street."
REFUSAL = (403, "ai_permission_required")


def model(system, user):
    """A model that finds nothing, in the shape each feature asks for."""
    if system.startswith("You list the real-world places"):
        return {"places": []}
    if "recipe" in system.lower():
        return {"is_recipe": False, "reason": "none", "ingredients": [], "steps": []}
    return {"answerable": False, "answer": "", "citations": []}


class RuleTests(unittest.TestCase):
    """The one rule, beside the interface's (ui/src/features/ai-permission/disclosure.test.ts)."""

    def parts(self, *, provider=None, transcriber=False, hosted_service=False, auto=True, fetch=True):
        """Just enough of an understanding service for the rule to read."""
        return SimpleNamespace(config=SimpleNamespace(hosted=hosted_service), settings=SimpleNamespace(transcribe_auto=auto), fetch_enabled=fetch,
                               provider=None if provider is None else StubProvider(hosted=provider == "hosted"), transcriber=object() if transcriber else None)

    def leaves(self, **kwargs):
        parts = self.parts(**kwargs)
        return tuple(leaves_server(parts, what) for what in ("text", "media", "suggest"))

    def test_nothing_leaves_a_server_with_no_model_or_a_local_one(self):
        self.assertEqual(self.leaves(), (False, False, False))
        self.assertEqual(self.leaves(provider="local"), (False, False, False))

    def test_a_hosted_model_is_sent_the_text(self):
        self.assertEqual(self.leaves(provider="hosted"), (True, False, True))

    def test_on_a_hosted_service_even_the_operators_own_model_is_someone_elses_machine(self):
        self.assertEqual(self.leaves(provider="local", hosted_service=True), (True, False, True))
        self.assertEqual(self.leaves(hosted_service=True), (False, False, False), "with no model there is nothing to send")

    def test_a_transcription_always_leaves_and_a_suggestion_does_when_thin_captions_are_transcribed_by_themselves(self):
        self.assertEqual(self.leaves(provider="local", transcriber=True), (False, True, True))
        self.assertEqual(self.leaves(provider="local", transcriber=True, auto=False), (False, True, False))
        self.assertEqual(self.leaves(provider="local", transcriber=True, fetch=False), (False, True, False))
        self.assertEqual(self.leaves(transcriber=True), (False, True, False), "a closer read is all a server without a model can send")

    def test_an_unknown_kind_is_a_mistake_in_the_code_not_a_yes(self):
        with self.assertRaises(ValueError):
            leaves_server(self.parts(), "everything")


class FeatureRouteScenarios:
    """Recipes, places and ask, which call the model inside the request. Run against both kinds of server."""
    harness = None

    def setUp(self):
        self.h = self.harness(allow_ai=False)
        self.addCleanup(self.h.close)
        self.a = self.h.account()
        self.recipe = self.a.add_item("https://example.com/pancakes", title="Pancakes", caption=RECIPE_TEXT)
        self.place = self.a.add_item("https://example.com/bakery", title="Bakery", caption=PLACE_TEXT)

    def requests(self):
        return (("POST", f"/api/items/{self.recipe}/recipe/extract", {"method": "ai", "force": True}),
                ("POST", f"/api/items/{self.place}/places/extract", {"method": "ai", "force": True}),
                ("POST", "/api/ask", {"question": "Which pancakes did I save?"}))

    def allow(self, yes=True):
        self.assertEqual(self.a.ok("PATCH", "/api/settings", json={"ai_sharing_allowed": yes})["ai_sharing_allowed"], yes)

    def test_a_hosted_model_is_never_called_without_the_permission_and_is_once_it_is_given(self):
        provider = self.a.use(StubProvider(model, hosted=True))
        self.assertFalse(self.a.ok("GET", "/api/settings")["ai_sharing_allowed"], "off until the owner says yes")
        for method, path, body in self.requests():
            with self.subTest(path=path):
                refused = self.a.call(method, path, json=body)
                self.assertEqual((refused.status_code, refused.json()["code"]), REFUSAL)
                self.assertIn("has not been allowed", refused.json()["detail"])
        self.assertEqual(provider.calls, [], "nothing reached the model")
        self.allow()
        for method, path, body in self.requests():
            self.assertEqual(self.a.call(method, path, json=body).status_code, 200, path)
        self.assertEqual(len(provider.calls), 3)
        self.allow(False)
        for method, path, body in self.requests():
            self.assertEqual(self.a.call(method, path, json=body).json().get("code"), REFUSAL[1], "withdrawn: " + path)
        self.assertEqual(len(provider.calls), 3)

    def test_what_does_not_need_the_model_is_not_refused(self):
        provider = self.a.use(StubProvider(model, hosted=True))
        self.assertEqual(self.a.call("POST", f"/api/items/{self.recipe}/recipe/extract", json={"method": "rules"}).status_code, 200)
        self.assertEqual(self.a.call("POST", f"/api/items/{self.place}/places/extract", json={"method": "rules"}).status_code, 200)
        nothing = self.a.ok("POST", "/api/ask", json={"question": "Anything about zeppelins?"})
        self.assertEqual(nothing["mode"], "no_results", "a question that matches no save has nothing to send")
        self.assertEqual(self.a.ok("GET", "/api/items")["total"], 2)
        self.assertEqual(provider.calls, [])


class SelfHostedFeatureRoutes(FeatureRouteScenarios, unittest.TestCase):
    harness = SelfHosted

    def test_a_local_model_on_the_owners_server_needs_no_permission(self):
        provider = self.a.use(StubProvider(model, hosted=False))
        for method, path, body in self.requests():
            self.assertEqual(self.a.call(method, path, json=body).status_code, 200, path)
        self.assertEqual(len(provider.calls), 3)
        self.assertFalse(self.a.ok("GET", "/api/settings")["ai_sharing_allowed"])
        self.assertEqual(self.a.ok("GET", "/api/enrichment/status")["sharing"], {"needed": False, "allowed": False, "waiting": 0})


class HostedFeatureRoutes(FeatureRouteScenarios, unittest.TestCase):
    harness = Hosted

    def test_the_operators_own_model_needs_the_accounts_permission_too_and_a_refusal_is_not_charged(self):
        provider = self.a.use(StubProvider(model, hosted=False))
        for method, path, body in self.requests():
            refused = self.a.call(method, path, json=body)
            self.assertEqual((refused.status_code, refused.json()["code"]), REFUSAL, path)
        self.assertEqual(provider.calls, [])
        calls = self.a.ok("GET", "/api/account")["entitlements"]["feature_calls"]
        self.assertEqual((calls["daily"]["used"], calls["monthly"]["used"]), (0, 0))

    def test_the_answer_is_one_accounts_and_never_anothers(self):
        other = self.h.account()
        mine, theirs = self.a.use(StubProvider(model, hosted=True)), other.use(StubProvider(model, hosted=True))
        other.add_item("https://example.com/pancakes", title="Pancakes", caption=RECIPE_TEXT)
        self.allow()
        self.assertEqual(self.a.call("POST", "/api/ask", json={"question": "Which pancakes did I save?"}).status_code, 200)
        refused = other.call("POST", "/api/ask", json={"question": "Which pancakes did I save?"})
        self.assertEqual((refused.status_code, refused.json()["code"]), REFUSAL)
        self.assertEqual((len(mine.calls), theirs.calls), (1, []))


class RecordingModel:
    """Stands in for the operator's model on a hosted service and records the titles it was sent."""
    name, model, max_batch, hosted = "ollama", "synthetic-model", 1, False

    def __init__(self):
        self.seen = []

    def identity(self):
        return {"provider": self.name, "model": self.model}

    def analyze(self, batch):
        self.seen += [entry.evidence.source.get("title", "") for entry in batch]
        return [AnalysisOutcome(entry.key, result={"suggested_title": "About " + entry.evidence.source.get("title", ""), "summary": "Synthetic summary.", "topics": ["example"],
                                                    "content_type": "link", "needs_review": True, "category": "Other", "collection": ""}) for entry in batch], ProviderUsage(1)


class HostedQueueTests(unittest.TestCase):
    """Queued suggestions on a hosted service: held per account, without the shared thread spinning on them."""

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="little-archive-sharing-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.enterContext(no_worker_threads())
        self.key = SigningKey()
        self.app, _ = hosted_app(self.root, self.key, **MODEL, hosted_free_deep_reads_monthly=5)
        self.client = TestClient(self.app)
        self.client.__enter__()
        self.addCleanup(self.client.__exit__, None, None, None)
        self.worker, self.libraries = self.app.state.worker, self.app.state.libraries

    def account(self, name):
        user = str(uuid4())
        auth = bearer(self.key.sign(claims(user)))
        item = self.client.post("/api/items", json={"url": f"https://example.com/{name}", "title": name, "caption": "Text to classify."}, headers=auth).json()["id"]
        model = RecordingModel()
        self.libraries.open(user).enrichment.configure(provider=model)
        return user, auth, item, model

    def allow(self, auth, yes=True):
        self.assertEqual(self.client.patch("/api/settings", json={"ai_sharing_allowed": yes}, headers=auth).status_code, 200)

    def queue(self, auth, item):
        return self.client.post("/api/ai/jobs", json={"ids": [item]}, headers=auth)

    def counts(self, auth):
        return self.client.get("/api/ai/jobs", headers=auth).json()["counts"]

    def waiting(self, auth):
        return self.client.get("/api/enrichment/status", headers=auth).json()["sharing"]

    def steps(self, limit=20):
        """Run the shared worker until it says there is nothing to do; fail if it never does."""
        for count in range(limit):
            if not self.worker.step():
                return count
        self.fail("the worker kept finding work it could not do")

    def test_queueing_is_refused_before_anything_is_queued_or_charged(self):
        user, auth, item, model = self.account("alice")
        offer_closer_reads(self.libraries.open(user))
        for path, body in (("/api/ai/jobs", {"ids": [item]}), ("/api/ai/jobs", {"filters": {}}), (f"/api/items/{item}/deep-read", None)):
            refused = self.client.post(path, json=body, headers=auth)
            self.assertEqual((refused.status_code, refused.json()["code"]), REFUSAL, path)
        self.assertEqual(sum(self.counts(auth).values()), 0)
        used = self.client.get("/api/account", headers=auth).json()["entitlements"]
        self.assertEqual((used["suggestions"]["daily"]["used"], used["deep_reads"]["used"]), (0, 0))
        self.assertEqual(self.steps(), 0)
        self.assertEqual(model.seen, [])

    def test_a_withdrawn_permission_holds_the_accounts_queue_and_giving_it_again_releases_it(self):
        (_, a, hers, her_model), (_, b, his, his_model) = self.account("alice"), self.account("bob")
        for auth, item in ((a, hers), (b, his)):
            self.allow(auth)
            self.assertEqual(self.queue(auth, item).json()["queued"], 1)
        self.allow(a, False)
        self.assertEqual(self.waiting(a), {"needed": True, "allowed": False, "waiting": 1})
        self.assertLessEqual(self.steps(), 3, "bob's job is done and alice's held one does not keep the loop turning")
        self.assertEqual((her_model.seen, his_model.seen), ([], ["bob"]))
        self.assertEqual((self.counts(a)["queued"], self.counts(a)["failed"], self.counts(b)["completed"]), (1, 0, 1))
        self.assertEqual(self.steps(), 0, "nothing to do until she answers")
        retry = self.client.post(f"/api/ai/jobs/{self.client.get('/api/ai/jobs', headers=a).json()['jobs'][0]['id']}/retry", headers=a)
        self.assertEqual(retry.json().get("code"), REFUSAL[1])

        self.allow(a)
        self.assertEqual(self.waiting(a), {"needed": True, "allowed": True, "waiting": 0})
        self.assertGreaterEqual(self.steps(), 1)
        self.assertEqual(her_model.seen, ["alice"])
        self.assertEqual(self.counts(a)["completed"], 1)
        self.assertEqual(self.client.get(f"/api/items/{hers}", headers=a).json()["ai"]["suggested_title"], "About alice")

    def test_a_held_queue_is_picked_up_after_a_restart_once_the_permission_is_given(self):
        user, auth, item, _ = self.account("alice")
        self.allow(auth)
        self.queue(auth, item)
        self.allow(auth, False)
        self.assertEqual(self.steps(), 1, "looked at once, then set aside")
        restarted, _ = hosted_app(self.root, self.key, **MODEL)
        with TestClient(restarted) as client:
            model = RecordingModel()
            restarted.state.libraries.open(user).enrichment.configure(provider=model)
            self.assertFalse(restarted.state.worker.step())
            self.assertEqual(client.patch("/api/settings", json={"ai_sharing_allowed": True}, headers=auth).status_code, 200)
            self.assertTrue(restarted.state.worker.step())
            self.assertEqual(model.seen, ["alice"])

    def test_the_rule_is_read_from_each_accounts_own_library(self):
        (alice, a, _, _), (bob, _, _, _) = self.account("alice"), self.account("bob")
        self.allow(a)
        self.assertTrue(allowed(self.libraries.open(alice).enrichment, "text"))
        self.assertFalse(allowed(self.libraries.open(bob).enrichment, "text"))


if __name__ == "__main__":
    unittest.main()
