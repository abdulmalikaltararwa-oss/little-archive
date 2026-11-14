"""Synthetic identity provider for hosted-mode tests. Nothing here uses a network.

Signing keys are generated in memory for each test and served by a fake key-set
fetcher, so every token is verified by the real code against real cryptography.
"""
import json
import time
from uuid import uuid4

import jwt
from cryptography.hazmat.primitives.asymmetric import ec, rsa

from server.app import create_app
from server.config import Config
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
