"""Bounded, offline parsers for saved-content imports.

This module never extracts ZIP members to disk and never requests a URL. Unknown
archive sections are ignored rather than recursively harvesting private data.
"""
from __future__ import annotations

import csv
import hashlib
import io
import json
import posixpath
import re
import stat
import zipfile
from datetime import datetime, timezone
from html.parser import HTMLParser
from urllib.parse import urlsplit

MAX_INPUT = 16 * 1024 * 1024
MAX_UNCOMPRESSED = 64 * 1024 * 1024
MAX_MEMBERS = 4000
MAX_ITEMS = 50000
MAX_COLLECTIONS = 5000
MAX_TEXT = 20000
MAX_WARNINGS = 100


class ImportFormatError(ValueError):
    """A supported import could not be parsed safely or unambiguously."""


def _key(value: object) -> str:
    return re.sub(r"[^a-z0-9]", "", str(value).lower())


def _text(value: object, limit: int = MAX_TEXT) -> str:
    return value[:limit] if isinstance(value, str) else ""


def _url(value: object) -> str | None:
    if not isinstance(value, str) or len(value) > 8192:
        return None
    value = value.strip()
    if any(ord(c) < 32 for c in value):
        return None
    try:
        p = urlsplit(value)
        if p.scheme not in ("http", "https") or not p.hostname or p.username or p.password:
            return None
        _ = p.port
    except ValueError:
        return None
    return value


def _date(value: object) -> str | None:
    if value in (None, ""):
        return None
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        try:
            stamp = value / 1000 if value > 10**11 else value
            return datetime.fromtimestamp(stamp, timezone.utc).isoformat().replace("+00:00", "Z")
        except (ValueError, OverflowError, OSError):
            return None
    if isinstance(value, str):
        if re.fullmatch(r"\d{10,13}", value.strip()):
            return _date(int(value))
        # Keep a recognizable source date for the application to normalize.
        return value[:100].strip()
    return None


def _boolean(value: object) -> bool:
    return value is True or (isinstance(value, str) and value.lower().strip() in ("1", "true", "yes"))


def _strings(value: object) -> list[str]:
    if isinstance(value, str):
        if value.strip().startswith("["):
            try:
                value = json.loads(value)
            except json.JSONDecodeError:
                value = value.split(";")
        else:
            value = value.split(";")
    if not isinstance(value, list):
        return []
    return list(dict.fromkeys(x.strip()[:100] for x in value[:100] if isinstance(x, str) and x.strip()))


def _collections(value: object, default_kind: str = "local") -> list[dict]:
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
            value = parsed if isinstance(parsed, list) else value.split(";")
        except json.JSONDecodeError:
            value = value.split(";")
    if not isinstance(value, list):
        return []
    result = []
    seen = set()
    for entry in value[:100]:
        if isinstance(entry, str):
            entry = {"name": entry, "kind": default_kind}
        if not isinstance(entry, dict) or not isinstance(entry.get("name"), str) or not entry["name"].strip():
            continue
        # Do not normalize spelling or whitespace inside source collection names.
        name = entry["name"][:300]
        kind = entry.get("kind") if entry.get("kind") in ("source", "local") else default_kind
        out = {"name": name, "kind": kind}
        source_key = entry.get("source_key") or (entry.get("id") if kind == "source" else None)
        if isinstance(source_key, str) and source_key:
            out["source_key"] = source_key[:500]
        ident = (kind, out.get("source_key", ""), name)
        if ident not in seen:
            seen.add(ident)
            result.append(out)
    return result


