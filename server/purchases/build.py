"""Assemble the purchase service from the configuration: Apple's verifier (always, with the bundled root), Google's client only if a
service account file is configured, Tap's client only if a secret key and a price are configured, and the store that remembers which
account holds which purchase."""
from __future__ import annotations

from pathlib import Path
from urllib.parse import urlsplit

from .apple import AppleVerifier
from .google import GooglePlayClient, PushVerifier
from .service import PurchaseService
from .store import PurchaseStore
from .tap import HttpTapClient, money
from ..config import LOOPBACK


def build_purchases(config, entitlements, libraries, clients=None):
    """`clients` (tests) may replace `apple`, `google`, `push` and `tap`; anything it leaves out is built from the configuration."""
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
    # Tap sells the same unlock on the web. Without a secret key and a price there is no client, and its routes say "not configured".
    priced = bool(config.tap_price)
    if "tap" in clients:
        tap = clients["tap"]
    else:
        tap = HttpTapClient(config.tap_secret_key, merchant_id=config.tap_merchant_id) if config.tap_secret_key and priced else None
    origin = config.public_url.rstrip("/")
    store = PurchaseStore(libraries.accounts_path)
    libraries.on_delete.append(store.forget)
    return PurchaseService(store, entitlements, apple=apple, google=google, google_package=config.google_package_name, google_product=config.google_product_id,
                           google_allow_test=config.google_allow_test_purchases, push=push,
                           tap=tap, tap_amount=money(config.tap_price, config.tap_currency) if priced else None, tap_currency=config.tap_currency,
                           tap_redirect=config.tap_return_url or origin + "/api/purchases/tap/return",
                           # Tap cannot post to a loopback address, so a server on one is settled by the buyer's return alone.
                           tap_post="" if urlsplit(origin).hostname in LOOPBACK else origin + "/api/purchases/tap/notifications")
