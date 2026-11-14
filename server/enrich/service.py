"""Attach what was learned about a public post to a saved item, without overwriting the owner.

Policy for every field: fill what is empty, never replace what the owner or a source
import already provided. The stored copy is the caption text and a re-encoded thumbnail;
the original URL stays on the item as the link back to the post. Video is never stored: a
fetched video exists in memory only while it is sent to the transcription provider.
"""
from __future__ import annotations

from dataclasses import replace
import json
import logging
import re
import sqlite3

from ..storage import now, safe_preview
from .analysis import Analyzer
from .extract import extract_page, sanitize_client_extraction
from .images import reencode_image, write_asset
from .netfetch import FetchError
from .transcribe import TranscriptResult, clean_transcript, transcript_needed
from .understanding import PLACEHOLDER_TITLE, ProviderError
from .urls import classify_url, oembed_endpoint

log = logging.getLogger("little_archive.enrich")
DEEP_READ_REASONS = {
    "transcription_not_configured": "Transcription is not configured on this server.",
    "already_has_transcript": "This save already has a transcript.",
    "page_fetch_disabled": "Reading the video needs server-side page reading, which is turned off on this server. Transcribe on your device and send the transcript instead.",
    "in_progress": "A closer read of this save is already queued.",
}
_TRAILING_TAGS = re.compile(r"(?:\s+[#@][\w.]+)+\s*$", re.U)


class EnrichError(Exception):
    """An expected refusal with the HTTP status a route should use. The message is safe to show."""

    def __init__(self, status: int, message: str, code: str = ""):
        super().__init__(message)
        self.status, self.message, self.code = status, message, code


def title_from_caption(caption: str) -> str:
    """The start of the caption, without trailing hashtags, as a fallback title."""
    line = next((ln.strip() for ln in (caption or "").splitlines() if ln.strip()), "")
    line = _TRAILING_TAGS.sub("", line).strip()
    if len(line) < 3:
        return ""
    if len(line) > 100:
        line = line[:100].rsplit(" ", 1)[0].rstrip(",;:.- ") + "…"
    return line


def set_evidence(store, c, item_id: str, kind: str, text: str) -> None:
    """Replace the single evidence entry of one kind and keep the search index current."""
    row = c.execute("SELECT evidence FROM items WHERE id=?", (item_id,)).fetchone()
    entries = [e for e in json.loads(row[0]) if isinstance(e, dict) and e.get("kind") != kind]
    entries = entries[-15:] + [{"kind": kind, "text": text[:20000]}]
    c.execute("UPDATE items SET evidence=?,updated_at=? WHERE id=?", (json.dumps(entries, ensure_ascii=False, separators=(",", ":"), sort_keys=True), now(), item_id))
    store.index_item(c, item_id)


def drop_evidence(store, c, item_id: str, kind: str) -> None:
    row = c.execute("SELECT evidence FROM items WHERE id=?", (item_id,)).fetchone()
    entries = [e for e in json.loads(row[0]) if isinstance(e, dict) and e.get("kind") != kind]
    c.execute("UPDATE items SET evidence=?,updated_at=? WHERE id=?", (json.dumps(entries, ensure_ascii=False, separators=(",", ":"), sort_keys=True), now(), item_id))
    store.index_item(c, item_id)


