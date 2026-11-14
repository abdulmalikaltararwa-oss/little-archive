"""Readers for the official "download your data" exports of Instagram and TikTok.

What each reader understands, and how that was established, is written in docs/importing.md. In short:

* Instagram JSON, current layout (every entry has ``label_values``): built from fixtures that a public open-source project
  documents as real exports with the values replaced, in English and French. Older layout (``saved_saved_media`` with
  ``string_map_data``): built from the same community documentation. Collections are read from the current layout only.
* Instagram HTML: built from documentation alone and never checked against a real export. Only post links and, where one
  sits next to a link in a recognised date format, its date are read; collections and creators are not.
* TikTok JSON (``Activity > Favorite Videos > FavoriteVideoList`` with ``Date`` and ``Link``) and TikTok TXT: built from
  documentation and community descriptions; no real export was available.

The readers look at *structure*, not at the language of labels, wherever they can: a post is the entry that carries an
Instagram post link, a collection is the entry that carries a list of them. Labels (caption, owner, username) are read in the
languages listed below; in any other language the links and dates are still read and the preview says captions were not.

Safety: nothing is extracted to disk, nothing here makes a request, archive paths are checked, reads are bounded by what was
actually read (not by what the archive claims), only files that look like saved content are opened, and unrelated files
(messages, comments, history) are counted but never read.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from html.parser import HTMLParser
import json
from pathlib import Path, PurePosixPath
import re
import stat
import zipfile

from .importers import _key
from .storage import normalize_search, normalize_url

IG_POST = re.compile(r"^https?://(?:www\.)?instagram\.com/(?:[A-Za-z0-9._]{1,30}/)?(?:p|reel|reels|tv)/[A-Za-z0-9_-]{1,100}/?(?:[?#].*)?$", re.I)
MAX_UNREADABLE_LISTED = 50

_PRIVATE_PARTS = {"message", "messages", "inbox", "direct", "comments", "login", "logins", "ads", "searches", "search", "contacts", "chat", "chats", "dm", "security",
                  "devices", "settings", "story", "stories", "reels", "likes", "liked", "followers", "following", "history", "watch", "browsing", "payments", "shopping"}


class ExportError(ValueError):
    """A refusal with a code a client can switch on and a message safe to show."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code, self.message = code, message


@dataclass(frozen=True)
class ExportLimits:
    max_members: int = 200_000
    max_member_bytes: int = 96 * 1024 * 1024
    max_total_bytes: int = 256 * 1024 * 1024
    max_ratio: int = 300
    max_records: int = 100_000
    max_sniffed_files: int = 60
    sniff_bytes: int = 64 * 1024


# ---------------------------------------------------------------- text repair and labels

def repair_text(value: str) -> str:
    """Meta writes each UTF-8 byte of a non-ASCII character as its own Latin-1 character; put them back together."""
    if not value or value.isascii() or max(map(ord, value)) > 0xFF:
        return value
    try:
        return value.encode("latin-1").decode("utf-8")
    except (UnicodeEncodeError, UnicodeDecodeError):
        return value


def repair_tree(node, depth=0):
    if depth > 40:
        return node
    if isinstance(node, str):
        return repair_text(node)
    if isinstance(node, list):
        return [repair_tree(x, depth + 1) for x in node]
    if isinstance(node, dict):
        return {repair_text(k) if isinstance(k, str) else k: repair_tree(v, depth + 1) for k, v in node.items()}
    return node


def _labels(*words: str) -> frozenset:
    return frozenset(normalize_search(w).strip() for w in words)


