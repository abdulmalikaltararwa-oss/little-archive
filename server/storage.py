"""Transactional storage and source identity. Every SQL value is bound, never interpolated."""
from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import secrets
import sqlite3
from threading import RLock
import unicodedata
from urllib.parse import urlsplit, urlunsplit, parse_qsl, urlencode
from uuid import uuid4

from .security import hash_password


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def json_text(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def normalize_search(text):
    text = unicodedata.normalize("NFKC", str(text)).lower().replace("ـ", "")
    text = "".join(c for c in text if not unicodedata.combining(c))
    return text.translate(str.maketrans({"أ": "ا", "إ": "ا", "آ": "ا"}))


def clean_tags(tags):
    if not isinstance(tags, list):
        raise ValueError("Use at most 50 tags per item.")
    out, seen = [], set()
    for value in tags:
        if not isinstance(value, str):
            raise ValueError("Tags must be text.")
        value = unicodedata.normalize("NFC", value.strip())
        if not value or len(value) > 80:
            raise ValueError("Each tag must be 1–80 characters.")
        key = value.casefold()
        if key not in seen:
            seen.add(key)
            out.append(value)
            if len(out) > 50:
                raise ValueError("Use at most 50 tags per item.")
    return out


def normalize_url(raw):
    if not isinstance(raw, str) or len(raw) > 4096:
        raise ValueError("Use a valid link under 4,096 characters.")
    raw = raw.strip()
    try:
        p = urlsplit(raw)
        _ = p.port
    except ValueError as exc:
        raise ValueError("That link is not a valid URL.") from exc
    if p.scheme not in {"https", "http"} or not p.hostname or p.username or p.password or any(ord(c) < 32 for c in raw):
        raise ValueError("Only HTTP(S) links without embedded credentials are supported.")
    host = p.hostname.lower().rstrip(".")
    if host in {"instagram.com", "www.instagram.com", "m.instagram.com"}:
        # Saved grids can expose creator-qualified links as well as root post
        # links. Their identity is the shortcode, independent of that prefix.
        m = re.fullmatch(r"/(?:[A-Za-z0-9._]{1,30}/)?(?P<kind>p|reel|reels)/(?P<key>[A-Za-z0-9_-]{1,100})/?", p.path)
        if not m:
            raise ValueError("Use an individual Instagram post or Reel link.")
        return "instagram", m["key"], f"https://www.instagram.com/p/{m['key']}/", "post" if m["kind"] == "p" else "video"
    if host in {"tiktok.com", "www.tiktok.com", "m.tiktok.com"}:
        m = re.fullmatch(r"/(@[^/]+)/(video|photo)/(\d+)/?", p.path)
        if m:
            return "tiktok", m[3], f"https://www.tiktok.com/{m[1]}/{m[2]}/{m[3]}", "video" if m[2] == "video" else "image"
        raise ValueError("Use a canonical TikTok video or photo link.")
    if host in {"vm.tiktok.com", "vt.tiktok.com"}:
        raise ValueError("Open the TikTok short link and copy the full post URL before importing.")
    query = [(k, v) for k, v in parse_qsl(p.query, keep_blank_values=True) if not k.lower().startswith("utm_") and k.lower() not in {"fbclid", "gclid", "igsh", "igshid"}]
    canonical = urlunsplit((p.scheme.lower(), p.netloc.lower(), p.path or "/", urlencode(query), p.fragment))
    return "web", hashlib.sha256(canonical.encode()).hexdigest(), canonical, "link"


def safe_preview(value):
    if not value or not isinstance(value, str) or len(value) > 4096:
        return None
    try:
        p = urlsplit(value)
        host = (p.hostname or "").lower()
        allowed = ("cdninstagram.com", "fbcdn.net", "tiktokcdn.com", "tiktokcdn-us.com", "tiktokcdn-eu.com", "byteoversea.com", "ibytedtos.com", "muscdn.com")
        if p.scheme == "https" and not p.username and not p.password and p.port in {None, 443} and any(host == x or host.endswith("." + x) for x in allowed):
            return value
    except ValueError:
        pass
    return None


def parse_date(value):
    if value in (None, ""):
        return None
    try:
        if isinstance(value, (float, int)) or str(value).isdigit():
            number = float(value)
            if number > 100000000000:
                number /= 1000
            d = datetime.fromtimestamp(number, timezone.utc)
        else:
            d = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
            if d.tzinfo is None:
                d = d.replace(tzinfo=timezone.utc)
        return d.astimezone(timezone.utc).isoformat(timespec="seconds")
    except (ValueError, TypeError, OverflowError, OSError):
        return None


SCHEMA = """
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY, csrf TEXT NOT NULL, expires REAL NOT NULL);
CREATE TABLE IF NOT EXISTS extension_tokens(id TEXT PRIMARY KEY, name TEXT NOT NULL, hash TEXT UNIQUE NOT NULL, created_at TEXT NOT NULL, last_used_at TEXT);
CREATE TABLE IF NOT EXISTS items(
 id TEXT PRIMARY KEY, platform TEXT NOT NULL, source_account TEXT NOT NULL, source_key TEXT NOT NULL,
 url TEXT NOT NULL, title TEXT NOT NULL, creator TEXT NOT NULL DEFAULT '', caption TEXT NOT NULL DEFAULT '',
 summary TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '', content_type TEXT NOT NULL DEFAULT 'link',
 preview_url TEXT, asset_hash TEXT, tags TEXT NOT NULL DEFAULT '[]', evidence TEXT NOT NULL DEFAULT '[]',
 favorite INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'inbox', needs_review INTEGER NOT NULL DEFAULT 1,
 saved_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
 manual_title INTEGER NOT NULL DEFAULT 0, manual_summary INTEGER NOT NULL DEFAULT 0, ai TEXT, ai_dismissed TEXT,
 UNIQUE(platform,source_account,source_key)
);
CREATE TABLE IF NOT EXISTS collections(
 id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, platform TEXT NOT NULL, source_account TEXT NOT NULL,
 source_key TEXT NOT NULL, color TEXT NOT NULL DEFAULT '#6F8A72', created_at TEXT NOT NULL,
 UNIQUE(kind,platform,source_account,source_key)
);
CREATE TABLE IF NOT EXISTS memberships(item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE, collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE, PRIMARY KEY(item_id,collection_id));
CREATE TABLE IF NOT EXISTS import_runs(
 id TEXT PRIMARY KEY, source TEXT NOT NULL, source_account TEXT NOT NULL, token_id TEXT,
 status TEXT NOT NULL, coverage TEXT NOT NULL DEFAULT 'partial', created INTEGER NOT NULL DEFAULT 0,
 updated INTEGER NOT NULL DEFAULT 0, skipped INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT '',
 started_at TEXT NOT NULL, finished_at TEXT, scopes TEXT NOT NULL DEFAULT '[]', expected_batches INTEGER
);
CREATE TABLE IF NOT EXISTS batches(
 batch_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES import_runs(id), sequence INTEGER NOT NULL,
 digest TEXT NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL, skipped INTEGER NOT NULL,
 UNIQUE(run_id,sequence)
);
CREATE TABLE IF NOT EXISTS ai_jobs(
 id TEXT PRIMARY KEY, item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE, input_hash TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'queued', error TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 UNIQUE(item_id,input_hash)
);
CREATE INDEX IF NOT EXISTS idx_items_recent ON items(created_at DESC,id);
CREATE INDEX IF NOT EXISTS idx_items_platform ON items(platform,status);
CREATE INDEX IF NOT EXISTS idx_items_favorite ON items(favorite,status);
CREATE INDEX IF NOT EXISTS idx_memberships_collection ON memberships(collection_id,item_id);
CREATE INDEX IF NOT EXISTS idx_jobs_state ON ai_jobs(status,created_at);
CREATE VIRTUAL TABLE IF NOT EXISTS item_search USING fts5(item_id UNINDEXED,title,body,tags,tokenize='unicode61 remove_diacritics 2');
"""


class Store:
    def __init__(self, config):
        self.config = config
        self.root = Path(config.data_dir)
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.assets = self.root / "assets"
        self.assets.mkdir(exist_ok=True, mode=0o700)
        self.path = self.root / "library.sqlite3"
        self.lock = RLock()
        self.item_hooks = []
        with self.transaction() as c:
            c.executescript(SCHEMA)
            version = c.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()
            if version and version[0] != "1":
                raise ValueError("Unsupported library schema. Use a compatible application version.")
            for k, v in {"schema_version": "1", "instance_id": str(uuid4()), "remote_previews": "false"}.items():
                c.execute("INSERT OR IGNORE INTO meta VALUES(?,?)", (k, v))
            if not c.execute("SELECT 1 FROM meta WHERE key='password_hash'").fetchone():
                if not config.admin_password:
                    raise ValueError("Set LA_ADMIN_PASSWORD to a strong password before the first start. Run scripts/setup.py for guided setup.")
                c.execute("INSERT INTO meta VALUES('password_hash',?)", (hash_password(config.admin_password),))
            c.execute("UPDATE ai_jobs SET status='queued',error='' WHERE status='running'")
        try:
            self.path.chmod(0o600)
        except OSError:
            pass

    @contextmanager
    def transaction(self):
        with self.lock:
            conn = sqlite3.connect(self.path, timeout=15)
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA foreign_keys=ON")
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA busy_timeout=15000")
            try:
                with conn:
                    yield conn
            finally:
                conn.close()

    def meta(self, key):
        with self.transaction() as c:
            row = c.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
            return row[0] if row else None

    def set_meta(self, key, value):
        with self.transaction() as c:
            c.execute("INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, value))

    def index_item(self, c, item_id):
        row = c.execute("SELECT * FROM items WHERE id=?", (item_id,)).fetchone()
        c.execute("DELETE FROM item_search WHERE item_id=?", (item_id,))
        if row:
            body = " ".join([row["creator"], row["caption"], row["summary"], row["notes"]] + [str(e.get("text", "")) for e in json.loads(row["evidence"])])
            c.execute("INSERT INTO item_search VALUES(?,?,?,?)", (item_id, normalize_search(row["title"]), normalize_search(body), normalize_search(" ".join(json.loads(row["tags"])))))

    def decode_item(self, c, row):
        if row is None:
            return None
        result = dict(row)
        for key in ("tags", "evidence", "ai"):
            result[key] = json.loads(result[key]) if result[key] else (None if key == "ai" else [])
        for key in ("favorite", "needs_review"):
            result[key] = bool(result[key])
        result["collections"] = [dict(x) for x in c.execute("SELECT c.id,c.name,c.kind,c.platform FROM collections c JOIN memberships m ON m.collection_id=c.id WHERE m.item_id=? ORDER BY c.name", (row["id"],))]
        result["thumbnail_url"] = f"/api/assets/{result['asset_hash']}" if result["asset_hash"] else None
        for key in ("asset_hash", "manual_title", "manual_summary", "ai_dismissed"):
            result.pop(key, None)
        return result

    def get_item(self, item_id, c=None):
        if c is not None:
            item = self.decode_item(c, c.execute("SELECT * FROM items WHERE id=?", (item_id,)).fetchone())
            # Optional decorators (see server/enrich) add derived fields to single-item reads.
            for hook in self.item_hooks if item else ():
                hook(c, item)
            return item
        with self.transaction() as conn:
            return self.get_item(item_id, conn)

    def resolve_collection(self, c, entry, platform, account):
        name = entry.get("name", "")
        if not isinstance(name, str) or not name.strip() or len(name) > 200:
            raise ValueError("A collection needs a name of 1–200 characters.")
        kind = entry.get("kind", "source")
        if kind not in {"source", "local"}:
            raise ValueError("Unknown collection kind.")
        if kind == "local":
            platform, account = "web", "local"
            key = "name:" + hashlib.sha256(name.casefold().encode()).hexdigest()
        else:
            key = str(entry.get("source_key") or "name:" + hashlib.sha256(name.encode()).hexdigest())[:500]
        row = c.execute("SELECT id FROM collections WHERE kind=? AND platform=? AND source_account=? AND source_key=?", (kind, platform, account, key)).fetchone()
        if row:
            if kind == "source":
                c.execute("UPDATE collections SET name=? WHERE id=?", (name, row[0]))
            return row[0]
        cid = str(uuid4())
        color = entry.get("color", "#6F8A72")
        if not isinstance(color, str) or not re.fullmatch(r"#[0-9a-fA-F]{6}", color):
            color = "#6F8A72"
        c.execute("INSERT INTO collections(id,name,kind,platform,source_account,source_key,color,created_at) VALUES(?,?,?,?,?,?,?,?)", (cid, name, kind, platform, account, key, color, now()))
        return cid

    def apply_item(self, c, data, account="default", expected_platform=None, portable=False, manual=False, file_input=False):
        platform, source_key, url, inferred_type = normalize_url(data.get("url"))
        if expected_platform and platform != expected_platform:
            raise ValueError("A batch item does not match the import platform.")
        account = str(data.get("source_account") or account)[:200] if portable or file_input else account
        if not account.strip():
            raise ValueError("Source account cannot be empty.")
        row = c.execute("SELECT * FROM items WHERE platform=? AND source_account=? AND source_key=?", (platform, account, source_key)).fetchone()
        title = str(data.get("title") or "").strip()[:500]
        caption = str(data.get("caption") or "")[:20000]
        creator = str(data.get("creator") or "")[:200]
        evidence = []
        if caption:
            evidence.append({"kind": "caption", "text": caption})
        if data.get("thumbnail_alt"):
            evidence.append({"kind": "thumbnail_alt", "text": str(data["thumbnail_alt"])[:20000]})
        if portable:
            for e in data.get("evidence", [])[:16]:
                if isinstance(e, dict) and e.get("kind") in {"caption", "thumbnail_alt", "user_text", "transcript"} and isinstance(e.get("text"), str):
                    clean = {"kind": e["kind"], "text": e["text"][:20000]}
                    if clean not in evidence:
                        evidence.append(clean)
        stamp = now()
        preview = safe_preview(data.get("preview_url"))
        content_type = data.get("content_type", inferred_type)
        if content_type not in {"post", "video", "article", "image", "link"}:
            content_type = inferred_type
        # A generic adapter default must not hide a media-specific URL.
        if content_type in {"post", "link"} and inferred_type in {"video", "image"}:
            content_type = inferred_type
        if row:
            iid = row["id"]
            updates = {"last_seen_at": stamp}
            # Refresh more precise source observations, but a later generic
            # saved-grid link must not erase a known video/image/article type.
            if content_type not in {"post", "link"} or row["content_type"] in {"post", "link"}:
                updates["content_type"] = content_type
            if title and not row["manual_title"]:
                updates["title"] = title
            if creator:
                updates["creator"] = creator
            if caption:
                updates["caption"] = caption
            if evidence:
                # A refresh replaces what the source says, never a transcript that was added later.
                kept = [e for e in json.loads(row["evidence"]) if e.get("kind") == "transcript" and not any(x["kind"] == "transcript" for x in evidence)]
                updates["evidence"] = json_text((evidence[:15] + kept)[:16])
            if preview:
                updates["preview_url"] = preview
            if parse_date(data.get("saved_at")):
                updates["saved_at"] = parse_date(data["saved_at"])
            if manual:
                for key in ("title", "summary", "notes"):
                    if data.get(key):
                        updates[key] = str(data[key])[:20000 if key == "notes" else 4000 if key == "summary" else 500]
                if title:
                    updates["manual_title"] = 1
                if data.get("summary"):
                    updates["manual_summary"] = 1
                updates["tags"] = json_text(clean_tags(json.loads(row["tags"]) + [t for t in data.get("tags", []) if t not in json.loads(row["tags"])]))
            if any(row[k] != v for k, v in updates.items() if k != "last_seen_at"):
                updates["updated_at"] = stamp
            c.execute("UPDATE items SET " + ",".join(k + "=?" for k in updates) + " WHERE id=?", [*updates.values(), iid])
            created = False
        else:
            iid = str(uuid4())
            annotations = portable or manual or file_input
            tags = clean_tags(data.get("tags", [])) if annotations else []
            status = data.get("status", "inbox") if annotations else "inbox"
            if status not in {"inbox", "to_revisit", "done", "archived"}:
                status = "inbox"
            values = {
                "id": iid, "platform": platform, "source_account": account, "source_key": source_key, "url": url,
                "title": title or f"Saved {platform.title()} {'link' if platform == 'web' else 'post'}", "creator": creator,
                "caption": caption, "summary": str(data.get("summary") or "")[:4000] if annotations else "",
                "notes": str(data.get("notes") or "")[:20000] if annotations else "", "content_type": content_type,
                "preview_url": preview, "tags": json_text(tags), "evidence": json_text(evidence[:16]),
                "favorite": int(bool(data.get("favorite"))) if annotations else 0, "status": status,
                "needs_review": int(data.get("needs_review", True)) if annotations else 1,
                "saved_at": parse_date(data.get("saved_at")), "created_at": stamp, "updated_at": stamp, "last_seen_at": stamp,
                "manual_title": int(data["manual_title"]) if portable and isinstance(data.get("manual_title"), bool) else int(bool(title) and annotations),
                "manual_summary": int(data["manual_summary"]) if portable and isinstance(data.get("manual_summary"), bool) else int(bool(data.get("summary")) and annotations),
            }
            c.execute("INSERT INTO items(" + ",".join(values) + ") VALUES(" + ",".join("?" for _ in values) + ")", list(values.values()))
            created = True
        collections = data.get("collections", [])
        if not isinstance(collections, list) or len(collections) > 50:
            raise ValueError("Use at most 50 collections per item.")
        for entry in collections:
            if not isinstance(entry, dict):
                raise ValueError("Collections must contain named objects.")
            cid = self.resolve_collection(c, entry, platform, account)
            c.execute("INSERT OR IGNORE INTO memberships VALUES(?,?)", (iid, cid))
        self.index_item(c, iid)
        return iid, created

    def set_local_memberships(self, c, iid, ids):
        ids = list(dict.fromkeys(ids))
        if ids:
            rows = c.execute("SELECT id,kind FROM collections WHERE id IN (" + ",".join("?" for _ in ids) + ")", ids).fetchall()
            if len(rows) != len(ids):
                raise ValueError("One of the collections no longer exists.")
            # Source IDs may be echoed by clients, but are never edited here.
            ids = [r["id"] for r in rows if r["kind"] == "local"]
        c.execute("DELETE FROM memberships WHERE item_id=? AND collection_id IN (SELECT id FROM collections WHERE kind='local')", (iid,))
        c.executemany("INSERT OR IGNORE INTO memberships VALUES(?,?)", [(iid, x) for x in ids])

    @staticmethod
    def item_filter(*, q="", platform="", collection_id="", tag="", status="", favorite=None, needs_review=None):
        """One predicate for browsing and explicit whole-library operations."""
        conditions, params = [], []
        if q.strip():
            words = re.findall(r"\w+", normalize_search(q))[:20]
            if words:
                match = " AND ".join('"' + word.replace('"', '""') + '"*' for word in words)
                conditions.append("i.id IN (SELECT item_id FROM item_search WHERE item_search MATCH ?)")
                params.append(match)
            else:
                conditions.append("0")
        for col, value in (("platform", platform), ("status", status)):
            if value:
                conditions.append(f"i.{col}=?")
                params.append(value)
        if not status:
            conditions.append("i.status!='archived'")
        if collection_id:
            conditions.append("EXISTS(SELECT 1 FROM memberships m WHERE m.item_id=i.id AND m.collection_id=?)")
            params.append(collection_id)
        if tag:
            conditions.append("EXISTS(SELECT 1 FROM json_each(i.tags) t WHERE t.value=?)")
            params.append(tag)
        for col, value in (("favorite", favorite), ("needs_review", needs_review)):
            if value is not None:
                conditions.append(f"i.{col}=?")
                params.append(int(value))
        return (" WHERE " + " AND ".join(conditions) if conditions else ""), params

    def matching_item_ids(self, **filters):
        where, params = self.item_filter(**filters)
        with self.transaction() as c:
            return [row[0] for row in c.execute("SELECT i.id FROM items i" + where + " ORDER BY i.created_at,i.id", params)]

    def list_items(self, *, q="", platform="", collection_id="", tag="", status="", favorite=None, needs_review=None, sort="recent", limit=60, offset=0):
        where, params = self.item_filter(q=q, platform=platform, collection_id=collection_id, tag=tag, status=status, favorite=favorite, needs_review=needs_review)
        order = {"recent": "i.created_at DESC,i.id DESC", "oldest": "i.created_at,i.id", "title": "i.title COLLATE NOCASE,i.id", "random": "random()"}[sort]
        with self.transaction() as c:
            total = c.execute("SELECT count(*) FROM items i" + where, params).fetchone()[0]
            rows = c.execute("SELECT i.* FROM items i" + where + " ORDER BY " + order + " LIMIT ? OFFSET ?", [*params, limit, offset]).fetchall()
            return {"items": [self.decode_item(c, x) for x in rows], "total": total, "limit": limit, "offset": offset}

    def collections(self, c=None):
        if c is None:
            with self.transaction() as conn:
                return self.collections(conn)
        return [dict(x) for x in c.execute("SELECT c.*,COUNT(i.id) AS count FROM collections c LEFT JOIN memberships m ON m.collection_id=c.id LEFT JOIN items i ON i.id=m.item_id AND i.status!='archived' GROUP BY c.id ORDER BY c.kind,c.name COLLATE NOCASE")]

    def export_items(self, c=None):
        if c is None:
            with self.transaction() as conn:
                return self.export_items(conn)
        items = []
        for row in c.execute("SELECT * FROM items ORDER BY created_at,id"):
            item = self.decode_item(c, row)
            # Preserve annotation intent, including a deliberately blank
            # summary, without exposing these internal flags in normal views.
            item["manual_title"] = bool(row["manual_title"])
            item["manual_summary"] = bool(row["manual_summary"])
            item["collections"] = [dict(x) for x in c.execute("SELECT c.id,c.name,c.kind,c.platform,c.source_account,c.source_key FROM collections c JOIN memberships m ON m.collection_id=c.id WHERE m.item_id=? ORDER BY c.name", (item["id"],))]
            # Relative authenticated assets are backed up separately, not portable remote URLs.
            item.pop("thumbnail_url", None)
            items.append(item)
        return items
