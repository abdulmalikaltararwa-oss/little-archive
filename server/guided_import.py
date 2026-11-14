"""Guided backlog import: an official Instagram or TikTok data export, checked before anything is saved, then imported as a job
that survives restarts.

The flow, each step a route (see server/guided_routes.py):

    create    declare the file (name, size, platform) and get a chunk size
    chunks    send the file in pieces; any piece can be sent again, and what has arrived can be asked for, so a dropped
              connection resumes instead of starting over (this also keeps every request small enough for a hosted service)
    finish    the pieces are joined, the file is read without extracting anything, and a PREVIEW is made: what was found, what
              is new, what is already in the library, what could not be read. Nothing is saved yet
    commit    the owner confirms the preview (by its digest) and a background job saves the saves in batches of 100. Every
              batch and the job's cursor are one transaction, so a crash or restart loses nothing and repeats nothing; the next
              status request or commit continues from the cursor
    progress  the job reports saves processed, created, updated and skipped

Importing never edits or deletes anything on the platform, and an import only ever adds or refreshes saves (the same merge the
other importers use); it never removes a save that is missing from the file.
"""
from __future__ import annotations

from dataclasses import dataclass, field
import hashlib
import logging
import os
from pathlib import Path
import shutil
import sqlite3
import threading
from uuid import uuid4

from .enrich.features import FeatureError, dumps, loads
from .exports import ExportError, ExportLimits, ExportRead, read_export
from .storage import LibraryClosed, now, parse_date

log = logging.getLogger("little_archive.imports")
ACTIVE = ("uploading", "previewed", "importing")
FINISHED = ("completed", "cancelled", "rejected")
MIB = 1024 * 1024
_SLOTS = threading.BoundedSemaphore(2)   # at most two imports write at once across every library in this process
FULL = "This library has reached its storage limit. Delete items or thumbnails to make room, then continue the import."


@dataclass(frozen=True)
class GuidedImportLimits:
    max_archive_bytes: int = 512 * MIB
    chunk_bytes: int = MIB
    max_active: int = 3
    batch_size: int = 100
    stale_hours: int = 72
    export: ExportLimits = field(default_factory=ExportLimits)

    @classmethod
    def from_config(cls, config, environ=None) -> "GuidedImportLimits":
        values = environ if environ is not None else ({} if getattr(config, "testing", False) else os.environ)
        raw = str(values.get("LA_IMPORT_MAX_ARCHIVE_MB", "")).strip()
        try:
            override = int(raw) * MIB if raw else None
        except ValueError as exc:
            raise ValueError("LA_IMPORT_MAX_ARCHIVE_MB must be a whole number.") from exc
        if override is not None and not 1 * MIB <= override <= 4096 * MIB:
            raise ValueError("LA_IMPORT_MAX_ARCHIVE_MB must be between 1 and 4096.")
        if getattr(config, "hosted", False):
            # A public service stages one export per account at a time, in pieces that fit its request limit.
            chunk = max(16 * 1024, min(256 * 1024, config.hosted_max_json_kb * 1024 - 8192))
            return cls(max_archive_bytes=override or 64 * MIB, chunk_bytes=chunk, max_active=1,
                       export=ExportLimits(max_member_bytes=48 * MIB, max_total_bytes=96 * MIB, max_records=50_000))
        return cls(max_archive_bytes=override or 512 * MIB)

    def public(self) -> dict:
        return {"max_archive_bytes": self.max_archive_bytes, "chunk_bytes": self.chunk_bytes, "max_active_imports": self.max_active, "batch_size": self.batch_size}


# ---------------------------------------------------------------- what to tell the person, per platform

