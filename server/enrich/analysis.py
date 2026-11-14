"""Run understanding for a set of items: evidence, cache, batching, metering, labelling.

Two evidence modes keep private context from travelling further than it must:

* ``full``   — what the classifier has always sent to the operator's own Ollama: the post's
  text plus the owner's notes and collection names.
* ``public`` — only text that comes from the post itself. Used whenever the shared cache is
  on (so a cached result can never be derived from private text) and for a hosted provider
  unless the operator chose ``LA_AI_SHARE_PRIVATE_CONTEXT``.

The folder suggestion is computed here for the owner, after the model answered, and is
never written to the cache.
"""
from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
import logging

from .understanding import (ANALYSIS_VERSION, CATEGORIES, AnalysisInput, AnalysisOutcome, ProviderError, build_evidence, evidence_note, map_folder,
                            output_schema, system_prompt)

log = logging.getLogger("little_archive.enrich")
SINGLE_BUDGET, BATCH_BUDGET, BATCH_CHARS = 14000, 6000, 40000
MAX_OFFERED_COLLECTIONS = 60


@dataclass
class Prepared:
    key: str
    item_id: str
    evidence: object
    mode: str
    offered: tuple            # collection names the model may choose from (full mode only)
    local_collections: tuple  # the owner's collection names, used only for the local folder mapping
    cache_url: str | None
    input_hash: str


@dataclass
class Outcome:
    key: str
    result: dict | None = None
    error: str | None = None
    cache_hit: bool = False


def _digest(value) -> str:
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


