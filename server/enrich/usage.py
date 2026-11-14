"""What each tier used, reported through one hook so a hosted deployment can meter it.

Every tier calls ``Metering.record`` with what it consumed (model calls, tokens, audio
seconds, bytes fetched, cache hits). Sinks receive each event. The default sink keeps
local counters in the library database. Nothing here limits, blocks or bills anything:
a deployment that sells "deep reads" attaches its own sink (or wraps this one) and reads
``deep_read`` / ``kind == "transcription"`` events.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass
import logging
from typing import Protocol

from ..storage import now

log = logging.getLogger("little_archive.enrich")

KINDS = {"page_read", "page_fetch", "model_call", "transcription", "cache_hit"}
TIERS = {"read", "understand", "transcribe"}


@dataclass(frozen=True)
class UsageEvent:
    kind: str                       # page_read | page_fetch | model_call | transcription | cache_hit
    tier: str                       # read | understand | transcribe
    provider: str = ""
    model: str = ""
    item_id: str | None = None      # the single item this event is for; None for a multi-item model call
    job_id: str | None = None
    items: int = 1                  # items covered, so one batched call is visible as one call for N items
    model_calls: int = 0
    input_tokens: int | None = None
    output_tokens: int | None = None
    audio_seconds: float = 0.0
    bytes_fetched: int = 0
    deep_read: bool = False         # True when a transcription was requested explicitly ("Read this more closely")
    cache_hit: bool = False
    at: str = ""


class UsageSink(Protocol):
    def record(self, event: UsageEvent) -> None: ...


class Metering:
    """Fan one event out to every attached sink. A failing sink never breaks the pipeline."""

    def __init__(self, *sinks: UsageSink):
        self.sinks: list[UsageSink] = list(sinks)

    def add_sink(self, sink: UsageSink) -> None:
        self.sinks.append(sink)

    def record(self, **fields) -> UsageEvent:
        if fields.get("kind") not in KINDS or fields.get("tier") not in TIERS:
            raise ValueError("Unknown usage event.")
        if fields["kind"] == "cache_hit":
            fields["cache_hit"] = True
        event = UsageEvent(**{**fields, "at": fields.get("at") or now()})
        for sink in list(self.sinks):
            try:
                sink.record(event)
            except Exception:  # metering must never fail a save, a read or a job
                log.warning("A usage sink failed; the event was not recorded there.", exc_info=False)
        return event


class LedgerSink:
    """Local counters in the library database (table ``enrich_usage``)."""

    def __init__(self, store):
        self.store = store

    def record(self, event: UsageEvent) -> None:
        with self.store.transaction() as c:
            c.execute(
                "INSERT INTO enrich_usage(at,kind,tier,provider,model,item_id,job_id,items,model_calls,input_tokens,output_tokens,audio_seconds,bytes_fetched,deep_read,cache_hit) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (event.at, event.kind, event.tier, event.provider, event.model, event.item_id, event.job_id, event.items, event.model_calls,
                 event.input_tokens, event.output_tokens, float(event.audio_seconds), int(event.bytes_fetched), int(event.deep_read), int(event.cache_hit)),
            )

    def totals(self, since: str | None = None) -> dict:
        where, params = ("WHERE at>=?", [since]) if since else ("", [])
        with self.store.transaction() as c:
            row = c.execute(
                "SELECT COALESCE(SUM(model_calls),0) AS model_calls, COALESCE(SUM(input_tokens),0) AS input_tokens, COALESCE(SUM(output_tokens),0) AS output_tokens,"
                " COALESCE(SUM(audio_seconds),0) AS audio_seconds, COALESCE(SUM(bytes_fetched),0) AS bytes_fetched,"
                " COALESCE(SUM(kind='page_read'),0) AS page_reads, COALESCE(SUM(kind='page_fetch'),0) AS page_fetches,"
                " COALESCE(SUM(kind='transcription'),0) AS transcriptions, COALESCE(SUM(deep_read),0) AS deep_reads,"
                " COALESCE(SUM(cache_hit),0) AS cache_hits FROM enrich_usage " + where, params).fetchone()
            providers = [dict(r) for r in c.execute(
                "SELECT provider, model, kind, COUNT(*) AS events, COALESCE(SUM(model_calls),0) AS model_calls, COALESCE(SUM(audio_seconds),0) AS audio_seconds FROM enrich_usage "
                + where + (" AND" if where else " WHERE") + " provider!='' GROUP BY provider, model, kind ORDER BY provider, model, kind", params)]
        totals = {k: (round(row[k], 1) if k == "audio_seconds" else int(row[k])) for k in row.keys()}
        return {**totals, "by_provider": providers, "since": since}


def event_dict(event: UsageEvent) -> dict:
    return asdict(event)
