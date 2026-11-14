"""The browser interface: where its build lives, and how the server hands it out.

The interface is the React app in `ui/`. It is built once (`npm ci && npm run build` in `ui/`, Node 22 or
newer) into static files, and this module only serves those files. Nothing here renders or runs the app.

The server looks for a build in this order and uses the first that has an `index.html`:

1. `webui/` beside `server/`: where the Docker image and the Mac app put the build they were made with.
2. `ui/dist/` in a source checkout, after `npm run build`.

If there is none, the API still works (the phone app and the browser extension only need it) and every page
answers with one line saying how to build the interface.

The pages (`index.html`, and the same file at `/share`) are the only responses that carry a script-visible
secret: a fresh nonce for each response. The libraries the interface uses add a few `<style>` elements at
run time (a dialog's scroll lock, a select's scrollbar rule); they put the nonce on those, so the policy can
say `style-src 'self' 'nonce-…'` and never needs `'unsafe-inline'`.
"""
from __future__ import annotations

import logging
import re
import secrets
from pathlib import Path

from starlette.exceptions import HTTPException
from starlette.responses import PlainTextResponse, Response
from starlette.staticfiles import StaticFiles

ROOT = Path(__file__).resolve().parent.parent
PACKAGED = ROOT / "webui"
CHECKOUT = ROOT / "ui" / "dist"
# The old buildless interface. It is not served any more, but it stays a place no data or configuration may live.
LEGACY = ROOT / "web"

MISSING = ("Little Archive's web interface has not been built. Run `npm ci && npm run build` in ui/ "
           "(Node 22 or newer), then restart the server.")

log = logging.getLogger("little_archive")


def find_build() -> Path | None:
    """The directory holding a built interface, or None."""
    for candidate in (PACKAGED, CHECKOUT):
        if (candidate / "index.html").is_file():
            return candidate
    return None


def public_directories() -> tuple[Path, ...]:
    """Every directory that is, or can become, publicly served. Private data and configuration stay out of them."""
    return tuple(path.resolve() for path in (PACKAGED, CHECKOUT, LEGACY))


def is_public(path: str | Path) -> bool:
    resolved = Path(path).resolve()
    return any(resolved.is_relative_to(directory) for directory in public_directories())


def content_security_policy(nonce: str | None = None) -> str:
    """The one policy every response carries. Only a page that was given a nonce may add nonce-marked styles."""
    style = "style-src 'self'" + (f" 'nonce-{nonce}'" if nonce else "")
    return "; ".join([
        "default-src 'self'", "script-src 'self'", style, "img-src 'self' data: https:", "connect-src 'self'",
        "font-src 'self'", "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'", "form-action 'self'",
    ])


class BuildFiles(StaticFiles):
    """The build's files. Hashed files under assets/ never change, so they are cached for good; everything else is
    revalidated, so an upgraded server is never paired with an old page."""

    # Not for visitors: the public demo's page (it ships in the same build, for the demo site) and build tooling.
    HIDDEN = frozenset({"demo.html", "index.html"})

    async def get_response(self, path: str, scope):
        if scope["method"] not in ("GET", "HEAD"):
            raise HTTPException(status_code=405)
        parts = [part for part in path.split("/") if part]
        if not parts or parts[-1] in self.HIDDEN or any(part.startswith(".") for part in parts):
            raise HTTPException(status_code=404)
        response = await super().get_response(path, scope)
        if response.status_code in (200, 304):
            immutable = parts[0] == "assets" and len(parts) > 1
            response.headers["Cache-Control"] = "public, max-age=31536000, immutable" if immutable else "no-cache"
        return response


class Interface:
    """Serves the pages and the files of one build, or the one-line explanation when there is none."""

    def __init__(self, build: Path | None = None):
        self.build = build if build is not None else find_build()
        if self.build is None:
            log.error(MISSING)

    def files(self) -> BuildFiles | None:
        return BuildFiles(directory=self.build, html=False, check_dir=True) if self.build else None

    def page(self) -> Response:
        """index.html, with this response's nonce in the policy and in the page. Never cached or shared."""
        if self.build is None:
            return PlainTextResponse(MISSING, status_code=503, headers={"Cache-Control": "no-store"})
        try:
            text = (self.build / "index.html").read_text(encoding="utf-8")
        except OSError:
            return PlainTextResponse(MISSING, status_code=503, headers={"Cache-Control": "no-store"})
        nonce = secrets.token_urlsafe(18)
        # `nonce` as an attribute is what the libraries read: through the `nonce` property, because browsers hide the
        # attribute's value once the page is parsed.
        marker = f'<meta property="csp-nonce" nonce="{nonce}">'
        text, replaced = re.subn(r"<head(\s[^>]*)?>", lambda match: match.group(0) + marker, text, count=1)
        if not replaced:
            text = marker + text
        return Response(text, media_type="text/html", headers={
            "Cache-Control": "no-store",
            "Content-Security-Policy": content_security_policy(nonce),
        })
