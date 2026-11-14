"""Synthetic identity provider for hosted-mode tests. Nothing here uses a network.

Signing keys are generated in memory for each test and served by a fake key-set
fetcher, so every token is verified by the real code against real cryptography.
"""
from contextlib import ExitStack
import json
import time
from unittest.mock import patch
from uuid import uuid4

import jwt
from cryptography.hazmat.primitives.asymmetric import ec, rsa

from server.app import create_app
from server.config import Config
from server.enrich.understanding import AnalysisOutcome, ProviderUsage
from server.identity import SupabaseVerifier


SUPABASE_URL = "https://synthetic-project.supabase.test"
ISSUER = SUPABASE_URL + "/auth/v1"
LEGACY_SECRET = "synthetic-legacy-jwt-secret-of-at-least-32-bytes"


class SigningKey:
    """One asymmetric signing key as the provider would publish and use it."""

    def __init__(self, algorithm="ES256", kid=None):
        self.algorithm, self.kid = algorithm, kid or "key-" + uuid4().hex[:12]
        self.private = ec.generate_private_key(ec.SECP256R1()) if algorithm == "ES256" else rsa.generate_private_key(public_exponent=65537, key_size=2048)

    def jwk(self):
        name = "ECAlgorithm" if self.algorithm == "ES256" else "RSAAlgorithm"
        document = json.loads(getattr(jwt.algorithms, name).to_jwk(self.private.public_key()))
        return {**document, "kid": self.kid, "alg": self.algorithm, "use": "sig", "key_ops": ["verify"]}

    def sign(self, claims, headers=None):
        return jwt.encode(claims, self.private, algorithm=self.algorithm, headers={"kid": self.kid, **(headers or {})})


class FakeKeySet:
    """Stands in for `<supabase url>/auth/v1/.well-known/jwks.json`."""

    def __init__(self, *keys):
        self.keys, self.calls, self.failing, self.urls = list(keys), 0, False, []

    def __call__(self, url):
        self.calls += 1
        self.urls.append(url)
        if self.failing:
            raise OSError("synthetic key endpoint outage")
        return {"keys": [key.jwk() for key in self.keys]}


def claims(user_id, **changes):
    """The claims of a Supabase access token for a signed-in account."""
    moment = int(time.time())
    document = {
        "iss": ISSUER, "aud": "authenticated", "sub": user_id, "role": "authenticated",
        "iat": moment - 5, "exp": moment + 3600, "email": "synthetic@example.test",
        "is_anonymous": False, "session_id": str(uuid4()),
    }
    document.update(changes)
    return {name: value for name, value in document.items() if value is not None}


def hosted_config(root, **settings):
    return Config(data_dir=root / "data", public_url="http://testserver", testing=True, mode="hosted",
                  supabase_url=SUPABASE_URL, **settings)


def hosted_app(root, *keys, **settings):
    """A real hosted application whose only fake part is where signing keys come from."""
    config = hosted_config(root, **settings)
    keyset = FakeKeySet(*keys)
    app = create_app(config, identity=SupabaseVerifier.from_config(config, fetch=keyset))
    return app, keyset


def bearer(token):
    return {"Authorization": "Bearer " + token}


def no_worker_threads():
    """Keep either mode's background worker from starting; tests drive it one step at a time."""
    stack = ExitStack()
    stack.enter_context(patch("server.jobs.ClassificationWorker.start"))
    stack.enter_context(patch("server.tenancy.AccountWorker.start"))
    return stack


def fake_model(seen=None, before=None):
    """Stand in for the configured model: each item is titled after its own title, so a
    result that reached the wrong library would be visible."""
    def analyze(provider, batch):
        if before is not None:
            before(batch)
        outcomes = []
        for entry in batch:
            title = entry.evidence.source.get("title", "")
            if seen is not None:
                seen.append(title)
            result = {"suggested_title": "About " + title, "summary": "Synthetic summary.", "topics": ["example"],
                      "content_type": "link", "needs_review": True, "category": "Other", "collection": ""}
            outcomes.append(AnalysisOutcome(entry.key, result=result))
        return outcomes, ProviderUsage(1)
    return patch("server.enrich.understanding.OllamaProvider.analyze", autospec=True, side_effect=analyze)


class FakeTranscriber:
    """Enough of a transcription provider for a closer read to be offered; never called."""
    name, model = "synthetic", "synthetic-transcriber"

    def transcribe(self, audio, content_type, *, language=None):
        raise AssertionError("No audio is transcribed in these tests.")


def offer_closer_reads(library):
    """Make this library's understanding service consider a closer read available."""
    library.enrichment.configure(transcriber=FakeTranscriber(), fetcher=object())
    library.enrichment.update_settings(fetch_enabled=True)