def guides(limits: GuidedImportLimits) -> dict:
    """The step-by-step instructions as data, so any client can draw them. Step ids are stable; text is English.

    Everything here comes from documentation and community descriptions of the two services' menus and files; none of it was
    checked against a live account, and the services change their menus. `verified` says so.
    """
    upload = {"accepts": [".zip", ".json", ".html", ".txt"], "keep_zipped": True, "max_bytes": limits.max_archive_bytes, "chunk_bytes": limits.chunk_bytes}
    return {
        "version": 1,
        "platforms": [
            {
                "id": "instagram", "name": "Instagram", "help_url": "https://help.instagram.com/ipad-app/181231772500920",
                "summary": "Instagram can send you a file with everything you saved. Little Archive reads only the saved posts and collections in it.",
                "steps": [
                    {"id": "open_accounts_center", "title": "Open Accounts Center", "detail": "In the Instagram app or on instagram.com, open Settings, then Accounts Center."},
                    {"id": "your_information", "title": "Find Download your information", "detail": "Choose Your information and permissions, then Download your information."},
                    {"id": "start_request", "title": "Start a request", "detail": "Choose Download or transfer information, pick your Instagram account, then choose Some of your information."},
                    {"id": "select_saved", "title": "Select what you saved", "detail": "Under Your Instagram activity, tick Saved. If you cannot find it, choose All available information: the file is larger but works the same."},
                    {"id": "file_options", "title": "Choose the file options", "detail": "Set Date range to All time and Format to JSON. Media quality does not matter for saved posts; Low keeps the file small."},
                    {"id": "submit", "title": "Submit the request", "detail": "Instagram prepares the file and emails you when it is ready. That can take minutes or a few days."},
                    {"id": "download", "title": "Download the ZIP", "detail": "Open the link in the email while signed in and download the ZIP file. Leave it zipped: do not unpack it."},
                    {"id": "upload", "title": "Add it here", "detail": "Add the ZIP to Little Archive. If Instagram gave you several ZIP files, add the one that holds saved_posts.json (usually the first)."},
                ],
                "choose": {"information": ["Saved"], "format": "JSON", "date_range": "All time"},
                "formats": [
                    {"id": "json", "recommended": True, "reads": ["saved posts with links, captions, creators and save dates", "collections and which saves are in them"]},
                    {"id": "html", "recommended": False, "reads": ["post links", "save dates in some formats"],
                     "limitations": ["Collections and creators are not read from the HTML version.", "Built from documentation only; not checked against a real export."]},
                ],
                "expect": [{"file": "your_instagram_activity/saved/saved_posts.json", "contains": "every saved post"},
                           {"file": "your_instagram_activity/saved/saved_collections.json", "contains": "your collections and the posts in each"}],
                "ignored": "Everything else in the file (messages, comments, likes, history) is never opened.",
                "caveats": ["Older exports list only the account and link of each saved post, so captions arrive later when the save is read.",
                            "Instagram can split a large export into several ZIP files; add each one and Little Archive merges them.",
                            "Instagram links the saved posts you still have; a deleted post may appear as a link that no longer opens."],
                "upload": upload,
                "verified": {"basis": "documentation and fixtures published by open-source projects", "real_export_tested": False,
                             "unverified": ["the HTML variant", "the older collections layout", "the wording of Instagram's menus"]},
            },
            {
                "id": "tiktok", "name": "TikTok", "help_url": None,
                "summary": "TikTok can send you a file of your activity. Little Archive reads only your Favorite videos in it.",
                "steps": [
                    {"id": "open_settings", "title": "Open Settings", "detail": "In the TikTok app, open your Profile, then the menu, then Settings and privacy."},
                    {"id": "download_your_data", "title": "Find Download your data", "detail": "Tap Account, then Download your data."},
                    {"id": "choose_format", "title": "Choose the file format", "detail": "On the Request data tab choose JSON (best) or TXT."},
                    {"id": "request", "title": "Request your data", "detail": "Tap Request data. TikTok prepares the file; this can take a few hours or a few days."},
                    {"id": "download", "title": "Download the ZIP", "detail": "Come back to the Download data tab and tap Download when it is ready; it stays available for only a few days. Leave the file zipped."},
                    {"id": "upload", "title": "Add it here", "detail": "Add the ZIP to Little Archive."},
                ],
                "choose": {"information": ["All data"], "format": "JSON"},
                "formats": [
                    {"id": "json", "recommended": True, "reads": ["favorite videos with their save dates"]},
                    {"id": "txt", "recommended": False, "reads": ["favorite videos with their save dates"], "limitations": ["Built from documentation only; not checked against a real export."]},
                ],
                "expect": [{"file": "user_data_tiktok.json", "contains": "your activity, including Favorite Videos"}],
                "ignored": "Likes, watch history, shares, sounds, hashtags and everything else in the file are never imported.",
                "caveats": ["TikTok's export lists each favorite as a dated link only: no caption, creator or cover, and no collection names.",
                            "Links look like tiktokv.com/share/video/... and only open while the video is still on TikTok.",
                            "A large file may exceed the size this server accepts; request the TXT format or only the activity data if so."],
                "upload": upload,
                "verified": {"basis": "documentation and community descriptions", "real_export_tested": False,
                             "unverified": ["the whole TikTok layout, JSON and TXT", "the wording of TikTok's menus"]},
            },
        ],
    }


