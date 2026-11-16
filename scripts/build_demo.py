#!/usr/bin/env python3
"""Export only the isolated synthetic demo of the React interface for a static web host.

    cd ui && npm ci && npm run build      # Node 22 or newer
    python scripts/build_demo.py          # then serve dist-demo with any static HTTP server

The demo is `ui/dist/demo.html` and the files it can load. The output has no Python server, private library,
credentials, manifest, icons for installation, or live API: the page's own policy forbids every connection.

Which files are the demo's is worked out, not listed by hand, because the build gives its files hashed names:
start from what `demo.html` references, follow every chunk those files import (statically or on demand) through
Vite's manifest (`ui/dist/.vite/manifest.json`), and take the stylesheets, fonts and images they name. Anything
else in `ui/dist` stays behind. The result is then held to a fixed rule about what may be published at all.

The same site also carries the plain pages the apps link to (privacy, terms, support, account deletion). Those are
listed by hand: four pages, their stylesheet and its one font, copied from `web/` to the same names beside the demo.
"""
from __future__ import annotations

import argparse
from html.parser import HTMLParser
import json
from pathlib import Path
import re
import shutil
import tempfile

ROOT = Path(__file__).resolve().parent.parent
MARKER = ".little-archive-demo-build"

# What a published demo file may be called. A hashed build file is `<name>-<8 character hash>.<extension>`.
ASSET = re.compile(r"assets/[A-Za-z0-9._-]+-[A-Za-z0-9_-]{8}\.(?:js|css|woff2?|webp)")
# The plain pages of the site, and the only other files they load. They use the demo's own icon.svg.
SITE_PAGES = ("privacy.html", "terms.html", "support.html", "delete-account.html")
SITE_FONT = "fonts/fraunces-soft.woff2"
SITE_FILES = SITE_PAGES + ("pages.css", SITE_FONT)
FIXED = {"index.html", "theme-init.js", "icon.svg", "LICENSE", ".nojekyll", MARKER, *SITE_FILES}
# The demo has no backend, so it must not advertise or depend on the installable app.
NEVER = re.compile(r"(?:^|/)(?:manifest[.-]|apple-touch|icons/|share[.-])", re.I)
MAX_BYTES = 24 * 1024 * 1024


class References(HTMLParser):
    """The local files a page names: its scripts, stylesheets, icons and images."""

    def __init__(self):
        super().__init__()
        self.found: list[str] = []

    def handle_starttag(self, tag, attrs):
        values = dict(attrs)
        reference = values.get("src") if tag in {"script", "img"} else values.get("href") if tag == "link" else None
        if reference:
            self.found.append(reference)


class SiteReferences(References):
    """What a plain page loads, kept apart from the links a reader follows to another page of this site."""

    def __init__(self):
        super().__init__()
        self.links: list[str] = []

    def handle_starttag(self, tag, attrs):
        super().handle_starttag(tag, attrs)
        target = dict(attrs).get("href") if tag == "a" else None
        if target and not target.startswith(("https://", "#")):
            self.links.append(target)


def local_path(reference: str, page: str = "demo.html") -> str:
    """`./assets/x.js` -> `assets/x.js`. Anything that leaves the page's own folder is refused."""
    if re.match(r"^[a-z][a-z0-9+.-]*:", reference, re.I) or reference.startswith(("//", "/", "#")):
        raise SystemExit(f"{page} names {reference!r}; the demo may only load its own relative files.")
    path = reference.removeprefix("./").split("?")[0].split("#")[0]
    if not path or ".." in Path(path).parts:
        raise SystemExit(f"{page} names {reference!r}, which is outside the build.")
    return path


def demo_files(dist: Path) -> list[str]:
    """Every file of `dist` the demo page can load, as paths relative to `dist`, in a stable order."""
    page = dist / "demo.html"
    manifest_path = dist / ".vite" / "manifest.json"
    if not page.is_file() or not manifest_path.is_file():
        raise SystemExit("ui/dist has no demo build. Run `npm ci && npm run build` in ui/ first (Node 22 or newer).")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    key_of = {entry["file"]: key for key, entry in manifest.items()}
    parser = References()
    parser.feed(page.read_text(encoding="utf-8"))
    wanted = {local_path(reference) for reference in parser.found}
    pending = [key_of[path] for path in sorted(wanted) if path in key_of]
    seen: set[str] = set()
    while pending:
        key = pending.pop()
        if key in seen:
            continue
        seen.add(key)
        entry = manifest[key]
        wanted.add(entry["file"])
        wanted.update(entry.get("css", []))
        wanted.update(entry.get("assets", []))
        pending.extend(entry.get("imports", []) + entry.get("dynamicImports", []))
    return sorted(wanted)


