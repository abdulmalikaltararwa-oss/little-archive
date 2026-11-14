"""Shared plumbing for the recipe, places and ask features and the guided backlog import.

Everything here is additive: the tables below are created beside the existing ones and are
never altered, an older build ignores them, and `backups.restore_backup` accepts a backup
with or without them. Nothing in this module calls a model by itself.

Three rules hold for every feature built on it:

* Honest degradation. With no provider a feature answers "not available" (a 503 with a
  machine-readable code) or uses a non-AI path whose result says it was not AI. Output is
  never made up to fill a gap.
* Evidence stays attached. Whatever a model contributed is checked against the text it was
  given, and the labels that describe it (``evidence_level``, ``evidence_sources``,
  ``evidence_note``) are computed from that input, never taken from the model.
* Hosted mode gates recipes, places and ask behind the account's one-time unlock, with a
  402 whose body carries ``code: "unlock_required"``. A self-hosted owner is never gated.
"""
from __future__ import annotations

from dataclasses import dataclass, field
import json
import logging
import re
import unicodedata

from fastapi import Depends, Request
from fastapi.responses import JSONResponse

from ..storage import normalize_search, now
from .understanding import ProviderError, build_evidence

log = logging.getLogger("little_archive.enrich")

FEATURES_SCHEMA_VERSION = 1

# Version 1. Add later steps to MIGRATIONS; ensure_features_schema applies every step the
# library has not seen, in order, so an existing library upgrades in place on its next start.
_V1 = """
CREATE TABLE IF NOT EXISTS item_recipe(
 item_id TEXT PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
 extracted TEXT,
 override TEXT,
 is_recipe INTEGER NOT NULL DEFAULT 0,
 method TEXT NOT NULL DEFAULT '',
 input_hash TEXT NOT NULL DEFAULT '',
 extracted_at TEXT,
 edited_at TEXT,
 updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_item_recipe_flag ON item_recipe(is_recipe,updated_at);
CREATE TABLE IF NOT EXISTS item_places(
 item_id TEXT PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
 extracted TEXT,
 override TEXT,
 method TEXT NOT NULL DEFAULT '',
 input_hash TEXT NOT NULL DEFAULT '',
 extracted_at TEXT,
 edited_at TEXT,
 updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS geocode_cache(
 key TEXT PRIMARY KEY,
 result TEXT NOT NULL,
 found INTEGER NOT NULL,
 fetched_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS guided_imports(
 id TEXT PRIMARY KEY,
 platform TEXT NOT NULL,
 source_account TEXT NOT NULL,
 filename TEXT NOT NULL,
 size_bytes INTEGER NOT NULL,
 chunk_size INTEGER NOT NULL,
 chunks_total INTEGER NOT NULL,
 state TEXT NOT NULL,
 error TEXT NOT NULL DEFAULT '',
 archive_sha256 TEXT NOT NULL DEFAULT '',
 preview TEXT,
 preview_digest TEXT NOT NULL DEFAULT '',
 total INTEGER NOT NULL DEFAULT 0,
 cursor INTEGER NOT NULL DEFAULT 0,
 created INTEGER NOT NULL DEFAULT 0,
 updated INTEGER NOT NULL DEFAULT 0,
 skipped INTEGER NOT NULL DEFAULT 0,
 run_id TEXT,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 started_at TEXT,
 finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_guided_imports_state ON guided_imports(state,created_at);
"""
MIGRATIONS = {1: _V1}
FEATURES_SCHEMA = "".join(MIGRATIONS[v] for v in sorted(MIGRATIONS))


