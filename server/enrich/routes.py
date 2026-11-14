"""HTTP routes for the understanding layer. Owner session plus CSRF, like every other write."""
from __future__ import annotations

import json
from typing import Literal

from fastapi import Depends, HTTPException, Query
from pydantic import Field, model_validator

from ..models import StrictModel
from .service import EnrichError

MAX_HTML_BYTES = 2_000_000


class ClientExtraction(StrictModel):
    title: str = Field(default="", max_length=500)
    creator: str = Field(default="", max_length=200)
    creator_url: str | None = Field(default=None, max_length=4096)
    caption: str = Field(default="", max_length=20000)
    thumbnail_url: str | None = Field(default=None, max_length=4096)
    video_url: str | None = Field(default=None, max_length=4096)
    canonical_url: str | None = Field(default=None, max_length=4096)
    content_type: Literal["post", "video", "article", "image", "link"] | None = None
    published_at: str | None = Field(default=None, max_length=100)
    duration_seconds: float | None = Field(default=None, ge=0, le=7 * 86400)
    language: str = Field(default="", max_length=35)
    site_name: str = Field(default="", max_length=200)


class PageInput(StrictModel):
    """Exactly one source: an extraction the client made, raw HTML it fetched (optionally with oEmbed JSON), or ``fetch``."""
    extraction: ClientExtraction | None = None
    html: str | None = Field(default=None, max_length=MAX_HTML_BYTES)
    oembed: dict | None = None
    fetch: bool = False

    @model_validator(mode="after")
    def one_source(self):
        chosen = [self.extraction is not None, self.html is not None or self.oembed is not None, self.fetch]
        if sum(chosen) != 1:
            raise ValueError("Send exactly one of: extraction, html (optionally with oembed), or fetch.")
        if self.oembed is not None and len(json.dumps(self.oembed)) > 64 * 1024:
            raise ValueError("The oEmbed object is too large.")
        return self


class TranscriptInput(StrictModel):
    text: str = Field(min_length=1, max_length=20000)
    language: str = Field(default="", max_length=35)
    source: Literal["on_device", "client"] = "on_device"
    seconds: float | None = Field(default=None, ge=0, le=7 * 86400)


def _run(call):
    try:
        return call()
    except EnrichError as exc:
        raise HTTPException(exc.status, exc.message) from exc


def install_routes(app, service, *, owner):
    @app.post("/api/items/{iid}/page")
    def attach_page(iid: str, data: PageInput, auth=Depends(owner)):
        if data.html is not None and len(data.html.encode("utf-8", "ignore")) > MAX_HTML_BYTES:
            raise HTTPException(413, "That page is too large. Send only the head of the document (everything up to its closing head tag).")
        extraction = data.extraction.model_dump() if data.extraction is not None else None
        return _run(lambda: service.attach_page(iid, extraction=extraction, html=data.html, oembed=data.oembed, fetch=data.fetch))

    @app.post("/api/items/{iid}/transcript")
    def add_transcript(iid: str, data: TranscriptInput, auth=Depends(owner)):
        return _run(lambda: service.set_transcript(iid, data.text, language=data.language, source="client", seconds=data.seconds))

    @app.delete("/api/items/{iid}/transcript")
    def delete_transcript(iid: str, auth=Depends(owner)):
        return _run(lambda: service.remove_transcript(iid))

    @app.post("/api/items/{iid}/deep-read")
    def deep_read(iid: str, auth=Depends(owner)):
        return _run(lambda: service.request_deep_read(iid))

    @app.get("/api/enrichment/status")
    def enrichment_status(auth=Depends(owner)):
        return service.status()

    @app.get("/api/enrichment/usage")
    def enrichment_usage(since: str | None = Query(default=None, max_length=40), auth=Depends(owner)):
        return service.ledger.totals(since)
