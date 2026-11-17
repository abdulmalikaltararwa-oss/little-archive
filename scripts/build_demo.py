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
listed by hand: four pages, their stylesheet and its one font, from `web/` to the same names beside the demo.

The pages name one contact address. It is written once, in `web/site.json` (`contact_email`), and put into the pages
here; the pages themselves hold only a token. While that address is empty the pages are not published at all, and
the demo is built without them: a page that tells people to write to an address nobody has chosen must not go public.

Pass --website to build the official site into work/dist-website. The explainer is the front page, the same
synthetic demo is at demo.html, and the four policy and support pages require a configured contact address.
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
WEBSITE_MARKER = ".little-archive-website-build"

# What a published demo file may be called. A hashed build file is `<name>-<8 character hash>.<extension>`.
ASSET = re.compile(r"assets/[A-Za-z0-9._-]+-[A-Za-z0-9_-]{8}\.(?:js|css|woff2?|webp)")
# The plain pages of the site, and the only other files they load. They use the demo's own icon.svg.
SITE_PAGES = ("privacy.html", "terms.html", "support.html", "delete-account.html")
SITE_FONT = "fonts/fraunces-soft.woff2"
SITE_FILES = SITE_PAGES + ("pages.css", SITE_FONT)
SITE_SETTINGS = "site.json"
# What the pages hold where the contact address goes, and what must never be published in its place.
CONTACT_TOKEN = "{{CONTACT_EMAIL}}"
UNSET_MARKS = ("{{", "}}", "[owner to set]")
# One mailbox at a domain: no spaces, no markup, nothing that could change the page it is written into.
CONTACT_SHAPE = re.compile(r"[A-Za-z0-9](?:[A-Za-z0-9._+-]{0,62}[A-Za-z0-9])?@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,24}")
# Names set aside for examples and tests. An address there reaches nobody, so the tracked file may not hold one.
RESERVED_DOMAIN = re.compile(r"(?:^|\.)(?:example|invalid|test|localhost|local)$|(?:^|\.)example\.(?:com|net|org)$", re.I)
DEMO_FIXED = {"index.html", "theme-init.js", "icon.svg", "LICENSE", ".nojekyll", MARKER}
FIXED = DEMO_FIXED | set(SITE_FILES)
WEBSITE_FIXED = (FIXED - {MARKER}) | {"demo.html", "home.css", "gallery-preview.jpg", WEBSITE_MARKER}
HOME_LOADS = {"home.css", "icon.svg", "gallery-preview.jpg"}
PLAIN_PAGE_CSP = "default-src 'none'; style-src 'self'; img-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'"
# The demo has no backend, so it must not advertise or depend on the installable app.
NEVER = re.compile(r"(?:^|/)(?:manifest[.-]|apple-touch|icons/|share[.-])", re.I)
MAX_BYTES = 24 * 1024 * 1024


class References(HTMLParser):
    """The local files a page names: its scripts, stylesheets, icons and images."""

    def __init__(self):
        super().__init__()
        self.found: list[str] = []
        self.policies: list[str] = []
        self.link_types: set[str] = set()

    def handle_starttag(self, tag, attrs):
        values = dict(attrs)
        if tag == "meta" and (values.get("http-equiv") or "").lower() == "content-security-policy":
            self.policies.append(values.get("content") or "")
        if tag == "link":
            self.link_types.update((values.get("rel") or "").lower().split())
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