# Languages whose labels the Instagram reader knows. Anything else still yields links and dates.
CAPTION_LABELS = _labels("Caption", "Légende", "Beschreibung", "Bildunterschrift", "Pie de foto", "Descripción", "Leyenda", "Didascalia", "Legenda", "Bijschrift", "التعليق", "الوصف")
OWNER_TITLES = _labels("Owner", "Propriétaire", "Propietario", "Eigentümer", "Proprietario", "Proprietário", "Eigenaar", "المالك", "صاحب الحساب")
USERNAME_LABELS = _labels("Username", "Nom de profil", "Nom d'utilisateur", "Nombre de usuario", "Benutzername", "Nome utente", "Nome de usuário", "Gebruikersnaam", "اسم المستخدم")
NAME_LABELS = _labels("Name", "Nom", "Nombre", "Nome", "Naam", "الاسم", "اسم")
# Other labels of a collection entry, in the languages above. If one is present the language is known, so a missing name means
# the collection has none, not that its label is in a language this importer cannot read.
COLLECTION_LABELS = NAME_LABELS | _labels("Type", "Privacy", "Confidentialité", "Update time", "Heure de mise à jour", "Visibilidad", "Datenschutz", "Privacidad")


def _norm(value) -> str:
    return normalize_search(value).strip() if isinstance(value, str) else ""


def _iso(value):
    """A source date as stored: Unix seconds stay numbers; other text is left for the application to normalise."""
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)) and value > 0:
        return int(value)
    if isinstance(value, str) and value.strip():
        return value.strip()[:40]
    return None


# ---------------------------------------------------------------- Instagram JSON

def _label_items(items):
    """Split a ``label_values`` list into direct labelled fields and nested groups."""
    fields, groups = [], []
    for item in items if isinstance(items, list) else []:
        if not isinstance(item, dict):
            continue
        if "dict" in item and isinstance(item["dict"], list):
            groups.append(item)
        elif "label" in item or "value" in item or "href" in item:
            fields.append(item)
    return fields, groups


def _post_link(field):
    for key in ("href", "value"):
        value = field.get(key)
        if isinstance(value, str) and IG_POST.match(value.strip()):
            return value.strip()
    return None


def _group_fields(group):
    out = []
    for inner in group.get("dict", []) if isinstance(group, dict) else []:
        out.extend(f for f in (inner.get("dict", []) if isinstance(inner, dict) else []) if isinstance(f, dict))
    return out


def _walk_post_entries(node, depth=0):
    """Every nested block that is itself a post (it carries a post link in a direct field)."""
    if depth > 6 or not isinstance(node, dict):
        return
    for inner in node.get("dict", []) if isinstance(node.get("dict"), list) else []:
        if isinstance(inner, dict) and isinstance(inner.get("dict"), list):
            fields = [f for f in inner["dict"] if isinstance(f, dict) and ("label" in f or "value" in f or "href" in f)]
            if any(_post_link(f) for f in fields):
                yield inner["dict"]
            else:
                yield from _walk_post_entries(inner, depth + 1)


def instagram_post_from_items(items, saved_at=None):
    """(record, language_note) from one block of label and value pairs, or (None, reason) when it is not a post."""
    fields, groups = _label_items(items)
    link = next((u for u in map(_post_link, fields) if u), None)
    if not link:
        return None, "no_post_link"
    caption = next((f["value"] for f in fields if _norm(f.get("label")) in CAPTION_LABELS and isinstance(f.get("value"), str) and f["value"].strip()), None)
    creator = None
    for group in groups:
        if _norm(group.get("title")) in OWNER_TITLES:
            inner = _group_fields(group)
            username = next((f.get("value") for f in inner if _norm(f.get("label")) in USERNAME_LABELS and isinstance(f.get("value"), str) and f["value"].strip()), None)
            name = next((f.get("value") for f in inner if _norm(f.get("label")) in NAME_LABELS and isinstance(f.get("value"), str) and f["value"].strip()), None)
            creator = ("@" + username.lstrip("@")) if username else name
            break
    labelled = [f for f in fields if f.get("label") and not _post_link(f)]
    unknown_language = bool(labelled) and caption is None and not any(_norm(f.get("label")) in CAPTION_LABELS for f in labelled) and len(labelled) >= 2 \
        and not any(_norm(g.get("title")) in OWNER_TITLES for g in groups) and bool(groups)
    record = {"url": link, "saved_at": _iso(saved_at)}
    if caption:
        record["caption"] = caption[:20000]
    if creator:
        record["creator"] = creator[:200]
    return record, ("labels_not_recognised" if unknown_language else "")


