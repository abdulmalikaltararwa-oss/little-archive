"""The owner's permission to send saved content to an AI or transcription service, enforced by the server.

The interface asks before the first AI action and keeps the answer as the setting ``ai_sharing_allowed``
(per library, so per account on a hosted service). A client that never asked (an older app, a script, a job
queued before the answer was withdrawn) must not get content sent anyway, so every point that sends calls
``require`` first. ``leaves_server`` is the one place that decides what counts as sending; it follows the
interface's own rule (``describeSharing`` in ui/src/features/ai-permission/disclosure.ts), so the server never
refuses something the interface would not have asked about.
"""
from __future__ import annotations

from .features import FeatureError

CODE = "ai_permission_required"


def leaves_server(service, what: str) -> bool:
    """Whether doing `what` would send saved content somewhere other than the owner's own server.

    * ``text``: a model call. It leaves with a hosted provider, and on a hosted service with any provider,
      because the model there runs on someone else's machine. Local Ollama on a self-hosted server stays home.
    * ``media``: a transcription. Every transcriber is an outside service and is given the media file.
    * ``suggest``: queueing a suggestion, which sends the text, or the media file first when the server
      transcribes thin captions by itself.
    """
    provider = service.provider
    text = provider is not None and bool(provider.hosted or service.config.hosted)
    media = service.transcriber is not None
    if what == "text":
        return text
    if what == "media":
        return media
    if what == "suggest":
        return text or (media and provider is not None and bool(service.settings.transcribe_auto and service.fetch_enabled))
    raise ValueError("Unknown kind of sharing.")


def given(service) -> bool:
    return service.store.meta("ai_sharing_allowed") == "true"


def allowed(service, what: str) -> bool:
    """True when `what` may go ahead: nothing would leave the server, or the owner has said yes."""
    return not leaves_server(service, what) or given(service)


class SharingNotAllowed(FeatureError):
    """The refusal a client can act on: ask the owner, set ``ai_sharing_allowed``, then try again."""

    def __init__(self, service):
        whose = "account" if service.config.hosted else "library"
        super().__init__(403, f"Sending saves to an AI service has not been allowed for this {whose}, so nothing was sent. Allow it in Settings, then try again.", CODE)


def require(service, what: str) -> None:
    if not allowed(service, what):
        raise SharingNotAllowed(service)
