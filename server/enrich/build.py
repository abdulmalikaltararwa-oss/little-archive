"""Assemble the understanding layer for one library (one Store).

``create_app`` calls ``build_enrichment`` once. A deployment that serves one library per
user calls it once per Store; every collaborator here is per-library except the optional
shared cache, which is deliberately shared and holds only public-post data.
"""
from __future__ import annotations

import os
from pathlib import Path

from .cache import PublicPostCache
from .netfetch import SafeFetcher, default_user_agent
from .schema import ensure_schema
from .service import EnrichmentService
from .settings import EnrichSettings
from .transcribe import GeminiTranscriber, GroqWhisperTranscriber
from .understanding import GeminiProvider, OllamaProvider
from .usage import LedgerSink, Metering
from .worker import UnderstandingWorker


def build_enrichment(store, config, environ=None) -> EnrichmentService:
    # Tests construct Config(testing=True); the process environment is not consulted then,
    # so a developer's shell can never change what a test exercises.
    values = environ if environ is not None else ({} if getattr(config, "testing", False) else os.environ)
    settings = EnrichSettings.from_env(values, config).validate()
    ensure_schema(store)
    meter = Metering()
    ledger = LedgerSink(store)
    meter.add_sink(ledger)
    cache = None
    if settings.cache_enabled:
        cache = PublicPostCache(Path(settings.cache_path) if settings.cache_path else store.root / "cache" / "public-posts.sqlite3", ttl_days=settings.cache_ttl_days)
        cache.purge_expired()
    provider = None
    if settings.ai_provider == "ollama":
        provider = OllamaProvider(settings.ollama_url, settings.ollama_model)
    elif settings.ai_provider == "gemini":
        provider = GeminiProvider(settings.gemini_api_key, settings.gemini_model, max_batch=settings.ai_batch_size)
    transcriber = None
    if settings.transcribe_provider == "groq":
        transcriber = GroqWhisperTranscriber(settings.groq_api_key, settings.groq_model)
    elif settings.transcribe_provider == "gemini":
        transcriber = GeminiTranscriber(settings.gemini_api_key, settings.gemini_transcribe_model or settings.gemini_model)
    fetcher = None
    if settings.fetch_enabled:
        fetcher = SafeFetcher(user_agent=default_user_agent(settings.fetch_contact), timeout=settings.fetch_timeout, total_timeout=max(20.0, settings.fetch_timeout * 2),
                              max_bytes=settings.fetch_max_bytes, max_redirects=settings.fetch_max_redirects)
    service = EnrichmentService(store, config, settings, fetcher=fetcher, provider=provider, transcriber=transcriber, cache=cache, meter=meter)
    service.ledger = ledger
    service.worker = UnderstandingWorker(store, config, service)
    store.item_hooks.append(service.item_hook)
    return service