class PlainPageReferences(References):
    """Reject active content and collect the static page's assets, links, and anchors."""

    def __init__(self, name: str):
        super().__init__()
        self.name = name
        self.links: list[str] = []
        self.ids: set[str] = set()

    def handle_starttag(self, tag, attrs):
        values = dict(attrs)
        if (tag in {"base", "script", "style", "iframe", "object", "embed", "form"}
                or any(key.startswith("on") or key in {"style", "srcset", "imagesrcset", "poster", "ping", "xlink:href"} for key in values)
                or ("src" in values and tag != "img") or ("href" in values and tag not in {"a", "link"})):
            raise SystemExit(f"{self.name} must be a plain page with only local stylesheet, icon and image dependencies.")
        if tag == "meta" and "http-equiv" in values and (values["http-equiv"] or "").lower() != "content-security-policy":
            raise SystemExit(f"{self.name} must not use HTTP-equivalent metadata other than its content security policy.")
        if tag == "link" and values.get("rel") not in {"stylesheet", "icon"}:
            raise SystemExit(f"{self.name} link elements must be a stylesheet or icon.")
        if tag == "a" and values.get("href"):
            self.links.append(values["href"])
        if values.get("id"):
            self.ids.add(values["id"])
        super().handle_starttag(tag, attrs)


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


def valid_contact(address: str, *, reserved_allowed: bool = False) -> str:
    """The address as it will be printed, or a stop that says what is wrong with it."""
    if not isinstance(address, str):
        raise SystemExit(f"contact_email in {SITE_SETTINGS} must be text.")
    address = address.strip()
    if not address:
        return ""
    if len(address) > 254 or ".." in address or not CONTACT_SHAPE.fullmatch(address):
        raise SystemExit(f"contact_email in {SITE_SETTINGS} is not an email address: {address!r}.")
    if not reserved_allowed and RESERVED_DOMAIN.search(address.rsplit("@", 1)[1]):
        raise SystemExit(f"contact_email in {SITE_SETTINGS} is at a domain reserved for examples, so nobody would receive it: {address!r}.")
    return address


def site_contact(site: Path) -> str:
    """The contact address the owner set in `web/site.json`, or the empty string while none is set."""
    path = site / SITE_SETTINGS
    if path.is_symlink() or site.is_symlink() or not path.is_file():
        raise SystemExit(f"{SITE_SETTINGS} is not a regular file in {site.name}/; it holds the pages' contact address.")
    try:
        settings = json.loads(path.read_text(encoding="utf-8"))
    except ValueError:
        raise SystemExit(f"{SITE_SETTINGS} in {site.name}/ is not valid JSON.") from None
    if not isinstance(settings, dict) or set(settings) != {"contact_email"}:
        raise SystemExit(f"{SITE_SETTINGS} in {site.name}/ must hold exactly one value, contact_email.")
    return valid_contact(settings["contact_email"])


def check_published(names: list[str], dist: Path, allowed=FIXED) -> None:
    """The fixed rule: only these kinds of file, only regular files, nothing about installation, a size ceiling."""
    total = 0
    for name in names:
        path = dist / name
        if path.is_symlink() or not path.is_file():
            raise SystemExit(f"{name} is not a regular file in the build.")
        if name not in allowed and not ASSET.fullmatch(name):
            raise SystemExit(f"{name} is not a file the public demo may publish.")
        if NEVER.search(name):
            raise SystemExit(f"{name} belongs to the installable app, not to the demo.")
        total += path.stat().st_size
    if total > MAX_BYTES:
        raise SystemExit(f"The demo is {total / 1e6:.1f} MB, over the {MAX_BYTES / 1e6:.0f} MB it is expected to stay under.")


def regular_file(root: Path, name: str) -> Path:
    """Refuse links in the fixed source path, including directories beneath the source root."""
    path = root / name
    chain = [path, *path.parents][: len(Path(name).parts) + 1]
    if any(part.is_symlink() for part in chain) or not path.is_file():
        raise SystemExit(f"{name} is not a regular file in {root.name}/.")
    return path


