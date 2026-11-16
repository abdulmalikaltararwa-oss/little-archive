"""Checks for the installable phone app: manifest, icons, the share-target route, the import-token
Shortcut recipe, and the boundary that keeps all of it out of the public demo.

The page, manifest and icons are the React interface's: its source files in ui/public and ui/index.html, and the
build the server actually serves (ui/dist, or webui in an image). Run `npm ci && npm run build` in ui/ first.

Fixtures are synthetic; every instance lives in a temporary directory.
"""
from html.parser import HTMLParser
import contextlib
import io
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import textwrap
import unittest
from unittest import mock

from fastapi.testclient import TestClient
from PIL import Image

from server import webui
from server.app import create_app
from server.config import Config


ROOT = Path(__file__).resolve().parents[1]
UI = ROOT / "ui"
PUBLIC = UI / "public"
PASSWORD = "test-owner-password-2026"
# The plain pages published beside the demo, and the only other files they load.
SITE_FILES = {"privacy.html", "terms.html", "support.html", "delete-account.html", "pages.css", "fonts/fraunces-soft.woff2"}
DEMO_ONLY = {"index.html", "theme-init.js", "icon.svg", "LICENSE", ".nojekyll", ".little-archive-demo-build"}
# An address for these checks only, at a name set aside for examples. The tracked web/site.json may not hold one like it.
CONTACT = "help@pages-check.example"
WITH_CONTACT = ["--contact-email", CONTACT]
TOKEN = "{{CONTACT_EMAIL}}"
ORIGIN = {"Origin": "http://testserver"}


class HeadTags(HTMLParser):
    def __init__(self):
        super().__init__()
        self.tags = []

    def handle_starttag(self, tag, attrs):
        if tag in {"link", "meta"}:
            self.tags.append((tag, dict(attrs)))


def head_tags(path):
    parser = HeadTags()
    parser.feed(path.read_text(encoding="utf-8"))
    return parser.tags


def policy_without_nonce(response):
    """The page's policy names a per-response nonce for styles; every other part is the same on every response."""
    return re.sub(r" 'nonce-[A-Za-z0-9_-]+'", "", response.headers["content-security-policy"])


