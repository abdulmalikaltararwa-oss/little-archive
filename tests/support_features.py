"""A harness for the recipe, places, ask and guided-import tests: one API, two server modes, no network.

`SelfHosted` is a single-owner library reached with a device token. `Hosted` is a multi-account server whose tokens are signed
with a locally generated key. Both expose `account()` (a caller with a library of its own), `call()` and `unlock()`, so a scenario
is written once and run against both. Providers and geocoders here are stubs that record what they were sent; nothing touches
a real model service or a real geocoder.
"""
from contextlib import ExitStack
from pathlib import Path
import tempfile
from uuid import uuid4

from fastapi.testclient import TestClient

from server.app import create_app
from server.config import Config
from server.enrich.understanding import ProviderUsage
from support_hosted import SigningKey, bearer, claims, hosted_app, no_worker_threads

PASSWORD = "feature-owner-password-2026"
FIXTURES = Path(__file__).parent / "fixtures"


class StubProvider:
    """Stands in for a model service. `answers` is a list of results (or one callable taking system and user text)."""
    name, model, max_batch = "stub", "stub-model-1", 1

    def __init__(self, answers=None, *, hosted=False):
        self.answers, self.calls, self.hosted = answers if answers is not None else [], [], hosted

    def identity(self):
        return {"provider": self.name, "model": self.model}

    def analyze(self, batch):
        raise AssertionError("These tests never classify.")

    def complete_json(self, system, user, schema, *, max_tokens=1024):
        self.calls.append({"system": system, "user": user, "schema": schema, "max_tokens": max_tokens})
        answer = self.answers(system, user) if callable(self.answers) else self.answers.pop(0)
        if isinstance(answer, Exception):
            raise answer
        return answer, ProviderUsage(1, 120, 40)


class Account:
    def __init__(self, harness, headers, user=None):
        self.harness, self.headers, self.user = harness, headers, user

    @property
    def library(self):
        return self.harness.library(self)

    @property
    def service(self):
        return self.library.enrichment

    def call(self, method, path, **kwargs):
        return self.harness.client.request(method, path, headers={**self.headers, **kwargs.pop("headers", {})}, **kwargs)

    def ok(self, method, path, **kwargs):
        response = self.call(method, path, **kwargs)
        assert response.status_code == 200, f"{method} {path}: {response.status_code} {response.text[:400]}"
        return response.json()

    def add_item(self, url="https://example.com/a", **fields):
        return self.ok("POST", "/api/items", json={"url": url, **fields})["id"]

    def configure(self, **parts):
        self.service.configure(**parts)

    def use(self, provider):
        self.service.configure(provider=provider)
        return provider


class _Harness:
    mode = ""

    def __init__(self, extra_settings=None):
        self.stack = ExitStack()
        self.temp = self.stack.enter_context(tempfile.TemporaryDirectory(prefix="little-archive-features-"))
        self.root = Path(self.temp)
        self.stack.enter_context(no_worker_threads())

    def close(self):
        self.stack.close()


class SelfHosted(_Harness):
    mode = "self-hosted"

    def __init__(self, allow_ai=True, **config):
        super().__init__()
        self.app = create_app(Config(data_dir=self.root / "data", admin_password=PASSWORD, public_url="http://testserver", testing=True, **config))
        if allow_ai:  # the owner has answered the AI sharing question, as in `Hosted`; test_ai_sharing.py covers the other answer
            self.app.state.store.set_meta("ai_sharing_allowed", "true")
        self.client = TestClient(self.app)
        self.client.__enter__()
        self.stack.callback(self.client.__exit__, None, None, None)
        paired = self.client.post("/api/auth/devices", json={"password": PASSWORD, "name": "Synthetic phone"})
        assert paired.status_code == 200, paired.text
        self._account = Account(self, bearer(paired.json()["token"]))

    def account(self):
        return self._account

    def library(self, account):
        return self.app.state.store

    def unlock(self, account):
        """A self-hosted owner is always unlocked."""


class Hosted(_Harness):
    mode = "hosted"

    def __init__(self, allow_ai=True, **settings):
        super().__init__()
        self.key = SigningKey()
        self.app, self.keyset = hosted_app(self.root, self.key, accounts_allow_ai=allow_ai, **settings)
        self.client = TestClient(self.app)
        self.client.__enter__()
        self.stack.callback(self.client.__exit__, None, None, None)

    def account(self, *, unlocked=True):
        user = str(uuid4())
        account = Account(self, bearer(self.key.sign(claims(user))), user)
        if unlocked:
            self.unlock(account)
        return account

    def library(self, account):
        return self.app.state.libraries.open(account.user)

    def unlock(self, account):
        self.app.state.entitlements.set_unlocked(account.user, True, source="synthetic-purchase")


MODES = (SelfHosted, Hosted)


def page_html(name):
    return (FIXTURES / "pages" / name).read_text()