def instagram_label_record(entry: dict) -> dict | None:
    """One entry of a current-layout ``saved_posts.json`` as an import record (used by the older direct-file importer too)."""
    record, _ = instagram_post_from_items(repair_tree(entry.get("label_values")), entry.get("timestamp"))
    return record


def _collection_from_entry(entry):
    fields, groups = _label_items(entry.get("label_values"))
    name = next((f["value"] for f in fields if _norm(f.get("label")) in NAME_LABELS and isinstance(f.get("value"), str) and f["value"].strip()), None)
    guessed = False
    if name is None and not any(_norm(f.get("label")) in COLLECTION_LABELS for f in fields):
        # Every label is in a language this importer does not know. The name is the first value, as in every layout seen.
        first = next((f for f in fields if isinstance(f.get("value"), str) and f["value"].strip() and not _post_link(f)), None)
        name, guessed = (first["value"] if first else None), first is not None
    members = []
    for group in groups:
        members.extend(_walk_post_entries(group))
    return name, members, guessed


@dataclass
class ReadResult:
    records: list = field(default_factory=list)          # {"url","caption"?,"creator"?,"saved_at"?}
    collections: list = field(default_factory=list)      # {"name","members":[record,...]}
    unreadable: list = field(default_factory=list)       # {"reason","index"}
    entries: int = 0
    warnings: list = field(default_factory=list)
    sections: list = field(default_factory=list)         # {"name","count"} for what was imported
    ignored_sections: list = field(default_factory=list) # {"name","count"} recognised but not saves
    collections_read: bool = True


def read_instagram_json(obj) -> ReadResult:
    result = ReadResult()
    obj = repair_tree(obj)
    if isinstance(obj, dict) and isinstance(obj.get("saved_saved_media"), list):
        # Older layout: {"saved_saved_media": [{"title": username, "string_map_data": {"Saved on": {"href", "timestamp"}}}]}
        for index, entry in enumerate(obj["saved_saved_media"]):
            result.entries += 1
            data = entry.get("string_map_data") if isinstance(entry, dict) else None
            hit = next((v for v in data.values() if isinstance(v, dict) and isinstance(v.get("href"), str) and IG_POST.match(v["href"].strip())), None) if isinstance(data, dict) else None
            if not hit:
                result.unreadable.append({"reason": "no_post_link", "index": index})
                continue
            record = {"url": hit["href"].strip(), "saved_at": _iso(hit.get("timestamp"))}
            title = entry.get("title")
            if isinstance(title, str) and re.fullmatch(r"[A-Za-z0-9._]{1,30}", title.strip()):
                record["creator"] = "@" + title.strip()
            result.records.append(record)
        result.sections.append({"name": "Saved posts", "count": len(result.records)})
        if any(isinstance(k, str) and "collection" in k.lower() for k in obj):
            result.collections_read = False
            result.warnings.append("This file also lists collections in an older layout this importer cannot read reliably, so the saves were imported without their collections. Download the information again in JSON to get them.")
        return result
    entries = obj if isinstance(obj, list) else [obj] if isinstance(obj, dict) and "label_values" in obj else None
    if entries is None:
        raise ExportError("unrecognised", "This JSON file is not an Instagram saved-posts or collections file.")
    unknown_language = 0
    for index, entry in enumerate(entries):
        result.entries += 1
        if not isinstance(entry, dict) or "label_values" not in entry:
            result.unreadable.append({"reason": "unrecognised_entry", "index": index})
            continue
        record, note = instagram_post_from_items(entry["label_values"], entry.get("timestamp"))
        if record is not None:
            unknown_language += note == "labels_not_recognised"
            result.records.append(record)
            continue
        name, members, guessed = _collection_from_entry(entry)
        if members:
            if not name or not name.strip():
                result.unreadable.append({"reason": "collection_without_name", "index": index})
                continue
            parsed = []
            for member in members:
                rec, _ = instagram_post_from_items(member)
                if rec:
                    parsed.append(rec)
            result.collections.append({"name": name.strip()[:200], "members": parsed})
            if guessed:
                unknown_language += 1
        else:
            result.unreadable.append({"reason": "no_post_link", "index": index})
    if unknown_language:
        result.warnings.append(f"{unknown_language} entries use labels in a language this importer does not know, so their captions, creators or collection names may be missing. Links and dates were still read.")
    if result.records:
        result.sections.append({"name": "Saved posts", "count": len(result.records)})
    return result


