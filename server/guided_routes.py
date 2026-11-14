"""HTTP routes for the guided backlog import (see server/guided_import.py for the flow and the guarantees).

Available in both modes, scoped to the caller's own library. Not part of the hosted unlock: bringing your saves in is the product,
not an add-on. Every piece of a file is its own small request, so the same flow works under a hosted service's request limits.
"""
from __future__ import annotations

from typing import Literal

from fastapi import Depends, Query, Request
from pydantic import Field

from .enrich.features import FeatureError, install_feature_errors
from .guided_import import GuidedImportLimits, guides
from .models import StrictModel

BODY = "little_archive.body"   # this request's buffered body, put in the ASGI scope by the app's body-limit middleware


class ArchiveStart(StrictModel):
    platform: Literal["instagram", "tiktok", "auto"] = "auto"
    filename: str = Field(min_length=1, max_length=200)
    size_bytes: int = Field(ge=1, le=64 * 1024 * 1024 * 1024)
    sha256: str | None = Field(default=None, pattern=r"^[0-9a-fA-F]{64}$")    # optional: checked when the file is joined
    source_account: str = Field(default="default", min_length=1, max_length=200)  # the handle these saves belong to; "default" matches the file importer


class ArchiveCommit(StrictModel):
    digest: str | None = Field(default=None, max_length=64)   # the preview's digest; required to start, not to resume


def install_guided_import_routes(app, *, owner):
    install_feature_errors(app)
    app.state.guided_import_limits = GuidedImportLimits.from_config(app.state.config)

    def jobs(auth):
        return auth.store.enrichment.guided

    @app.get("/api/imports/guides")
    def import_guides(auth=Depends(owner)):
        """Step-by-step instructions per platform, as data. Fixed text; nothing about the library."""
        return guides(auth.store.enrichment.guided.limits)

    @app.get("/api/imports/archives")
    def list_archives(limit: int = Query(20, ge=1, le=100), auth=Depends(owner)):
        return jobs(auth).list(limit)

    @app.post("/api/imports/archives")
    def start_archive(data: ArchiveStart, auth=Depends(owner)):
        return jobs(auth).create(platform=data.platform, source_account=data.source_account.strip() or "default", filename=data.filename, size_bytes=data.size_bytes, sha256=data.sha256)

    @app.get("/api/imports/archives/{rid}")
    def archive_status(rid: str, auth=Depends(owner)):
        service = jobs(auth)
        view = service.view(rid)
        if view["state"] == "importing":
            service.ensure_running(rid)      # an import interrupted by a restart continues as soon as anyone looks at it
        return view

    @app.put("/api/imports/archives/{rid}/chunks/{index}")
    def put_chunk(rid: str, index: int, request: Request, auth=Depends(owner)):
        body = request.scope.get(BODY)
        if body is None:
            raise FeatureError(400, "Send the piece as the raw request body.", "no_body")
        return jobs(auth).put_chunk(rid, index, body, request.headers.get("x-chunk-sha256"))

    @app.post("/api/imports/archives/{rid}/finish")
    def finish_archive(rid: str, auth=Depends(owner)):
        return jobs(auth).finish(rid)

    @app.get("/api/imports/archives/{rid}/preview")
    def archive_preview(rid: str, auth=Depends(owner)):
        return jobs(auth).preview(rid)

    @app.post("/api/imports/archives/{rid}/commit")
    def commit_archive(rid: str, data: ArchiveCommit | None = None, auth=Depends(owner)):
        return jobs(auth).commit(rid, (data or ArchiveCommit()).digest)

    @app.delete("/api/imports/archives/{rid}")
    def cancel_archive(rid: str, auth=Depends(owner)):
        return jobs(auth).cancel(rid)