# ---------------------------------------------------------------- the job engine

def _ranges(indexes: list[int]) -> list[list[int]]:
    out: list[list[int]] = []
    for i in sorted(indexes):
        if out and i == out[-1][1] + 1:
            out[-1][1] = i
        else:
            out.append([i, i])
    return out


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for block in iter(lambda: stream.read(MIB), b""):
            digest.update(block)
    return digest.hexdigest()


class GuidedImports:
    """One library's guided imports. Holds no state that a restart would lose; the database and the staged file are the job."""

    def __init__(self, store, limits: GuidedImportLimits, *, background: bool = True):
        self.store, self.limits, self.background = store, limits, background
        self.threads: dict[str, threading.Thread] = {}
        self.on_batch = None          # test hook: called after each committed batch with (job id, cursor)
        self._guard, self._active = threading.Lock(), set()

    # -- paths
    def _dir(self, jid: str) -> Path:
        return self.store.root / "imports" / jid

    def _archive(self, jid: str) -> Path:
        return self._dir(jid) / "export.bin"

    def _received(self, jid: str) -> list[int]:
        folder = self._dir(jid) / "chunks"
        return sorted(int(p.name) for p in folder.iterdir() if p.name.isdigit()) if folder.is_dir() else []

    # -- rows
    def _row(self, c, jid):
        row = c.execute("SELECT * FROM guided_imports WHERE id=?", (jid,)).fetchone()
        if row is None:
            raise FeatureError(404, "This import was not found.", "import_not_found")
        return row

    def _set(self, c, jid, **fields):
        fields["updated_at"] = now()
        c.execute("UPDATE guided_imports SET " + ",".join(k + "=?" for k in fields) + " WHERE id=?", [*fields.values(), jid])

    def view(self, jid: str, *, with_preview: bool = True) -> dict:
        with self.store.transaction() as c:
            row = self._row(c, jid)
        return self._view(row, with_preview)

    def _view(self, row, with_preview=True) -> dict:
        jid = row["id"]
        received = self._received(jid) if row["state"] == "uploading" else list(range(row["chunks_total"])) if row["state"] in {"previewed", "importing", "completed", "failed"} else []
        total, cursor = row["total"], row["cursor"]
        return {
            "id": jid, "platform": row["platform"], "source_account": row["source_account"], "filename": row["filename"], "size_bytes": row["size_bytes"], "state": row["state"],
            "error": row["error"] or None,
            "upload": {"chunk_size": row["chunk_size"], "chunks_total": row["chunks_total"], "received": _ranges(received), "received_count": len(received),
                       "complete": len(received) == row["chunks_total"]},
            "preview": loads(row["preview"]) if with_preview and row["preview"] else None,
            "progress": {"total": total, "processed": cursor, "created": row["created"], "updated": row["updated"], "skipped": row["skipped"],
                         "percent": (100 if row["state"] == "completed" else min(99, cursor * 100 // total) if total else 0)},
            "run_id": row["run_id"], "created_at": row["created_at"], "updated_at": row["updated_at"], "started_at": row["started_at"], "finished_at": row["finished_at"],
            "resumable": row["state"] in {"uploading", "previewed", "importing", "failed"},
        }

    def list(self, limit: int = 20) -> dict:
        with self.store.transaction() as c:
            rows = c.execute("SELECT * FROM guided_imports ORDER BY created_at DESC,id DESC LIMIT ?", (limit,)).fetchall()
        for row in rows:
            if row["state"] == "importing":
                self.ensure_running(row["id"])      # an import interrupted by a restart picks up again when someone looks
        return {"imports": [self._view(r, with_preview=False) for r in rows]}

    # -- 1. create
    def create(self, *, platform: str, source_account: str, filename: str, size_bytes: int, sha256: str | None) -> dict:
        if size_bytes < 1 or size_bytes > self.limits.max_archive_bytes:
            raise FeatureError(413, f"This file is larger than this server accepts for an import ({self.limits.max_archive_bytes // MIB} MiB).", "file_too_large", max_bytes=self.limits.max_archive_bytes)
        if self.store.quota_bytes is not None and self.store.used_bytes() + size_bytes > self.store.quota_bytes:
            # A hosted account's staged upload counts toward its storage quota (Store.used_bytes), so say so before any piece is sent.
            raise FeatureError(507, "This library does not have room for a file this size. Delete items or thumbnails to make room, then add the file again.", "storage_full")
        self._prune()
        with self.store.lock:
            with self.store.transaction() as c:
                active = c.execute("SELECT count(*) FROM guided_imports WHERE state IN ('uploading','previewed','importing')").fetchone()[0]
                if active >= self.limits.max_active:
                    raise FeatureError(409, "Finish or cancel the import in progress before starting another.", "import_in_progress", max_active=self.limits.max_active)
                jid = str(uuid4())
                chunk = self.limits.chunk_bytes
                total = (size_bytes + chunk - 1) // chunk
                c.execute("INSERT INTO guided_imports(id,platform,source_account,filename,size_bytes,chunk_size,chunks_total,state,archive_sha256,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                          (jid, platform, source_account, filename, size_bytes, chunk, total, "uploading", (sha256 or "").lower(), now(), now()))
            (self._dir(jid) / "chunks").mkdir(parents=True, exist_ok=True, mode=0o700)
        return self.view(jid)

    def _prune(self) -> None:
        """Remove what an abandoned import left behind: staged pieces of any import untouched for a few days."""
        cutoff = now()
        with self.store.transaction() as c:
            rows = c.execute("SELECT id,updated_at FROM guided_imports WHERE state IN ('uploading','previewed','rejected')").fetchall()
        from datetime import datetime, timedelta, timezone
        limit = datetime.now(timezone.utc) - timedelta(hours=self.limits.stale_hours)
        for row in rows:
            try:
                stale = datetime.fromisoformat(row["updated_at"]) < limit
            except ValueError:
                stale = True
            if stale:
                with self.store.transaction() as c:
                    self._set(c, row["id"], state="cancelled", error="Abandoned, so it was cleared.", finished_at=cutoff)
                self._clear(row["id"])

    def _clear(self, jid: str) -> None:
        shutil.rmtree(self._dir(jid), ignore_errors=True)

    # -- 2. chunks
    def put_chunk(self, jid: str, index: int, data: bytes, checksum: str | None = None) -> dict:
        with self.store.transaction() as c:
            row = self._row(c, jid)
        if row["state"] != "uploading":
            raise FeatureError(409, "This import is no longer accepting pieces.", "not_uploading", state=row["state"])
        if not 0 <= index < row["chunks_total"]:
            raise FeatureError(422, "That piece is outside the file.", "bad_chunk_index", chunks_total=row["chunks_total"])
        expected = row["chunk_size"] if index < row["chunks_total"] - 1 else row["size_bytes"] - row["chunk_size"] * (row["chunks_total"] - 1)
        if len(data) != expected:
            raise FeatureError(422, f"That piece should be {expected} bytes.", "bad_chunk_size", expected=expected)
        if checksum and hashlib.sha256(data).hexdigest() != checksum.lower():
            raise FeatureError(422, "That piece arrived damaged. Send it again.", "chunk_checksum_mismatch")
        folder = self._dir(jid) / "chunks"
        folder.mkdir(parents=True, exist_ok=True, mode=0o700)
        part = folder / f"{index}.partial"
        part.write_bytes(data)
        os.replace(part, folder / str(index))
        with self.store.transaction() as c:
            self._set(c, jid)
        received = self._received(jid)
        return {"index": index, "received_count": len(received), "chunks_total": row["chunks_total"], "complete": len(received) == row["chunks_total"], "received": _ranges(received)}

    # -- 3. finish and preview
    def finish(self, jid: str) -> dict:
        with self.store.transaction() as c:
            row = self._row(c, jid)
        announced = row["archive_sha256"]       # while uploading, the checksum the client announced (or empty)
        if row["state"] in {"previewed", "importing", "completed"}:
            return self.view(jid)
        if row["state"] != "uploading":
            raise FeatureError(409, "This import cannot be finished in its current state.", "bad_state", state=row["state"])
        received = self._received(jid)
        if len(received) != row["chunks_total"]:
            missing = sorted(set(range(row["chunks_total"])) - set(received))
            raise FeatureError(409, "Some pieces have not arrived yet.", "upload_incomplete", missing=_ranges(missing)[:50], received=_ranges(received))
        archive = self._archive(jid)
        with open(archive, "wb") as out:
            for index in range(row["chunks_total"]):
                out.write((self._dir(jid) / "chunks" / str(index)).read_bytes())
        shutil.rmtree(self._dir(jid) / "chunks", ignore_errors=True)
        archive.chmod(0o600)
        digest = _sha256(archive)
        if archive.stat().st_size != row["size_bytes"] or (announced and announced != digest):
            self._reject(jid, "The file arrived damaged: it does not match what was announced. Add it again.", "checksum_mismatch", row)
            raise FeatureError(422, "The file arrived damaged: it does not match what was announced. Add it again.", "checksum_mismatch")
        with self.store.transaction() as c:
            self._set(c, jid, archive_sha256=digest)
        try:
            read = read_export(archive, row["filename"], row["platform"], self.limits.export)
        except ExportError as exc:
            self._reject(jid, exc.message, exc.code, row)
            raise FeatureError(422, exc.message, exc.code) from exc
        preview = self._preview(read, row)
        with self.store.transaction() as c:
            self._set(c, jid, state="previewed", preview=dumps(preview), preview_digest=preview["digest"], total=preview["totals"]["saves"], platform=read.platform)
        return self.view(jid)

    def _reject(self, jid, message, code, row) -> None:
        with self.store.transaction() as c:
            self._set(c, jid, state="rejected", error=message, finished_at=now())
        self._clear(jid)

    def preview(self, jid: str) -> dict:
        view = self.view(jid)
        if view["preview"] is None:
            raise FeatureError(409, "There is no preview yet: send the whole file and finish the upload first.", "no_preview", state=view["state"])
        return {"id": jid, "state": view["state"], "preview": view["preview"]}

    def _preview(self, read: ExportRead, row) -> dict:
        account = row["source_account"]
        known: dict[str, set] = {}
        keys = read.keys
        with self.store.transaction() as c:
            for start in range(0, len(keys), 500):
                chunk = keys[start:start + 500]
                marks = ",".join("?" for _ in chunk)
                for found in c.execute(f"SELECT source_key,source_account FROM items WHERE platform=? AND source_key IN ({marks})", [read.platform, *[k[1] for k in chunk]]):
                    known.setdefault(found["source_key"], set()).add(found["source_account"])
            existing_collections = {r[0] for r in c.execute("SELECT name FROM collections WHERE kind='source' AND platform=? AND source_account=?", (read.platform, account))}
        already = sum(1 for k in keys if account in known.get(k[1], ()))
        elsewhere = sum(1 for k in keys if k[1] in known and account not in known[k[1]])
        dates = sorted(d for d in (parse_date(r.get("saved_at")) for r in read.records) if d)
        sample = [{"url": r["url"], "creator": r.get("creator"), "saved_at": parse_date(r.get("saved_at")), "collections": [c["name"] for c in r["collections"]]} for r in read.records[:5]]
        canonical = dumps({"platform": read.platform, "account": account, "saves": [[r["url"], sorted(c["name"] for c in r["collections"]), parse_date(r.get("saved_at"))] for r in read.records]})
        return {
            "platform": read.platform, "format": read.format, "source_account": account,
            "files": read.files,
            "totals": {"entries": read.entries, "saves": len(read.records), "new": len(read.records) - already, "already_in_library": already, "in_library_other_account": elsewhere,
                       "duplicates_in_archive": read.duplicates, "unreadable": read.unreadable_total, "in_collections_only": sum(1 for r in read.records if r.get("collection_only"))},
            "collections": [{**c, "exists": c["name"] in existing_collections} for c in read.collections[:500]], "collections_total": len(read.collections), "collections_read": read.collections_read,
            "sections": read.sections, "ignored": {"sections": read.ignored_sections[:20], "files": read.ignored_files, "nested_archives": read.nested_archives},
            "date_range": {"first": dates[0], "last": dates[-1]} if dates else None,
            "unreadable": read.unreadable, "unreadable_total": read.unreadable_total, "sample": sample, "warnings": read.warnings[:20],
            "digest": hashlib.sha256(canonical.encode()).hexdigest(), "scanned_at": now(),
        }

    # -- 4. commit and the job
    def commit(self, jid: str, digest: str | None) -> dict:
        with self.store.lock:
            with self.store.transaction() as c:
                row = self._row(c, jid)
                if row["state"] == "previewed":
                    if not digest or digest != row["preview_digest"]:
                        raise FeatureError(409, "Confirm the preview that was shown: its digest does not match.", "digest_mismatch")
                    run_id = str(uuid4())
                    c.execute("INSERT INTO import_runs(id,source,source_account,status,started_at,scopes) VALUES(?,?,?,?,?,?)",
                              (run_id, row["platform"], row["source_account"], "running", now(), dumps([Path(row["filename"]).name])))
                    self._set(c, jid, state="importing", run_id=run_id, started_at=now(), error="")
                elif row["state"] == "failed":
                    self._set(c, jid, state="importing", error="")          # continue from the cursor
                elif row["state"] != "importing":
                    raise FeatureError(409, "This import cannot be started in its current state.", "bad_state", state=row["state"])
        self.ensure_running(jid)
        return self.view(jid)

    def ensure_running(self, jid: str) -> None:
        if not self.background:
            return
        thread = self.threads.get(jid)
        if thread is not None and thread.is_alive():
            return
        thread = threading.Thread(target=self._thread, args=(jid,), daemon=True, name=f"little-archive-import-{jid[:8]}")
        self.threads[jid] = thread
        thread.start()

    def _thread(self, jid: str) -> None:
        with _SLOTS:
            self.run(jid)

    def run(self, jid: str) -> None:
        """Process the job from its cursor until it is done, cancelled or stopped. Safe to call again at any time: a second
        caller while one is running returns at once, and each batch checks the stored cursor before it writes."""
        with self._guard:
            if jid in self._active:
                return
            self._active.add(jid)
        try:
            self._run(jid)
        finally:
            with self._guard:
                self._active.discard(jid)

    def _run(self, jid: str) -> None:
        try:
            with self.store.transaction() as c:
                row = self._row(c, jid)
            if row["state"] != "importing":
                return
            archive = self._archive(jid)
            if not archive.is_file() or _sha256(archive) != row["archive_sha256"]:
                self._fail(jid, "The staged file is missing or changed. Add the export again.", retryable=False)
                return
            read = read_export(archive, row["filename"], row["platform"], self.limits.export)
            records = read.records
            if len(records) != row["total"]:
                self._fail(jid, "The file no longer matches its preview. Add the export again.", retryable=False)
                return
            cursor, errors = row["cursor"], []
            created, updated, skipped = row["created"], row["updated"], row["skipped"]
            while cursor < len(records):
                batch = records[cursor:cursor + self.limits.batch_size]
                resync = None
                with self.store.lock:
                    with self.store.transaction() as c:
                        state = c.execute("SELECT state,cursor,created,updated,skipped FROM guided_imports WHERE id=?", (jid,)).fetchone()
                        if state is None or state["state"] != "importing":
                            return                                          # cancelled while working
                        if state["cursor"] != cursor:
                            # Another runner (another process, or this library reopened) already committed past here.
                            resync = (state["cursor"], state["created"], state["updated"], state["skipped"])
                        else:
                            b_created = b_updated = b_skipped = 0
                            for offset, record in enumerate(batch):
                                payload = {k: v for k, v in record.items() if k != "collection_only"}
                                c.execute("SAVEPOINT guided_item")
                                try:
                                    _, new = self.store.apply_item(c, payload, account=row["source_account"], file_input=True)
                                    b_created += int(new)
                                    b_updated += int(not new)
                                    c.execute("RELEASE guided_item")
                                except (ValueError, TypeError, sqlite3.IntegrityError) as exc:
                                    c.execute("ROLLBACK TO guided_item")
                                    c.execute("RELEASE guided_item")
                                    b_skipped += 1
                                    if len(errors) < 20:
                                        errors.append(f"Save {cursor + offset + 1}: {str(exc)[:160]}")
                            cursor += len(batch)
                            created, updated, skipped = created + b_created, updated + b_updated, skipped + b_skipped
                            self._set(c, jid, cursor=cursor, created=created, updated=updated, skipped=skipped)
                            c.execute("UPDATE import_runs SET created=?,updated=?,skipped=? WHERE id=?", (created, updated, skipped, row["run_id"]))
                if resync is not None:
                    cursor, created, updated, skipped = resync
                    continue
                if self.on_batch is not None:
                    self.on_batch(jid, cursor)
            with self.store.lock:
                with self.store.transaction() as c:
                    still = c.execute("SELECT state FROM guided_imports WHERE id=?", (jid,)).fetchone()
                    if still is not None and still[0] == "importing":
                        self._set(c, jid, state="completed", finished_at=now())
                        c.execute("UPDATE import_runs SET status='completed',coverage='partial',created=?,updated=?,skipped=?,error=?,finished_at=? WHERE id=?",
                                  (created, updated, skipped, "\n".join(errors)[:5000], now(), row["run_id"]))
            self._clear(jid)
        except LibraryClosed:
            return
        except sqlite3.OperationalError as exc:
            if getattr(exc, "sqlite_errorcode", None) == sqlite3.SQLITE_FULL:
                self._fail(jid, FULL, retryable=True)
            else:
                log.warning("A guided import stopped on a database error.", exc_info=False)
                self._fail(jid, "The import stopped on a database error. Start it again to continue from where it stopped.", retryable=True)
        except ExportError as exc:
            self._fail(jid, exc.message, retryable=False)
        except Exception:
            log.warning("A guided import stopped unexpectedly.", exc_info=False)
            self._fail(jid, "The import stopped unexpectedly. Start it again to continue from where it stopped.", retryable=True)

    def _fail(self, jid: str, message: str, *, retryable: bool) -> None:
        try:
            with self.store.transaction() as c:
                self._set(c, jid, state="failed" if retryable else "rejected", error=message, finished_at=None if retryable else now())
                row = c.execute("SELECT run_id FROM guided_imports WHERE id=?", (jid,)).fetchone()
                if row and row["run_id"] and not retryable:
                    c.execute("UPDATE import_runs SET status='cancelled',finished_at=? WHERE id=?", (now(), row["run_id"]))
        except LibraryClosed:
            return
        if not retryable:
            self._clear(jid)

    def drain(self) -> None:
        """Run every importing job to the end on this thread. For tests and one-shot tools."""
        with self.store.transaction() as c:
            ids = [r[0] for r in c.execute("SELECT id FROM guided_imports WHERE state='importing'")]
        for jid in ids:
            self.run(jid)

    # -- cancel
    def cancel(self, jid: str) -> dict:
        with self.store.lock:
            with self.store.transaction() as c:
                row = self._row(c, jid)
                if row["state"] in FINISHED:
                    return self._view(row)
                self._set(c, jid, state="cancelled", error="Cancelled. Saves already imported were kept.", finished_at=now())
                if row["run_id"]:
                    c.execute("UPDATE import_runs SET status='cancelled',coverage='partial',finished_at=? WHERE id=?", (now(), row["run_id"]))
        self._clear(jid)
        return self.view(jid)