# ---------------------------------------------------------------- Instagram HTML (documentation only)

_DATE_FORMATS = ("%b %d, %Y, %I:%M %p", "%b %d, %Y %I:%M %p", "%b %d, %Y, %I:%M%p", "%b %d, %Y %I:%M%p", "%B %d, %Y, %I:%M %p", "%B %d, %Y", "%b %d, %Y", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%d")


def parse_export_date(text: str):
    text = " ".join(text.split())
    for pattern in _DATE_FORMATS:
        try:
            return int(datetime.strptime(text, pattern).replace(tzinfo=timezone.utc).timestamp())
        except ValueError:
            continue
    return None


class _InstagramHtml(HTMLParser):
    def __init__(self, cap):
        super().__init__(convert_charrefs=True)
        self.records, self.cap, self.overflow = [], cap, False

    def handle_starttag(self, tag, attrs):
        if tag != "a":
            return
        href = dict(attrs).get("href") or ""
        if IG_POST.match(href.strip()):
            if len(self.records) >= self.cap:
                self.overflow = True
                return
            self.records.append({"url": href.strip(), "saved_at": None})

    def handle_data(self, data):
        if self.records and self.records[-1]["saved_at"] is None:
            text = data.strip()
            if text and len(text) < 60 and (stamp := parse_export_date(text)):
                self.records[-1]["saved_at"] = stamp


def read_instagram_html(text: str, cap: int) -> ReadResult:
    parser = _InstagramHtml(cap)
    try:
        parser.feed(text)
        parser.close()
    except (AssertionError, ValueError, RecursionError) as exc:
        raise ExportError("unreadable", "This HTML file could not be read.") from exc
    result = ReadResult(records=parser.records, entries=len(parser.records), collections_read=False)
    if parser.overflow:
        raise ExportError("too_many_records", "This file lists more saves than the importer accepts.")
    result.sections.append({"name": "Saved posts", "count": len(parser.records)})
    result.warnings.append("This is the HTML version of the export. Post links and, where the date is in a format this importer knows, save dates were read; collections and creators are not in a form it can read. Download the information again in JSON to get them.")
    return result


# ---------------------------------------------------------------- TikTok

_FAVORITE_VIDEO_KEYS = {"favoritevideos", "favouritevideos"}
_VIDEO_LIST_KEYS = {"favoritevideolist", "favouritevideolist", "list", "items", "videos"}
_NOT_SAVES = {"likelist": "Likes", "itemfavoritelist": "Likes", "videobrowsinghistory": "Watch history", "watchhistory": "Watch history", "sharehistory": "Shares",
              "favoritesounds": "Favorite sounds", "favouritesounds": "Favorite sounds", "favoritehashtags": "Favorite hashtags", "favouritehashtags": "Favorite hashtags",
              "favoriteeffects": "Favorite effects", "favouriteeffects": "Favorite effects", "searchhistory": "Search history", "followinglist": "Following", "followerlist": "Followers"}


def _first_list(value):
    if isinstance(value, list):
        return value
    if isinstance(value, dict):
        for k, v in value.items():
            if isinstance(v, list):
                return v
    return []


def read_tiktok_json(obj) -> ReadResult:
    result = ReadResult()
    found = False

    def walk(node, depth):
        nonlocal found
        if depth > 8 or not isinstance(node, dict):
            return
        for key, value in node.items():
            name = _key(key)
            if name in _FAVORITE_VIDEO_KEYS:
                found = True
                entries = next((v for k, v in value.items() if _key(k) in _VIDEO_LIST_KEYS and isinstance(v, list)), None) if isinstance(value, dict) else value if isinstance(value, list) else None
                before = len(result.records)
                for index, entry in enumerate(entries or []):
                    result.entries += 1
                    link = None
                    if isinstance(entry, dict):
                        lowered = {_key(k): v for k, v in entry.items()}
                        link = next((lowered[k] for k in ("link", "videolink", "url", "href") if isinstance(lowered.get(k), str)), None)
                    if not link:
                        result.unreadable.append({"reason": "no_video_link", "index": index})
                        continue
                    result.records.append({"url": link.strip(), "saved_at": _iso(lowered.get("date"))})
                result.sections.append({"name": "Favorite Videos", "count": len(result.records) - before})
            elif name in _NOT_SAVES:
                result.ignored_sections.append({"name": _NOT_SAVES[name], "count": len(_first_list(value))})
            elif isinstance(value, dict):
                walk(value, depth + 1)

    walk(obj if isinstance(obj, dict) else {}, 0)
    if not found:
        raise ExportError("no_saved_data", "No Favorite Videos section was found in this TikTok file.")
    result.collections_read = False
    return result


_TT_FIELD = re.compile(r"^(date|link|video link|video landing page link|url|title|description|caption|username)\s*:\s*(.*)$", re.I)


def read_tiktok_txt(text: str, filename: str) -> ReadResult:
    """Dated link entries under a "Favorite Videos" heading (or in a file named for it). Other sections are never read."""
    result = ReadResult(collections_read=False)
    active = bool(re.search(r"favou?rite[ _-]*videos?", PurePosixPath(filename).name, re.I))
    recognised, date, pending = active, None, 0
    ignored: dict[str, int] = {}
    heading = None
    for raw in text.splitlines():
        line = raw.strip()
        if not line or re.fullmatch(r"[-=_*#\s]{3,}", line):
            continue
        field = _TT_FIELD.match(line)
        if field:
            name = field[1].lower()
            if not active:
                if name in {"link", "video link", "video landing page link", "url"} and heading:
                    ignored[heading] = ignored.get(heading, 0) + 1
                continue
            if name == "date":
                date = field[2].strip()
            elif name in {"link", "video link", "video landing page link", "url"}:
                result.entries += 1
                result.records.append({"url": field[2].strip(), "saved_at": _iso(date)})
                date = None
            continue
        heading = line.rstrip(":").strip()
        active = _key(heading) in _FAVORITE_VIDEO_KEYS
        recognised = recognised or active
        date = None
    if not recognised:
        raise ExportError("no_saved_data", "No Favorite Videos section was found in this text file.")
    result.sections.append({"name": "Favorite Videos", "count": len(result.records)})
    result.ignored_sections = [{"name": name, "count": count} for name, count in ignored.items() if _key(name) in _NOT_SAVES or name.lower().startswith(("like", "watch", "favorite", "favourite"))][:10]
    return result


# ---------------------------------------------------------------- finding the files

_IG_NAME = re.compile(r"^saved_(?:posts|media|collections)\.(json|html)$", re.I)
_TT_NAME = re.compile(r"^(?:user_data(?:_tiktok)?\.(?:json|txt)|favou?rite[ _-]*videos?\.(?:json|txt))$", re.I)


def classify_member(name: str) -> tuple[str, str] | None:
    base = PurePosixPath(name).name
    if _IG_NAME.match(base):
        return "instagram", "collections" if "collection" in base.lower() else "posts"
    if _TT_NAME.match(base):
        return "tiktok", "favorites"
    return None


def _private_path(name: str) -> bool:
    return any(_key(part) in _PRIVATE_PARTS for part in PurePosixPath(name).parts[:-1])


def sniff(head: str, name: str) -> tuple[str, str] | None:
    """Last resort when no file has a recognised name: decide from the first bytes of a likely candidate."""
    lowered = name.lower()
    if lowered.endswith(".json"):
        if '"saved_saved_media"' in head or ("label_values" in head and "instagram.com/" in head):
            return "instagram", "posts"
        if "FavoriteVideoList" in head or re.search(r'"Favou?rite Videos"', head):
            return "tiktok", "favorites"
    elif lowered.endswith(".txt") and re.search(r"^\s*Favou?rite Videos\s*:?\s*$", head, re.I | re.M):
        return "tiktok", "favorites"
    elif lowered.endswith((".html", ".htm")) and head.count("instagram.com/p/") + head.count("instagram.com/reel/") >= 1 and re.search(r"saved", head[:20000], re.I):
        return "instagram", "posts"
    return None


@dataclass
class ExportRead:
    platform: str
    format: str
    files: list
    records: list                 # unique saves, in archive order: {"url","caption"?,"creator"?,"saved_at"?,"collections":[{"name","kind"}]}
    entries: int
    duplicates: int
    unreadable: list
    unreadable_total: int
    collections: list             # {"name","count"}
    sections: list
    ignored_sections: list
    warnings: list
    ignored_files: int
    nested_archives: int
    collections_read: bool
    keys: list = field(default_factory=list)       # (platform, source_key) per record, parallel to `records`


def _check_name(name: str) -> str:
    normal = name.replace("\\", "/")
    parts = normal.split("/")
    if normal.startswith("/") or re.match(r"^[A-Za-z]:", normal) or ".." in parts or "\x00" in normal:
        raise ExportError("unsafe_archive", "This archive contains an unsafe file path, so it was not read.")
    return normal


def _read_member(archive, info, limit, state, limits):
    if info.flag_bits & 1:
        raise ExportError("unsafe_archive", "This archive is password-protected, so it cannot be read.")
    if info.file_size > 1024 * 1024 and info.file_size / max(info.compress_size, 1) > limits.max_ratio:
        raise ExportError("unsafe_archive", "A file in this archive is compressed far more than normal data, so it was not read.")
    if info.file_size > limit or state["read"] + min(info.file_size, limit) > limits.max_total_bytes:
        raise ExportError("too_large", "A saved-data file in this archive is larger than the importer accepts. Request the export again with only the saved data selected, or in the text format.")
    try:
        with archive.open(info) as member:
            data = member.read(limit + 1)
    except (zipfile.BadZipFile, RuntimeError, NotImplementedError, OSError, EOFError) as exc:
        raise ExportError("unreadable", "A file in this archive could not be read safely.") from exc
    if len(data) > limit:
        raise ExportError("too_large", "A saved-data file in this archive is larger than the importer accepts.")
    state["read"] += len(data)
    return data


def read_export(path: Path, filename: str, platform: str = "auto", limits: ExportLimits = ExportLimits()) -> ExportRead:
    """Find and read the saved posts or favorite videos in an export. `path` is a file on disk; nothing is extracted."""
    suffix = PurePosixPath(filename.lower()).suffix
    with open(path, "rb") as stream:
        magic = stream.read(4)
    is_zip = suffix == ".zip" or magic[:2] == b"PK"
    state = {"read": 0}
    members: list[tuple[str, object]] = []         # (name, info or None)
    ignored_files = nested = 0
    archive = None
    try:
        if is_zip:
            try:
                archive = zipfile.ZipFile(path)
            except (zipfile.BadZipFile, OSError) as exc:
                raise ExportError("not_a_zip", "This file is not a valid ZIP archive. Upload the file exactly as Instagram or TikTok gave it to you.") from exc
            infos = archive.infolist()
            if len(infos) > limits.max_members:
                raise ExportError("too_many_files", "This archive holds more files than the importer accepts.")
            seen = set()
            for info in infos:
                name = _check_name(info.filename)
                if stat.S_ISLNK(info.external_attr >> 16):
                    raise ExportError("unsafe_archive", "This archive contains a symbolic link, so it was not read.")
                if info.is_dir():
                    continue
                if name in seen and classify_member(name):
                    raise ExportError("unsafe_archive", "This archive lists the same saved-data file twice, so it was not read.")
                seen.add(name)
                if name.lower().endswith(".zip"):
                    nested += 1
                    continue
                members.append((name, info))
        else:
            members.append((PurePosixPath(filename).name or "file", None))
        named = [(n, i, classify_member(n)) for n, i in members]
        found = {c[0] for _, _, c in named if c}
        if platform == "auto":
            if len(found) > 1:
                raise ExportError("ambiguous_platform", "This archive holds both Instagram and TikTok data. Choose which one to import.")
            platform = next(iter(found), "auto")
        elif platform not in {"instagram", "tiktok"}:
            raise ExportError("invalid_platform", "Choose Instagram or TikTok.")
        elif found and platform not in found:
            other = "TikTok" if platform == "instagram" else "Instagram"
            raise ExportError("wrong_platform", f"This looks like a {other} export. Choose {other}, or upload the right file.")
        chosen = [(n, i, c) for n, i, c in named if c and (platform == "auto" or c[0] == platform)]
        if not chosen:
            sniffed = 0
            for name, info, _ in named:
                if sniffed >= limits.max_sniffed_files or _private_path(name) or not name.lower().endswith((".json", ".txt", ".html", ".htm")):
                    continue
                if info is not None and info.file_size > limits.max_member_bytes:
                    continue
                sniffed += 1
                head = (_read_head(archive, info, limits) if info is not None else _read_prefix(path, limits.sniff_bytes)).decode("utf-8", "replace")
                found_kind = sniff(head, name)
                if found_kind and (platform == "auto" or found_kind[0] == platform):
                    chosen.append((name, info, found_kind))
            platform = chosen[0][2][0] if chosen and platform == "auto" else platform
        ignored_files = len(members) - len(chosen)
        if not chosen:
            raise ExportError("no_saved_data", "No saved posts or favorite videos were found in this file. Check that you requested the saved data, then upload the file exactly as it was given to you.")
        chosen.sort(key=lambda c: (c[2][1] != "posts", c[0]))     # posts before collections
        files, merged, collections, warnings = [], ReadResult(), [], []
        unreadable_total = 0
        formats = set()
        for name, info, (kind_platform, role) in chosen:
            file_info = {"path": name, "role": role, "entries": 0, "error": None}
            try:
                data = _read_member(archive, info, limits.max_member_bytes, state, limits) if info is not None else _read_prefix(path, limits.max_member_bytes + 1)
                if info is None and len(data) > limits.max_member_bytes:
                    raise ExportError("too_large", "This file is larger than the importer accepts.")
                text = data.decode("utf-8-sig", "replace") if not data.startswith((b"\xff\xfe", b"\xfe\xff")) else data.decode("utf-16", "replace")
                lowered = name.lower()
                if lowered.endswith(".json"):
                    try:
                        obj = json.loads(text)
                    except (ValueError, RecursionError) as exc:
                        raise ExportError("unreadable", "This JSON file is damaged or is not UTF-8 text.") from exc
                    result = read_instagram_json(obj) if kind_platform == "instagram" else read_tiktok_json(obj)
                    formats.add("json")
                elif lowered.endswith((".html", ".htm")):
                    result = read_instagram_html(text, limits.max_records)
                    formats.add("html")
                elif lowered.endswith(".txt"):
                    result = read_tiktok_txt(text, name)
                    formats.add("txt")
                else:
                    raise ExportError("unrecognised", "This file type is not part of the supported exports.")
            except ExportError as exc:
                if exc.code in {"unsafe_archive", "too_large"}:
                    raise
                file_info["error"] = exc.message
                files.append(file_info)
                warnings.append(f"{PurePosixPath(name).name} could not be read: {exc.message}")
                continue
            file_info["entries"] = result.entries
            files.append(file_info)
            merged.entries += result.entries
            merged.records.extend(result.records)
            collections.extend(result.collections)
            for item in result.unreadable:
                unreadable_total += 1
                if len(merged.unreadable) < MAX_UNREADABLE_LISTED:
                    merged.unreadable.append({"file": PurePosixPath(name).name, **item})
            merged.sections.extend(result.sections)
            merged.ignored_sections.extend(result.ignored_sections)
            warnings.extend(result.warnings)
            merged.collections_read = merged.collections_read and result.collections_read
            if len(merged.records) > limits.max_records:
                raise ExportError("too_many_records", "This export lists more saves than the importer accepts in one go.")
        if not any(f["error"] is None for f in files):
            raise ExportError("unreadable", "None of the saved-data files in this archive could be read. " + (files[0]["error"] or ""))
        return _assemble(platform, "mixed" if len(formats) > 1 else next(iter(formats), "json"), files, merged, collections, warnings, unreadable_total, ignored_files, nested)
    finally:
        if archive is not None:
            archive.close()


def _read_prefix(path, count: int) -> bytes:
    with open(path, "rb") as stream:
        return stream.read(count)


def _read_head(archive, info, limits) -> bytes:
    try:
        with archive.open(info) as member:
            return member.read(limits.sniff_bytes)
    except (zipfile.BadZipFile, RuntimeError, NotImplementedError, OSError, EOFError):
        return b""


def _assemble(platform, fmt, files, merged, collections, warnings, unreadable_total, ignored_files, nested) -> ExportRead:
    """Identity, duplicates and collection memberships: one record per distinct save, in the order the archive gave them."""
    records, keys, index, duplicates = [], [], {}, 0

    def identify(url):
        try:
            found_platform, key, canonical, _ = normalize_url(url)
        except ValueError:
            return None
        return (found_platform, key), canonical

    def add(raw, from_collection=False):
        nonlocal duplicates
        ident = identify(raw["url"])
        if ident is None or ident[0][0] != platform:
            return None
        key, canonical = ident
        if key in index:
            if not from_collection:
                duplicates += 1
            existing = records[index[key]]
            for name in ("caption", "creator", "saved_at"):
                if not existing.get(name) and raw.get(name):
                    existing[name] = raw[name]
            return existing
        record = {"url": canonical, "collections": []}
        for name in ("caption", "creator", "saved_at"):
            if raw.get(name):
                record[name] = raw[name]
        if from_collection:
            record["collection_only"] = True
        index[key] = len(records)
        records.append(record)
        keys.append(key)
        return record

    unreadable = list(merged.unreadable)
    for position, raw in enumerate(merged.records):
        if add(raw) is None:
            unreadable_total += 1
            if len(unreadable) < MAX_UNREADABLE_LISTED:
                unreadable.append({"file": "", "reason": "not_a_post_or_reel_link" if platform == "instagram" else "not_a_video_link", "index": position})
    counts: dict[str, int] = {}
    for collection in collections:
        name = collection["name"]
        members = {}
        for raw in collection["members"]:
            record = add(raw, from_collection=True)
            if record is not None:
                members[id(record)] = record
        for record in members.values():
            if all(c["name"] != name for c in record["collections"]):
                record["collections"].append({"name": name, "kind": "source"})
        counts[name] = counts.get(name, 0) + len(members)
    ordered = [{"name": n, "count": c} for n, c in sorted(counts.items(), key=lambda x: (-x[1], x[0].casefold()))]
    if platform == "instagram" and not collections:
        if merged.collections_read and fmt == "json":
            warnings.append("No collections file was found, so saves are imported without collections. Instagram keeps them in saved_collections.json when you select all saved data.")
    return ExportRead(platform, fmt, files, records, merged.entries, duplicates, unreadable, unreadable_total, ordered, merged.sections, merged.ignored_sections,
                      list(dict.fromkeys(warnings)), ignored_files, nested, merged.collections_read, keys)