def _portable_collections(value: object) -> tuple[list[dict], dict[str, dict], list[str]]:
    """Preserve standalone collection definitions, including empty folders.

    Source definitions need explicit account/platform scope. Legacy definitions
    without it remain usable as item references, but cannot create an invented
    account-wide empty source collection. Imported IDs are reference keys only;
    they never become local database IDs.
    """
    if not isinstance(value, list):
        raise ImportFormatError("Portable collection definitions must be an array.")
    if len(value) > MAX_COLLECTIONS:
        raise ImportFormatError("Portable export exceeds the 5,000-collection limit.")
    result, references, warnings = [], {}, []
    for entry in value:
        if not isinstance(entry, dict):
            warnings.append("Skipped an invalid collection definition.")
            continue
        name = entry.get("name")
        kind = entry.get("kind", "local")
        if not isinstance(name, str) or not name.strip() or len(name) > 200 or kind not in ("source", "local"):
            warnings.append("Skipped a collection with an invalid name or kind.")
            continue
        raw_key = entry.get("source_key")
        exported_id = entry.get("id")
        if raw_key is not None and (not isinstance(raw_key, str) or not raw_key or len(raw_key) > 500):
            warnings.append("Skipped a collection with an invalid source key.")
            continue
        if not isinstance(exported_id, str) or not exported_id or len(exported_id) > 500:
            exported_id = None
        if kind == "source":
            source_key = raw_key or exported_id or "name:" + hashlib.sha256(name.encode()).hexdigest()
        else:
            source_key = "name:" + hashlib.sha256(name.casefold().encode()).hexdigest()
        base = {"name": name, "kind": kind, "source_key": source_key}
        if exported_id:
            references[exported_id] = base
        if kind == "local":
            platform, account = "web", "local"
        else:
            platform = entry.get("platform")
            account = entry.get("source_account")
            if platform not in ("instagram", "tiktok", "web") or not isinstance(account, str) or not account.strip() or len(account) > 200:
                warnings.append("A source collection lacked explicit platform/account scope; its item memberships can still be imported, but its standalone definition was skipped.")
                continue
        color = entry.get("color", "#6F8A72")
        if not isinstance(color, str) or not re.fullmatch(r"#[0-9A-Fa-f]{6}", color):
            color = "#6F8A72"
            warnings.append("An invalid collection color was replaced with the default.")
        result.append({**base, "platform": platform, "source_account": account, "color": color})
    return result, references, list(dict.fromkeys(warnings))


def _record(raw: object, *, portable: bool = False, source: bool = False) -> dict | None:
    if isinstance(raw, str):
        raw = {"url": raw}
    if not isinstance(raw, dict):
        return None
    lower = {_key(k): v for k, v in raw.items()}
    href = next((_url(lower.get(k)) for k in ("url", "link", "href", "videolandingpagelink", "videolink") if _url(lower.get(k))), None)
    if not href:
        return None
    result: dict = {"url": href}
    for field, aliases in {
        "title": ("title", "name"), "creator": ("creator", "author", "username"),
        "caption": ("caption", "description"), "thumbnail_alt": ("thumbnailalt", "alt"),
    }.items():
        value = next((lower[k] for k in aliases if isinstance(lower.get(k), str)), None)
        if value is not None:
            result[field] = _text(value, 1000 if field in ("title", "creator") else MAX_TEXT)
    preview = _url(lower.get("previewurl") or lower.get("imageurl") or lower.get("thumbnailurl"))
    if preview:
        result["preview_url"] = preview
    saved = _date(lower.get("savedat") or lower.get("date") or lower.get("timestamp") or lower.get("adddate"))
    if saved:
        result["saved_at"] = saved
    account = lower.get("sourceaccount")
    if isinstance(account, str) and account.strip():
        result["source_account"] = account[:200]
    cols = _collections(raw.get("collections", lower.get("collections", lower.get("collection", []))), "source" if source else "local")
    if cols:
        result["collections"] = cols
    if not source or portable:
        for field in ("summary", "notes"):
            if isinstance(lower.get(field), str):
                result[field] = _text(lower[field])
        result["tags"] = _strings(lower.get("tags", []))
        if "favorite" in lower:
            result["favorite"] = _boolean(lower["favorite"])
        if lower.get("status") in ("inbox", "to_revisit", "done", "archived"):
            result["status"] = lower["status"]
        if "needsreview" in lower:
            result["needs_review"] = _boolean(lower["needsreview"])
    content_type = lower.get("contenttype")
    if content_type in ("post", "video", "article", "image", "link"):
        result["content_type"] = content_type
    # Portable exports retain edit intent as well as text. Only real booleans
    # from this format may distinguish a source value from a protected edit.
    if portable:
        for field in ("manual_title", "manual_summary"):
            if isinstance(lower.get(_key(field)), bool):
                result[field] = lower[_key(field)]
    # Portable exports retain text provenance, but never asset paths or secrets.
    if portable and isinstance(raw.get("evidence"), list):
        evidence = []
        for e in raw["evidence"][:100]:
            if isinstance(e, dict) and e.get("kind") in ("caption", "thumbnail_alt", "user_text") and isinstance(e.get("text"), str):
                evidence.append({"kind": e["kind"], "text": _text(e["text"])})
        if evidence:
            result["evidence"] = evidence
    return result


