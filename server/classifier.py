"""Evidence-limited classification of one saved item through an operator-configured Ollama.

This module is the stable, single-item entry point (see API_CONTRACT.md, "AI module
contract"). The work itself lives behind a provider interface in ``server/enrich``:
``OllamaProvider`` and ``GeminiProvider`` share one evidence builder, one prompt and one
validator, so a title, summary and topic list mean the same thing whichever provider
produced them. The durable queue uses the richer interface directly (folder suggestions,
batching, transcripts); this function keeps the original five-field result.
"""
from __future__ import annotations

from .enrich.understanding import (LEGACY_SCHEMA, TYPES, AnalysisInput, OllamaProvider, ProviderError, build_evidence, system_prompt, validate_result)

ClassificationError = ProviderError
SCHEMA = LEGACY_SCHEMA
SYSTEM_PROMPT = system_prompt(extended=False)

__all__ = ["ClassificationError", "SCHEMA", "SYSTEM_PROMPT", "TYPES", "classify_item"]


def _evidence(item: dict) -> tuple[dict, str]:
    """The bounded text projection the model sees, and its evidence level."""
    evidence = build_evidence(item, mode="full")
    return evidence.source, evidence.level


def _validate(value: object) -> dict:
    return validate_result(value, extended=False)


def classify_item(item: dict, base_url: str, model: str, client=None) -> dict:
    """Classify text evidence; caller owns job persistence and human acceptance.

    base_url and model must come from server operator configuration, never from
    imported data or an unauthenticated client request. A private Docker host is
    allowed because inference may run in another self-hosted container.
    """
    provider = OllamaProvider(base_url, model, client=client)
    evidence = build_evidence(item, mode="full")
    if evidence.empty:
        raise ClassificationError("There is not enough text evidence to classify this item.")
    outcomes, _usage = provider.analyze([AnalysisInput("item", evidence, extended=False)])
    result = outcomes[0].result
    if result is None:
        raise ClassificationError(outcomes[0].error or "The model returned an invalid classification object.")
    # All generated classifications are suggestions until explicitly reviewed.
    result["needs_review"] = True
    result["evidence_level"] = evidence.level
    result["model"] = model
    return result
