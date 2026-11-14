"""Say where a keyword search matched.

The index (``item_search``) already holds titles, captions, transcripts, summaries, notes
and tags, so a transcript is searchable as soon as it is stored. The index cannot say
which field matched, so for each returned page of results the same words are looked up in
the item's own fields. This is best effort and describes the page the owner is looking at;
it never changes which items match.
"""
from __future__ import annotations

import re

from ..storage import normalize_search

FIELDS = ("title", "caption", "alt_text", "transcript", "summary", "notes", "tags", "creator")


def _tokens(text) -> list[str]:
    return re.findall(r"[^\W_]+", normalize_search(text or ""))


def query_words(q: str) -> list[str]:
    # The same word extraction the index query uses (storage.Store.item_filter).
    return re.findall(r"\w+", normalize_search(q))[:20]


def _field_texts(item: dict) -> dict[str, str]:
    evidence = item.get("evidence") if isinstance(item.get("evidence"), list) else []
    spoken = " ".join(str(e.get("text", "")) for e in evidence if isinstance(e, dict) and e.get("kind") == "transcript")
    captions = [item.get("caption") or ""] + [str(e.get("text", "")) for e in evidence if isinstance(e, dict) and e.get("kind") == "caption"]
    alt = " ".join(str(e.get("text", "")) for e in evidence if isinstance(e, dict) and e.get("kind") == "thumbnail_alt")
    return {
        "title": item.get("title") or "", "caption": " ".join(captions), "alt_text": alt, "transcript": spoken, "summary": item.get("summary") or "",
        "notes": item.get("notes") or "", "tags": " ".join(item.get("tags") or []), "creator": item.get("creator") or "",
    }


def match_locations(q: str, item: dict) -> list[str]:
    words = query_words(q)
    if not words:
        return []
    tokens = {name: _tokens(text) for name, text in _field_texts(item).items()}
    found = {name for name, field_tokens in tokens.items() for word in words if any(t.startswith(word) for t in field_tokens)}
    return [name for name in FIELDS if name in found]


def annotate_matches(items: list[dict], q: str) -> None:
    for item in items:
        item["match_in"] = match_locations(q, item)
