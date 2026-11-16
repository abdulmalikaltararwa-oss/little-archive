from dataclasses import dataclass, field
from pathlib import Path
import os
import re
import unicodedata
from urllib.parse import urlsplit

from .webui import is_public


SELF_HOSTED, HOSTED = "self-hosted", "hosted"
LOOPBACK = {"localhost", "127.0.0.1", "::1"}


def _unsafe_text(value):
    return any(unicodedata.category(c) in {"Cc", "Cs", "Zl", "Zp"} for c in value)


def _whole_number(values, key, default):
    raw = str(values.get(key, "")).strip()
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError as exc:
        raise ValueError(f"{key} must be a whole number.") from exc


@dataclass(frozen=True)
class Config:
    data_dir: Path
    admin_password: str = ""
    public_url: str = "http://localhost:8787"
    ollama_url: str = ""
    ollama_model: str = ""
    session_hours: int = 24
    testing: bool = False
    # Self-hosted device tokens (server/devices.py): idle expiry, and an optional hard lifetime. 0 turns a rule off.
    device_token_idle_days: int = 180
    device_token_max_days: int = 0
    # Hosted multi-user mode is opt-in. Every default below leaves the
    # single-owner instance exactly as it is without these settings.
    mode: str = SELF_HOSTED
    supabase_url: str = ""
    supabase_jwt_secret: str = ""
    supabase_jwt_audience: str = "authenticated"
    supabase_jwt_issuer: str = ""
    hosted_storage_quota_mb: int = 500
    hosted_max_json_kb: int = 512
    hosted_max_upload_mb: int = 8
    hosted_max_thumbnail_mb: int = 4
    hosted_open_libraries: int = 64
    hosted_deep_reads_monthly: int = 300
    hosted_free_deep_reads_monthly: int = 0
    # Ordinary AI suggestions per account (titles, folders, summaries): what a free and an unlocked account may queue.
    hosted_suggestions_daily_free: int = 25
    hosted_suggestions_monthly_free: int = 300
    hosted_suggestions_daily_unlocked: int = 200
    hosted_suggestions_monthly_unlocked: int = 3000
    # Feature calls: the model calls and geocoder requests behind recipe cards, places and ask-your-archive. Those features are part of
    # the unlock, so a free account has 0 unless the operator gives it some (which also opens the features to it).
    hosted_feature_calls_daily_free: int = 0
    hosted_feature_calls_monthly_free: int = 0
    hosted_feature_calls_daily_unlocked: int = 100
    hosted_feature_calls_monthly_unlocked: int = 1500
    # Request limits, in this process's memory (see server/limits.py). 0 turns a rate limit off.
    hosted_rate_address_per_minute: int = 600
    hosted_rate_account_per_minute: int = 300
    hosted_rate_auth_failures: int = 30          # failed sign-ins an address may make per ten minutes
    hosted_trusted_proxy_hops: int = 0           # reverse proxies in front of this server that append to X-Forwarded-For
    hosted_heavy_per_account: int = 2            # exports, backups, imports and thumbnail uploads running at once, per account
    hosted_heavy_overall: int = 8                # ... and for the whole service
    # Account deletion also deletes the person's Supabase sign-in, which needs the project's secret key (never logged, never
    # shown, never returned by any route). Starting hosted mode without it is refused unless the operator says so.
    supabase_service_key: str = field(default="", repr=False)
    hosted_allow_login_survives_deletion: bool = False
    # The one-time unlock, as the stores know it. All of these are placeholders until the app is listed: change them to the real ids.
    apple_bundle_id: str = "app.littlearchive.mobile"
    apple_product_id: str = "unlock_full"
    apple_environments: str = "Production"   # "Production", or "Production,Sandbox" while the app is in review or TestFlight
    apple_app_id: int = 0                    # the numeric App Store id; if set, notifications must carry it
    google_package_name: str = "app.littlearchive.mobile"
    google_product_id: str = "unlock_full"
    google_service_account_file: str = field(default="", repr=False)   # a path; the key file itself is never in the repository
    google_allow_test_purchases: bool = False
    google_rtdn_audience: str = ""
    google_rtdn_service_account: str = ""
    # The same unlock sold on the web through Tap Payments (server/purchases/tap.py). Off until both the key and the price are set.
    tap_secret_key: str = field(default="", repr=False)   # sk_test_... or sk_live_...; never logged, shown or returned by any route
    tap_price: str = ""                      # what the unlock costs, as a decimal in the currency's own places: "2.500" for KWD
    tap_currency: str = "KWD"
    tap_return_url: str = ""                 # where Tap sends the buyer afterwards; empty means this server's own small page
    tap_merchant_id: str = ""                # only for a Tap account with more than one merchant
    tap_allow_test_purchases: bool = False   # with a live key: keep counting unlocks that were paid for with a test card
    # The pay page (/pay, server/purchases/pay.py) signs a buyer in at the Supabase project from a browser, which needs the project's
    # publishable key. That key is public by design (the phone app ships with it); it is not the secret key above.
    supabase_publishable_key: str = ""
    public_site_url: str = "https://abdulmalikaltararwa-oss.github.io/little-archive"   # where privacy.html and terms.html are published
    # Sign in with Apple, revoked when an account is deleted (server/apple_signin.py). All four or none: the team id, the id of the
    # team's Sign in with Apple key, the client id (the app's bundle id) and the key itself, given inline or as a path to the .p8 file.
    apple_signin_team_id: str = ""
    apple_signin_key_id: str = ""
    apple_signin_client_id: str = ""
    apple_signin_private_key: str = field(default="", repr=False)
    apple_signin_private_key_file: str = field(default="", repr=False)   # a path; the key file itself is never in the repository

    @classmethod
    def from_env(cls, values=None):
        values = os.environ if values is None else values
        return cls(
            data_dir=Path(values.get("LA_DATA_DIR", "./data")).resolve(),
            admin_password=values.get("LA_ADMIN_PASSWORD", ""),
            public_url=values.get("LA_PUBLIC_URL", "http://localhost:8787").rstrip("/"),
            ollama_url=values.get("LA_OLLAMA_URL", "").rstrip("/"),
            ollama_model=values.get("LA_OLLAMA_MODEL", ""),
            device_token_idle_days=_whole_number(values, "LA_DEVICE_TOKEN_IDLE_DAYS", 180),
            device_token_max_days=_whole_number(values, "LA_DEVICE_TOKEN_MAX_DAYS", 0),
            mode=values.get("LA_MODE", "").strip().lower() or SELF_HOSTED,
            supabase_url=values.get("LA_SUPABASE_URL", "").strip().rstrip("/"),
            supabase_jwt_secret=values.get("LA_SUPABASE_JWT_SECRET", ""),
            supabase_jwt_audience=values.get("LA_SUPABASE_JWT_AUDIENCE", "").strip() or "authenticated",
            supabase_jwt_issuer=values.get("LA_SUPABASE_JWT_ISSUER", "").strip(),
            hosted_storage_quota_mb=_whole_number(values, "LA_HOSTED_STORAGE_QUOTA_MB", 500),
            hosted_max_json_kb=_whole_number(values, "LA_HOSTED_MAX_JSON_KB", 512),
            hosted_max_upload_mb=_whole_number(values, "LA_HOSTED_MAX_UPLOAD_MB", 8),
            hosted_max_thumbnail_mb=_whole_number(values, "LA_HOSTED_MAX_THUMBNAIL_MB", 4),
            hosted_open_libraries=_whole_number(values, "LA_HOSTED_OPEN_LIBRARIES", 64),
            hosted_deep_reads_monthly=_whole_number(values, "LA_HOSTED_DEEP_READS_MONTHLY", 300),
            hosted_free_deep_reads_monthly=_whole_number(values, "LA_HOSTED_FREE_DEEP_READS_MONTHLY", 0),
            hosted_suggestions_daily_free=_whole_number(values, "LA_HOSTED_SUGGESTIONS_DAILY_FREE", 25),
            hosted_suggestions_monthly_free=_whole_number(values, "LA_HOSTED_SUGGESTIONS_MONTHLY_FREE", 300),
            hosted_suggestions_daily_unlocked=_whole_number(values, "LA_HOSTED_SUGGESTIONS_DAILY_UNLOCKED", 200),
            hosted_suggestions_monthly_unlocked=_whole_number(values, "LA_HOSTED_SUGGESTIONS_MONTHLY_UNLOCKED", 3000),
            hosted_feature_calls_daily_free=_whole_number(values, "LA_HOSTED_FEATURE_CALLS_DAILY_FREE", 0),
            hosted_feature_calls_monthly_free=_whole_number(values, "LA_HOSTED_FEATURE_CALLS_MONTHLY_FREE", 0),
            hosted_feature_calls_daily_unlocked=_whole_number(values, "LA_HOSTED_FEATURE_CALLS_DAILY_UNLOCKED", 100),
            hosted_feature_calls_monthly_unlocked=_whole_number(values, "LA_HOSTED_FEATURE_CALLS_MONTHLY_UNLOCKED", 1500),
            hosted_rate_address_per_minute=_whole_number(values, "LA_HOSTED_RATE_ADDRESS_PER_MINUTE", 600),
            hosted_rate_account_per_minute=_whole_number(values, "LA_HOSTED_RATE_ACCOUNT_PER_MINUTE", 300),
            hosted_rate_auth_failures=_whole_number(values, "LA_HOSTED_RATE_AUTH_FAILURES", 30),
            hosted_trusted_proxy_hops=_whole_number(values, "LA_HOSTED_TRUSTED_PROXY_HOPS", 0),
            hosted_heavy_per_account=_whole_number(values, "LA_HOSTED_HEAVY_PER_ACCOUNT", 2),
            hosted_heavy_overall=_whole_number(values, "LA_HOSTED_HEAVY_OVERALL", 8),
            supabase_service_key=values.get("LA_SUPABASE_SERVICE_KEY", "").strip(),
            hosted_allow_login_survives_deletion=str(values.get("LA_HOSTED_ALLOW_LOGIN_SURVIVES_DELETION", "")).strip().lower() in {"1", "true", "yes", "on"},
            apple_bundle_id=values.get("LA_APPLE_BUNDLE_ID", "").strip() or "app.littlearchive.mobile",
            apple_product_id=values.get("LA_APPLE_PRODUCT_ID", "").strip() or "unlock_full",
            apple_environments=values.get("LA_APPLE_ENVIRONMENTS", "").strip() or "Production",
            apple_app_id=_whole_number(values, "LA_APPLE_APP_ID", 0),
            google_package_name=values.get("LA_GOOGLE_PACKAGE_NAME", "").strip() or "app.littlearchive.mobile",
            google_product_id=values.get("LA_GOOGLE_PRODUCT_ID", "").strip() or "unlock_full",
            google_service_account_file=values.get("LA_GOOGLE_SERVICE_ACCOUNT_FILE", "").strip(),
            google_allow_test_purchases=str(values.get("LA_GOOGLE_ALLOW_TEST_PURCHASES", "")).strip().lower() in {"1", "true", "yes", "on"},
            google_rtdn_audience=values.get("LA_GOOGLE_RTDN_AUDIENCE", "").strip(),
            google_rtdn_service_account=values.get("LA_GOOGLE_RTDN_SERVICE_ACCOUNT", "").strip(),
            tap_secret_key=values.get("LA_TAP_SECRET_KEY", "").strip(),
            tap_price=values.get("LA_TAP_PRICE", "").strip(),
            tap_currency=values.get("LA_TAP_CURRENCY", "").strip().upper() or "KWD",
            tap_return_url=values.get("LA_TAP_RETURN_URL", "").strip(),
            tap_merchant_id=values.get("LA_TAP_MERCHANT_ID", "").strip(),
            tap_allow_test_purchases=str(values.get("LA_TAP_ALLOW_TEST_PURCHASES", "")).strip().lower() in {"1", "true", "yes", "on"},
            supabase_publishable_key=values.get("LA_SUPABASE_PUBLISHABLE_KEY", "").strip(),
            public_site_url=values.get("LA_PUBLIC_SITE_URL", "").strip().rstrip("/") or "https://abdulmalikaltararwa-oss.github.io/little-archive",
            apple_signin_team_id=values.get("LA_APPLE_SIGNIN_TEAM_ID", "").strip(),
            apple_signin_key_id=values.get("LA_APPLE_SIGNIN_KEY_ID", "").strip(),
            apple_signin_client_id=values.get("LA_APPLE_SIGNIN_CLIENT_ID", "").strip(),
            apple_signin_private_key=values.get("LA_APPLE_SIGNIN_PRIVATE_KEY", "").strip(),
            apple_signin_private_key_file=values.get("LA_APPLE_SIGNIN_PRIVATE_KEY_FILE", "").strip(),
        )

    def validate(self):
        if is_public(self.data_dir):
            raise ValueError("LA_DATA_DIR must be outside the public web directory.")
        if any(unicodedata.category(c) in {"Cc", "Cs", "Zl", "Zp"} for c in self.public_url) or len(self.public_url) > 2048:
            raise ValueError("Use a bounded public origin without control characters.")
        p = urlsplit(self.public_url)
        _ = p.port
        if p.scheme not in {"http", "https"} or not p.hostname or p.username or p.password or p.path not in {"", "/"} or p.query or p.fragment:
            raise ValueError("LA_PUBLIC_URL must be the application's HTTP(S) origin, without a path.")
        if p.scheme == "http" and p.hostname not in {"localhost", "127.0.0.1", "::1"} and not self.testing:
            raise ValueError("Use HTTPS for a non-loopback LA_PUBLIC_URL.")
        if bool(self.ollama_url) != bool(self.ollama_model):
            raise ValueError("Set both LA_OLLAMA_URL and LA_OLLAMA_MODEL, or neither.")
        if self.ollama_url:
            if any(unicodedata.category(c) in {"Cc", "Cs", "Zl", "Zp"} for c in self.ollama_url) or len(self.ollama_url) > 2048:
                raise ValueError("Use a bounded model origin without control characters.")
            m = urlsplit(self.ollama_url)
            _ = m.port
            if m.scheme not in {"http", "https"} or not m.hostname or m.username or m.password or m.query or m.fragment or m.path not in {"", "/"}:
                raise ValueError("LA_OLLAMA_URL must be an operator-configured HTTP(S) origin.")
            if not self.ollama_model.strip() or len(self.ollama_model) > 200 or any(unicodedata.category(c) in {"Cc", "Cs", "Zl", "Zp"} for c in self.ollama_model):
                raise ValueError("Use a model name under 201 characters without control characters.")
        if not 1 <= self.session_hours <= 168:
            raise ValueError("Session lifetime must be between one hour and seven days.")
        for label, value in (("LA_DEVICE_TOKEN_IDLE_DAYS", self.device_token_idle_days), ("LA_DEVICE_TOKEN_MAX_DAYS", self.device_token_max_days)):
            if not isinstance(value, int) or isinstance(value, bool) or not 0 <= value <= 3650:
                raise ValueError(f"{label} must be a whole number of days from 0 (off) to 3650.")
        self._validate_mode()
        self._validate_apple_signin()

    def _validate_mode(self):
        if self.mode not in {SELF_HOSTED, HOSTED}:
            raise ValueError("LA_MODE must be self-hosted (the default) or hosted.")
        if self.mode == SELF_HOSTED:
            # A half-configured identity provider must never look like it is in effect.
            if self.supabase_url or self.supabase_jwt_secret or self.supabase_jwt_issuer or self.supabase_service_key or self.supabase_publishable_key:
                raise ValueError("LA_SUPABASE_* settings apply only with LA_MODE=hosted. Remove them or set LA_MODE=hosted.")
            return
        if self.admin_password:
            raise ValueError("Hosted mode has no owner password. Remove LA_ADMIN_PASSWORD when LA_MODE=hosted.")
        for label, value in (("LA_SUPABASE_URL", self.supabase_url), ("LA_SUPABASE_JWT_ISSUER", self.supabase_jwt_issuer)):
            if _unsafe_text(value) or len(value) > 2048:
                raise ValueError(f"{label} must be bounded text without control characters.")
        if not self.supabase_url:
            raise ValueError("Set LA_SUPABASE_URL to your Supabase project URL for hosted mode.")
        s = urlsplit(self.supabase_url)
        _ = s.port
        if s.scheme not in {"http", "https"} or not s.hostname or s.username or s.password or s.path not in {"", "/"} or s.query or s.fragment:
            raise ValueError("LA_SUPABASE_URL must be the project's HTTP(S) origin, without a path.")
        # Signing keys are fetched from this origin, so it is as sensitive as a key.
        if s.scheme == "http" and s.hostname not in LOOPBACK:
            raise ValueError("Use HTTPS for a non-loopback LA_SUPABASE_URL.")
        if self.supabase_jwt_issuer:
            i = urlsplit(self.supabase_jwt_issuer)
            if i.scheme not in {"http", "https"} or not i.hostname or i.username or i.password or i.query or i.fragment:
                raise ValueError("LA_SUPABASE_JWT_ISSUER must be the issuer URL from your project's access tokens.")
        if self.supabase_jwt_secret and (len(self.supabase_jwt_secret.encode()) < 32 or len(self.supabase_jwt_secret) > 1024 or _unsafe_text(self.supabase_jwt_secret)):
            raise ValueError("LA_SUPABASE_JWT_SECRET must be the project's legacy JWT secret (at least 32 bytes), or empty.")
        if not self.supabase_jwt_audience or len(self.supabase_jwt_audience) > 200 or _unsafe_text(self.supabase_jwt_audience):
            raise ValueError("LA_SUPABASE_JWT_AUDIENCE must be a short audience name.")
        for label, value, low, high in (
            ("LA_HOSTED_STORAGE_QUOTA_MB", self.hosted_storage_quota_mb, 1, 1024 * 1024),
            ("LA_HOSTED_MAX_JSON_KB", self.hosted_max_json_kb, 64, 16 * 1024),
            ("LA_HOSTED_MAX_UPLOAD_MB", self.hosted_max_upload_mb, 1, 64),
            ("LA_HOSTED_MAX_THUMBNAIL_MB", self.hosted_max_thumbnail_mb, 1, 8),
            ("LA_HOSTED_OPEN_LIBRARIES", self.hosted_open_libraries, 1, 4096),
            ("LA_HOSTED_DEEP_READS_MONTHLY", self.hosted_deep_reads_monthly, 0, 1000000),
            ("LA_HOSTED_FREE_DEEP_READS_MONTHLY", self.hosted_free_deep_reads_monthly, 0, 1000000),
            ("LA_HOSTED_SUGGESTIONS_DAILY_FREE", self.hosted_suggestions_daily_free, 0, 1000000),
            ("LA_HOSTED_SUGGESTIONS_MONTHLY_FREE", self.hosted_suggestions_monthly_free, 0, 1000000),
            ("LA_HOSTED_SUGGESTIONS_DAILY_UNLOCKED", self.hosted_suggestions_daily_unlocked, 0, 1000000),
            ("LA_HOSTED_SUGGESTIONS_MONTHLY_UNLOCKED", self.hosted_suggestions_monthly_unlocked, 0, 1000000),
            ("LA_HOSTED_FEATURE_CALLS_DAILY_FREE", self.hosted_feature_calls_daily_free, 0, 1000000),
            ("LA_HOSTED_FEATURE_CALLS_MONTHLY_FREE", self.hosted_feature_calls_monthly_free, 0, 1000000),
            ("LA_HOSTED_FEATURE_CALLS_DAILY_UNLOCKED", self.hosted_feature_calls_daily_unlocked, 0, 1000000),
            ("LA_HOSTED_FEATURE_CALLS_MONTHLY_UNLOCKED", self.hosted_feature_calls_monthly_unlocked, 0, 1000000),
            ("LA_HOSTED_RATE_ADDRESS_PER_MINUTE", self.hosted_rate_address_per_minute, 0, 1000000),
            ("LA_HOSTED_RATE_ACCOUNT_PER_MINUTE", self.hosted_rate_account_per_minute, 0, 1000000),
            ("LA_HOSTED_RATE_AUTH_FAILURES", self.hosted_rate_auth_failures, 0, 100000),
            ("LA_HOSTED_TRUSTED_PROXY_HOPS", self.hosted_trusted_proxy_hops, 0, 5),
            ("LA_HOSTED_HEAVY_PER_ACCOUNT", self.hosted_heavy_per_account, 1, 64),
            ("LA_HOSTED_HEAVY_OVERALL", self.hosted_heavy_overall, 1, 1024),
        ):
            if not isinstance(value, int) or isinstance(value, bool) or not low <= value <= high:
                raise ValueError(f"{label} must be between {low} and {high}.")
        self._validate_purchases()
        if self.supabase_service_key:
            key = self.supabase_service_key
            if _unsafe_text(key) or len(key) > 4096 or len(key) < 20 or any(c.isspace() for c in key):
                raise ValueError("LA_SUPABASE_SERVICE_KEY must be the project's secret key (sb_secret_...) or its legacy service_role key, on one line.")
            if key.startswith("sb_publishable_"):
                raise ValueError("LA_SUPABASE_SERVICE_KEY holds a publishable key. Use the project's secret key; a publishable key can delete nobody.")

    def _validate_purchases(self):
        for label, value, pattern in (("LA_APPLE_BUNDLE_ID", self.apple_bundle_id, r"[A-Za-z0-9.-]{1,155}"), ("LA_GOOGLE_PACKAGE_NAME", self.google_package_name, r"[A-Za-z0-9._]{1,155}"),
                                      ("LA_APPLE_PRODUCT_ID", self.apple_product_id, r"[A-Za-z0-9._-]{1,100}"), ("LA_GOOGLE_PRODUCT_ID", self.google_product_id, r"[A-Za-z0-9._-]{1,100}")):
            if not re.fullmatch(pattern, value):
                raise ValueError(f"{label} must be a store identifier (letters, digits and . _ - only).")
        environments = [part.strip() for part in self.apple_environments.split(",")]
        if not environments or any(part not in {"Production", "Sandbox"} for part in environments):
            raise ValueError("LA_APPLE_ENVIRONMENTS must be Production, Sandbox, or both separated by a comma.")
        if not isinstance(self.apple_app_id, int) or isinstance(self.apple_app_id, bool) or not 0 <= self.apple_app_id < 10 ** 15:
            raise ValueError("LA_APPLE_APP_ID must be the app's numeric App Store id, or 0.")
        if bool(self.google_rtdn_audience) != bool(self.google_rtdn_service_account):
            raise ValueError("Set both LA_GOOGLE_RTDN_AUDIENCE and LA_GOOGLE_RTDN_SERVICE_ACCOUNT, or neither.")
        if self.google_rtdn_audience and not self.google_service_account_file:
            raise ValueError("Google real-time notifications need LA_GOOGLE_SERVICE_ACCOUNT_FILE, because each one is checked by asking Google again.")
        for label, value in (("LA_GOOGLE_RTDN_AUDIENCE", self.google_rtdn_audience), ("LA_GOOGLE_RTDN_SERVICE_ACCOUNT", self.google_rtdn_service_account), ("LA_GOOGLE_SERVICE_ACCOUNT_FILE", self.google_service_account_file)):
            if _unsafe_text(value) or len(value) > 2048:
                raise ValueError(f"{label} must be bounded text without control characters.")
        if self.google_service_account_file and not Path(self.google_service_account_file).is_absolute():
            raise ValueError("LA_GOOGLE_SERVICE_ACCOUNT_FILE must be an absolute path.")
        if self.google_service_account_file and Path(self.google_service_account_file).resolve().is_relative_to((Path(__file__).resolve().parent.parent).resolve()):
            raise ValueError("LA_GOOGLE_SERVICE_ACCOUNT_FILE must be outside the source tree: a key file does not belong in the repository.")
        self._validate_tap()

    def _validate_tap(self):
        """Tap is off unless LA_TAP_SECRET_KEY and LA_TAP_PRICE are both set. No message here ever contains the key."""
        from .purchases.tap import DECIMALS, KEY, money
        if self.tap_secret_key and not KEY.fullmatch(self.tap_secret_key):
            raise ValueError("LA_TAP_SECRET_KEY must be a Tap secret key (sk_test_... or sk_live_...), on one line. A publishable key (pk_...) cannot make a charge.")
        if bool(self.tap_secret_key) != bool(self.tap_price):
            raise ValueError("Set both LA_TAP_SECRET_KEY and LA_TAP_PRICE, or neither.")
        if self.tap_currency not in DECIMALS:
            raise ValueError("LA_TAP_CURRENCY must be one of " + ", ".join(sorted(DECIMALS)) + ".")
        if self.tap_price:
            places = DECIMALS[self.tap_currency]
            amount = money(self.tap_price, self.tap_currency)
            if amount is None or len(self.tap_price) > 16 or not re.fullmatch(r"[0-9]+(\.[0-9]+)?", self.tap_price):
                raise ValueError(f"LA_TAP_PRICE must be a positive amount with at most {places} decimal places for {self.tap_currency}, such as {'2.500' if places == 3 else '9.99'}.")
            if self.tap_currency == "KWD" and amount * 10 < 1:
                raise ValueError("LA_TAP_PRICE must be at least 0.100 KWD, the smallest charge Tap makes.")
        self._validate_pay_page()
        if self.tap_merchant_id and not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", self.tap_merchant_id):
            raise ValueError("LA_TAP_MERCHANT_ID must be the merchant id from the Tap dashboard.")
        if self.tap_return_url:
            if _unsafe_text(self.tap_return_url) or len(self.tap_return_url) > 2048:
                raise ValueError("LA_TAP_RETURN_URL must be bounded text without control characters.")
            r = urlsplit(self.tap_return_url)
            _ = r.port
            if r.scheme not in {"http", "https"} or not r.hostname or r.username or r.password or r.query or r.fragment or (r.scheme == "http" and r.hostname not in LOOPBACK):
                raise ValueError("LA_TAP_RETURN_URL must be an HTTPS page address without a query; Tap adds ?tap_id=... to it.")

    def _validate_apple_signin(self):
        key, key_file = self.apple_signin_private_key, self.apple_signin_private_key_file
        given = [self.apple_signin_team_id, self.apple_signin_key_id, self.apple_signin_client_id, key or key_file]
        if not any(given):
            return
        if not self.hosted:
            raise ValueError("LA_APPLE_SIGNIN_* settings apply only with LA_MODE=hosted. Remove them or set LA_MODE=hosted.")
        if not all(given):
            raise ValueError("Set LA_APPLE_SIGNIN_TEAM_ID, LA_APPLE_SIGNIN_KEY_ID, LA_APPLE_SIGNIN_CLIENT_ID and the key (LA_APPLE_SIGNIN_PRIVATE_KEY or "
                             "LA_APPLE_SIGNIN_PRIVATE_KEY_FILE) together, or none of them.")
        if key and key_file:
            raise ValueError("Set LA_APPLE_SIGNIN_PRIVATE_KEY or LA_APPLE_SIGNIN_PRIVATE_KEY_FILE, not both.")
        for label, value in (("LA_APPLE_SIGNIN_TEAM_ID", self.apple_signin_team_id), ("LA_APPLE_SIGNIN_KEY_ID", self.apple_signin_key_id)):
            if not re.fullmatch(r"[A-Z0-9]{10}", value):
                raise ValueError(f"{label} must be the 10 capital letters and digits Apple shows for it.")
        if not re.fullmatch(r"[A-Za-z0-9.-]{1,155}", self.apple_signin_client_id):
            raise ValueError("LA_APPLE_SIGNIN_CLIENT_ID must be the app's bundle id (letters, digits and . - only), without the team id in front.")
        # Never echoed: a message about the key names the setting only.
        if key and (len(key) > 8192 or "PRIVATE KEY" not in key):
            raise ValueError("LA_APPLE_SIGNIN_PRIVATE_KEY must be the contents of the .p8 file, with its BEGIN and END lines (line breaks may be written as \\n).")
        if key_file:
            if _unsafe_text(key_file) or len(key_file) > 2048 or not Path(key_file).is_absolute():
                raise ValueError("LA_APPLE_SIGNIN_PRIVATE_KEY_FILE must be an absolute path.")
            if Path(key_file).resolve().is_relative_to((Path(__file__).resolve().parent.parent).resolve()):
                raise ValueError("LA_APPLE_SIGNIN_PRIVATE_KEY_FILE must be outside the source tree: a key file does not belong in the repository.")

    @property
    def apple_signin_configured(self):
        return bool(self.apple_signin_team_id and self.apple_signin_key_id and self.apple_signin_client_id and (self.apple_signin_private_key or self.apple_signin_private_key_file))

    def _validate_pay_page(self):
        """The two values the pay page shows a browser. The publishable key is public; anything that could be a secret key is refused,
        because this value is written into a page anyone can open."""
        key = self.supabase_publishable_key
        if key:
            role = ""
            if key.count(".") == 2:  # a legacy key is a JWT whose payload names its role: "anon" is public, "service_role" is the secret one
                import base64
                import json
                try:
                    payload = key.split(".")[1]
                    role = str(json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4))).get("role", ""))
                except (ValueError, AttributeError, UnicodeError):
                    role = "unreadable"
            if (_unsafe_text(key) or len(key) > 4096 or len(key) < 20 or any(c.isspace() for c in key) or key.startswith("sb_secret_") or key == self.supabase_service_key
                    or (key.count(".") == 2 and role != "anon") or (key.count(".") != 2 and not key.startswith("sb_publishable_"))):
                raise ValueError("LA_SUPABASE_PUBLISHABLE_KEY must be the project's publishable key (sb_publishable_...) or its legacy anon key. It is shown to browsers, so a secret key is refused.")
        site = self.public_site_url
        s = urlsplit(site)
        if _unsafe_text(site) or len(site) > 2048 or s.scheme != "https" or not s.hostname or s.username or s.password or s.query or s.fragment or any(c in site for c in "\"<>'"):
            raise ValueError("LA_PUBLIC_SITE_URL must be the HTTPS address of the public site, without a query.")

    def require_account_deletion(self):
        """Hosted mode must be able to delete a person's sign-in with their library (App Store guideline 5.1.1(v)).

        Called when the server starts and by `doctor`. Raises unless the Supabase secret key is set, or the operator has said in
        so many words that a deleted account's login should survive (a development stack with no real project). Test
        configurations are exempt, so the many tests that are not about deletion need no key.
        """
        if self.hosted and not (self.supabase_service_key or self.hosted_allow_login_survives_deletion or self.testing):
            raise ValueError("Set LA_SUPABASE_SERVICE_KEY to your Supabase project's secret key so that deleting an account also deletes its sign-in "
                             "(App Store guideline 5.1.1(v)). To run without it, for development only, set LA_HOSTED_ALLOW_LOGIN_SURVIVES_DELETION=true; "
                             "deleting an account then leaves the person able to sign in to a new, empty library.")

    @property
    def hosted(self):
        return self.mode == HOSTED

    @property
    def supabase_issuer(self):
        return self.supabase_jwt_issuer or self.supabase_url + "/auth/v1"

    @property
    def supabase_jwks_url(self):
        return self.supabase_url + "/auth/v1/.well-known/jwks.json"

    @property
    def secure_cookies(self):
        return self.public_url.startswith("https://")

    @property
    def allowed_hosts(self):
        return list({urlsplit(self.public_url).hostname, "localhost", "127.0.0.1", "::1"})
