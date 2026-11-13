"""Self-hosted HTTP API. Run one worker; SQLite and durable jobs coordinate within it."""
from contextlib import asynccontextmanager
import csv
from datetime import datetime
import hashlib
import hmac
import html
import io
import json
import os
from pathlib import Path
import re
import secrets
import sqlite3
import time
from typing import Literal
from urllib.parse import urlsplit
from uuid import uuid4

from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from starlette.background import BackgroundTask
from starlette.middleware.trustedhost import TrustedHostMiddleware

from . import __version__
from .backups import create_backup
from .config import Config
from .jobs import ClassificationWorker
from .models import AIJobs, BulkAction, CollectionInput, CollectionPatch, ImportBatch, ImportFinish, ImportStart, ItemPatch, Login, NewItem, SettingsPatch, TokenInput
from .security import RateLimiter, token_hash, verify_password
from .storage import Store, clean_tags, json_text, normalize_url, now


COOKIE = "little_archive_session"


class BodyLimitMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope.get("method") not in {"POST", "PUT", "PATCH"}:
            return await self.app(scope, receive, send)
        path = scope.get("path", "")
        maximum = 16 * 1024 * 1024
        if path.endswith("/batches"):
            maximum = 256 * 1024
        elif path.startswith("/api/auth/"):
            maximum = 8 * 1024
        elif path.endswith("/thumbnail"):
            maximum = 8 * 1024 * 1024
        headers = dict(scope.get("headers", []))
        try:
            declared = int(headers.get(b"content-length", b"0"))
        except ValueError:
            return await JSONResponse({"detail": "Invalid request length."}, 400)(scope, receive, send)
        if declared > maximum or declared < 0:
            return await JSONResponse({"detail": "This upload exceeds the request size limit."}, 413)(scope, receive, send)
        chunks, count = [], 0
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            chunk = message.get("body", b"")
            count += len(chunk)
            if count > maximum:
                return await JSONResponse({"detail": "This upload exceeds the request size limit."}, 413)(scope, receive, send)
            chunks.append(chunk)
            if not message.get("more_body"):
                break
        body = b"".join(chunks)
        sent = False

        async def replay():
            nonlocal sent
            if not sent:
                sent = True
                return {"type": "http.request", "body": body, "more_body": False}
            return await receive()

        await self.app(scope, replay, send)


