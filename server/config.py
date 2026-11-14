from dataclasses import dataclass
from pathlib import Path
import os
import unicodedata
from urllib.parse import urlsplit


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

    @classmethod
    def from_env(cls, values=None):
        values = os.environ if values is None else values
        return cls(
            data_dir=Path(values.get("LA_DATA_DIR", "./data")).resolve(),
            admin_password=values.get("LA_ADMIN_PASSWORD", ""),
            public_url=values.get("LA_PUBLIC_URL", "http://localhost:8787").rstrip("/"),
            ollama_url=values.get("LA_OLLAMA_URL", "").rstrip("/"),
            ollama_model=values.get("LA_OLLAMA_MODEL", ""),
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
        )

    def validate(self):
        public_files = (Path(__file__).resolve().parent.parent / "web").resolve()
        if Path(self.data_dir).resolve().is_relative_to(public_files):
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
        self._validate_mode()

    def _validate_mode(self):
        if self.mode not in {SELF_HOSTED, HOSTED}:
            raise ValueError("LA_MODE must be self-hosted (the default) or hosted.")
        if self.mode == SELF_HOSTED:
            # A half-configured identity provider must never look like it is in effect.
            if self.supabase_url or self.supabase_jwt_secret or self.supabase_jwt_issuer:
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
        ):
            if not isinstance(value, int) or isinstance(value, bool) or not low <= value <= high:
                raise ValueError(f"{label} must be between {low} and {high}.")

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