class Analyzer:
    def __init__(self, provider, settings, *, cache=None, meter=None):
        self.provider, self.settings, self.cache, self.meter = provider, settings, cache, meter

    @property
    def enabled(self) -> bool:
        return self.provider is not None

    @property
    def mode(self) -> str:
        if self.settings.cache_enabled:
            return "public"
        if self.provider is not None and self.provider.hosted and not self.settings.share_private_context:
            return "public"
        return "full"

    @property
    def budget(self) -> int:
        return BATCH_BUDGET if self.provider is not None and self.provider.max_batch > 1 else SINGLE_BUDGET

    def material(self) -> dict:
        """Everything about the pipeline that should invalidate a stored suggestion when it changes."""
        return {
            "analysis_version": ANALYSIS_VERSION, "mode": self.mode,
            "provider": self.provider.identity() if self.provider is not None else {},
            "prompt": system_prompt(extended=True, collections=self.mode == "full"),
            "schema": output_schema(extended=True, collections=("x",) if self.mode == "full" else ()), "taxonomy": list(CATEGORIES),
        }

    def prepare(self, key, item, *, manual_title=False, local_collections=(), cache_url=None) -> Prepared:
        mode = self.mode
        evidence = build_evidence(item, mode=mode, manual_title=manual_title, budget=self.budget)
        local = tuple(n for n in local_collections if isinstance(n, str) and n.strip())
        offered = tuple(sorted((n for n in local if len(n) <= 100), key=str.casefold)[:MAX_OFFERED_COLLECTIONS]) if mode == "full" else ()
        public_url = cache_url if (mode == "public" and self.cache is not None) else None
        input_hash = _digest({"material": self.material(), "evidence": evidence.source}) if public_url else ""
        return Prepared(key, item["id"], evidence, mode, offered, local, public_url, input_hash)

    # -- running ------------------------------------------------------------
    def run(self, prepared: list[Prepared], *, job_ids=None) -> dict[str, Outcome]:
        job_ids = job_ids or {}
        outcomes: dict[str, Outcome] = {}
        pending: list[Prepared] = []
        for p in prepared:
            if p.evidence.empty:
                outcomes[p.key] = Outcome(p.key, error="There is not enough text evidence to classify this item.")
            elif p.cache_url and (hit := self.cache.get(p.cache_url, "analysis", p.input_hash)):
                outcomes[p.key] = Outcome(p.key, result=self._finalize(p, hit), cache_hit=True)
                self._meter(kind="cache_hit", tier="understand", provider=hit.get("provider", ""), model=hit.get("model", ""), item_id=p.item_id, job_id=job_ids.get(p.key), cache_hit=True)
            else:
                pending.append(p)
        if pending and self.provider is None:
            for p in pending:
                outcomes[p.key] = Outcome(p.key, error="No AI provider is configured.")
            return outcomes
        # Identical public input in one run is analysed once; the others share the answer.
        leaders: dict[str, Prepared] = {}
        followers: dict[str, list[Prepared]] = {}
        to_call: list[Prepared] = []
        for p in pending:
            if p.cache_url and p.input_hash in leaders:
                followers.setdefault(p.input_hash, []).append(p)
                continue
            if p.cache_url:
                leaders[p.input_hash] = p
            to_call.append(p)
        for chunk in self._chunks(to_call):
            outcomes.update(self._call(chunk, job_ids))
        for input_hash, copies in followers.items():
            leader = outcomes[leaders[input_hash].key]
            for p in copies:
                if leader.result is not None:
                    outcomes[p.key] = Outcome(p.key, result=self._finalize(p, leader.result), cache_hit=True)
                    self._meter(kind="cache_hit", tier="understand", provider=leader.result.get("provider", ""), model=leader.result.get("model", ""), item_id=p.item_id, job_id=job_ids.get(p.key), cache_hit=True)
                else:
                    outcomes[p.key] = Outcome(p.key, error=leader.error)
        return outcomes

    def _chunks(self, pending):
        limit = self.provider.max_batch if self.provider is not None else 1
        chunk, size = [], 0
        for p in pending:
            length = len(json.dumps(p.evidence.source, ensure_ascii=False))
            if chunk and (len(chunk) >= limit or size + length > BATCH_CHARS or p.offered != chunk[0].offered):
                yield chunk
                chunk, size = [], 0
            chunk.append(p)
            size += length
        if chunk:
            yield chunk

    def _call(self, chunk, job_ids) -> dict[str, Outcome]:
        inputs = [AnalysisInput(p.key, p.evidence, True, p.offered) for p in chunk]
        results: dict[str, Outcome] = {}
        try:
            answers, usage = self.provider.analyze(inputs)
            self._meter(kind="model_call", tier="understand", provider=self.provider.name, model=self.provider.model, items=len(chunk),
                        item_id=chunk[0].item_id if len(chunk) == 1 else None, job_id=job_ids.get(chunk[0].key) if len(chunk) == 1 else None,
                        model_calls=usage.model_calls, input_tokens=usage.input_tokens, output_tokens=usage.output_tokens)
        except ProviderError as exc:
            if len(chunk) > 1 and not exc.retryable:
                # One bad answer must not sink the others: try each item on its own.
                for p in chunk:
                    results.update(self._call([p], job_ids))
                return results
            return {p.key: Outcome(p.key, error=str(exc)) for p in chunk}
        by_key = {p.key: p for p in chunk}
        failed = []
        for answer in answers:
            p = by_key[answer.key]
            if answer.result is not None:
                results[p.key] = Outcome(p.key, result=self._finalize(p, answer.result))
                self._store(p, answer.result)
            else:
                failed.append(p)
        if len(chunk) > 1:
            for p in failed:
                results.update(self._call([p], job_ids))
        else:
            for p, answer in zip(failed, [a for a in answers if a.result is None]):
                results[p.key] = Outcome(p.key, error=answer.error or "The model did not return a usable answer.")
        return results

    def _store(self, p: Prepared, result: dict) -> None:
        if not p.cache_url:
            return
        payload = {k: result[k] for k in ("suggested_title", "summary", "topics", "content_type", "category") if k in result}
        payload.update(evidence_level=p.evidence.level, evidence_sources=p.evidence.sources, evidence_note=evidence_note(p.evidence.sources),
                       model=self.provider.model, provider=self.provider.name, needs_review=True)
        try:
            self.cache.put(p.cache_url, "analysis", payload, p.input_hash)
        except Exception:  # a cache problem must never fail the analysis itself
            log.warning("The shared cache could not store a result.", exc_info=False)

    def _finalize(self, p: Prepared, result: dict) -> dict:
        """Add the labels and the owner-specific folder. Labels come from the input, not the model."""
        category = result.get("category") if result.get("category") in CATEGORIES else "Other"
        folder = result.get("collection") or map_folder(category, result.get("topics", []), p.local_collections)
        # A cached result is only ever returned for an identical public input, so this item's own
        # labels are also the labels of the cached analysis.
        provider = result.get("provider") or (self.provider.name if self.provider is not None else "")
        model = result.get("model") or (self.provider.model if self.provider is not None else "")
        return {
            "suggested_title": result["suggested_title"], "summary": result["summary"], "topics": list(result["topics"]),
            "content_type": result["content_type"], "category": category, "suggested_folder": folder,
            "needs_review": True, "evidence_level": p.evidence.level, "evidence_sources": list(p.evidence.sources),
            "evidence_note": evidence_note(p.evidence.sources), "model": model, "provider": provider,
        }

    def _meter(self, **fields):
        if self.meter is not None:
            self.meter.record(**fields)