def copy_site(site: Path, stage: Path, contact: str) -> None:
    """Copy the plain pages, their stylesheet and its font, writing the contact address into the pages. Each must be
    a regular file, checked before the copy because a copy would follow a link and publish whatever it points at."""
    for name in SITE_FILES:
        source = site / name
        chain = [source, *source.parents][: len(Path(name).parts) + 1]  # the file, its folders, and `site` itself
        if any(path.is_symlink() for path in chain) or not source.is_file():
            raise SystemExit(f"{name} is not a regular file in {site.name}/; the demo site needs it.")
        target = stage / name
        if target.exists():
            raise SystemExit(f"{name} is already one of the demo's own files.")
        target.parent.mkdir(parents=True, exist_ok=True)
        if name not in SITE_PAGES:
            shutil.copy2(source, target)
            continue
        text = source.read_text(encoding="utf-8")
        if CONTACT_TOKEN not in text:
            raise SystemExit(f"{name} does not hold {CONTACT_TOKEN}, where the contact address goes.")
        text = text.replace(CONTACT_TOKEN, contact)
        for mark in UNSET_MARKS:
            if mark in text:
                raise SystemExit(f"{name} would be published with {mark!r} in it; the contact address or another value was not filled in.")
        target.write_text(text, encoding="utf-8")


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


def copy_home(site: Path, stage: Path) -> None:
    for source, target in (("home.html", "index.html"), ("home.css", "home.css")):
        shutil.copy2(regular_file(site, source), stage / target)
    shutil.copy2(regular_file(ROOT, "docs/assets/gallery-current.jpg"), stage / "gallery-preview.jpg")


def plain_page(path: Path, name: str) -> PlainPageReferences:
    parser = PlainPageReferences(name)
    parser.feed(path.read_text(encoding="utf-8"))
    if parser.policies != [PLAIN_PAGE_CSP]:
        raise SystemExit(f"{name} must use the plain-page content security policy.")
    return parser


def check_website_pages(stage: Path) -> None:
    demo = References()
    demo.feed((stage / "demo.html").read_text(encoding="utf-8"))
    connections = [rule.split() for policy in demo.policies for rule in policy.split(";")
                   if re.match(r"^\s*connect-src\b", rule, re.I)]
    if connections != [["connect-src", "'none'"]] or demo.link_types & {"manifest", "apple-touch-icon"}:
        raise SystemExit("demo.html must forbid all connections and must not link the installable app.")
    for name in SITE_PAGES:
        plain_page(stage / name, name)

    parser = plain_page(stage / "index.html", "home.html")
    for reference in parser.found:
        path = local_path(reference, "home.html")
        if path not in HOME_LOADS or not (stage / path).is_file():
            raise SystemExit(f"home.html loads {reference!r}, which is not a published home asset.")
    for link in parser.links:
        if link.startswith("https://"):
            continue
        target, _, fragment = link.partition("#")
        route = "index.html" if target in {"", "./"} else local_path(target, "home.html")
        if route not in (*SITE_PAGES, "index.html", "demo.html") or not (stage / route).is_file():
            raise SystemExit(f"home.html links to {link!r}, which is not a published page.")
        if route == "index.html" and fragment and fragment not in parser.ids:
            raise SystemExit(f"home.html links to {link!r}, which is not a home anchor.")
    styles = (stage / "home.css").read_text(encoding="utf-8")
    if re.search(r"@import\b|\bimage-set\s*\(", styles, re.I):
        raise SystemExit("home.css must not use stylesheet imports or image sets.")
    for reference in re.findall(r"""url\(\s*['"]?([^'")]+)['"]?\s*\)""", styles, re.I):
        if local_path(reference, "home.css") != SITE_FONT or not (stage / SITE_FONT).is_file():
            raise SystemExit(f"home.css loads {reference!r}, which is not the published font.")