class EnrichmentService:
    def __init__(self, store, config, settings, *, fetcher=None, provider=None, transcriber=None, cache=None, meter=None):
        self.store, self.config, self.settings = store, config, settings
        self.fetcher, self.provider, self.transcriber, self.cache, self.meter = fetcher, provider, transcriber, cache, meter
        self.worker = None

    # -- wiring ---------------------------------------------------------------
    def configure(self, **parts):
        """Replace collaborators (providers, fetcher, cache, settings). Used at start-up and by tests."""
        for name, value in parts.items():
            if name not in {"settings", "fetcher", "provider", "transcriber", "cache", "meter"}:
                raise ValueError("Unknown part.")
            setattr(self, name, value)
        return self

    def update_settings(self, **changes):
        self.settings = replace(self.settings, **changes)

    @property
    def fetch_enabled(self) -> bool:
        return bool(self.settings.fetch_enabled and self.fetcher is not None)

    def ai_ready(self) -> bool:
        return self.provider is not None

    def analyzer(self) -> Analyzer:
        return Analyzer(self.provider, self.settings, cache=self.cache, meter=self.meter)

    def batch_limit(self) -> int:
        return self.provider.max_batch if self.provider is not None else 1

    def _meter(self, **fields):
        if self.meter is not None:
            self.meter.record(**fields)

    # -- what clients may see -------------------------------------------------
    def public_settings(self) -> dict:
        p = self.provider
        return {
            "ai_enabled": p is not None, "ai_available": p is not None, "ai_model": p.model if p else "", "ai_provider": p.name if p else "",
            "ai_hosted": bool(p and p.hosted), "page_fetch_enabled": self.fetch_enabled,
            "transcription_available": self.transcriber is not None, "shared_cache_enabled": self.cache is not None,
        }

    def status(self) -> dict:
        p = self.provider
        return {
            "page": {"client_extraction": True, "client_html": True, "server_fetch": self.fetch_enabled, "html_max_bytes": 2_000_000},
            "analysis": {"provider": p.name if p else None, "model": p.model if p else None, "hosted": bool(p and p.hosted), "batch_size": p.max_batch if p else 0,
                         "evidence_mode": self.analyzer().mode if p else None},
            "transcription": {"provider": self.transcriber.name if self.transcriber else None, "auto": bool(self.transcriber and self.settings.transcribe_auto and self.fetch_enabled),
                              "client_transcripts": True, "max_audio_minutes": self.settings.transcribe_max_seconds // 60},
            "deep_read": {"available": bool(self.transcriber and self.fetch_enabled)},
            "shared_cache": {"enabled": self.cache is not None},
        }

    # -- the item view ---------------------------------------------------------
    def item_hook(self, c, item: dict) -> None:
        try:
            item["enrichment"] = self._view(c, item)
        except (sqlite3.Error, ValueError, KeyError):  # never let a read of an item fail on this
            log.warning("Enrichment details could not be read for an item.", exc_info=False)

    def _view(self, c, item: dict) -> dict:
        row = c.execute("SELECT * FROM item_enrichment WHERE item_id=?", (item["id"],)).fetchone()
        page = json.loads(row["page"]) if row and row["page"] else None
        needed, reason = transcript_needed(item, page)
        spoken = next((str(e.get("text", "")) for e in item.get("evidence", []) if isinstance(e, dict) and e.get("kind") == "transcript" and str(e.get("text", "")).strip()), "")
        state = row["deep_read_state"] if row else ""
        if self.transcriber is None:
            available, why = False, "transcription_not_configured"
        elif spoken:
            available, why = False, "already_has_transcript"
        elif not self.fetch_enabled:
            available, why = False, "page_fetch_disabled"
        elif state in {"queued", "running"}:
            available, why = False, "in_progress"
        else:
            available, why = True, ""
        return {
            "page": ({"source": row["page_source"], "at": row["page_at"], "content_type": page.get("content_type"), "has_video": bool(page.get("video_url")),
                      "duration_seconds": page.get("duration_seconds")} if page else None),
            "transcript": ({"source": (row["transcript_source"] if row and row["transcript_source"] else "imported"), "language": row["transcript_language"] if row else "",
                            "seconds": row["transcript_seconds"] if row else None, "chars": len(spoken)} if spoken else None),
            "transcript_needed": needed, "transcript_reason": reason,
            "deep_read": {"available": available, "reason": why, "state": state, "error": row["deep_read_error"] if row else ""},
        }

    def _upsert(self, c, item_id: str, **fields) -> None:
        c.execute("INSERT OR IGNORE INTO item_enrichment(item_id,updated_at) VALUES(?,?)", (item_id, now()))
        fields["updated_at"] = now()
        c.execute("UPDATE item_enrichment SET " + ",".join(k + "=?" for k in fields) + " WHERE item_id=?", [*fields.values(), item_id])

    def stored_page(self, item_id: str):
        with self.store.transaction() as c:
            row = c.execute("SELECT page,page_source FROM item_enrichment WHERE item_id=?", (item_id,)).fetchone()
        return (json.loads(row["page"]), row["page_source"]) if row and row["page"] else (None, "")

    # -- tier 1 and 2: the public page ----------------------------------------
    def read_public_page(self, url: str) -> dict:
        """The server's own, opt-in read of a public page (and its open oEmbed answer)."""
        if not self.fetch_enabled:
            raise EnrichError(409, "Server-side page reading is turned off. Send the page details from your device, or ask the server's operator to enable it.", "page_fetch_disabled")
        post = classify_url(url)
        if self.cache is not None and (hit := self.cache.get(post.canonical, "extraction")):
            self._meter(kind="cache_hit", tier="read")
            return hit
        sent, oembed, page_result, error = 0, None, None, None
        endpoint = oembed_endpoint(post)
        if endpoint:
            try:
                answer = self.fetcher.fetch_json(endpoint)
                sent += len(answer.body)
                oembed = json.loads(answer.body)
            except (FetchError, ValueError, RecursionError):
                oembed = None
        try:
            page_result = self.fetcher.fetch_html(url)
            sent += len(page_result.body)
        except FetchError as exc:
            error = exc
        if page_result is None and oembed is None:
            raise EnrichError(502, error.message if error else "The page could not be read.", error.code if error else "")
        page = extract_page(page_result.body if page_result else None, url, oembed=oembed, content_type=page_result.content_type if page_result else None)
        self._meter(kind="page_fetch", tier="read", bytes_fetched=sent)
        if page["usable"] and self.cache is not None:
            self.cache.put(post.canonical, "extraction", page)
        return page

    def attach_page(self, item_id: str, *, extraction=None, html=None, oembed=None, content_type=None, fetch=False) -> dict:
        item = self.store.get_item(item_id)
        if not item:
            raise EnrichError(404, "This item was not found.")
        if fetch:
            page, source = self.read_public_page(item["url"]), "server_fetch"
        elif extraction is not None:
            try:
                page, source = sanitize_client_extraction(extraction, item["url"]), "client"
            except ValueError as exc:
                raise EnrichError(422, str(exc)) from exc
        else:
            page, source = extract_page(html or None, item["url"], oembed=oembed, content_type=content_type), "client_html"
        if not page["usable"]:
            message = ("These page details are for a different post than this save." if page["reason"] == "different_page"
                       else "The page showed no public details for this post. It may need you to sign in, so nothing was changed.")
            raise EnrichError(422, message, page["reason"])
        self._meter(kind="page_read", tier="read", item_id=item_id, bytes_fetched=0)
        copy = self._fetch_thumbnail(page["thumbnail_url"], item_id) if self.fetch_enabled and page.get("thumbnail_url") else None
        with self.store.transaction() as c:
            if not c.execute("SELECT 1 FROM items WHERE id=?", (item_id,)).fetchone():
                raise EnrichError(404, "This item was not found.")
            self._apply_page(c, item_id, page, source, copy)
            return self.store.get_item(item_id, c)

    def _fetch_thumbnail(self, url: str, item_id: str):
        """A re-encoded local copy of the cover, through the same safe fetcher. Best effort."""
        try:
            answer = self.fetcher.fetch_image(url)
            blob = reencode_image(answer.body)
            self._meter(kind="page_fetch", tier="read", item_id=item_id, bytes_fetched=len(answer.body))
            return write_asset(self.store, blob)
        except (FetchError, ValueError, OSError):
            return None

    def _apply_page(self, c, item_id: str, page: dict, source: str, asset_digest=None) -> None:
        row = c.execute("SELECT * FROM items WHERE id=?", (item_id,)).fetchone()
        updates = {}
        caption = page.get("caption") or ""
        if caption and not row["caption"].strip():
            updates["caption"] = caption[:20000]
        if page.get("creator") and not row["creator"].strip():
            updates["creator"] = page["creator"][:200]
        if not row["manual_title"] and (not row["title"].strip() or PLACEHOLDER_TITLE.match(row["title"].strip())):
            title = page.get("title") or title_from_caption(caption or row["caption"])
            if title:
                updates["title"] = title[:500]
        if row["content_type"] in {"post", "link"} and page.get("content_type") in {"video", "article", "image"}:
            updates["content_type"] = page["content_type"]
        if not row["preview_url"] and (preview := safe_preview(page.get("thumbnail_url"))):
            updates["preview_url"] = preview
        if asset_digest and not row["asset_hash"]:
            updates["asset_hash"] = asset_digest
        if updates:
            updates["updated_at"] = now()
            c.execute("UPDATE items SET " + ",".join(k + "=?" for k in updates) + " WHERE id=?", [*updates.values(), item_id])
        if "caption" in updates:
            set_evidence(self.store, c, item_id, "caption", updates["caption"])
        self._upsert(c, item_id, page=json.dumps(page, ensure_ascii=False, separators=(",", ":"), sort_keys=True), page_source=source, page_at=now())
        self.store.index_item(c, item_id)

    # -- tier 5: transcripts -----------------------------------------------------
    def set_transcript(self, item_id: str, text: str, *, language: str = "", source: str = "client", seconds=None) -> dict:
        cleaned = clean_transcript(text)
        if not cleaned:
            raise EnrichError(422, "The transcript was empty.", "no_speech")
        with self.store.transaction() as c:
            if not c.execute("SELECT 1 FROM items WHERE id=?", (item_id,)).fetchone():
                raise EnrichError(404, "This item was not found.")
            set_evidence(self.store, c, item_id, "transcript", cleaned)
            self._upsert(c, item_id, transcript_source=source, transcript_language=(language or "")[:35], transcript_seconds=seconds, transcript_at=now(), deep_read_state="", deep_read_error="")
            return self.store.get_item(item_id, c)

    def remove_transcript(self, item_id: str) -> dict:
        with self.store.transaction() as c:
            if not c.execute("SELECT 1 FROM items WHERE id=?", (item_id,)).fetchone():
                raise EnrichError(404, "This item was not found.")
            drop_evidence(self.store, c, item_id, "transcript")
            self._upsert(c, item_id, transcript_source="", transcript_language="", transcript_seconds=None, transcript_at=None)
            return self.store.get_item(item_id, c)

    def request_deep_read(self, item_id: str) -> dict:
        item = self.store.get_item(item_id)
        if not item:
            raise EnrichError(404, "This item was not found.")
        deep = (item.get("enrichment") or {}).get("deep_read") or {"available": False, "reason": "transcription_not_configured"}
        if not deep["available"]:
            raise EnrichError(409, DEEP_READ_REASONS.get(deep["reason"], "A closer read is not available for this save."), deep["reason"])
        self.worker.enqueue_deep(item_id)
        return {"queued": 1}

    def wants_auto_transcript(self, item: dict) -> bool:
        """The thin-caption rule, applied only when the operator allows automatic transcription."""
        if not (self.settings.transcribe_auto and self.transcriber is not None and self.fetch_enabled):
            return False
        enrichment = item.get("enrichment") or {}
        if (enrichment.get("deep_read") or {}).get("state") == "failed":
            return False  # tried already; the owner can ask again explicitly
        page, _ = self.stored_page(item["id"])
        return transcript_needed(item, page)[0]

    def make_transcript(self, item: dict, *, deep: bool) -> tuple[TranscriptResult, str]:
        """Find the audio, transcribe it in memory, and return the text. The media is never kept."""
        if self.transcriber is None:
            raise EnrichError(409, DEEP_READ_REASONS["transcription_not_configured"], "transcription_not_configured")
        if not self.fetch_enabled:
            raise EnrichError(409, DEEP_READ_REASONS["page_fetch_disabled"], "page_fetch_disabled")
        post = classify_url(item["url"])
        if self.cache is not None and (hit := self.cache.get(post.canonical, "transcript")) and hit.get("text"):
            self._meter(kind="cache_hit", tier="transcribe", item_id=item["id"], provider=hit.get("provider", ""), model=hit.get("model", ""), cache_hit=True)
            return TranscriptResult(hit["text"], hit.get("language", ""), hit.get("seconds")), "cache"
        page, source = self.stored_page(item["id"])
        trusted = source == "server_fetch"
        refreshed = False

        def refresh():
            nonlocal page, trusted, refreshed
            page, trusted, refreshed = self.read_public_page(item["url"]), True, True
            if page["usable"]:
                with self.store.transaction() as c:
                    if c.execute("SELECT 1 FROM items WHERE id=?", (item["id"],)).fetchone():
                        self._apply_page(c, item["id"], page, "server_fetch")
        if not page or not page.get("video_url"):
            refresh()
        if not page or not page.get("video_url"):
            raise EnrichError(422, "The page does not expose a video the server can read. Transcribe it on your device and send the transcript instead.", "no_audio_source")
        if page.get("duration_seconds") and page["duration_seconds"] > self.settings.transcribe_max_seconds:
            raise EnrichError(422, f"This video is longer than the {self.settings.transcribe_max_seconds // 60}-minute limit for transcription.", "too_long")
        try:
            try:
                media = self.fetcher.fetch_media(page["video_url"], self.settings.transcribe_max_bytes)
            except FetchError as exc:
                if exc.code != "http_status" or refreshed:
                    raise
                refresh()  # a signed media link may simply have expired
                if not page.get("video_url"):
                    raise
                media = self.fetcher.fetch_media(page["video_url"], self.settings.transcribe_max_bytes)
        except FetchError as exc:
            raise EnrichError(502, exc.message, exc.code) from exc
        self._meter(kind="page_fetch", tier="transcribe", item_id=item["id"], bytes_fetched=len(media.body))
        match = re.match(r"[a-z]{2}", (page.get("language") or "").lower())
        try:
            result = self.transcriber.transcribe(media.body, media.content_type, language=match.group(0) if match else None)
        except ProviderError as exc:
            raise EnrichError(502, str(exc), "transcription_failed") from exc
        finally:
            media = None  # nothing from the video is kept
        self._meter(kind="transcription", tier="transcribe", provider=self.transcriber.name, model=self.transcriber.model, item_id=item["id"],
                    audio_seconds=result.seconds or 0.0, deep_read=deep)
        if not result.text:
            raise EnrichError(422, "No speech was detected in the audio.", "no_speech")
        if self.cache is not None and trusted:
            self.cache.put(post.canonical, "transcript", {"text": result.text, "language": result.language, "seconds": result.seconds, "provider": self.transcriber.name, "model": self.transcriber.model})
        return result, self.transcriber.name

    def transcribe_item(self, item: dict, *, deep: bool) -> dict:
        result, source = self.make_transcript(item, deep=deep)
        return self.set_transcript(item["id"], result.text, language=result.language, source=source, seconds=result.seconds)

    # -- tier 3 helpers used by the worker -----------------------------------------
    def local_collection_names(self) -> list[str]:
        with self.store.transaction() as c:
            return [r[0] for r in c.execute("SELECT name FROM collections WHERE kind='local' ORDER BY name COLLATE NOCASE LIMIT 200")]

    def manual_title(self, item_id: str) -> bool:
        with self.store.transaction() as c:
            row = c.execute("SELECT manual_title FROM items WHERE id=?", (item_id,)).fetchone()
        return bool(row and row[0])

    def apply_suggested_folder(self, c, item_id: str, ai: dict) -> None:
        """On acceptance only: file the item under the suggested folder, creating it if it is a fixed-taxonomy name."""
        from .understanding import CATEGORIES
        name = ai.get("suggested_folder") if isinstance(ai, dict) else ""
        if not isinstance(name, str) or not name.strip() or len(name) > 200:
            return
        existing = c.execute("SELECT id FROM collections WHERE kind='local' AND lower(name)=lower(?)", (name.strip(),)).fetchone()
        if existing:
            collection = existing[0]
        elif name in CATEGORIES and name != "Other":
            collection = self.store.resolve_collection(c, {"name": name, "kind": "local"}, "web", "local")
        else:
            return  # a collection the owner has since deleted is not recreated
        c.execute("INSERT OR IGNORE INTO memberships VALUES(?,?)", (item_id, collection))
