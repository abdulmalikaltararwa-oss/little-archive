"""Operator settings for the understanding layer. Environment only; keys are never returned.

``config.py`` is left alone: these settings are read from the same ``LA_*`` environment
(or ``.env`` loaded into it) but live here, so adding a provider never touches shared
configuration code. Secrets are held in fields excluded from ``repr`` and are never part
of ``public()``, which is the only thing routes return.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
import re
import unicodedata

PROVIDERS = {"", "none", "ollama", "gemini"}
DEFAULT_GEMINI_MODEL = "gemini-3.5-flash-lite"
DEFAULT_GROQ_MODEL = "whisper-large-v3-turbo"
_MODEL_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._/-]{0,99}")
_TRUE, _FALSE = {"1", "true", "yes", "on"}, {"0", "false", "no", "off"}


def _flag(values, key, default):
    raw = values.get(key)
    if raw is None or not str(raw).strip():
        return default
    text = str(raw).strip().lower()
    if text in _TRUE:
        return True
    if text in _FALSE:
        return False
    raise ValueError(f"{key} must be true or false.")


def _number(values, key, default, low, high, cast=int):
    raw = values.get(key)
    if raw is None or not str(raw).strip():
        return default
    try:
        value = cast(str(raw).strip())
    except ValueError as exc:
        raise ValueError(f"{key} must be a number.") from exc
    if not low <= value <= high:
        raise ValueError(f"{key} must be between {low} and {high}.")
    return value


@dataclass(frozen=True)
class EnrichSettings:
    # Tier 2b: server-side page fetching. Off unless the operator turns it on.
    fetch_enabled: bool = False
    fetch_timeout: float = 10.0
    fetch_max_bytes: int = 2 * 1024 * 1024
    fetch_max_redirects: int = 4
    fetch_contact: str = ""
    # Tier 4: understanding from text.
    ai_provider: str = ""            # "", "ollama" or "gemini"
    ollama_url: str = ""
    ollama_model: str = ""
    gemini_api_key: str = field(default="", repr=False)
    gemini_model: str = DEFAULT_GEMINI_MODEL
    ai_batch_size: int = 8           # Gemini only; Ollama always analyses one item per request
    share_private_context: bool = False
    # Tier 5: transcription.
    transcribe_provider: str = ""    # "", "groq" or "gemini"
    gemini_transcribe_model: str = ""
    groq_api_key: str = field(default="", repr=False)
    groq_model: str = DEFAULT_GROQ_MODEL
    transcribe_auto: bool = True
    transcribe_max_bytes: int = 24_000_000
    transcribe_max_seconds: int = 900
    # Tier 6: shared cache of public-post results.
    cache_enabled: bool = False
    cache_path: str = ""
    cache_ttl_days: int = 30

    @classmethod
    def from_env(cls, values, config=None):
        ollama_url = getattr(config, "ollama_url", "") or ""
        ollama_model = getattr(config, "ollama_model", "") or ""
        provider = str(values.get("LA_AI_PROVIDER", "")).strip().lower()
        if provider not in PROVIDERS:
            raise ValueError("LA_AI_PROVIDER must be ollama, gemini or none.")
        gemini_key = str(values.get("LA_GEMINI_API_KEY", "")).strip()
        if provider == "":
            provider = "ollama" if ollama_url else ""
        if provider == "none":
            provider = ""
        if gemini_key and provider != "gemini":
            # A hosted key never activates by itself: text only leaves the machine when this is explicit.
            raise ValueError("LA_GEMINI_API_KEY is set but LA_AI_PROVIDER is not gemini. Set LA_AI_PROVIDER=gemini to send text to Google's Gemini API, or remove the key.")
        groq_key = str(values.get("LA_GROQ_API_KEY", "")).strip()
        transcriber = str(values.get("LA_TRANSCRIBE_PROVIDER", "")).strip().lower()
        if transcriber not in {"", "groq", "gemini", "none"}:
            raise ValueError("LA_TRANSCRIBE_PROVIDER must be groq, gemini or none.")
        if transcriber == "":
            # Audio only goes to Gemini when that is asked for by name; a Groq key keeps its old meaning.
            transcriber = "groq" if groq_key else ""
        if transcriber == "none":
            transcriber = ""
        return cls(
            fetch_enabled=_flag(values, "LA_FETCH_ENABLED", False),
            fetch_timeout=_number(values, "LA_FETCH_TIMEOUT_SECONDS", 10.0, 2.0, 60.0, float),
            fetch_max_bytes=_number(values, "LA_FETCH_MAX_BYTES", 2 * 1024 * 1024, 64 * 1024, 8 * 1024 * 1024),
            fetch_max_redirects=_number(values, "LA_FETCH_MAX_REDIRECTS", 4, 0, 8),
            fetch_contact=str(values.get("LA_FETCH_CONTACT", "")).strip(),
            ai_provider=provider, ollama_url=ollama_url, ollama_model=ollama_model,
            gemini_api_key=gemini_key, gemini_model=str(values.get("LA_GEMINI_MODEL", "")).strip() or DEFAULT_GEMINI_MODEL,
            ai_batch_size=_number(values, "LA_AI_BATCH_SIZE", 8, 1, 20),
            share_private_context=_flag(values, "LA_AI_SHARE_PRIVATE_CONTEXT", False),
            transcribe_provider=transcriber,
            gemini_transcribe_model=str(values.get("LA_GEMINI_TRANSCRIBE_MODEL", "")).strip(),
            groq_api_key=groq_key,
            groq_model=str(values.get("LA_GROQ_MODEL", "")).strip() or DEFAULT_GROQ_MODEL,
            transcribe_auto=_flag(values, "LA_TRANSCRIBE_AUTO", True),
            transcribe_max_bytes=_number(values, "LA_TRANSCRIBE_MAX_MB", 24, 1, 100) * 1_000_000,
            transcribe_max_seconds=_number(values, "LA_TRANSCRIBE_MAX_MINUTES", 15, 1, 120) * 60,
            cache_enabled=_flag(values, "LA_PUBLIC_CACHE", False),
            cache_path=str(values.get("LA_PUBLIC_CACHE_PATH", "")).strip(),
            cache_ttl_days=_number(values, "LA_PUBLIC_CACHE_TTL_DAYS", 30, 1, 365),
        )

    def validate(self):
        for label, value in (("LA_FETCH_CONTACT", self.fetch_contact), ("LA_PUBLIC_CACHE_PATH", self.cache_path)):
            if len(value) > 1024 or any(unicodedata.category(c) in {"Cc", "Cs", "Zl", "Zp"} for c in value):
                raise ValueError(f"{label} must be a short value without control characters.")
        if self.ai_provider == "gemini":
            if not self.gemini_api_key:
                raise ValueError("LA_AI_PROVIDER=gemini needs LA_GEMINI_API_KEY.")
            if not _MODEL_NAME.fullmatch(self.gemini_model):
                raise ValueError("LA_GEMINI_MODEL must be a model name such as gemini-3.5-flash-lite.")
        if self.ai_provider == "ollama" and not (self.ollama_url and self.ollama_model):
            raise ValueError("LA_AI_PROVIDER=ollama needs LA_OLLAMA_URL and LA_OLLAMA_MODEL.")
        if self.groq_api_key and not _MODEL_NAME.fullmatch(self.groq_model):
            raise ValueError("LA_GROQ_MODEL must be a model name such as whisper-large-v3-turbo.")
        if self.transcribe_provider == "groq" and not self.groq_api_key:
            raise ValueError("LA_TRANSCRIBE_PROVIDER=groq needs LA_GROQ_API_KEY.")
        if self.transcribe_provider == "gemini":
            if not self.gemini_api_key:
                raise ValueError("LA_TRANSCRIBE_PROVIDER=gemini needs LA_GEMINI_API_KEY and LA_AI_PROVIDER=gemini.")
            if self.gemini_transcribe_model and not _MODEL_NAME.fullmatch(self.gemini_transcribe_model):
                raise ValueError("LA_GEMINI_TRANSCRIBE_MODEL must be a model name such as gemini-3.5-flash-lite.")
        if self.cache_path:
            path = Path(self.cache_path)
            if not path.is_absolute():
                raise ValueError("LA_PUBLIC_CACHE_PATH must be an absolute path.")
            if path.resolve().is_relative_to((Path(__file__).resolve().parent.parent.parent / "web").resolve()):
                raise ValueError("LA_PUBLIC_CACHE_PATH must be outside the public web directory.")
        return self

    # -- derived, secret-free views ---------------------------------------
    @property
    def transcription_provider(self) -> str:
        return self.transcribe_provider

    @property
    def ai_model(self) -> str:
        return {"ollama": self.ollama_model, "gemini": self.gemini_model}.get(self.ai_provider, "")

    @property
    def ai_hosted(self) -> bool:
        return self.ai_provider == "gemini"

    def public(self) -> dict:
        """Everything a client may see. Contains no key, URL of a private service, or path."""
        return {
            "ai_provider": self.ai_provider,
            "ai_hosted": self.ai_hosted,
            "ai_batch_size": self.ai_batch_size if self.ai_provider == "gemini" else 1,
            "page_fetch_enabled": self.fetch_enabled,
            "transcription_provider": self.transcription_provider,
            "transcription_auto": bool(self.transcription_provider and self.transcribe_auto),
            "shared_cache_enabled": self.cache_enabled,
        }