def check_website_text(stage: Path, names: list[str]) -> None:
    # The Pages workflow applies the same check independently to the files it uploads.
    for name in names:
        path = stage / name
        if path.suffix in {".js", ".css", ".html", ".svg"}:
            text = path.read_text(encoding="utf-8")
            if any(mark in text for mark in ("LA_ADMIN_PASSWORD", "BEGIN PRIVATE KEY", "secrets.env")):
                source = "home.html" if name == "index.html" else name
                raise SystemExit(f"{source} contains credential-related text.")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--dist", type=Path, default=ROOT / "ui" / "dist", help="the built interface (default: ui/dist)")
    parser.add_argument("--website", action="store_true", help="export the official home with the demo at demo.html")
    parser.add_argument("--output", type=Path, help="output directory (defaults: dist-demo, or work/dist-website with --website)")
    parser.add_argument("--site", type=Path, default=ROOT / "web", help="where the plain pages are (default: web)")
    parser.add_argument("--contact-email", default=None,
                        help="for a local check only: build the pages with this address instead of the one in the pages' site.json")
    args = parser.parse_args(argv)
    # The pages' folder is made absolute but not resolved: a link standing in for it or for a page must be seen.
    dist = args.dist.absolute() if args.website else args.dist.resolve()
    output = args.output or ROOT / ("work/dist-website" if args.website else "dist-demo")
    if args.website and output.is_symlink():
        raise SystemExit("The website output must be a directory, not a symbolic link.")
    output, site = output.resolve(), args.site.absolute()
    contact = site_contact(site) if args.contact_email is None else valid_contact(args.contact_email, reserved_allowed=True)
    allowed = FIXED if contact else DEMO_FIXED
    if args.website and not contact:
        raise SystemExit(f"The website needs a contact address in {site.name}/{SITE_SETTINGS} (contact_email).")
    marker = WEBSITE_MARKER if args.website else MARKER
    if args.website:
        regular_file(dist, "demo.html")
        regular_file(dist, ".vite/manifest.json")
    files = demo_files(dist)
    check_published(files, dist, {"theme-init.js", "icon.svg"} if args.website else allowed)
    if args.website:
        for name in files:
            regular_file(dist, name)
        if args.output is None:
            output.parent.mkdir(exist_ok=True)
        if (output / marker).is_symlink():
            raise SystemExit("The website build marker must be a regular file.")
    if output.exists() and not (output / marker).is_file() and any(output.iterdir()):
        raise SystemExit(f"{output.name} contains unrecognized files; move it aside before building the demo.")
    with tempfile.TemporaryDirectory(prefix=".demo-build-", dir=output.parent) as temporary:
        stage = Path(temporary)
        for name in files:
            target = stage / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(dist / name, target)
        # Both entry paths are in the same directory, so the unchanged demo's references still resolve.
        shutil.copy2(dist / "demo.html", stage / ("demo.html" if args.website else "index.html"))
        shutil.copy2(regular_file(ROOT, "LICENSE") if args.website else ROOT / "LICENSE", stage / "LICENSE")
        if contact:
            copy_site(site, stage, contact)
            check_site(stage)
        if args.website:
            copy_home(site, stage)
            check_website_pages(stage)
        (stage / ".nojekyll").write_text("")
        label = "Little Archive website and synthetic demo." if args.website else "Synthetic standalone demo."
        (stage / marker).write_text(f"{label} Generated by scripts/build_demo.py.\n")
        published = sorted(str(path.relative_to(stage)) for path in stage.rglob("*") if path.is_file())
        check_published(published, stage, WEBSITE_FIXED if args.website else allowed)
        if args.website:
            check_website_text(stage, published)
        if output.exists():
            shutil.rmtree(output)
        shutil.copytree(stage, output)
    if args.website:
        print(f"Built {output} ({len(published)} files). Website, synthetic demo and the plain pages only; no backend or credentials.")
    elif contact:
        print(f"Built {output} ({len(published)} files). Synthetic demo and the plain pages only; no backend or credentials.")
    else:
        print(f"The privacy, terms, support and account deletion pages were NOT published: contact_email in {site.name}/{SITE_SETTINGS} is empty. Set it and build again.")
        print(f"Built {output} ({len(published)} files). Synthetic demo only; no backend or credentials.")


if __name__ == "__main__":
    main()