class InstallableAppTests(unittest.TestCase):
    def setUp(self):
        self.build = webui.find_build()
        self.assertIsNotNone(self.build, webui.MISSING)
        self.temporary = tempfile.TemporaryDirectory(prefix="little-archive-phone-")
        config = Config(data_dir=Path(self.temporary.name) / "data", admin_password=PASSWORD, public_url="http://testserver", testing=True)
        self.app = create_app(config)
        self.anonymous = TestClient(self.app)
        self.anonymous.__enter__()
        self.owner = TestClient(self.app)
        self.owner.__enter__()
        login = self.owner.post("/api/auth/login", json={"password": PASSWORD}, headers=ORIGIN)
        self.assertEqual(login.status_code, 200, login.text)
        self.write_headers = {"X-CSRF-Token": login.json()["csrf_token"], **ORIGIN}
        self.manifest = json.loads((PUBLIC / "manifest.webmanifest").read_text(encoding="utf-8"))

    def tearDown(self):
        self.owner.__exit__(None, None, None)
        self.anonymous.__exit__(None, None, None)
        self.temporary.cleanup()

    def test_manifest_is_served_as_a_web_app_manifest_under_the_existing_policy(self):
        response = self.anonymous.get("/manifest.webmanifest")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["content-type"].split(";")[0], "application/manifest+json")
        self.assertEqual(response.json(), self.manifest)
        home = self.anonymous.get("/")
        for header in ("x-content-type-options", "x-frame-options", "referrer-policy"):
            self.assertEqual(response.headers[header], home.headers[header], header)
        # The page's policy adds its own nonce for styles; the rest is identical, and neither allows inline styles outright.
        self.assertEqual(response.headers["content-security-policy"], policy_without_nonce(home))
        self.assertNotIn("unsafe-inline", home.headers["content-security-policy"])

    def test_manifest_describes_a_standalone_app_with_the_refreshed_colours(self):
        manifest = self.manifest
        self.assertEqual((manifest["name"], manifest["short_name"]), ("Little Archive", "Little Archive"))
        self.assertEqual(manifest["display"], "standalone")
        self.assertEqual((manifest["start_url"], manifest["scope"], manifest["id"]), ("/", "/", "/"))
        tokens = (UI / "src" / "styles" / "tokens.css").read_text(encoding="utf-8")
        light_background = re.search(r":root\s*\{[^}]*?--paper:\s*(#[0-9a-fA-F]{6})", tokens, re.S).group(1)
        self.assertEqual(manifest["background_color"].lower(), light_background.lower())
        self.assertEqual(manifest["theme_color"].lower(), light_background.lower())
        wording = " ".join(str(manifest[key]) for key in ("name", "short_name", "description")).lower()
        for brand in ("instagram", "tiktok"):
            self.assertNotIn(brand, wording)

    def test_share_target_is_a_plain_get_that_the_server_routes_to_the_app(self):
        target = self.manifest["share_target"]
        self.assertEqual((target["action"], target["method"]), ("/share", "GET"))
        self.assertEqual(target["params"], {"title": "title", "text": "text", "url": "url"})
        # The action must be inside the app's scope for browsers to register it.
        self.assertTrue(target["action"].startswith(self.manifest["scope"]))

    def test_every_declared_icon_is_served_with_its_declared_type_and_size(self):
        seen = set()
        for icon in self.manifest["icons"]:
            response = self.anonymous.get(icon["src"])
            self.assertEqual(response.status_code, 200, icon["src"])
            self.assertEqual(response.headers["content-type"].split(";")[0], icon["type"], icon["src"])
            if icon["type"] == "image/png":
                with Image.open(io.BytesIO(response.content)) as image:
                    self.assertEqual(image.format, "PNG")
                    self.assertEqual(f"{image.width}x{image.height}", icon["sizes"], icon["src"])
            seen.add((icon["sizes"], icon["purpose"]))
        self.assertTrue({("192x192", "any"), ("512x512", "any"), ("512x512", "maskable")} <= seen)

    def test_icons_have_the_transparency_each_platform_needs(self):
        def alpha(path):
            with Image.open(path) as image:
                return image.convert("RGBA").getchannel("A")

        # iOS fills transparency with black and a mask crops a maskable icon: both must be full-bleed and opaque.
        for name in ("icons/icon-maskable-512.png", "apple-touch-icon.png"):
            self.assertEqual(alpha(PUBLIC / name).getextrema(), (255, 255), name)
        # The ordinary icons keep their rounded tile: transparent corners, opaque centre.
        for name in ("icons/icon-192.png", "icons/icon-512.png"):
            channel = alpha(PUBLIC / name)
            self.assertEqual(channel.getpixel((0, 0)), 0, name)
            self.assertEqual(channel.getpixel((channel.width // 2, channel.height // 2)), 255, name)
        with Image.open(PUBLIC / "apple-touch-icon.png") as image:
            self.assertEqual(image.size, (180, 180))

    def test_index_links_the_manifest_and_the_touch_icon_and_stays_script_only_from_self(self):
        for label, path in (("source", UI / "index.html"), ("build", self.build / "index.html")):
            with self.subTest(page=label):
                tags = head_tags(path)
                links = {(attrs.get("rel"), attrs.get("href")): attrs for tag, attrs in tags if tag == "link"}
                self.assertIn(("manifest", "./manifest.webmanifest"), links)
                self.assertEqual(links[("apple-touch-icon", "./apple-touch-icon.png")]["sizes"], "180x180")
                theme = [attrs["content"] for tag, attrs in tags if tag == "meta" and attrs.get("name") == "theme-color"]
                self.assertEqual(theme, [self.manifest["theme_color"]])
                html = path.read_text(encoding="utf-8")
                # The policy allows only same-origin scripts, and styles only from the page's own files and its nonce:
                # no inline script, no inline <style>, and no style attributes in the markup.
                self.assertEqual([tag for tag in re.findall(r"<script\b[^>]*>", html) if " src=" not in tag], [])
                self.assertNotRegex(html, r"<style\b")
                self.assertNotRegex(html, r"\sstyle=")

    def test_the_served_page_is_the_build_with_this_responses_nonce_and_the_share_route_never_echoes_the_query(self):
        hostile = "/share?title=%3Cb%3Ex&text=%3Cscript%3Ealert(1)%3C%2Fscript%3E&url=javascript%3Aalert(1)"
        response = self.anonymous.get(hostile)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["content-type"].split(";")[0], "text/html")
        built = (self.build / "index.html").read_text(encoding="utf-8")
        nonce = re.search(r'<meta property="csp-nonce" nonce="([A-Za-z0-9_-]+)">', response.text).group(1)
        self.assertEqual(response.text.replace(f'<meta property="csp-nonce" nonce="{nonce}">', "", 1), built)
        self.assertIn(f"style-src 'self' 'nonce-{nonce}'", response.headers["content-security-policy"])
        self.assertNotIn("alert(1)", response.text)
        self.assertEqual(policy_without_nonce(response), policy_without_nonce(self.anonymous.get("/")))
        self.assertEqual(self.anonymous.head("/share?url=https%3A%2F%2Fexample.com%2F").status_code, 200)

    def test_a_share_link_never_saves_anything_even_for_a_signed_in_owner(self):
        before = self.owner.get("/api/items").json()["total"]
        for query in ("url=https%3A%2F%2Fexample.com%2Fpasta", "text=https%3A%2F%2Fwww.instagram.com%2Freel%2FSYNTH1%2F&title=Hi", "url=javascript%3Aalert(1)"):
            self.assertEqual(self.owner.get("/share?" + query).status_code, 200)
            self.assertEqual(self.owner.get("/share?" + query, headers={"Origin": "https://unrelated.example", "Sec-Fetch-Site": "cross-site"}).status_code, 200)
        self.assertEqual(self.owner.get("/api/items").json()["total"], before)
        # There is no write surface on the share route itself.
        self.assertEqual(self.owner.post("/share?url=https%3A%2F%2Fexample.com%2F", headers=self.write_headers).status_code, 405)
        self.assertEqual(self.owner.get("/api/items").json()["total"], before)
        # Saving still needs the owner's session and CSRF token.
        self.assertEqual(self.anonymous.post("/api/items", json={"url": "https://example.com/pasta"}, headers=ORIGIN).status_code, 401)

    def test_shortcut_recipe_saves_an_instagram_link_with_only_an_import_token(self):
        created = self.owner.post("/api/extension/tokens", json={"name": "Phone shortcut"}, headers=self.write_headers)
        self.assertEqual(created.status_code, 200, created.text)
        bearer = {"Authorization": "Bearer " + created.json()["token"]}
        # The Shortcut is a native client: no cookie, no Origin header, no CSRF token.
        shortcut = TestClient(self.app)
        with shortcut:
            started = shortcut.post("/api/extension/imports", json={"platform": "instagram", "source_account": "iphone", "scope": "Share sheet"}, headers=bearer)
            self.assertEqual(started.status_code, 200, started.text)
            run = started.json()["run_id"]
            batch = {"batch_id": "20261114101500123", "sequence": 0, "items": [{"url": "https://www.instagram.com/reel/SYNTHrecipe1/?igsh=tracking", "title": "Shared from an iPhone shortcut (synthetic)"}]}
            applied = shortcut.post(f"/api/extension/imports/{run}/batches", json=batch, headers=bearer)
            self.assertEqual((applied.status_code, applied.json()["created"]), (200, 1), applied.text)
            finished = shortcut.post(f"/api/extension/imports/{run}/finish", json={"expected_batches": 1, "coverage": "partial"}, headers=bearer)
            self.assertEqual(finished.status_code, 200, finished.text)
            items = self.owner.get("/api/items", params={"q": "iPhone shortcut"}).json()["items"]
            self.assertEqual([(i["platform"], i["url"], i["source_account"]) for i in items], [("instagram", "https://www.instagram.com/p/SYNTHrecipe1/", "iphone")])
            # Each share is one finished import run, visible under Import activity.
            runs = self.owner.get("/api/imports").json()["imports"]
            self.assertEqual([(r["source"], r["source_account"], r["status"], r["created"], r["scopes"]) for r in runs], [("instagram", "iphone", "completed", 1, ["Share sheet"])])
            # What the recipe's documentation promises it cannot do.
            second = shortcut.post("/api/extension/imports", json={"platform": "instagram", "source_account": "iphone", "scope": "Share sheet"}, headers=bearer).json()["run_id"]
            limits = (("https://example.com/a-page", "does not match the import platform"), ("https://www.tiktok.com/@someone/video/7000000000000000000", "does not match the import platform"), ("https://vm.tiktok.com/ZMsynthetic/", "TikTok short link"))
            for number, (url, message) in enumerate(limits):
                rejected = shortcut.post(f"/api/extension/imports/{second}/batches", json={"batch_id": f"limit-{number}", "sequence": 0, "items": [{"url": url}]}, headers=bearer)
                self.assertEqual(rejected.status_code, 400, url)
                self.assertIn(message, rejected.json()["detail"])
            self.assertEqual(shortcut.post("/api/items", json={"url": "https://example.com/a"}, headers=bearer).status_code, 401)
            self.assertEqual(shortcut.get("/api/items", headers=bearer).status_code, 401)
            # The same three requests with platform "tiktok" save a full TikTok link.
            tiktok = shortcut.post("/api/extension/imports", json={"platform": "tiktok", "source_account": "iphone", "scope": "Share sheet"}, headers=bearer).json()["run_id"]
            video = {"batch_id": "20261114101600456", "sequence": 0, "items": [{"url": "https://www.tiktok.com/@someone/video/7000000000000000000"}]}
            self.assertEqual(shortcut.post(f"/api/extension/imports/{tiktok}/batches", json=video, headers=bearer).json()["created"], 1)
            self.assertEqual(shortcut.post(f"/api/extension/imports/{tiktok}/finish", json={"expected_batches": 1, "coverage": "partial"}, headers=bearer).status_code, 200)
            # A missing, wrong or revoked token is refused.
            self.assertEqual(shortcut.post("/api/extension/imports", json={"platform": "instagram", "source_account": "iphone", "scope": "x"}).status_code, 401)
            self.assertEqual(shortcut.post("/api/extension/imports", json={"platform": "instagram", "source_account": "iphone", "scope": "x"}, headers={"Authorization": "Bearer la_not-a-real-token"}).status_code, 401)
            self.assertEqual(self.owner.delete(f"/api/extension/tokens/{created.json()['id']}", headers=self.write_headers).status_code, 200)
            self.assertEqual(shortcut.post("/api/extension/imports", json={"platform": "instagram", "source_account": "iphone", "scope": "x"}, headers=bearer).status_code, 401)
        self.assertEqual(self.owner.get("/api/items").json()["total"], 2)

    def test_phone_guide_names_the_endpoints_the_recipe_relies_on(self):
        guide = (ROOT / "docs" / "phone.md").read_text(encoding="utf-8")
        for needle in ("/api/extension/imports", "/batches", "/finish", "Authorization: Bearer", "/share?url=", '"expected_batches":1', '"sequence":0'):
            self.assertIn(needle, guide)


class DemoBoundaryTests(unittest.TestCase):
    """The public demo has no backend and must not advertise or depend on the phone-app files.

    scripts/build_demo.py works out the demo's files from the page and the build's manifest. The logic is tested on a
    small synthetic build; the last tests run it on the real one. The same site carries the plain pages from web/
    (privacy, terms, support, account deletion): fixed names, with the contact address from web/site.json written in.
    While that address is empty the pages are not published at all."""

    def setUp(self):
        from scripts import build_demo
        self.build = build_demo
        self.temporary = tempfile.TemporaryDirectory(prefix="little-archive-demo-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.dist = self.root / "dist"
        self.out = self.root / "out"

    def make_dist(self, page=None, manifest=None, extra=()):
        """A build shaped like Vite's: hashed files, a manifest keyed by source file, and both pages sharing one bundle."""
        (self.dist / "assets").mkdir(parents=True)
        (self.dist / ".vite").mkdir()
        (self.dist / "icons").mkdir()
        files = {
            "assets/main-AAAAAAAA.js": "import './shared-BBBBBBBB.js';", "assets/shared-BBBBBBBB.js": "export {};",
            "assets/screen-CCCCCCCC.js": "export {};", "assets/demo-DDDDDDDD.js": "export {};", "assets/main-EEEEEEEE.css": "body{}",
            "assets/face-FFFFFFFF.woff2": "font", "assets/001-GGGGGGGG.webp": "image", "assets/orphan-HHHHHHHH.js": "export {};",
            "theme-init.js": "// theme", "icon.svg": "<svg/>", "index.html": "<!doctype html><title>app</title>",
            "manifest.webmanifest": "{}", "apple-touch-icon.png": "png", "icons/icon-192.png": "png",
        }
        for name, text in dict(files, **dict(extra)).items():
            (self.dist / name).write_text(text)
        (self.dist / "demo.html").write_text(page or (
            '<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="connect-src \'none\'">'
            '<link rel="icon" href="./icon.svg"><script src="./theme-init.js"></script>'
            '<script type="module" src="./assets/main-AAAAAAAA.js"></script><script type="module" src="./assets/shared-BBBBBBBB.js"></script>'
            '<link rel="stylesheet" href="./assets/main-EEEEEEEE.css"></head><body><img src="./icon.svg"></body></html>'))
        (self.dist / ".vite" / "manifest.json").write_text(json.dumps(manifest or {
            "src/main.tsx": {"file": "assets/main-AAAAAAAA.js", "imports": ["_shared"], "dynamicImports": ["src/screen.tsx", "src/demo.ts"], "css": ["assets/main-EEEEEEEE.css"]},
            "_shared": {"file": "assets/shared-BBBBBBBB.js"},
            "src/screen.tsx": {"file": "assets/screen-CCCCCCCC.js", "assets": ["assets/face-FFFFFFFF.woff2"]},
            "src/demo.ts": {"file": "assets/demo-DDDDDDDD.js", "assets": ["assets/001-GGGGGGGG.webp"]},
        }))

    def published(self):
        return {str(path.relative_to(self.out)) for path in self.out.rglob("*") if path.is_file()}

    def make_site(self):
        return self.make_site_at("site")

    def make_site_at(self, folder):
        """A copy of the plain pages that a test may spoil."""
        site = self.root / folder
        for name in SITE_FILES | {"site.json"}:
            (site / name).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(ROOT / "web" / name, site / name)
        return site

    def set_contact(self, site, address):
        (site / "site.json").write_text(json.dumps({"contact_email": address}), encoding="utf-8")

    def workflow_check(self, folder, contact=""):
        """Run the publishing workflow's own check of the artifact, as written in the workflow, on `folder`, beside a
        web/site.json that holds `contact` (the workflow reads the tracked one from the repository's root)."""
        (folder.parent / "web").mkdir(exist_ok=True)
        self.set_contact(folder.parent / "web", contact)
        workflow = (ROOT / ".github" / "workflows" / "demo-pages.yml").read_text(encoding="utf-8")
        script = re.search(r"python - <<'PY'\n(.*?)\n\s*PY\n", workflow, re.S).group(1)
        self.assertEqual(folder.name, "dist-demo", "the workflow checks a folder of this name")
        return subprocess.run([sys.executable, "-I", "-c", textwrap.dedent(script)], cwd=folder.parent, capture_output=True, text=True)

    def test_the_demo_is_the_demo_page_and_exactly_the_files_it_can_load(self):
        self.make_dist()
        self.build.main(["--dist", str(self.dist), "--output", str(self.out)])
        self.assertEqual(self.published(), {
            "index.html", "theme-init.js", "icon.svg", "LICENSE", ".nojekyll", ".little-archive-demo-build",
            "assets/main-AAAAAAAA.js", "assets/shared-BBBBBBBB.js", "assets/screen-CCCCCCCC.js", "assets/demo-DDDDDDDD.js",
            "assets/main-EEEEEEEE.css", "assets/face-FFFFFFFF.woff2", "assets/001-GGGGGGGG.webp",
        } | (SITE_FILES if self.build.site_contact(ROOT / "web") else set()))
        self.assertEqual((self.out / "index.html").read_bytes(), (self.dist / "demo.html").read_bytes())
        self.assertEqual((self.out / "LICENSE").read_bytes(), (ROOT / "LICENSE").read_bytes())
        self.assertFalse(any(path.is_symlink() for path in self.out.rglob("*")))

    def test_the_tracked_contact_address_is_unset_or_real_and_the_pages_hold_only_the_token(self):
        settings = json.loads((ROOT / "web" / "site.json").read_text(encoding="utf-8"))
        self.assertEqual(list(settings), ["contact_email"])
        self.assertEqual(self.build.site_contact(ROOT / "web"), settings["contact_email"].strip(), "empty, or an address the build accepts")
        for name in self.build.SITE_PAGES:
            text = (ROOT / "web" / name).read_text(encoding="utf-8")
            self.assertEqual(text.count(TOKEN), 1, name)
            self.assertNotIn("[owner to set]", text, name)
            self.assertNotRegex(text.replace(TOKEN, ""), r"\{\{|\}\}|[\w.+-]+@[\w-]+\.[\w.-]+", f"{name} names no address of its own")

    def test_with_no_contact_address_the_pages_are_not_published_and_the_demo_still_builds(self):
        self.make_dist()
        site = self.make_site()
        self.set_contact(site, "")
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            self.build.main(["--dist", str(self.dist), "--output", str(self.out), "--site", str(site)])
        self.assertFalse(SITE_FILES & self.published())
        self.assertEqual({str(path.relative_to(self.out)) for path in self.out.rglob("*") if path.is_dir()}, {"assets"})
        self.assertEqual({name for name in self.published() if not name.startswith("assets/")}, DEMO_ONLY)
        self.assertEqual(output.getvalue().count("NOT published"), 1)
        self.assertIn("contact_email in site/site.json is empty", output.getvalue())
        # Without the address the pages are not read at all, so a fault in one cannot stop the demo.
        (site / "privacy.html").unlink()
        self.build.main(["--dist", str(self.dist), "--output", str(self.out), "--site", str(site)])
        self.assertIn("index.html", self.published())

    def test_with_a_contact_address_the_pages_are_published_with_it_written_in(self):
        self.make_dist()
        for source in ("flag", "file"):
            with self.subTest(source=source):
                site = self.make_site_at(f"site-{source}")
                address = CONTACT if source == "flag" else "hello@pages-check.example"
                self.set_contact(site, "" if source == "flag" else address)
                # The tracked file may not hold an address at an example name; for this check alone that rule is lifted.
                with mock.patch.object(self.build, "RESERVED_DOMAIN", re.compile(r"(?!)")):
                    self.build.main(["--dist", str(self.dist), "--output", str(self.out), "--site", str(site)] + (WITH_CONTACT if source == "flag" else []))
                self.assertLessEqual(SITE_FILES, self.published())
                self.assertNotIn("site.json", self.published())
                self.assertEqual({str(path.relative_to(self.out)) for path in self.out.rglob("*") if path.is_dir()}, {"assets", "fonts"})
                for name in SITE_FILES:
                    written, original = (self.out / name).read_bytes(), (ROOT / "web" / name).read_bytes()
                    if not name.endswith(".html"):
                        self.assertEqual(written, original, name)
                        continue
                    self.assertEqual(written, original.replace(TOKEN.encode(), address.encode()), name)
                    text = written.decode()
                    self.assertEqual(text.count(address), 1, name)
                    for left in ("{{", "}}", "[owner to set]"):
                        self.assertNotIn(left, text, name)

    def test_a_contact_address_that_is_not_one_stops_the_build(self):
        self.make_dist()
        shapes = ("support@[owner to set]", "support", "a b@pages-check.example", "a@b", "<b>@pages-check.example", "a@pages-check.example\nb@pages-check.example",
                  "a..b@pages-check.example", "{{CONTACT_EMAIL}}")
        reserved = ("x@example.com", "x@mail.example", "x@host.test", "x@thing.invalid", CONTACT)
        for number, address in enumerate(shapes + reserved):
            with self.subTest(address=address):
                site = self.make_site_at(f"bad-{number}")
                self.set_contact(site, address)
                # A badly shaped address is refused for its shape, so the rule about example names is lifted while those are tried.
                lifted = re.compile(r"(?!)") if address in shapes else self.build.RESERVED_DOMAIN
                with mock.patch.object(self.build, "RESERVED_DOMAIN", lifted), self.assertRaises(SystemExit) as stopped:
                    self.build.main(["--dist", str(self.dist), "--output", str(self.out), "--site", str(site)])
                self.assertIn("is not an email address" if address in shapes else "reserved for examples", str(stopped.exception))
        for number, text in enumerate(("", "[]", '{"contact_email": 5}', '{"contact_email": "", "other": 1}', "{}")):
            with self.subTest(text=text):
                site = self.make_site_at(f"shape-{number}")
                (site / "site.json").write_text(text)
                with self.assertRaises(SystemExit) as stopped:
                    self.build.main(["--dist", str(self.dist), "--output", str(self.out), "--site", str(site)])
                self.assertIn("site.json", str(stopped.exception))
        site = self.make_site_at("no-settings")
        (site / "site.json").unlink()
        with self.assertRaises(SystemExit):
            self.build.main(["--dist", str(self.dist), "--output", str(self.out), "--site", str(site)])
        (site / "site.json").symlink_to(ROOT / "web" / "site.json")
        with self.assertRaises(SystemExit):
            self.build.main(["--dist", str(self.dist), "--output", str(self.out), "--site", str(site)])
        self.assertFalse(self.out.exists())

    def test_a_page_that_would_ship_something_unfilled_stops_the_build(self):
        self.make_dist()
        cases = (("privacy.html", TOKEN, "support@[owner to set]"), ("terms.html", TOKEN, "the address"), ("support.html", "<h1>", "<h1>{{SITE_NAME}} "),
                 ("delete-account.html", "<h1>", "<h1>[owner to set] "))
        for name, old, new in cases:
            with self.subTest(name=name, new=new):
                site = self.make_site()
                text = (site / name).read_text(encoding="utf-8")
                self.assertIn(old, text)
                (site / name).write_text(text.replace(old, new, 1), encoding="utf-8")
                with self.assertRaises(SystemExit) as stopped:
                    self.build.main(["--dist", str(self.dist), "--output", str(self.out), "--site", str(site)] + WITH_CONTACT)
                self.assertIn(name, str(stopped.exception))
                shutil.rmtree(site)
        self.assertFalse(self.out.exists())

    def test_files_the_page_does_not_load_stay_behind(self):
        self.make_dist()
        self.build.main(["--dist", str(self.dist), "--output", str(self.out)])
        for name in ("assets/orphan-HHHHHHHH.js", "manifest.webmanifest", "apple-touch-icon.png", "icons/icon-192.png", ".vite/manifest.json", "demo.html"):
            self.assertNotIn(name, self.published(), name)

    def test_the_demo_ships_nothing_that_belongs_to_the_installable_app(self):
        self.make_dist()
        self.build.main(["--dist", str(self.dist), "--output", str(self.out)])
        self.assertFalse([name for name in self.published() if re.search(r"(?:^|/)(?:manifest[.-]|apple-touch|icons/|share[.-])", name, re.I)])
        self.assertIn("assets/shared-BBBBBBBB.js", self.published(), "a chunk that is merely called shared is an ordinary file")

    def test_a_file_the_demo_may_not_publish_stops_the_build_even_when_the_page_loads_it(self):
        for number, name in enumerate(("assets/main-AAAAAAAA.js.map", "assets/notes-IIIIIIII.json", "assets/leak.env", "assets/share-JJJJJJJJ.js")):
            with self.subTest(name=name):
                self.dist, out = self.root / f"case-{number}", self.root / f"case-out-{number}"
                self.make_dist(extra={name: "x"}, manifest={"src/main.tsx": {"file": "assets/main-AAAAAAAA.js", "assets": [name]}})
                with self.assertRaises(SystemExit) as stopped:
                    self.build.main(["--dist", str(self.dist), "--output", str(out)])
                self.assertIn("demo", str(stopped.exception).lower())
                self.assertFalse(out.exists())

    def test_a_page_that_reaches_outside_its_own_files_stops_the_build(self):
        for number, reference in enumerate(("https://cdn.example.com/x.js", "//cdn.example.com/x.js", "/assets/main-AAAAAAAA.js", "./../secret.js", "data:text/javascript,1")):
            with self.subTest(reference=reference):
                self.dist = self.root / f"page-{number}"
                self.make_dist(page=f'<!doctype html><script src="{reference}"></script>')
                with self.assertRaises(SystemExit):
                    self.build.main(["--dist", str(self.dist), "--output", str(self.out)])
        self.assertFalse(self.out.exists())

    def test_a_symbolic_link_in_the_build_stops_the_build(self):
        self.make_dist()
        (self.dist / "assets" / "main-AAAAAAAA.js").unlink()
        (self.dist / "assets" / "main-AAAAAAAA.js").symlink_to(self.root / "elsewhere.js")
        (self.root / "elsewhere.js").write_text("export {};")
        with self.assertRaises(SystemExit):
            self.build.main(["--dist", str(self.dist), "--output", str(self.out)])

    def test_the_plain_pages_are_a_fixed_list_and_nothing_else_in_web_is_published(self):
        self.assertEqual(set(self.build.SITE_FILES), SITE_FILES)
        self.assertEqual(set(self.build.SITE_PAGES), {name for name in SITE_FILES if name.endswith(".html")})
        self.assertLessEqual(SITE_FILES, self.build.FIXED)
        self.assertEqual(self.build.DEMO_FIXED, DEMO_ONLY)
        self.assertNotIn("site.json", self.build.FIXED)
        self.make_dist()
        site = self.make_site()
        for name in ("notes.html", "fonts/Fraunces-OFL.txt", "fonts/other.woff2", "demo-data.js", "manifest.webmanifest"):
            (site / name).write_text("x")
        self.build.main(["--dist", str(self.dist), "--output", str(self.out), "--site", str(site)] + WITH_CONTACT)
        self.assertEqual({name for name in self.published() if not name.startswith("assets/")}, DEMO_ONLY | SITE_FILES)

    def test_a_plain_page_that_is_missing_or_a_link_stops_the_build(self):
        self.make_dist()
        elsewhere = self.root / "elsewhere.html"
        elsewhere.write_text((ROOT / "web" / "privacy.html").read_text(encoding="utf-8"), encoding="utf-8")
        for name in sorted(SITE_FILES):
            for spoil in ("missing", "link"):
                with self.subTest(name=name, spoil=spoil):
                    site = self.make_site()
                    (site / name).unlink()
                    if spoil == "link":
                        (site / name).symlink_to(elsewhere)
                    with self.assertRaises(SystemExit) as stopped:
                        self.build.main(["--dist", str(self.dist), "--output", str(self.out), "--site", str(site)] + WITH_CONTACT)
                    self.assertIn(name, str(stopped.exception))
                    shutil.rmtree(site)
        # A folder that is a link is refused too, whether it is the font folder or the pages' folder itself.
        site = self.make_site()
        (site / "fonts").rename(self.root / "real-fonts")
        (site / "fonts").symlink_to(self.root / "real-fonts", target_is_directory=True)
        with self.assertRaises(SystemExit):
            self.build.main(["--dist", str(self.dist), "--output", str(self.out), "--site", str(site)] + WITH_CONTACT)
        (self.root / "linked-site").symlink_to(self.make_site_at("real-site"), target_is_directory=True)
        for flags in (WITH_CONTACT, []):  # refused when the address would come from the linked folder's own site.json too
            with self.assertRaises(SystemExit):
                self.build.main(["--dist", str(self.dist), "--output", str(self.out), "--site", str(self.root / "linked-site")] + flags)
        self.build.main(["--dist", str(self.dist), "--output", str(self.out), "--site", str(self.root / "real-site")] + WITH_CONTACT)
        self.assertLessEqual(SITE_FILES, self.published())

    def test_a_plain_page_that_names_a_file_the_site_does_not_publish_stops_the_build(self):
        self.make_dist()
        cases = (
            ("privacy.html", '<link rel="stylesheet" href="./pages.css">', '<link rel="stylesheet" href="./other.css">'),
            ("terms.html", '<img src="./icon.svg"', '<img src="./icons/icon-192.png"'),
            ("support.html", '<link rel="stylesheet" href="./pages.css">', '<link rel="stylesheet" href="./pages.css"><script src="./theme-init.js"></script>'),
            ("support.html", 'href="./terms.html#refunds"', 'href="./pricing.html"'),
            ("delete-account.html", 'href="./privacy.html"', 'href="/privacy.html"'),
            ("delete-account.html", '<img src="./icon.svg"', '<img src="https://cdn.example.com/icon.svg"'),
            ("pages.css", "url('./fonts/fraunces-soft.woff2')", "url('./fonts/other.woff2')"),
            ("pages.css", "@font-face", "@import './more.css';\n@font-face"),
        )
        for name, old, new in cases:
            with self.subTest(name=name, new=new):
                site = self.make_site()
                text = (site / name).read_text(encoding="utf-8")
                self.assertIn(old, text)
                (site / name).write_text(text.replace(old, new), encoding="utf-8")
                with self.assertRaises(SystemExit) as stopped:
                    self.build.main(["--dist", str(self.dist), "--output", str(self.out), "--site", str(site)] + WITH_CONTACT)
                self.assertIn(name, str(stopped.exception))
                shutil.rmtree(site)
        self.assertFalse(self.out.exists())

    def test_a_missing_build_says_how_to_make_one(self):
        with self.assertRaises(SystemExit) as stopped:
            self.build.main(["--dist", str(self.dist), "--output", str(self.out)])
        self.assertIn("npm ci && npm run build", str(stopped.exception))

    def test_a_folder_that_is_not_a_demo_build_is_not_replaced(self):
        self.make_dist()
        self.out.mkdir()
        (self.out / "precious.txt").write_text("keep")
        with self.assertRaises(SystemExit):
            self.build.main(["--dist", str(self.dist), "--output", str(self.out)])
        self.assertEqual((self.out / "precious.txt").read_text(), "keep")

    def test_rebuilding_replaces_a_previous_demo(self):
        self.make_dist()
        self.build.main(["--dist", str(self.dist), "--output", str(self.out)])
        (self.out / "stale.txt").write_text("old")
        self.build.main(["--dist", str(self.dist), "--output", str(self.out)])
        self.assertNotIn("stale.txt", self.published())

    def test_demo_page_source_links_no_manifest_and_forbids_every_connection(self):
        tags = head_tags(UI / "demo.html")
        self.assertEqual(sorted(attrs.get("rel") for tag, attrs in tags if tag == "link"), ["icon"])
        policy = next(attrs["content"] for tag, attrs in tags if tag == "meta" and attrs.get("http-equiv") == "Content-Security-Policy")
        for part in ("default-src 'self'", "script-src 'self'", "connect-src 'none'", "img-src 'self'", "form-action 'none'", "object-src 'none'"):
            self.assertIn(part, policy)
        workflow = (ROOT / ".github" / "workflows" / "demo-pages.yml").read_text(encoding="utf-8")
        self.assertEqual(re.findall(r"^\s+path: (.+)$", workflow, re.M), ["dist-demo"], "only the demo folder is uploaded")
        self.assertIn("python scripts/build_demo.py", workflow)

    def test_the_real_build_makes_a_demo_that_passes_the_same_rules(self):
        build = webui.find_build()
        self.assertIsNotNone(build, webui.MISSING)
        self.assertTrue((build / "demo.html").is_file() and (build / ".vite" / "manifest.json").is_file(), "ui/dist must be a full build, not the packaged copy")
        # As the repository stands (whatever web/site.json holds), then with an address, which publishes the pages.
        self.build.main(["--dist", str(build), "--output", str(self.out)])
        if not self.build.site_contact(ROOT / "web"):
            self.assertEqual({name for name in self.published() if not name.startswith("assets/")}, DEMO_ONLY)
            self.assertEqual(sum(name.endswith(".webp") for name in self.published()), 60)
        self.build.main(["--dist", str(build), "--output", str(self.out)] + WITH_CONTACT)
        names = self.published()
        self.assertEqual(sum(name.endswith(".webp") for name in names), 60)
        self.assertFalse([name for name in names if re.search(r"(?:^|/)(?:manifest[.-]|apple-touch|icons/|share[.-])|\.map$|\.json$", name, re.I)])
        page = (self.out / "index.html").read_text(encoding="utf-8")
        self.assertIn("connect-src 'none'", page)
        self.assertNotRegex(page, r'rel="(?:manifest|apple-touch-icon)"')
        # Every file the page names is in the folder, so the demo is complete on a static host.
        for reference in re.findall(r'(?:src|href)="\./([^"]+)"', page):
            self.assertIn(reference, names)
        # The plain pages are there under the names the apps link to, with everything they load or link to.
        self.assertLessEqual(SITE_FILES, names)
        self.assertEqual({name for name in names if "/" not in name}, DEMO_ONLY | {name for name in SITE_FILES if "/" not in name})
        self.assertEqual({name for name in names if name.startswith("fonts/")}, {"fonts/fraunces-soft.woff2"})
        for name in sorted(name for name in SITE_FILES if name.endswith(".html")):
            text = (self.out / name).read_text(encoding="utf-8")
            self.assertEqual(text.count(CONTACT), 1, name)
            self.assertNotRegex(text, r"\{\{|\}\}|\[owner to set\]", name)
            for reference in re.findall(r'(?:src|href)="(\.?/?[^"#:]*)(?:#[^"]*)?"', text):
                if reference in ("", "./"):
                    continue
                self.assertRegex(reference, r"^\./[a-z0-9.-]+$", f"{name}: {reference} is relative, so it works under any site path")
                self.assertIn(reference[2:], names, f"{name}: {reference}")
        self.assertIn("fonts/fraunces-soft.woff2", (self.out / "pages.css").read_text(encoding="utf-8"))

    def test_the_publishing_workflow_accepts_the_real_demo_and_refuses_anything_added_to_it(self):
        build = webui.find_build()
        self.assertIsNotNone(build, webui.MISSING)
        self.out = self.root / "dist-demo"
        site = self.make_site()
        self.set_contact(site, "")
        with_pages = self.root / "with-pages" / "dist-demo"
        with_pages.parent.mkdir()
        self.build.main(["--dist", str(build), "--output", str(with_pages), "--site", str(site)] + WITH_CONTACT)

        # No address: the artifact is the demo alone, and the pages may not be in it in any form.
        self.build.main(["--dist", str(build), "--output", str(self.out), "--site", str(site)])
        passed = self.workflow_check(self.out)
        self.assertEqual(passed.returncode, 0, passed.stderr)
        self.assertIn("Verified the synthetic demo artifact", passed.stdout)
        self.assertIn("are not published: contact_email in web/site.json is empty", passed.stdout)
        state = {"contact": ""}

        def refused(spoil, expected):
            copy = self.root / "spoiled" / "dist-demo"
            shutil.copytree(self.out, copy)
            spoil(copy)
            result = self.workflow_check(copy, state["contact"])
            self.assertNotEqual(result.returncode, 0, expected)
            self.assertIn(expected, result.stderr)
            shutil.rmtree(copy.parent)

        def append(name, text):
            return lambda copy: (copy / name).write_text((copy / name).read_text(encoding="utf-8") + text, encoding="utf-8")

        def replace(name, old, new):
            def spoil(copy):
                text = (copy / name).read_text(encoding="utf-8")
                self.assertIn(old, text)
                (copy / name).write_text(text.replace(old, new), encoding="utf-8")
            return spoil

        for name in sorted(name for name in SITE_FILES if "/" not in name):
            refused(lambda copy, name=name: shutil.copy2(with_pages / name, copy / name), "Unexpected demo artifact files")
        refused(lambda copy: shutil.copytree(with_pages / "fonts", copy / "fonts"), "Unexpected demo artifact folders")
        refused(lambda copy: (copy / "site.json").write_text("{}"), "Unexpected demo artifact files")
        unset_but_published = self.workflow_check(with_pages, "")
        self.assertNotEqual(unset_but_published.returncode, 0, "pages in the artifact while no address is set")
        for address in ("support@[owner to set]", "not an address"):
            self.assertIn("is not an email address", self.workflow_check(with_pages, address).stderr)

        # An address: the artifact is the demo and the pages, each naming that address once and nothing unfilled.
        set_but_absent = self.workflow_check(self.out, CONTACT)
        self.assertIn("Unexpected demo artifact folders", set_but_absent.stderr)
        shutil.rmtree(self.out)
        shutil.copytree(with_pages, self.out)
        state["contact"] = CONTACT
        passed = self.workflow_check(self.out, CONTACT)
        self.assertEqual(passed.returncode, 0, passed.stderr)
        self.assertNotIn("not published", passed.stdout)
        self.assertIn("must name the contact address once", self.workflow_check(self.out, "someone-else@pages-check.example").stderr)
        for name in ("privacy.html", "terms.html", "support.html", "delete-account.html"):
            refused(replace(name, CONTACT, TOKEN), "must name the contact address once")
            refused(replace(name, CONTACT, "support@[owner to set]"), "must name the contact address once")
            refused(append(name, f"<p>{CONTACT}</p>"), "must name the contact address once")
        refused(lambda copy: shutil.copy2(ROOT / "web" / "fonts" / "Fraunces-OFL.txt", copy / "fonts" / "Fraunces-OFL.txt"), "Unexpected demo artifact files")
        refused(lambda copy: (copy / "notes.html").write_text("x"), "Unexpected demo artifact files")
        refused(lambda copy: (copy / "pages").mkdir(), "Unexpected demo artifact folders")
        refused(lambda copy: (copy / "support.html").unlink(), "Missing demo artifact files")
        refused(lambda copy: shutil.rmtree(copy / "fonts"), "Unexpected demo artifact folders")
        refused(lambda copy: ((copy / "terms.html").unlink(), (copy / "terms.html").symlink_to(copy / "privacy.html")), "symbolic links")
        for name in ("privacy.html", "delete-account.html", "pages.css"):
            for needle in ("LA_ADMIN_PASSWORD", "BEGIN PRIVATE KEY", "secrets.env"):
                refused(append(name, f"\n<!-- /* {needle} */ -->\n"), f"mentions {needle}")
        refused(append("privacy.html", '<script src="./theme-init.js"></script>'), "must be a plain page")
        refused(replace("terms.html", '<img src="./icon.svg"', '<img src="./assets/x.webp"'), "terms.html loads")
        refused(replace("support.html", 'href="./terms.html#refunds"', 'href="./pricing.html"'), "support.html links to")
        refused(replace("pages.css", "./fonts/fraunces-soft.woff2", "./fonts/other.woff2"), "pages.css must load only its own font file")


if __name__ == "__main__":
    unittest.main()