def ensure_features_schema(store) -> None:
    """Create or upgrade this library's feature tables. Safe to call on every start."""
    with store.transaction() as c:
        row = c.execute("SELECT value FROM meta WHERE key='features_schema_version'").fetchone()
        current = int(row[0]) if row and str(row[0]).isdigit() else 0
        if current > FEATURES_SCHEMA_VERSION:
            raise ValueError("This library was written by a newer version of Little Archive.")
        for version in sorted(v for v in MIGRATIONS if v > current):
            c.executescript(MIGRATIONS[version])
        c.execute("INSERT INTO meta VALUES('features_schema_version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (str(FEATURES_SCHEMA_VERSION),))
        # A job that was uploading or importing when the process stopped is picked up again
        # the next time a client asks about it; nothing here restarts work by itself.


# ---------------------------------------------------------------- errors and gating

class FeatureError(Exception):
    """An expected refusal: an HTTP status, a safe message and a code a client can switch on."""

    def __init__(self, status: int, message: str, code: str, **extra):
        super().__init__(message)
        self.status, self.message, self.code, self.extra = status, message, code, extra

    def body(self) -> dict:
        return {"detail": self.message, "code": self.code, **self.extra}


class FeatureLocked(FeatureError):
    def __init__(self, feature: str):
        super().__init__(402, "This comes with the full unlock.", "unlock_required", feature=feature)


def install_feature_errors(app) -> None:
    async def handle(request, exc: FeatureError):
        return JSONResponse(exc.body(), status_code=exc.status)
    app.add_exception_handler(FeatureError, handle)


def gated(owner, feature: str):
    """A dependency: the caller's library, after the hosted unlock check. Self-hosted is never gated."""
    def dependency(request: Request, auth=Depends(owner)):
        app = request.app
        if app.state.config.hosted and not app.state.entitlements.is_unlocked(auth.user_id):
            meters = getattr(app.state, "meters", None)
            if meters is None or not meters.features_open_to_free():   # an operator may give accounts that have not unlocked a small allowance
                raise FeatureLocked(feature)
        return auth
    return dependency


# ---------------------------------------------------------------- settings

@dataclass(frozen=True)
class FeatureSettings:
    """Operator settings for the optional geocoder. Environment only, off by default."""
    geocoder_url: str = ""
    geocoder_contact: str = field(default="", repr=False)
    geocoder_min_interval: float = 1.1     # seconds between requests to one geocoder; Nominatim's public limit is one a second
    geocoder_cache_days: int = 30
    geocoder_timeout: float = 8.0

    @classmethod
    def from_env(cls, values) -> "FeatureSettings":
        url = str(values.get("LA_GEOCODER_URL", "")).strip().rstrip("/")
        contact = str(values.get("LA_GEOCODER_CONTACT", "")).strip()
        try:
            interval = float(str(values.get("LA_GEOCODER_MIN_INTERVAL_SECONDS", "") or 1.1))
            days = int(str(values.get("LA_GEOCODER_CACHE_DAYS", "") or 30))
        except ValueError as exc:
            raise ValueError("LA_GEOCODER_MIN_INTERVAL_SECONDS and LA_GEOCODER_CACHE_DAYS must be numbers.") from exc
        settings = cls(url, contact, interval, days)
        return settings.validate()

    def validate(self) -> "FeatureSettings":
        if not self.geocoder_url:
            if self.geocoder_contact:
                raise ValueError("LA_GEOCODER_CONTACT is set but LA_GEOCODER_URL is not. Set both to turn geocoding on, or neither.")
            return self
        from urllib.parse import urlsplit
        parts = urlsplit(self.geocoder_url)
        _ = parts.port
        loopback = (parts.hostname or "") in {"localhost", "127.0.0.1", "::1"}
        if parts.scheme not in {"http", "https"} or not parts.hostname or parts.username or parts.password or parts.query or parts.fragment or len(self.geocoder_url) > 2048:
            raise ValueError("LA_GEOCODER_URL must be the geocoder's HTTP(S) origin or base path, without credentials or a query.")
        if parts.scheme == "http" and not loopback:
            raise ValueError("Use HTTPS for a non-loopback LA_GEOCODER_URL.")
        if len(self.geocoder_contact) < 5 or len(self.geocoder_contact) > 200 or any(unicodedata.category(c) in {"Cc", "Cs", "Zl", "Zp"} for c in self.geocoder_contact):
            raise ValueError("LA_GEOCODER_CONTACT must be an email address or URL (5-200 characters) that identifies you to the geocoder's operator, as its usage policy requires.")
        if not 1.0 <= self.geocoder_min_interval <= 60:
            raise ValueError("LA_GEOCODER_MIN_INTERVAL_SECONDS must be between 1 and 60: the public Nominatim service allows at most one request a second.")
        if not 1 <= self.geocoder_cache_days <= 365:
            raise ValueError("LA_GEOCODER_CACHE_DAYS must be between 1 and 365.")
        return self

    @property
    def geocoding_enabled(self) -> bool:
        return bool(self.geocoder_url)


# ---------------------------------------------------------------- text matching

_TOKEN = re.compile(r"[^\W_]+|[½¼¾⅓⅔⅛]", re.U)


def match_tokens(text) -> list[str]:
    """Words and digits, folded so that case, accents, Arabic letter variants and punctuation never decide a match."""
    return _TOKEN.findall(normalize_search(text or ""))


def contains_run(haystack: list[str], needle: list[str]) -> bool:
    """True when `needle` appears in `haystack` as a contiguous run of tokens."""
    if not needle or len(needle) > len(haystack):
        return False
    first, size = needle[0], len(needle)
    for index in range(len(haystack) - size + 1):
        if haystack[index] == first and haystack[index:index + size] == needle:
            return True
    return False


class EvidenceText:
    """The text a model is shown, kept by field so that a quote can be traced to where it came from."""

    LABELS = {"title": "title", "creator": "creator", "caption": "caption", "thumbnail_alt": "alt_text", "notes": "notes", "transcript": "transcript",
              "page": "page"}

    def __init__(self, fields: dict[str, str], evidence):
        self.fields = {k: v for k, v in fields.items() if isinstance(v, str) and v.strip()}
        self.evidence = evidence                       # understanding.Evidence: level, sources, truncated
        self._tokens = {k: match_tokens(v) for k, v in self.fields.items()}

    @property
    def level(self) -> str:
        return self.evidence.level

    @property
    def sources(self) -> list[str]:
        return list(self.evidence.sources)

    def locate(self, quote: str) -> str | None:
        """The label of the first field that contains `quote` verbatim (ignoring case, accents and punctuation), else None."""
        needle = match_tokens(quote)
        if len(needle) < 1:
            return None
        for name, tokens in self._tokens.items():
            if contains_run(tokens, needle):
                return self.LABELS.get(name, "caption" if name.startswith("evidence") else name)
        return None

    def contains_word_run(self, text: str) -> bool:
        return self.locate(text) is not None

    def all_tokens(self) -> set[str]:
        return {t for tokens in self._tokens.values() for t in tokens}

    def payload(self) -> str:
        return json.dumps(self.fields, ensure_ascii=False)


def evidence_text(service, item: dict, *, page_text: str = "", budget: int = 14000) -> EvidenceText:
    """The evidence a feature may send to the provider, in the same mode the classifier uses.

    A hosted provider is sent only what came from the post itself (never the owner's notes) unless
    the operator allows more; the label is computed from what is actually included.
    """
    analyzer = service.analyzer()
    ev = build_evidence(item, mode=analyzer.mode, manual_title=service.manual_title(item["id"]) if hasattr(service, "manual_title") else False, budget=budget)
    fields: dict[str, str] = {}
    for key, value in ev.source.items():
        if isinstance(value, str) and key not in {"text_was_truncated"}:
            fields[key] = value
    for index, extra in enumerate(ev.source.get("evidence", []) if isinstance(ev.source.get("evidence"), list) else []):
        if isinstance(extra, dict) and isinstance(extra.get("text"), str):
            fields[f"evidence_{index + 1}"] = extra["text"]
    if page_text.strip():
        fields["page"] = page_text.strip()[:8000]
    return EvidenceText(fields, ev)


# ---------------------------------------------------------------- one structured model call

def structured_call(service, *, system: str, user: str, schema: dict, max_tokens: int, item_id: str | None = None, items: int = 1, feature: str = "ai") -> dict:
    """Ask the configured provider for one JSON object, meter it, and return the decoded object (unvalidated).

    On a hosted service every call is first charged to the account (`service.call_guard`, set by the tenancy layer), which refuses it
    with a 402 or 429 when the account has no allowance left, and gives the charge back if the provider fails or answers unusably.
    `feature` names what the call is for (recipes, places, ask) in that refusal. A self-hosted service has no guard and no charge.
    """
    provider = service.provider
    if provider is None or not hasattr(provider, "complete_json"):
        raise FeatureError(503, "No AI provider is configured on this server, so this cannot use one.", "ai_not_configured")
    guard = getattr(service, "call_guard", None)
    if guard is not None:
        guard.before(feature)
    try:
        answer, usage = provider.complete_json(system, user, schema, max_tokens=max_tokens)
    except ProviderError as exc:
        if guard is not None:
            guard.failed()
        raise FeatureError(502, str(exc), "ai_failed", retryable=bool(getattr(exc, "retryable", False))) from exc
    except Exception:
        if guard is not None:
            guard.failed()
        raise
    if service.meter is not None:
        service.meter.record(kind="model_call", tier="understand", provider=provider.name, model=provider.model, item_id=item_id, items=items,
                             model_calls=usage.model_calls, input_tokens=usage.input_tokens, output_tokens=usage.output_tokens)
    if not isinstance(answer, dict):
        if guard is not None:
            guard.failed()
        raise FeatureError(502, "The model returned an unusable answer; nothing was kept.", "ai_invalid")
    return answer


def ai_label(service, evidence: EvidenceText) -> dict:
    """How an AI-derived result describes itself. Computed from the input, never from the model."""
    from .understanding import evidence_note
    provider = service.provider
    return {"evidence_level": evidence.level, "evidence_sources": evidence.sources, "evidence_note": evidence_note(evidence.sources),
            "provider": provider.name if provider else "", "model": provider.model if provider else ""}


def dumps(value) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def loads(text, default=None):
    try:
        return json.loads(text) if text else default
    except (TypeError, ValueError):
        return default


__all__ = ["FeatureError", "FeatureLocked", "FeatureSettings", "ensure_features_schema", "gated", "install_feature_errors", "now"]