def _instagram(entries: object) -> list[dict]:
    if not isinstance(entries, list):
        return []
    out = []
    for entry in entries[:MAX_ITEMS + 1]:
        if not isinstance(entry, dict):
            continue
        direct = _record(entry, source=True)
        if direct:
            out.append(direct)
            continue
        values = []
        mapping = entry.get("string_map_data")
        if isinstance(mapping, dict):
            values.extend(v for k, v in mapping.items() if _key(k) in ("savedon", "saved", "link", "post"))
        if isinstance(entry.get("string_list_data"), list):
            values.extend(entry["string_list_data"])
        for value in values:
            if not isinstance(value, dict):
                continue
            rec = _record(value, source=True)
            if rec:
                if isinstance(entry.get("title"), str):
                    rec.setdefault("creator", entry["title"][:1000])
                cols = _collections(entry.get("collections"), "source")
                if cols:
                    rec["collections"] = cols
                out.append(rec)
    return out


FAVORITE_KEYS = {"favoritevideos", "favouritevideos", "favoritevideolist", "favouritevideolist"}
WRAPPER_KEYS = {"activity", "youractivity", "likesandfavourites", "likesandfavorites", "userdata", "data"}
INSTAGRAM_KEYS = {"savedsavedmedia", "savedsavedposts", "savedposts", "savedmedia"}


def _favorite_entries(value: object) -> list:
    if isinstance(value, list):
        return value
    if isinstance(value, dict):
        for k, v in value.items():
            if _key(k) in FAVORITE_KEYS | {"videos", "list", "items"} and isinstance(v, list):
                return v
    return []


def _archive_sections(obj: dict, depth: int = 0) -> tuple[list[dict], bool]:
    if depth > 5:
        return [], False
    out, recognized = [], False
    for key, value in obj.items():
        normalized = _key(key)
        if normalized in INSTAGRAM_KEYS:
            recognized = True
            out.extend(_instagram(value))
        elif normalized in FAVORITE_KEYS:
            recognized = True
            for entry in _favorite_entries(value)[:MAX_ITEMS + 1]:
                rec = _record(entry, source=True)
                if rec:
                    out.append(rec)
        elif normalized in WRAPPER_KEYS and isinstance(value, dict):
            child, found = _archive_sections(value, depth + 1)
            out.extend(child)
            recognized |= found
    return out, recognized


def _check_json_shape(value: object) -> None:
    queue = [(value, 0)]
    visited = 0
    while queue:
        node, depth = queue.pop()
        visited += 1
        if visited > 300000 or depth > 30:
            raise ImportFormatError("JSON exceeds the supported nesting or record limits.")
        if isinstance(node, dict):
            queue.extend((v, depth + 1) for v in node.values())
        elif isinstance(node, list):
            queue.extend((v, depth + 1) for v in node)


