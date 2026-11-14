"""Transcripts: when one is worth having, and the hosted provider that can make one.

A transcript can arrive three ways: the phone transcribes on the device and sends the text
(free), an explicit "deep read" asks the server to do it, or the rule below says the caption
is too thin to title and tag the save with confidence. Audio is only ever held in memory
while it is sent to the provider; it is never written to disk.
"""
from __future__ import annotations

from dataclasses import dataclass
import json
import re
import unicodedata

import httpx

from .understanding import PLACEHOLDER_TITLE, ProviderError

THIN_LETTERS = 40
MAX_TRANSCRIPT_CHARS = 20000
_LINKS = re.compile(r"https?://\S+|www\.\S+", re.I)
_TAGS = re.compile(r"[#@][\w.]+", re.U)
_EXTENSIONS = {"video/mp4": ".mp4", "video/webm": ".webm", "video/quicktime": ".mp4", "audio/mpeg": ".mp3", "audio/mp4": ".m4a", "audio/x-m4a": ".m4a",
               "audio/webm": ".webm", "audio/ogg": ".ogg", "audio/wav": ".wav", "audio/flac": ".flac"}


def meaningful_letters(text: str) -> int:
    """Letters and digits left after dropping links, hashtags, mentions and emoji."""
    text = _TAGS.sub(" ", _LINKS.sub(" ", text or ""))
    return sum(1 for ch in text if unicodedata.category(ch)[0] in {"L", "N"})


def transcript_needed(item: dict, page: dict | None = None) -> tuple[bool, str]:
    """The rule: a video whose caption and title together carry fewer than 40 letters or digits.

    Returns (needed, reason). Reasons: has_transcript, not_video, caption_sufficient, thin_caption.
    The rule only says a transcript would help; whether one is made automatically is the
    operator's ``LA_TRANSCRIBE_AUTO`` choice, and a deep read can always be requested.
    """
    entries = item.get("evidence") if isinstance(item.get("evidence"), list) else []
    if any(isinstance(e, dict) and e.get("kind") == "transcript" and str(e.get("text", "")).strip() for e in entries):
        return False, "has_transcript"
    page = page or {}
    video = item.get("content_type") == "video" or item.get("platform") == "tiktok" or page.get("content_type") == "video" or page.get("kind") == "youtube"
    if not video:
        return False, "not_video"
    texts = [item.get("caption") or ""]
    texts += [str(e.get("text", "")) for e in entries if isinstance(e, dict) and e.get("kind") == "caption"]
    title = (item.get("title") or "").strip()
    if title and not PLACEHOLDER_TITLE.match(title):
        texts.append(title)
    if meaningful_letters(" ".join(dict.fromkeys(t for t in texts if t))) >= THIN_LETTERS:
        return False, "caption_sufficient"
    return True, "thin_caption"


def clean_transcript(text) -> str:
    if not isinstance(text, str):
        return ""
    text = "".join(ch for ch in unicodedata.normalize("NFC", text) if ch in "\n\t" or unicodedata.category(ch) not in {"Cc", "Cs"})
    return "\n".join(" ".join(line.split()) for line in text.split("\n")).strip()[:MAX_TRANSCRIPT_CHARS]


@dataclass
class TranscriptResult:
    text: str
    language: str = ""
    seconds: float | None = None


class GroqWhisperTranscriber:
    """Groq's OpenAI-compatible speech-to-text endpoint. The key is read from the environment only."""
    name = "groq"
    BASE_URL = "https://api.groq.com/openai/v1"

    def __init__(self, api_key, model, *, client=None, base_url=None):
        if not isinstance(api_key, str) or not api_key.strip() or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._/-]{0,99}", model or ""):
            raise ProviderError("Transcription configuration is invalid.")
        self._key, self.model, self.client = api_key.strip(), model, client
        self.base_url = (base_url or self.BASE_URL).rstrip("/")

    def __repr__(self):
        return f"GroqWhisperTranscriber(model={self.model!r})"

    def transcribe(self, audio: bytes, content_type: str, *, language: str | None = None) -> TranscriptResult:
        if not audio:
            raise ProviderError("There was no audio to transcribe.")
        media = content_type.split(";")[0].strip().lower()
        filename = "audio" + _EXTENSIONS.get(media, ".mp4")
        data = {"model": self.model, "response_format": "verbose_json", "temperature": "0"}
        if language and re.fullmatch(r"[a-z]{2,3}", language):
            data["language"] = language
        owned = self.client is None
        client = self.client or httpx.Client(timeout=httpx.Timeout(120, connect=5, write=60, pool=5), follow_redirects=False, trust_env=False)
        try:
            with client.stream("POST", self.base_url + "/audio/transcriptions", headers={"Authorization": "Bearer " + self._key}, data=data, files={"file": (filename, audio, media or "video/mp4")}) as response:
                status = response.status_code
                raw = b""
                if status == 200:
                    chunks, size = [], 0
                    for chunk in response.iter_bytes():
                        size += len(chunk)
                        if size > 2 * 1024 * 1024:
                            raise ProviderError("The transcription response exceeded the size limit.")
                        chunks.append(chunk)
                    raw = b"".join(chunks)
            if status == 429:
                raise ProviderError("The transcription service is limiting requests. Try again later.", retryable=True)
            if status >= 500:
                raise ProviderError("The transcription service is unavailable. Try again later.", retryable=True)
            if status == 413:
                raise ProviderError("The audio is larger than the transcription service accepts.")
            if status != 200:
                raise ProviderError("The transcription service rejected the request; check the API key and model name.")
            body = json.loads(raw)
            if not isinstance(body, dict) or not isinstance(body.get("text"), str):
                raise ProviderError("The transcription service returned an unusable answer.")
            seconds = body.get("duration")
            if not isinstance(seconds, (int, float)) or isinstance(seconds, bool) or seconds < 0:
                segments = body.get("segments")
                last = segments[-1] if isinstance(segments, list) and segments and isinstance(segments[-1], dict) else {}
                seconds = last.get("end") if isinstance(last.get("end"), (int, float)) and not isinstance(last.get("end"), bool) else None
            detected = body.get("language") if isinstance(body.get("language"), str) else ""
            return TranscriptResult(clean_transcript(body["text"]), detected[:35] if re.fullmatch(r"[A-Za-z-]{2,35}", detected) else "", round(float(seconds), 1) if seconds is not None else None)
        except httpx.TimeoutException as exc:
            raise ProviderError("The transcription service timed out. Try again later.", retryable=True) from exc
        except httpx.HTTPError as exc:
            raise ProviderError("The transcription service could not be reached.", retryable=True) from exc
        except (json.JSONDecodeError, UnicodeDecodeError, RecursionError) as exc:
            raise ProviderError("The transcription service returned an unusable answer.") from exc
        finally:
            if owned:
                client.close()