def check_published(names: list[str], dist: Path) -> None:
    """The fixed rule: only these kinds of file, only regular files, nothing about installation, a size ceiling."""
    total = 0
    for name in names:
        path = dist / name
        if path.is_symlink() or not path.is_file():
            raise SystemExit(f"{name} is not a regular file in the build.")
        if name not in FIXED and not ASSET.fullmatch(name):
            raise SystemExit(f"{name} is not a file the public demo may publish.")
        if NEVER.search(name):
            raise SystemExit(f"{name} belongs to the installable app, not to the demo.")
        total += path.stat().st_size
    if total > MAX_BYTES:
        raise SystemExit(f"The demo is {total / 1e6:.1f} MB, over the {MAX_BYTES / 1e6:.0f} MB it is expected to stay under.")


def copy_site(site: Path, stage: Path) -> None:
    """Copy the plain pages, their stylesheet and its font. Each must be a regular file, checked before the copy
    because a copy would follow a link and publish whatever it points at."""
    for name in SITE_FILES:
        source = site / name
        chain = [source, *source.parents][: len(Path(name).parts) + 1]  # the file, its folders, and `site` itself
        if any(path.is_symlink() for path in chain) or not source.is_file():
            raise SystemExit(f"{name} is not a regular file in {site.name}/; the demo site needs it.")
        target = stage / name
        if target.exists():
            raise SystemExit(f"{name} is already one of the demo's own files.")
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)


def check_site(stage: Path) -> None:
    """Everything a plain page loads or links to on this site is published with it, and it loads only the fixed files."""
    loadable = {"icon.svg", "pages.css"}
    for name in SITE_PAGES:
        parser = SiteReferences()
        parser.feed((stage / name).read_text(encoding="utf-8"))
        for reference in parser.found:
            if local_path(reference, name) not in loadable:
                raise SystemExit(f"{name} loads {reference!r}, which is not one of the demo site's page files.")
        for link in parser.links:
            if link != "./" and local_path(link, name) not in SITE_PAGES:
                raise SystemExit(f"{name} links to {link!r}, which the demo site does not publish.")
    styles = (stage / "pages.css").read_text(encoding="utf-8")
    if "@import" in styles:
        raise SystemExit("pages.css imports another stylesheet; the demo site publishes only this one.")
    for reference in re.findall(r"""url\(\s*['"]?([^'")]+)['"]?\s*\)""", styles):
        if local_path(reference, "pages.css") != SITE_FONT:
            raise SystemExit(f"pages.css loads {reference!r}, which is not one of the demo site's page files.")
    for name in sorted(loadable | {SITE_FONT}):
        if not (stage / name).is_file():
            raise SystemExit(f"The demo site's pages need {name}, which is not in the build.")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--dist", type=Path, default=ROOT / "ui" / "dist", help="the built interface (default: ui/dist)")
    parser.add_argument("--output", type=Path, default=ROOT / "dist-demo", help="where to write the demo (default: dist-demo)")
    parser.add_argument("--site", type=Path, default=ROOT / "web", help="where the plain pages are (default: web)")
    args = parser.parse_args(argv)
    # The pages' folder is made absolute but not resolved: a link standing in for it or for a page must be seen.
    dist, output, site = args.dist.resolve(), args.output.resolve(), args.site.absolute()
    files = demo_files(dist)
    check_published(files, dist)
    if output.exists() and not (output / MARKER).is_file() and any(output.iterdir()):
        raise SystemExit(f"{output.name} contains unrecognized files; move it aside before building the demo.")
    with tempfile.TemporaryDirectory(prefix=".demo-build-", dir=output.parent) as temporary:
        stage = Path(temporary)
        for name in files:
            target = stage / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(dist / name, target)
        # The page is published as the site's front page. Its own references are relative, so they still resolve.
        shutil.copy2(dist / "demo.html", stage / "index.html")
        shutil.copy2(ROOT / "LICENSE", stage / "LICENSE")
        copy_site(site, stage)
        check_site(stage)
        (stage / ".nojekyll").write_text("")
        (stage / MARKER).write_text("Synthetic standalone demo. Generated by scripts/build_demo.py.\n")
        published = sorted(str(path.relative_to(stage)) for path in stage.rglob("*") if path.is_file())
        check_published(published, stage)
        if output.exists():
            shutil.rmtree(output)
        shutil.copytree(stage, output)
    print(f"Built {output} ({len(published)} files). Synthetic demo and the plain pages only; no backend or credentials.")


if __name__ == "__main__":
    main()