def _json(data: bytes, filename: str) -> dict:
    try:
        obj = json.loads(data.decode("utf-8-sig"))
    except (UnicodeDecodeError, json.JSONDecodeError, RecursionError) as exc:
        raise ImportFormatError("The JSON file is invalid or is not UTF-8 encoded.") from exc
    _check_json_shape(obj)
    portable = isinstance(obj, dict) and obj.get("format") == "little-archive"
    if portable:
        if obj.get("version") != 1 or not isinstance(obj.get("items"), list):
            raise ImportFormatError("This Little Archive export version is not supported.")
        collections, definitions, warnings = _portable_collections(obj.get("collections", []))
        raw_items = []
        for raw in obj["items"]:
            if isinstance(raw, dict):
                raw = dict(raw)
                cols = raw.get("collections", raw.get("collection_ids", []))
                if isinstance(cols, list):
                    raw["collections"] = [definitions.get(c, {"name": c, "kind": "local"}) if isinstance(c, str) else c for c in cols]
                raw_items.append(raw)
        items = [x for v in raw_items if (x := _record(v, portable=True))]
        if len(items) != len(obj["items"]):
            warnings.append("Some records without a valid HTTP(S) URL were skipped.")
        return {"items": items, "warnings": warnings, "portable": True, "collections": collections}
    if isinstance(obj, dict):
        items, recognized = _archive_sections(obj)
        if recognized:
            return {"items": items, "warnings": ["Only recognized saved/favorite sections were read; collection coverage depends on fields present in the export."], "portable": False}
        if isinstance(obj.get("items"), list):
            raw_items = obj["items"]
        elif _record(obj):
            raw_items = [obj]
        else:
            raise ImportFormatError("No supported saved/favorite section or items array was found. Unrelated account data was not imported.")
    elif isinstance(obj, list):
        # Standalone Instagram saved-media lists may lack their usual wrapper.
        if re.search(r"saved[_ -]?(posts|media)", filename, re.I):
            return {"items": _instagram(obj), "warnings": ["Standalone saved-media list imported; missing collection memberships were not invented."], "portable": False}
        raw_items = obj
    else:
        raise ImportFormatError("Expected a JSON object or array of saved links.")
    items = [x for v in raw_items if (x := _record(v))]
    warnings = [] if len(items) == len(raw_items) else ["Some records without a valid HTTP(S) URL were skipped."]
    return {"items": items, "warnings": warnings, "portable": False}


def _csv(data: bytes) -> dict:
    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise ImportFormatError("CSV must be UTF-8 encoded.") from exc
    try:
        dialect = csv.Sniffer().sniff(text[:8192], delimiters=",\t;")
    except csv.Error:
        dialect = csv.excel
    reader = csv.DictReader(io.StringIO(text), dialect=dialect)
    if not reader.fieldnames or not {_key(x) for x in reader.fieldnames} & {"url", "link", "href"}:
        raise ImportFormatError("CSV needs a url, link, or href column.")
    items, skipped = [], 0
    try:
        for row in reader:
            rec = _record(row)
            if rec:
                items.append(rec)
            else:
                skipped += 1
            if len(items) + skipped > MAX_ITEMS:
                raise ImportFormatError("This file exceeds the 50,000-record import limit.")
    except csv.Error as exc:
        raise ImportFormatError("CSV contains a malformed or oversized field.") from exc
    return {"items": items, "warnings": [f"Skipped {skipped} rows without a valid URL."] if skipped else [], "portable": False}


