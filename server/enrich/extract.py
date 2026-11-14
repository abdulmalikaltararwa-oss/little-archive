"""Read what a normal visitor's browser receives for a public post. Pure functions only.

Nothing here touches the network or the database: callers pass HTML bytes/text and,
optionally, an oEmbed JSON object, and get a plain dictionary back. The sources are
Open Graph and Twitter-card meta tags, JSON-LD, schema.org ``itemprop`` meta tags,
``<title>``, and the official open oEmbed endpoints. Undocumented in-page application
state is deliberately not read.

All text is untrusted. It is cleaned (control characters, bidirectional overrides),
length-bounded, and URLs are limited to http(s) without credentials.
"""
from __future__ import annotations

from collections import deque
from datetime import datetime
from html.parser import HTMLParser
import json
import re
import unicodedata
from urllib.parse import urljoin, urlsplit

from .urls import PostURL, classify_url

SCHEMA_VERSION = 1
MAX_HTML_CHARS = 3_000_000
MAX_META_TAGS = 3000
MAX_LD_BLOCKS = 20
MAX_LD_CHARS = 512_000
MAX_LD_NODES = 200
LIMITS = {"title": 500, "creator": 200, "caption": 20000, "site_name": 200, "language": 35}
CONTENT_TYPES = {"post", "video", "article", "image", "link"}

# Titles that mean "the platform showed a shell, not the post".
_GENERIC_TITLES = {
    "instagram", "login • instagram", "tiktok", "tiktok - make your day", "youtube", "login", "log in", "sign in",
    "just a moment...", "access denied", "attention required! | cloudflare", "403 forbidden", "404 not found",
    "not found", "page not found", "error", "redirecting...", "redirecting", "before you continue",
}

_STRIP_CHARS = {c: None for c in [*range(0x202A, 0x202F), *range(0x2066, 0x206A), 0xFEFF]}
_MEDIA_EXTENSIONS = (".mp4", ".webm", ".mov", ".m4v", ".m3u8")
_LD_ARTICLES = {"article", "newsarticle", "blogposting", "report"}
_LD_CONTENT_TYPES = _LD_ARTICLES | {"videoobject", "socialmediaposting", "imageobject", "recipe", "product", "webpage"}


# ---------------------------------------------------------------- cleaning

def clean_text(value, limit, *, multiline=False) -> str:
    """Normalise untrusted text: no control characters or bidi overrides, bounded length."""
    if not isinstance(value, str):
        return ""
    value = unicodedata.normalize("NFC", value).translate(_STRIP_CHARS)
    value = value.replace(" ", "\n").replace(" ", "\n").replace("\r\n", "\n").replace("\r", "\n")
    value = "".join(ch for ch in value if ch in "\n\t" or unicodedata.category(ch) not in {"Cc", "Cs"})
    if multiline:
        out, blank = [], 0
        for line in (" ".join(line.split()) for line in value.split("\n")):
            blank = blank + 1 if not line else 0
            if blank <= 1:
                out.append(line)
        value = "\n".join(out).strip()
    else:
        value = " ".join(value.split())
    return value[:limit].rstrip()


def clean_url(value, base=None) -> str | None:
    """http(s) URL without credentials, resolved against ``base``; anything else is dropped."""
    if not isinstance(value, str):
        return None
    value = value.strip()
    if not value or len(value) > 4096 or any(ord(c) <= 32 or ord(c) == 127 for c in value):
        return None
    try:
        absolute = urljoin(base, value) if base else value
        parts = urlsplit(absolute)
        _ = parts.port
    except ValueError:
        return None
    if parts.scheme not in {"http", "https"} or not parts.hostname or parts.username or parts.password or len(absolute) > 4096:
        return None
    return absolute


