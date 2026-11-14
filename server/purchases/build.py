"""Assemble the purchase service from the configuration: Apple's verifier (always, with the bundled root), Google's client only if a
service account file is configured, and the store that remembers which account holds which purchase."""
from __future__ import annotations

from pathlib import Path

from .apple import AppleVerifier
from .google import GooglePlayClient, PushVerifier
from .service import PurchaseService
from .store import PurchaseStore


def build_purchases(config, entitlements, libraries, clients=None):
    """`clients` (tests) may replace `apple`, `google` and `push`; anything it leaves out is built from the configuration."""
    clients = dict(clients or {})
    apple = clients["apple"] if "apple" in clients else AppleVerifier(config.apple_bundle_id, config.apple_product_id, tuple(part.strip() for part in config.apple_environments.split(",")), config.apple_app_id)
    if "google" in clients:
        google = clients["google"]
    else:
        google = GooglePlayClient.from_file(Path(config.google_service_account_file)) if config.google_service_account_file else None
    if "push" in clients:
        push = clients["push"]
    else:
        push = PushVerifier(config.google_rtdn_audience, config.google_rtdn_service_account) if google is not None and config.google_rtdn_audience else None
    store = PurchaseStore(libraries.accounts_path)
    libraries.on_delete.append(store.forget)
    return PurchaseService(store, entitlements, apple=apple, google=google, google_package=config.google_package_name, google_product=config.google_product_id,
                           google_allow_test=config.google_allow_test_purchases, push=push)