class _BookmarkParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.items, self.folders, self.pending_folder = [], [], None
        self.in_h3, self.heading, self.anchor, self.anchor_text = False, [], None, []
        self.depth = 0

    def handle_starttag(self, tag, attrs):
        values = dict(attrs)
        if tag == "h3":
            self.in_h3, self.heading = True, []
        elif tag == "dl":
            self.depth += 1
            if self.depth > 50:
                raise ImportFormatError("Bookmark folders exceed the nesting limit.")
            self.folders.append(self.pending_folder)
            self.pending_folder = None
        elif tag == "a":
            self.anchor = values
            self.anchor_text = []

    def handle_data(self, data):
        if self.in_h3:
            self.heading.append(data)
        if self.anchor is not None:
            self.anchor_text.append(data)

    def handle_endtag(self, tag):
        if tag == "h3":
            self.in_h3 = False
            self.pending_folder = "".join(self.heading)[:300]
        elif tag == "dl":
            self.depth = max(0, self.depth - 1)
            if self.folders:
                self.folders.pop()
        elif tag == "a" and self.anchor is not None:
            raw = {"url": self.anchor.get("href"), "title": "".join(self.anchor_text), "tags": self.anchor.get("tags", ""), "saved_at": self.anchor.get("add_date")}
            raw["collections"] = [{"name": n, "kind": "local"} for n in self.folders if n]
            rec = _record(raw)
            if rec:
                self.items.append(rec)
            if len(self.items) > MAX_ITEMS:
                raise ImportFormatError("This bookmark file exceeds the 50,000-record limit.")
            self.anchor = None


def _html(data: bytes) -> dict:
    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise ImportFormatError("Bookmark HTML must be UTF-8 encoded.") from exc
    if "netscape-bookmark-file" not in text[:4096].lower():
        raise ImportFormatError("Only Netscape-format bookmark HTML is supported; arbitrary page HTML is not imported.")
    parser = _BookmarkParser()
    parser.feed(text)
    parser.close()
    return {"items": parser.items, "warnings": ["Bookmark folder names become local collections; duplicate folder names may need review."], "portable": False}


def _txt(data: bytes, filename: str) -> dict:
    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise ImportFormatError("Text export must be UTF-8 encoded.") from exc
    # A dedicated Favorites file is trusted only as an explicitly selected scope.
    active = bool(re.search(r"favou?rite[_ -]?(videos?)?", posixpath.basename(filename), re.I))
    recognized = active
    pending_date = None
    items = []
    for line in text.splitlines():
        line = line.strip()
        key = _key(line.rstrip(":"))
        if key in FAVORITE_KEYS:
            active, recognized, pending_date = True, True, None
            continue
        if not line:
            continue
        if re.match(r"^date\s*:", line, re.I):
            if active:
                pending_date = line.split(":", 1)[1].strip()
            continue
        match = re.match(r"^(?:video\s+(?:landing\s+page\s+)?link|link|url)\s*:\s*(https?://\S+)\s*$", line, re.I)
        if match:
            if active:
                rec = _record({"url": match[1], "saved_at": pending_date}, source=True)
                host = (urlsplit(rec["url"]).hostname or "").lower() if rec else ""
                if rec and (host == "tiktok.com" or host.endswith(".tiktok.com")):
                    items.append(rec)
                    if len(items) > MAX_ITEMS:
                        raise ImportFormatError("This file exceeds the 50,000-record import limit.")
            continue
        # Any new non-field heading closes the favorites section. Do not absorb
        # watch history, likes, messages, or arbitrary following URLs.
        if not re.match(r"^(?:title|description|username)\s*:", line, re.I):
            active = False
            pending_date = None
    if not recognized:
        raise ImportFormatError("No explicit Favorite Videos section was found in this text file.")
    return {"items": items, "warnings": ["Only explicitly identified favorite-video entries were read."], "portable": False}