def decode_html(raw, content_type: str | None = None) -> tuple[str, list[str]]:
    """Bytes to text using a BOM, the HTTP charset, or a <meta charset> hint; never raises."""
    warnings = []
    if isinstance(raw, str):
        text = raw
    else:
        encoding = None
        if raw.startswith(b"\xef\xbb\xbf"):
            encoding = "utf-8-sig"
        elif raw.startswith((b"\xff\xfe", b"\xfe\xff")):
            encoding = "utf-16"
        if not encoding and content_type:
            match = re.search(r"charset\s*=\s*[\"']?([A-Za-z0-9_.:-]{1,40})", content_type, re.I)
            encoding = match.group(1) if match else None
        if not encoding:
            match = re.search(rb"<meta[^>]{0,200}charset\s*=\s*[\"']?([A-Za-z0-9_.:-]{1,40})", raw[:4096], re.I)
            encoding = match.group(1).decode("ascii", "ignore") if match else "utf-8"
        try:
            text = raw.decode(encoding, errors="replace")
        except (LookupError, ValueError):
            text = raw.decode("utf-8", errors="replace")
            warnings.append("unknown_charset")
    if len(text) > MAX_HTML_CHARS:
        text = text[:MAX_HTML_CHARS]
        warnings.append("truncated_input")
    return text, warnings


# ---------------------------------------------------------------- HTML scan

