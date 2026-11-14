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
FIXED = {"index.html", "theme-init.js", "icon.svg", "LICENSE", ".nojekyll", MARKER}
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


def local_path(reference: str) -> str:
    """`./assets/x.js` -> `assets/x.js`. Anything that leaves the page's own folder is refused."""
    if re.match(r"^[a-z][a-z0-9+.-]*:", reference, re.I) or reference.startswith(("//", "/", "#")):
        raise SystemExit(f"demo.html names {reference!r}; the demo may only load its own relative files.")
    path = reference.removeprefix("./").split("?")[0].split("#")[0]
    if not path or ".." in Path(path).parts:
        raise SystemExit(f"demo.html names {reference!r}, which is outside the build.")
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


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--dist", type=Path, default=ROOT / "ui" / "dist", help="the built interface (default: ui/dist)")
    parser.add_argument("--output", type=Path, default=ROOT / "dist-demo", help="where to write the demo (default: dist-demo)")
    args = parser.parse_args(argv)
    dist, output = args.dist.resolve(), args.output.resolve()
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
        (stage / ".nojekyll").write_text("")
        (stage / MARKER).write_text("Synthetic standalone demo. Generated by scripts/build_demo.py.\n")
        published = sorted(str(path.relative_to(stage)) for path in stage.rglob("*") if path.is_file())
        check_published(published, stage)
        if output.exists():
            shutil.rmtree(output)
        shutil.copytree(stage, output)
    print(f"Built {output} ({len(published)} files). Synthetic demo only; no backend or credentials.")


if __name__ == "__main__":
    main()