def create_app(config: Config | None = None):
    config = config or Config.from_env()
    config.validate()
    store = Store(config)
    worker = ClassificationWorker(store, config)
    limiter = RateLimiter()

    @asynccontextmanager
    async def lifespan(app):
        worker.start()
        yield
        worker.stop()

    app = FastAPI(title="Little Archive", version=__version__, docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)
    app.state.store, app.state.config, app.state.worker = store, config, worker
    app.add_middleware(BodyLimitMiddleware)
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=config.allowed_hosts)

    @app.middleware("http")
    async def security_headers(request, call_next):
        origin = request.headers.get("origin", "")
        extension_origin = bool(re.fullmatch(r"chrome-extension://[a-p]{32}", origin))
        if request.method == "OPTIONS" and request.url.path.startswith("/api/extension/") and extension_origin:
            response = Response(status_code=204, headers={
                "Access-Control-Allow-Origin": origin,
                "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
                "Access-Control-Allow-Headers": "Authorization,Content-Type",
                "Access-Control-Max-Age": "600",
                "Vary": "Origin",
            })
        else:
            response = await call_next(request)
            if extension_origin and request.url.path.startswith("/api/extension/"):
                response.headers["Access-Control-Allow-Origin"] = origin
                response.headers["Vary"] = "Origin"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
        response.headers["Content-Security-Policy"] = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
        if request.url.path.startswith("/api/"):
            response.headers["Cache-Control"] = "no-store"
        if config.secure_cookies:
            response.headers["Strict-Transport-Security"] = "max-age=31536000"
        return response

    @app.exception_handler(ValueError)
    async def bad_value(request, exc):
        return JSONResponse({"detail": str(exc)}, status_code=400)

    @app.exception_handler(sqlite3.IntegrityError)
    async def conflict(request, exc):
        return JSONResponse({"detail": "That change conflicts with an existing record."}, status_code=409)

    def same_origin(request):
        origin = request.headers.get("origin")
        if origin and origin.rstrip("/") != config.public_url:
            raise HTTPException(403, "This action must originate from your Little Archive instance.")
        if request.headers.get("sec-fetch-site") == "cross-site":
            raise HTTPException(403, "Cross-site request refused.")

    def session_row(request):
        token = request.cookies.get(COOKIE, "")
        if not token or len(token) > 200:
            return None
        with store.transaction() as c:
            row = c.execute("SELECT * FROM sessions WHERE hash=? AND expires>?", (token_hash(token), time.time())).fetchone()
            return dict(row) if row else None

    def owner(request: Request):
        session = session_row(request)
        if not session:
            raise HTTPException(401, "Sign in to your library.")
        if request.method not in {"GET", "HEAD", "OPTIONS"}:
            same_origin(request)
            supplied = request.headers.get("x-csrf-token", "")
            if not supplied or not hmac.compare_digest(supplied, session["csrf"]):
                raise HTTPException(403, "Your session changed. Refresh the page and try again.")
        return session

    def importer(request: Request):
        header = request.headers.get("authorization", "")
        if not header.startswith("Bearer ") or len(header) > 256:
            raise HTTPException(401, "A valid extension import token is required.")
        raw = header[7:]
        with store.transaction() as c:
            row = c.execute("SELECT * FROM extension_tokens WHERE hash=?", (token_hash(raw),)).fetchone()
            if not row:
                raise HTTPException(401, "The extension token is invalid or has been revoked.")
            c.execute("UPDATE extension_tokens SET last_used_at=? WHERE id=?", (now(), row["id"]))
            return dict(row)

    def must_item(iid, c=None):
        item = store.get_item(iid, c)
        if not item:
            raise HTTPException(404, "This item was not found.")
        return item

    @app.get("/api/health")
    def health():
        return {"status": "ok", "version": __version__}

    @app.get("/api/auth/me")
    def auth_me(request: Request):
        session = session_row(request)
        return {"authenticated": bool(session), "version": __version__, **({"csrf_token": session["csrf"]} if session else {})}

    @app.post("/api/auth/login")
    def login(data: Login, request: Request):
        same_origin(request)
        peer = request.client.host if request.client else "unknown"
        if not limiter.consume(peer):
            raise HTTPException(429, "Too many sign-in attempts. Try again in 15 minutes.", headers={"Retry-After": "900"})
        if not verify_password(data.password, store.meta("password_hash")):
            raise HTTPException(401, "That password did not match.")
        limiter.clear(peer)
        token, csrf = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
        with store.transaction() as c:
            old = request.cookies.get(COOKIE)
            if old:
                c.execute("DELETE FROM sessions WHERE hash=?", (token_hash(old),))
            c.execute("DELETE FROM sessions WHERE expires<=?", (time.time(),))
            c.execute("INSERT INTO sessions VALUES(?,?,?)", (token_hash(token), csrf, time.time() + config.session_hours * 3600))
        response = JSONResponse({"authenticated": True, "csrf_token": csrf})
        response.set_cookie(COOKIE, token, max_age=config.session_hours * 3600, httponly=True, secure=config.secure_cookies, samesite="strict", path="/")
        return response

    @app.post("/api/auth/logout")
    def logout(request: Request, auth=Depends(owner)):
        with store.transaction() as c:
            c.execute("DELETE FROM sessions WHERE hash=?", (auth["hash"],))
        response = JSONResponse({"ok": True})
        response.delete_cookie(COOKIE, path="/", secure=config.secure_cookies, httponly=True, samesite="strict")
        return response

    @app.get("/api/items")
    def list_items(q: str = Query("", max_length=500), platform: Literal["", "instagram", "tiktok", "web"] = "", collection_id: str = "", tag: str = "", status: Literal["", "inbox", "to_revisit", "done", "archived"] = "", favorite: bool | None = None, needs_review: bool | None = None, sort: Literal["recent", "oldest", "title", "random"] = "recent", limit: int = Query(60, ge=1, le=200), offset: int = Query(0, ge=0, le=1000000), auth=Depends(owner)):
        return store.list_items(q=q, platform=platform, collection_id=collection_id, tag=tag, status=status, favorite=favorite, needs_review=needs_review, sort=sort, limit=limit, offset=offset)

    @app.post("/api/items")
    def add_item(data: NewItem, auth=Depends(owner)):
        with store.transaction() as c:
            iid, _ = store.apply_item(c, data.model_dump(), manual=True)
            if data.collection_ids:
                store.set_local_memberships(c, iid, data.collection_ids)
            return store.get_item(iid, c)

    @app.post("/api/items/bulk")
    def bulk(data: BulkAction, auth=Depends(owner)):
        ids = list(dict.fromkeys(data.ids))
        with store.transaction() as c:
            for iid in ids:
                must_item(iid, c)
            if data.action == "collection":
                col = c.execute("SELECT kind FROM collections WHERE id=?", (data.value,)).fetchone()
                if not col or col[0] != "local":
                    raise ValueError("Choose a local collection.")
            for iid in ids:
                if data.action in {"favorite", "unfavorite"}:
                    c.execute("UPDATE items SET favorite=?,updated_at=? WHERE id=?", (int(data.action == "favorite"), now(), iid))
                elif data.action in {"archive", "restore"}:
                    c.execute("UPDATE items SET status=?,updated_at=? WHERE id=?", ("archived" if data.action == "archive" else "inbox", now(), iid))
                elif data.action == "tag":
                    tag = clean_tags([data.value])[0]
                    current = json.loads(c.execute("SELECT tags FROM items WHERE id=?", (iid,)).fetchone()[0])
                    c.execute("UPDATE items SET tags=?,updated_at=? WHERE id=?", (json_text(clean_tags(current + [tag])), now(), iid))
                    store.index_item(c, iid)
                elif data.action == "collection":
                    c.execute("INSERT OR IGNORE INTO memberships VALUES(?,?)", (iid, data.value))
            return {"updated": len(ids)}

    @app.get("/api/items/{iid}")
    def item_detail(iid: str, auth=Depends(owner)):
        return must_item(iid)

    @app.patch("/api/items/{iid}")
    def edit_item(iid: str, data: ItemPatch, auth=Depends(owner)):
        values = data.model_dump(exclude_unset=True)
        with store.transaction() as c:
            must_item(iid, c)
            local_collections = values.pop("collection_ids", None)
            if "tags" in values:
                values["tags"] = json_text(clean_tags(values["tags"]))
            if "title" in values:
                if not values["title"].strip():
                    raise ValueError("Give the item a title.")
                values["manual_title"] = 1
            if "summary" in values:
                values["manual_summary"] = 1
            if values:
                values["updated_at"] = now()
                c.execute("UPDATE items SET " + ",".join(k + "=?" for k in values) + " WHERE id=?", [*values.values(), iid])
            if local_collections is not None:
                store.set_local_memberships(c, iid, local_collections)
            store.index_item(c, iid)
            return store.get_item(iid, c)

    @app.delete("/api/items/{iid}")
    def delete_item(iid: str, auth=Depends(owner)):
        with store.transaction() as c:
            must_item(iid, c)
            c.execute("DELETE FROM item_search WHERE item_id=?", (iid,))
            c.execute("DELETE FROM items WHERE id=?", (iid,))
        return {"ok": True}

    @app.post("/api/items/{iid}/thumbnail")
    async def upload_thumbnail(iid: str, request: Request, auth=Depends(owner)):
        from PIL import Image, ImageOps, UnidentifiedImageError
        must_item(iid)
        raw = await request.body()
        try:
            with Image.open(io.BytesIO(raw)) as im:
                if im.format not in {"PNG", "JPEG", "WEBP"} or im.width * im.height > 20000000:
                    raise ValueError("Use a PNG, JPEG, or WebP image under 20 megapixels.")
                im = ImageOps.exif_transpose(im).convert("RGB")
                im.thumbnail((1600, 1600))
                output = io.BytesIO()
                im.save(output, format="PNG", optimize=True)
                blob = output.getvalue()
        except (UnidentifiedImageError, OSError, Image.DecompressionBombError):
            raise ValueError("That file could not be decoded as a safe image.")
        digest = hashlib.sha256(blob).hexdigest()
        target = store.assets / (digest + ".png")
        with store.lock:
            if not target.exists():
                temporary = store.assets / ("." + secrets.token_hex(16) + ".tmp")
                try:
                    with open(temporary, "xb") as f:
                        f.write(blob)
                        f.flush()
                        os.fsync(f.fileno())
                    temporary.chmod(0o600)
                    os.replace(temporary, target)
                finally:
                    temporary.unlink(missing_ok=True)
            with store.transaction() as c:
                must_item(iid, c)
                c.execute("UPDATE items SET asset_hash=?,updated_at=? WHERE id=?", (digest, now(), iid))
                return store.get_item(iid, c)

    @app.delete("/api/items/{iid}/thumbnail")
    def delete_thumbnail(iid: str, auth=Depends(owner)):
        with store.transaction() as c:
            must_item(iid, c)
            c.execute("UPDATE items SET asset_hash=NULL,updated_at=? WHERE id=?", (now(), iid))
            return store.get_item(iid, c)

    @app.get("/api/assets/{digest}")
    def asset(digest: str, auth=Depends(owner)):
        if not re.fullmatch(r"[0-9a-f]{64}", digest):
            raise HTTPException(404, "Thumbnail not found.")
        with store.transaction() as c:
            found = c.execute("SELECT 1 FROM items WHERE asset_hash=? LIMIT 1", (digest,)).fetchone()
        path = store.assets / (digest + ".png")
        if not found or not path.is_file():
            raise HTTPException(404, "Thumbnail not found.")
        return FileResponse(path, media_type="image/png")

    @app.get("/api/collections")
    def list_collections(auth=Depends(owner)):
        return {"collections": store.collections()}

    @app.post("/api/collections")
    def add_collection(data: CollectionInput, auth=Depends(owner)):
        with store.transaction() as c:
            cid = store.resolve_collection(c, {"name": data.name.strip(), "kind": "local"}, "web", "local")
            c.execute("UPDATE collections SET color=? WHERE id=?", (data.color, cid))
            return next(x for x in store.collections(c) if x["id"] == cid)

    @app.patch("/api/collections/{cid}")
    def edit_collection(cid: str, data: CollectionPatch, auth=Depends(owner)):
        values = data.model_dump(exclude_unset=True)
        if any(v is None for v in values.values()) or ("name" in values and not values["name"].strip()):
            raise ValueError("Use a nonempty collection name and a valid color.")
        with store.transaction() as c:
            old = c.execute("SELECT * FROM collections WHERE id=?", (cid,)).fetchone()
            if not old:
                raise HTTPException(404, "Collection not found.")
            if old["kind"] != "local":
                raise HTTPException(403, "Source collections preserve the original name. Create a local collection to organize differently.")
            if "name" in values:
                values["name"] = values["name"].strip()
                values["source_key"] = "name:" + hashlib.sha256(values["name"].casefold().encode()).hexdigest()
            if values:
                c.execute("UPDATE collections SET " + ",".join(k + "=?" for k in values) + " WHERE id=?", [*values.values(), cid])
            return next(x for x in store.collections(c) if x["id"] == cid)

    @app.delete("/api/collections/{cid}")
    def delete_collection(cid: str, auth=Depends(owner)):
        with store.transaction() as c:
            row = c.execute("SELECT kind FROM collections WHERE id=?", (cid,)).fetchone()
            if not row:
                raise HTTPException(404, "Collection not found.")
            if row[0] != "local":
                raise HTTPException(403, "Source collection membership is managed by imports.")
            c.execute("DELETE FROM collections WHERE id=?", (cid,))
        return {"ok": True}

    @app.get("/api/tags")
    def list_tags(auth=Depends(owner)):
        with store.transaction() as c:
            return {"tags": [dict(x) for x in c.execute("SELECT j.value AS name,COUNT(*) AS count FROM items i,json_each(i.tags) j WHERE i.status!='archived' GROUP BY j.value ORDER BY count DESC,name LIMIT 1000")]}

    @app.get("/api/stats")
    def stats(auth=Depends(owner)):
        with store.transaction() as c:
            def count(where="1"):
                return c.execute("SELECT count(*) FROM items WHERE " + where).fetchone()[0]
            return {"total": count("status!='archived'"), "favorites": count("favorite=1 AND status!='archived'"), "to_revisit": count("status='to_revisit'"), "needs_review": count("needs_review=1 AND status!='archived'"), "archived": count("status='archived'"), "collections": c.execute("SELECT count(*) FROM collections").fetchone()[0], "platforms": {x: c.execute("SELECT count(*) FROM items WHERE platform=? AND status!='archived'", (x,)).fetchone()[0] for x in ("instagram", "tiktok", "web")}}

    @app.post("/api/imports/file")
    async def import_file(request: Request, filename: str = Query(..., min_length=1, max_length=200), auth=Depends(owner)):
        from .importers import parse_import
        data = await request.body()
        parsed = parse_import(data, filename)
        if len(parsed["items"]) > 20000:
            raise ValueError("Import at most 20,000 records at once; split this export into smaller files.")
        rid = str(uuid4())
        created = updated = skipped = 0
        errors = list(parsed.get("warnings", []))[:30]
        with store.transaction() as c:
            c.execute("INSERT INTO import_runs(id,source,source_account,status,started_at,scopes) VALUES(?,?,?,?,?,?)", (rid, "file", "file", "running", now(), json_text([Path(filename).name])))
            for definition in parsed.get("collections", []):
                store.resolve_collection(c, definition, definition["platform"], definition["source_account"])
            for index, record in enumerate(parsed["items"]):
                c.execute("SAVEPOINT item_import")
                try:
                    _, new = store.apply_item(c, record, portable=bool(parsed.get("portable")), file_input=True)
                    created += int(new)
                    updated += int(not new)
                    c.execute("RELEASE item_import")
                except (ValueError, TypeError, sqlite3.IntegrityError) as exc:
                    c.execute("ROLLBACK TO item_import")
                    c.execute("RELEASE item_import")
                    skipped += 1
                    if len(errors) < 30:
                        errors.append(f"Record {index + 1}: {str(exc)[:200]}")
            c.execute("UPDATE import_runs SET status='completed',coverage='partial',created=?,updated=?,skipped=?,error=?,finished_at=? WHERE id=?", (created, updated, skipped, "\n".join(errors)[:5000], now(), rid))
        return {"run_id": rid, "created": created, "updated": updated, "skipped": skipped, "errors": errors, "coverage": "partial"}

    @app.get("/api/imports")
    def imports(auth=Depends(owner)):
        with store.transaction() as c:
            result = [dict(x) for x in c.execute("SELECT id,source,source_account,status,coverage,created,updated,skipped,error,started_at,finished_at,scopes FROM import_runs ORDER BY started_at DESC,id DESC LIMIT 100")]
            for row in result:
                row["scopes"] = json.loads(row["scopes"])
            return {"imports": result}

    @app.get("/api/export")
    def export(format: Literal["json", "csv", "html"] = "json", auth=Depends(owner)):
        with store.transaction() as c:
            items, collections = store.export_items(c), store.collections(c)
        if format == "json":
            blob = json.dumps({"format": "little-archive", "version": 1, "exported_at": now(), "items": items, "collections": collections}, ensure_ascii=False, indent=2).encode()
            media = "application/json"
        elif format == "csv":
            out = io.StringIO(newline="")
            fields = ["url", "title", "platform", "source_account", "creator", "caption", "summary", "notes", "tags", "collections", "favorite", "status", "saved_at"]
            writer = csv.DictWriter(out, fieldnames=fields)
            writer.writeheader()
            for item in items:
                row = {k: item.get(k) or "" for k in fields}
                row["tags"] = json_text(item["tags"])
                row["collections"] = json_text(item["collections"])
                row["favorite"] = "true" if item["favorite"] else "false"
                # Formula injection protection for spreadsheet consumers.
                row = {k: "'" + v if isinstance(v, str) and v.lstrip().startswith(("=", "+", "-", "@")) else v for k, v in row.items()}
                writer.writerow(row)
            blob, media = out.getvalue().encode("utf-8-sig"), "text/csv"
        else:
            lines = ['<!DOCTYPE NETSCAPE-Bookmark-file-1>', '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">', '<TITLE>Little Archive</TITLE>', '<H1>Little Archive</H1>', '<DL><p>']
            for item in items:
                lines.append(f'<DT><A HREF="{html.escape(item["url"], quote=True)}">{html.escape(item["title"])}</A>')
                if item["notes"]:
                    lines.append("<DD>" + html.escape(item["notes"]))
            lines.append('</DL><p>')
            blob, media = "\n".join(lines).encode(), "text/html"
        return Response(blob, media_type=media, headers={"Content-Disposition": f'attachment; filename="little-archive-export.{format}"'})

    @app.get("/api/backup")
    def backup(auth=Depends(owner)):
        temporary, path = create_backup(store)
        filename = "little-archive-backup-" + datetime.now().strftime("%Y%m%d") + ".zip"
        return FileResponse(path, media_type="application/zip", filename=filename, background=BackgroundTask(temporary.cleanup))

    @app.get("/api/extension/tokens")
    def tokens(auth=Depends(owner)):
        with store.transaction() as c:
            return {"tokens": [dict(x) for x in c.execute("SELECT id,name,created_at,last_used_at FROM extension_tokens ORDER BY created_at DESC")]}

    @app.post("/api/extension/tokens")
    def create_token(data: TokenInput, auth=Depends(owner)):
        token, tid = "la_" + secrets.token_urlsafe(32), str(uuid4())
        with store.transaction() as c:
            if c.execute("SELECT count(*) FROM extension_tokens").fetchone()[0] >= 20:
                raise ValueError("Revoke an unused token before creating another (20-token limit).")
            c.execute("INSERT INTO extension_tokens(id,name,hash,created_at) VALUES(?,?,?,?)", (tid, data.name.strip() or "Browser", token_hash(token), now()))
        return {"id": tid, "name": data.name, "token": token}

    @app.delete("/api/extension/tokens/{tid}")
    def revoke_token(tid: str, auth=Depends(owner)):
        with store.transaction() as c:
            c.execute("DELETE FROM extension_tokens WHERE id=?", (tid,))
            c.execute("UPDATE import_runs SET status='cancelled',coverage='partial',finished_at=? WHERE token_id=? AND status='running'", (now(), tid))
        return {"ok": True}

    @app.get("/api/extension/status")
    def extension_status(auth=Depends(importer)):
        return {"ok": True, "version": __version__, "instance_id": store.meta("instance_id")}

    @app.post("/api/extension/imports")
    def begin_import(data: ImportStart, auth=Depends(importer)):
        rid = str(uuid4())
        with store.transaction() as c:
            c.execute("INSERT INTO import_runs(id,source,source_account,token_id,status,started_at,scopes) VALUES(?,?,?,?,?,?,?)", (rid, data.platform, data.source_account, auth["id"], "running", now(), json_text([data.scope])))
        return {"run_id": rid, "instance_id": store.meta("instance_id")}

    @app.post("/api/extension/imports/{rid}/batches")
    def import_batch(rid: str, data: ImportBatch, auth=Depends(importer)):
        digest = hashlib.sha256(json_text(data.model_dump()).encode()).hexdigest()
        with store.transaction() as c:
            run = c.execute("SELECT * FROM import_runs WHERE id=? AND token_id=?", (rid, auth["id"])).fetchone()
            if not run:
                raise HTTPException(404, "Import run not found for this token.")
            previous = c.execute("SELECT * FROM batches WHERE batch_id=? OR (run_id=? AND sequence=?)", (data.batch_id, rid, data.sequence)).fetchall()
            if previous:
                if len(previous) != 1 or previous[0]["digest"] != digest or previous[0]["run_id"] != rid or previous[0]["batch_id"] != data.batch_id or previous[0]["sequence"] != data.sequence:
                    raise HTTPException(409, "Batch identity conflicts with an earlier payload.")
                r = previous[0]
                return {"status": "applied", "created": r["created"], "updated": r["updated"], "skipped": r["skipped"], "replayed": True}
            if run["status"] != "running":
                raise HTTPException(409, "This import is closed. Start a new import.")
            created = updated = 0
            for observation in data.items:
                _, new = store.apply_item(c, observation.model_dump(), account=run["source_account"], expected_platform=run["source"])
                created += int(new)
                updated += int(not new)
            c.execute("INSERT INTO batches VALUES(?,?,?,?,?,?,?)", (data.batch_id, rid, data.sequence, digest, created, updated, 0))
            c.execute("UPDATE import_runs SET created=created+?,updated=updated+? WHERE id=?", (created, updated, rid))
        return {"status": "applied", "created": created, "updated": updated, "skipped": 0, "replayed": False}

    @app.post("/api/extension/imports/{rid}/finish")
    def finish_import(rid: str, data: ImportFinish, auth=Depends(importer)):
        with store.transaction() as c:
            run = c.execute("SELECT * FROM import_runs WHERE id=? AND token_id=?", (rid, auth["id"])).fetchone()
            if not run:
                raise HTTPException(404, "Import run not found for this token.")
            if run["status"] == "cancelled":
                raise HTTPException(409, "This import was cancelled.")
            seq = [x[0] for x in c.execute("SELECT sequence FROM batches WHERE run_id=? ORDER BY sequence", (rid,))]
            if seq != list(range(data.expected_batches)):
                raise HTTPException(409, "Some import batches are missing or the expected count differs.")
            coverage = data.coverage if data.expected_batches else "partial"
            if run["status"] == "completed" and (run["expected_batches"] != data.expected_batches or run["coverage"] != coverage):
                raise HTTPException(409, "This run was already finalized with different coverage.")
            c.execute("UPDATE import_runs SET status='completed',coverage=?,error=?,expected_batches=?,finished_at=? WHERE id=?", (coverage, data.reason, data.expected_batches, now(), rid))
            return {"ok": True, "created": run["created"], "updated": run["updated"], "skipped": run["skipped"], "coverage": coverage}

    def current_settings():
        enabled = bool(config.ollama_url and config.ollama_model)
        return {"remote_previews": store.meta("remote_previews") == "true", "ai_enabled": enabled, "ai_available": enabled, "ai_model": config.ollama_model}

    @app.get("/api/settings")
    def settings(auth=Depends(owner)):
        return current_settings()

    @app.patch("/api/settings")
    def edit_settings(data: SettingsPatch, auth=Depends(owner)):
        store.set_meta("remote_previews", "true" if data.remote_previews else "false")
        return current_settings()

    @app.post("/api/ai/jobs")
    def queue_ai(data: AIJobs, auth=Depends(owner)):
        if not config.ollama_url or not config.ollama_model:
            raise HTTPException(503, "Configure LA_OLLAMA_URL and LA_OLLAMA_MODEL on your server to enable local AI.")
        return {"queued": worker.enqueue(data.ids)}

    @app.get("/api/ai/jobs")
    def ai_jobs(auth=Depends(owner)):
        with store.transaction() as c:
            return {"jobs": [dict(x) for x in c.execute("SELECT id,item_id,status,error,created_at FROM ai_jobs ORDER BY created_at DESC,id DESC LIMIT 100")]}

    @app.post("/api/items/{iid}/ai/accept")
    def accept_ai(iid: str, auth=Depends(owner)):
        with store.transaction() as c:
            item = must_item(iid, c)
            row = c.execute("SELECT * FROM items WHERE id=?", (iid,)).fetchone()
            if not row["ai"]:
                raise ValueError("There are no AI suggestions to accept.")
            ai = json.loads(row["ai"])
            if ai.get("input_hash") != worker.fingerprint(item):
                raise HTTPException(409, "This item's information changed. Generate fresh suggestions before accepting them.")
            tags = clean_tags(json.loads(row["tags"]) + ai.get("topics", []))
            c.execute("UPDATE items SET title=?,summary=?,tags=?,needs_review=0,updated_at=? WHERE id=?", (row["title"] if row["manual_title"] else ai.get("suggested_title") or row["title"], row["summary"] if row["manual_summary"] else ai.get("summary") or row["summary"], json_text(tags), now(), iid))
            store.index_item(c, iid)
            return store.get_item(iid, c)

    @app.post("/api/items/{iid}/ai/dismiss")
    def dismiss_ai(iid: str, auth=Depends(owner)):
        with store.transaction() as c:
            item = must_item(iid, c)
            if item["ai"]:
                c.execute("UPDATE items SET ai_dismissed=?,ai=NULL,needs_review=0,updated_at=? WHERE id=?", (item["ai"].get("input_hash"), now(), iid))
            return store.get_item(iid, c)

    @app.post("/api/demo")
    def seed_demo(auth=Depends(owner)):
        from .demo import demo_items
        created = 0
        with store.transaction() as c:
            for record in demo_items():
                _, new = store.apply_item(c, record, account="demo", portable=True)
                created += int(new)
        return {"created": created}

    web = Path(__file__).resolve().parent.parent / "web"
    app.mount("/", StaticFiles(directory=web, html=True), name="web")
    return app