class _Scan(HTMLParser):
    """Collect only what extraction needs; ignore everything else."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.meta: dict[str, list[str]] = {}
        self.links: list[tuple[str, str, str]] = []
        self.ld_blocks: list[str] = []
        self.title = ""
        self.lang = ""
        self.meta_count = 0
        self._in_title = False
        self._title_done = False
        self._in_ld = False
        self._ld_buffer: list[str] = []
        self._ld_size = 0

    def handle_starttag(self, tag, attrs):
        attributes = {k.lower(): (v or "") for k, v in attrs}
        if tag == "html" and not self.lang:
            self.lang = attributes.get("lang", "")
        elif tag == "meta":
            self.meta_count += 1
            if self.meta_count > MAX_META_TAGS:
                return
            key = (attributes.get("property") or attributes.get("name") or attributes.get("itemprop") or "").strip().lower()
            content = attributes.get("content", "")
            if key and content:
                self.meta.setdefault(key, []).append(content[:100_000])
        elif tag == "link":
            rel = attributes.get("rel", "").lower()
            href = attributes.get("href", "")
            if rel and href and len(self.links) < 200:
                self.links.append((rel, attributes.get("type", "").lower(), href))
        elif tag == "title" and not self._title_done:
            self._in_title = True
        elif tag == "script" and attributes.get("type", "").lower().split(";")[0].strip() == "application/ld+json" and len(self.ld_blocks) < MAX_LD_BLOCKS:
            self._in_ld, self._ld_buffer, self._ld_size = True, [], 0

    def handle_endtag(self, tag):
        if tag == "title" and self._in_title:
            self._in_title, self._title_done = False, True
        elif tag == "script" and self._in_ld:
            self._in_ld = False
            self.ld_blocks.append("".join(self._ld_buffer))

    def handle_data(self, data):
        if self._in_title and len(self.title) < 2000:
            self.title += data
        elif self._in_ld and self._ld_size <= MAX_LD_CHARS:
            self._ld_buffer.append(data)
            self._ld_size += len(data)


def _ld_nodes(blocks: list[str]) -> list[dict]:
    """Typed JSON-LD objects from top level, arrays and @graph. Iterative and bounded."""
    nodes: list[dict] = []
    queue: deque = deque()
    for text in blocks:
        if len(text) > MAX_LD_CHARS:
            continue
        try:
            queue.append((json.loads(text), 0))
        except (ValueError, RecursionError):
            continue
    visited = 0
    while queue and visited < 500 and len(nodes) < MAX_LD_NODES:
        current, depth = queue.popleft()
        visited += 1
        if isinstance(current, list) and depth < 3:
            queue.extend((x, depth + 1) for x in current[:50])
        elif isinstance(current, dict):
            if "@type" in current:
                nodes.append(current)
            graph = current.get("@graph")
            if isinstance(graph, list) and depth < 3:
                queue.extend((x, depth + 1) for x in graph[:50])
    return nodes


def _ld_types(node: dict) -> set[str]:
    raw = node.get("@type")
    values = raw if isinstance(raw, list) else [raw]
    return {v.rsplit("/", 1)[-1].lower() for v in values if isinstance(v, str)}


def _ld_string(value, limit=500, *, multiline=False) -> str:
    if isinstance(value, str):
        return clean_text(value, limit, multiline=multiline)
    if isinstance(value, dict):
        return _ld_string(value.get("name") or value.get("headline") or "", limit)
    if isinstance(value, list):
        for entry in value[:5]:
            found = _ld_string(entry, limit)
            if found:
                return found
    return ""


def _ld_url(value, base) -> str | None:
    if isinstance(value, str):
        return clean_url(value, base)
    if isinstance(value, dict):
        return _ld_url(value.get("url") or value.get("contentUrl"), base)
    if isinstance(value, list):
        for entry in value[:5]:
            found = _ld_url(entry, base)
            if found:
                return found
    return None


_ISO_DURATION = re.compile(r"^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$", re.I)


def parse_duration(value) -> float | None:
    """ISO-8601 ``PT3M34S`` or plain seconds. Out-of-range or malformed gives None."""
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        seconds = float(value)
    elif isinstance(value, str):
        text = value.strip()
        match = _ISO_DURATION.match(text) if text.upper().startswith("P") else None
        if match and any(match.groups()):
            d, h, m, s = (float(x) if x else 0.0 for x in match.groups())
            seconds = d * 86400 + h * 3600 + m * 60 + s
        else:
            try:
                seconds = float(text)
            except ValueError:
                return None
    else:
        return None
    return round(seconds, 1) if 0 < seconds <= 7 * 86400 else None


def _date(value) -> str | None:
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip()[:40]
    try:
        if "T" in text:
            return datetime.fromisoformat(text.replace("Z", "+00:00")).isoformat(timespec="seconds")
        return datetime.fromisoformat(text).date().isoformat()
    except ValueError:
        return None


# ---------------------------------------------------------------- platform patterns

_HANDLE = r"[A-Za-z0-9._]{1,30}"
_DATE = r"[A-Z][a-z]+ \d{1,2}, \d{4}"
# Observed 14 Nov 2026: "<caption> - @handle on June 16, 2015".
_IG_DESC_CURRENT = re.compile(rf"^(?P<caption>.*)\s+-\s+@(?P<handle>{_HANDLE})\s+on\s+(?P<date>{_DATE})\s*$", re.S)
# Earlier shape, kept because older cached or client-supplied pages use it.
_IG_DESC_LEGACY = re.compile(rf"^[\d.,]+[KMBkmb]?\s+likes?,\s+[\d.,]+[KMBkmb]?\s+comments?\s+-\s+(?P<handle>{_HANDLE})\s+on\s+(?P<date>{_DATE}):\s*[“\"](?P<caption>.*)[”\"]\.?\s*$", re.S)
_IG_TITLE = re.compile(r"^(?P<name>.+?)\s+on Instagram:\s*[“\"](?P<caption>.*)[”\"]\s*$", re.S)
_IG_TWITTER_TITLE = re.compile(rf"^(?P<name>.+?)\s+\(@(?P<handle>{_HANDLE})\)\s+•\s+Instagram\s+(?P<what>[A-Za-z ]+?)\s*$")
# TikTok shapes below were documented historically; the public page observed on 14 Nov 2026 had no Open Graph tags.
_TT_DESC = re.compile(r"^[\d.,]+[KMBkmb]?\s+Likes?,\s+[\d.,]+[KMBkmb]?\s+Comments?\.\s+TikTok video from\s+.+?\s+\(@(?P<handle>[A-Za-z0-9._]+)\):\s*[“\"](?P<caption>.*?)[”\"]\.?(?:\s+original sound.*)?$", re.S)
_TT_TITLE = re.compile(r"^(?P<name>.+?)\s+\(@(?P<handle>[A-Za-z0-9._]+)\)\s+on TikTok\s*$")


def _ig_date(value: str) -> str | None:
    try:
        return datetime.strptime(value, "%B %d, %Y").date().isoformat()
    except ValueError:
        return None


class _Fields:
    """Candidates per field in precedence order; the first valid one wins."""

    def __init__(self):
        self.values: dict[str, list[tuple[str, object]]] = {}
        self.used: list[str] = []

    def add(self, field: str, source: str, value) -> None:
        if value not in (None, "", []):
            self.values.setdefault(field, []).append((source, value))

    def pick(self, field: str, default=""):
        for source, value in self.values.get(field, []):
            if source not in self.used:
                self.used.append(source)
            return value
        return default


def parse_oembed(kind: str, data) -> dict:
    """Fields from an oEmbed JSON object. The ``html`` member is never propagated."""
    if not isinstance(data, dict):
        return {}
    out = {
        "title": clean_text(data.get("title"), LIMITS["title"]),
        "creator": clean_text(data.get("author_name"), LIMITS["creator"]),
        "creator_url": clean_url(data.get("author_url")),
        "thumbnail_url": clean_url(data.get("thumbnail_url")),
        "embed_id": clean_text(str(data.get("embed_product_id") or ""), 40),
    }
    if data.get("type") == "video" or kind in {"youtube", "tiktok"}:
        out["content_type"] = "video"
    return {k: v for k, v in out.items() if v}


def _is_generic_title(title: str, site_name: str) -> bool:
    lowered = title.strip().lower()
    return not lowered or lowered in _GENERIC_TITLES or (bool(site_name) and lowered == site_name.strip().lower())


def _media_url(url: str | None, declared_type: str | None) -> str | None:
    """Only a URL that really is a media file; an embed page (text/html) is not one."""
    if not url:
        return None
    if declared_type and declared_type.lower().startswith(("video/", "audio/", "application/vnd.apple.mpegurl")):
        return url
    return url if urlsplit(url).path.lower().endswith(_MEDIA_EXTENSIONS) else None


def _result(post: PostURL, f: _Fields, warnings, *, usable: bool, reason: str, content_type: str) -> dict:
    return {
        "schema": SCHEMA_VERSION, "kind": post.kind, "source_url": post.canonical, "canonical_url": post.canonical,
        "content_type": content_type, "title": "", "creator": "", "creator_url": None, "caption": "",
        "thumbnail_url": None, "video_url": None, "published_at": None, "duration_seconds": None,
        "language": "", "site_name": "", "sources": list(f.used), "warnings": list(dict.fromkeys(warnings)),
        "usable": usable, "reason": reason,
    }


def extract_page(html, url: str, *, oembed: dict | None = None, content_type: str | None = None) -> dict:
    """Normalised public details for one post. ``html`` and ``oembed`` are both optional.

    ``usable`` is False when the input shows a login wall or a different page rather
    than the post; callers then keep the item unchanged and report ``reason``.
    """
    try:
        post = classify_url(url)
    except ValueError:
        post = PostURL("web", url.strip()[:4096], "link")
    warnings: list[str] = []
    scan = _Scan()
    if html:
        text, warnings = decode_html(html, content_type)
        try:
            scan.feed(text)
            scan.close()
        except (AssertionError, ValueError, RecursionError):
            warnings.append("html_parse_error")
    meta, f = scan.meta, _Fields()

    def first(*keys, limit=LIMITS["title"], multiline=False) -> str:
        for key in keys:
            for raw in meta.get(key, []):
                cleaned = clean_text(raw, limit, multiline=multiline)
                if cleaned:
                    return cleaned
        return ""

    def first_url(*keys) -> str | None:
        for key in keys:
            for raw in meta.get(key, []):
                found = clean_url(raw, url)
                if found:
                    return found
        return None

    site_name = first("og:site_name", limit=LIMITS["site_name"])
    og_title, tw_title = first("og:title"), first("twitter:title")
    og_desc = first("og:description", limit=LIMITS["caption"], multiline=True)
    tw_desc = first("twitter:description", limit=LIMITS["caption"], multiline=True)
    plain_desc = first("description", limit=LIMITS["caption"], multiline=True)
    og_type = first("og:type").lower()
    ld = _ld_nodes(scan.ld_blocks)
    ld_main = next((n for n in ld if _ld_types(n) & _LD_CONTENT_TYPES), None)
    embedded = parse_oembed(post.kind, oembed) if oembed else {}

    # The oEmbed answer must describe this very post.
    embed_id = embedded.get("embed_id")
    if post.kind == "tiktok" and embed_id and not post.canonical.rstrip("/").endswith("/" + embed_id):
        return _result(post, f, [*warnings, "oembed_for_another_post"], usable=False, reason="different_page", content_type="link")

    handle, published, page_type = "", None, "link"
    if post.kind == "instagram":
        page_type = "video" if og_type.startswith("video") else "post"
        caption = ""
        for description in (og_desc, plain_desc, tw_desc):
            for pattern in (_IG_DESC_LEGACY, _IG_DESC_CURRENT):
                match = pattern.match(description) if description else None
                if match:
                    caption, handle, published = match["caption"], match["handle"], _ig_date(match["date"])
                    break
            if caption:
                break
        if not caption:
            title_match = _IG_TITLE.match(og_title) if og_title else None
            caption = title_match["caption"] if title_match else (og_desc or plain_desc)
        twitter_match = _IG_TWITTER_TITLE.match(tw_title) if tw_title else None
        if twitter_match:
            handle = handle or twitter_match["handle"]
            what = twitter_match["what"].lower()
            page_type = "video" if "video" in what and "photo" not in what else page_type
        f.add("caption", "opengraph", clean_text(caption, LIMITS["caption"], multiline=True))
    elif post.kind == "tiktok":
        page_type = "video"
        match = _TT_DESC.match(og_desc) if og_desc else None
        if match:
            handle = match["handle"]
            f.add("caption", "opengraph", clean_text(match["caption"], LIMITS["caption"], multiline=True))
        else:
            f.add("caption", "opengraph", og_desc)
        title_match = _TT_TITLE.match(og_title) if og_title else None
        handle = handle or (title_match["handle"] if title_match else "")
        # Where oEmbed still carries the creator's text, it is the caption, not a title.
        f.add("caption", "oembed", embedded.get("title"))
    else:
        if og_type.startswith("video") or post.kind == "youtube":
            page_type = "video"
        elif og_type == "article":
            page_type = "article"
        elif ld_main:
            kinds = _ld_types(ld_main)
            page_type = "video" if "videoobject" in kinds else "image" if "imageobject" in kinds else "article" if kinds & _LD_ARTICLES else "link"
        for source, value in (("opengraph", og_desc), ("twitter", tw_desc), ("html", plain_desc)):
            f.add("caption", source, value)
        if ld_main:
            f.add("caption", "jsonld", _ld_string(ld_main.get("description"), LIMITS["caption"], multiline=True))

    # Titles. Instagram and TikTok posts have no title of their own; their page title is the site name.
    if post.kind == "youtube":
        f.add("title", "oembed", embedded.get("title"))
    if post.kind not in {"instagram", "tiktok"}:
        f.add("title", "opengraph", og_title)
        f.add("title", "twitter", tw_title)
        if ld_main:
            f.add("title", "jsonld", _ld_string(ld_main.get("name") or ld_main.get("headline"), LIMITS["title"]))
        f.add("title", "html", first("title"))
        f.add("title", "html", clean_text(scan.title, LIMITS["title"]))

    f.add("creator", "oembed", embedded.get("creator"))
    f.add("creator_url", "oembed", embedded.get("creator_url"))
    if post.kind not in {"instagram", "tiktok", "youtube"}:
        if ld_main:
            f.add("creator", "jsonld", _ld_string(ld_main.get("author"), LIMITS["creator"]))
            author = ld_main.get("author")
            f.add("creator_url", "jsonld", _ld_url(author, url) if isinstance(author, dict) else None)
        f.add("creator", "html", first("author", limit=LIMITS["creator"]))

    f.add("thumbnail_url", "opengraph", first_url("og:image:secure_url", "og:image:url", "og:image"))
    f.add("thumbnail_url", "twitter", first_url("twitter:image", "twitter:image:src"))
    if ld_main:
        f.add("thumbnail_url", "jsonld", _ld_url(ld_main.get("thumbnailUrl") or ld_main.get("image"), url))
    for rel, _type, href in scan.links:
        if rel == "image_src":
            f.add("thumbnail_url", "html", clean_url(href, url))
    f.add("thumbnail_url", "oembed", embedded.get("thumbnail_url"))

    declared = (meta.get("og:video:type") or [""])[0]
    f.add("video_url", "opengraph", _media_url(first_url("og:video:secure_url", "og:video:url", "og:video"), declared))
    f.add("video_url", "twitter", _media_url(first_url("twitter:player:stream"), None))
    if ld_main:
        f.add("video_url", "jsonld", _media_url(_ld_url(ld_main.get("contentUrl"), url), None))

    published = published or _date(first("article:published_time", "datepublished", "uploaddate", limit=60))
    if not published and ld_main:
        published = _date(_ld_string(ld_main.get("datePublished") or ld_main.get("uploadDate"), 60))
    duration = parse_duration(first("video:duration", "og:video:duration", "duration", limit=40))
    if not duration and ld_main:
        duration = parse_duration(ld_main.get("duration"))
    language = clean_text(scan.lang or first("og:locale", limit=LIMITS["language"]), LIMITS["language"])

    # The page must say it is this post. A different post of the same platform means the
    # content belongs elsewhere (for example a redirect), so nothing is attached.
    page_canonical, mismatch = "", False
    candidates = [clean_url(href, url) for rel, _t, href in scan.links if rel == "canonical"] + [first_url("og:url")]
    for candidate in filter(None, candidates):
        try:
            other = classify_url(candidate)
        except ValueError:
            continue
        if post.kind != "web":
            if other.kind == post.kind and other.canonical == post.canonical:
                page_canonical = post.canonical
            elif other.kind == post.kind:
                mismatch = True
        elif other.kind == "web" and urlsplit(other.canonical).hostname == urlsplit(post.canonical).hostname:
            page_canonical = page_canonical or other.canonical
    if mismatch and not page_canonical:
        return _result(post, f, [*warnings, "canonical_mismatch"], usable=False, reason="different_page", content_type="link")

    title = f.pick("title")
    if _is_generic_title(title, site_name):
        title = ""
    if post.kind == "youtube":
        title = re.sub(r"\s+[-|–]\s+YouTube$", "", title)
    creator = "@" + handle if handle else f.pick("creator")
    caption = f.pick("caption")
    thumbnail, video = f.pick("thumbnail_url") or None, f.pick("video_url") or None
    usable = bool(title or caption or creator or thumbnail or video)
    # The creator named in a TikTok URL is only added once the page itself had something.
    if usable and not creator and post.kind == "tiktok":
        match = re.search(r"/@([^/]+)/", post.canonical)
        creator = "@" + match.group(1) if match else ""
    kind_type = embedded.get("content_type") or page_type
    result = _result(post, f, warnings, usable=usable, reason="" if usable else "no_public_details", content_type=kind_type if kind_type in CONTENT_TYPES else "link")
    result.update(
        title=clean_text(title, LIMITS["title"]), creator=clean_text(creator, LIMITS["creator"]), creator_url=f.pick("creator_url") or None,
        caption=caption, thumbnail_url=thumbnail, video_url=video, published_at=published, duration_seconds=duration,
        language=language, site_name=site_name, canonical_url=page_canonical or post.canonical, sources=list(f.used),
    )
    return result


# ---------------------------------------------------------------- client-supplied extraction

def sanitize_client_extraction(data: dict, url: str) -> dict:
    """Apply the same cleaning to an extraction a client parsed itself.

    The client is the owner's own device, but it still fetched untrusted pages: text is
    cleaned and bounded, URLs are restricted, and the canonical URL must name the same
    post as the saved item, so one item's page can never be attached to another.
    """
    try:
        post = classify_url(url)
    except ValueError:
        post = PostURL("web", url.strip()[:4096], "link")
    canonical = clean_url(data.get("canonical_url"), url)
    if canonical:
        try:
            other = classify_url(canonical)
        except ValueError:
            other = None
        if other and post.kind != "web" and (other.kind != post.kind or other.canonical != post.canonical):
            raise ValueError("The supplied page details are for a different post than this save.")
    content_type = data.get("content_type") if data.get("content_type") in CONTENT_TYPES else post.content_type
    site_name = clean_text(data.get("site_name"), LIMITS["site_name"])
    title = clean_text(data.get("title"), LIMITS["title"])
    result = {
        "schema": SCHEMA_VERSION, "kind": post.kind, "source_url": post.canonical, "canonical_url": post.canonical,
        "content_type": content_type, "title": "" if _is_generic_title(title, site_name) else title,
        "creator": clean_text(data.get("creator"), LIMITS["creator"]), "creator_url": clean_url(data.get("creator_url")),
        "caption": clean_text(data.get("caption"), LIMITS["caption"], multiline=True),
        "thumbnail_url": clean_url(data.get("thumbnail_url")), "video_url": clean_url(data.get("video_url")),
        "published_at": _date(data.get("published_at")), "duration_seconds": parse_duration(data.get("duration_seconds")),
        "language": clean_text(data.get("language"), LIMITS["language"]), "site_name": site_name,
        "sources": ["client"], "warnings": [],
    }
    result["usable"] = bool(result["title"] or result["caption"] or result["creator"] or result["thumbnail_url"] or result["video_url"])
    result["reason"] = "" if result["usable"] else "no_public_details"
    return result