def _zip(data: bytes) -> dict:
    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile as exc:
        raise ImportFormatError("The ZIP archive is invalid.") from exc
    with archive:
        members = archive.infolist()
        if len(members) > MAX_MEMBERS:
            raise ImportFormatError("ZIP contains too many members (maximum 4,000).")
        items, warnings, total, portable_flags, collections = [], [], 0, [], []
        selected = 0
        for info in members:
            name = info.filename.replace("\\", "/")
            parts = name.split("/")
            if name.startswith("/") or re.match(r"^[A-Za-z]:", name) or ".." in parts or stat.S_ISLNK(info.external_attr >> 16):
                raise ImportFormatError("ZIP contains an unsafe path or symbolic link.")
            if info.flag_bits & 1:
                raise ImportFormatError("Encrypted ZIP files are not supported.")
            if info.is_dir():
                continue
            suffix = posixpath.splitext(name)[1].lower()
            if suffix == ".zip":
                raise ImportFormatError("Nested ZIP archives are not supported.")
            # Import only plausible saved-content files, never every JSON in an
            # account export. This intentionally excludes DMs and watch history.
            candidate = suffix in (".json", ".csv", ".txt", ".html", ".htm") and (
                re.search(r"saved[_ -]?(posts|media)|favou?rite|bookmarks|little[-_]archive|(?:^|/)(?:export|user_data(?:_tiktok)?)\.(json|csv)$", name, re.I)
            )
            if not candidate:
                continue
            total += info.file_size
            if info.file_size > MAX_INPUT or total > MAX_UNCOMPRESSED:
                raise ImportFormatError("Selected ZIP contents exceed the supported uncompressed size limit.")
            if info.file_size > 1024 * 1024 and info.file_size / max(info.compress_size, 1) > 200:
                raise ImportFormatError("ZIP has an unsafe compression ratio.")
            selected += 1
            try:
                with archive.open(info) as member:
                    body = member.read(MAX_INPUT + 1)
                if len(body) > MAX_INPUT:
                    raise ImportFormatError("ZIP member exceeds the size limit.")
                result = _parse(body, name)
                items.extend(result["items"])
                portable_flags.append(result.get("portable", False))
                collections.extend(result.get("collections", []))
                warnings.extend(result["warnings"])
            except (zipfile.BadZipFile, RuntimeError, NotImplementedError) as exc:
                raise ImportFormatError("A ZIP member could not be decoded safely.") from exc
            except ImportFormatError as exc:
                warnings.append(f"Skipped {posixpath.basename(name)[:120]}: {exc}")
            if len(items) > MAX_ITEMS:
                raise ImportFormatError("ZIP exceeds the 50,000-record import limit.")
            if len(collections) > MAX_COLLECTIONS:
                raise ImportFormatError("ZIP exceeds the 5,000-collection import limit.")
        if not selected:
            raise ImportFormatError("No recognized saved/favorite or bookmark files were found in this ZIP. Select the saved-data JSON/CSV directly if its name is different.")
        if not portable_flags:
            raise ImportFormatError("Recognized ZIP candidates could not be parsed. Select a supported saved-data file directly.")
        warnings.append("Only recognized saved-content files were inspected; unrelated archive files were ignored.")
        result = {"items": items, "warnings": list(dict.fromkeys(warnings))[:MAX_WARNINGS], "portable": all(portable_flags)}
        if collections:
            if result["portable"]:
                result["collections"] = collections
            else:
                result["warnings"].append("Standalone portable collection definitions were skipped in this mixed-format ZIP; import the portable JSON separately to restore them.")
        return result


def _parse(data: bytes, filename: str) -> dict:
    suffix = posixpath.splitext(filename.lower())[1]
    if suffix == ".zip":
        return _zip(data)
    if suffix == ".json":
        return _json(data, filename)
    if suffix in (".csv", ".tsv"):
        return _csv(data)
    if suffix in (".html", ".htm"):
        return _html(data)
    if suffix == ".txt":
        return _txt(data, filename)
    raise ImportFormatError("Use a JSON, CSV, TSV, Netscape bookmarks HTML, favorite-video TXT, or ZIP file.")


def parse_import(data: bytes, filename: str) -> dict:
    """Return normalized observations; fail closed on unrelated account formats."""
    if not isinstance(data, bytes) or not data:
        raise ImportFormatError("The import file is empty.")
    if len(data) > MAX_INPUT:
        raise ImportFormatError("The file exceeds the 16 MiB import limit. Split it into smaller saved-data files.")
    if not isinstance(filename, str) or len(filename) > 500:
        raise ImportFormatError("Invalid import filename.")
    result = _parse(data, filename)
    if len(result["items"]) > MAX_ITEMS:
        raise ImportFormatError("The file exceeds the 50,000-record import limit.")
    result["warnings"] = result["warnings"][:MAX_WARNINGS]
    return result
