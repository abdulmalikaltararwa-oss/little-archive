"""Recognise the post URLs the understanding pipeline knows, and give each a stable key.

The key is the canonical post URL. It is what the optional shared cache is keyed
by, so it must not carry tracking parameters, fragments or per-user state.
"""
from __future__ import annotations

from dataclasses import dataclass
import re
from urllib.parse import quote, urlsplit, urlunsplit

from ..storage import normalize_url

_YOUTUBE_HOSTS = {"youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be", "www.youtube-nocookie.com", "youtube-nocookie.com"}
_YOUTUBE_ID = re.compile(r"[A-Za-z0-9_-]{11}")


@dataclass(frozen=True)
class PostURL:
    kind: str          # instagram | tiktok | youtube | web
    canonical: str     # cache key; credentials, tracking parameters and fragments removed
    content_type: str  # best guess from the URL alone: post | video | image | article | link


def _youtube(parts):
    host = (parts.hostname or "").lower().rstrip(".")
    if host not in _YOUTUBE_HOSTS:
        return None
    segments = [s for s in parts.path.split("/") if s]
    video_id = None
    shorts = False
    if host.endswith("youtu.be"):
        video_id = segments[0] if segments else None
    elif segments and segments[0] == "watch":
        for pair in parts.query.split("&"):
            name, _, value = pair.partition("=")
            if name == "v":
                video_id = value
                break
    elif len(segments) >= 2 and segments[0] in {"shorts", "embed", "live", "v"}:
        video_id = segments[1]
        shorts = segments[0] == "shorts"
    if not video_id or not _YOUTUBE_ID.fullmatch(video_id):
        return None
    if shorts:
        return PostURL("youtube", f"https://www.youtube.com/shorts/{video_id}", "video")
    return PostURL("youtube", f"https://www.youtube.com/watch?v={video_id}", "video")


def classify_url(raw: str) -> PostURL:
    """Raise ValueError for anything that is not an ordinary http(s) page URL."""
    platform, _, canonical, content_type = normalize_url(raw)
    if platform in {"instagram", "tiktok"}:
        return PostURL(platform, canonical, content_type)
    youtube = _youtube(urlsplit(canonical))
    if youtube:
        return youtube
    parts = urlsplit(canonical)
    return PostURL("web", urlunsplit((parts.scheme, parts.netloc, parts.path or "/", parts.query, "")), "link")


def oembed_endpoint(post: PostURL) -> str | None:
    """Official open oEmbed endpoints only. Instagram's requires an app token, so it is not used."""
    if post.kind == "youtube":
        return "https://www.youtube.com/oembed?format=json&url=" + quote(post.canonical, safe="")
    if post.kind == "tiktok":
        return "https://www.tiktok.com/oembed?url=" + quote(post.canonical, safe="")
    return None
