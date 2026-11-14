"""Checks for the installable phone app: manifest, icons, the share-target route, the import-token
Shortcut recipe, and the boundary that keeps all of it out of the public demo.

Fixtures are synthetic; every instance lives in a temporary directory.
"""
import ast
from html.parser import HTMLParser
import io
import json
from pathlib import Path
import re
import tempfile
import unittest

from fastapi.testclient import TestClient
from PIL import Image

from server.app import create_app
from server.config import Config


ROOT = Path(__file__).resolve().parents[1]
WEB = ROOT / "web"
PASSWORD = "test-owner-password-2026"
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


class InstallableAppTests(unittest.TestCase):
    def setUp(self):
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
        self.manifest = json.loads((WEB / "manifest.webmanifest").read_text(encoding="utf-8"))

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
        for header in ("content-security-policy", "x-content-type-options", "x-frame-options", "referrer-policy"):
            self.assertEqual(response.headers[header], home.headers[header], header)

    def test_manifest_describes_a_standalone_app_with_the_refreshed_colours(self):
        manifest = self.manifest
        self.assertEqual((manifest["name"], manifest["short_name"]), ("Little Archive", "Little Archive"))
        self.assertEqual(manifest["display"], "standalone")
        self.assertEqual((manifest["start_url"], manifest["scope"], manifest["id"]), ("/", "/", "/"))
        css = (WEB / "styles.css").read_text(encoding="utf-8")
        light_background = re.findall(r":root\s*\{[^}]*--bg:(#[0-9a-fA-F]{6})", css)[-1]
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
            self.assertEqual(alpha(WEB / name).getextrema(), (255, 255), name)
        # The ordinary icons keep their rounded tile: transparent corners, opaque centre.
        for name in ("icons/icon-192.png", "icons/icon-512.png"):
            channel = alpha(WEB / name)
            self.assertEqual(channel.getpixel((0, 0)), 0, name)
            self.assertEqual(channel.getpixel((channel.width // 2, channel.height // 2)), 255, name)
        with Image.open(WEB / "apple-touch-icon.png") as image:
            self.assertEqual(image.size, (180, 180))

    def test_index_links_the_manifest_and_the_touch_icon_and_stays_script_only_from_self(self):
        tags = head_tags(WEB / "index.html")
        links = {(attrs.get("rel"), attrs.get("href")): attrs for tag, attrs in tags if tag == "link"}
        self.assertIn(("manifest", "/manifest.webmanifest"), links)
        self.assertEqual(links[("apple-touch-icon", "/apple-touch-icon.png")]["sizes"], "180x180")
        theme = [attrs["content"] for tag, attrs in tags if tag == "meta" and attrs.get("name") == "theme-color"]
        self.assertEqual(theme, [self.manifest["theme_color"]])
        html = (WEB / "index.html").read_text(encoding="utf-8")
        # The policy allows only same-origin scripts, so the page must not need an inline one.
        self.assertEqual(re.findall(r"<script\b[^>]*>", html), ['<script type="module" src="/app.js">'])

    def test_share_route_serves_the_static_app_and_never_reads_or_echoes_the_query(self):
        hostile = "/share?title=%3Cb%3Ex&text=%3Cscript%3Ealert(1)%3C%2Fscript%3E&url=javascript%3Aalert(1)"
        response = self.anonymous.get(hostile)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["content-type"].split(";")[0], "text/html")
        self.assertEqual(response.content, (WEB / "index.html").read_bytes())
        self.assertNotIn(b"alert(1)", response.content)
        self.assertEqual(response.headers["content-security-policy"], self.anonymous.get("/").headers["content-security-policy"])
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
    """The public demo has no backend and must not advertise or depend on the phone-app files."""

    @staticmethod
    def demo_files():
        tree = ast.parse((ROOT / "scripts" / "build_demo.py").read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if isinstance(node, ast.Assign) and any(getattr(t, "id", "") == "files" for t in node.targets):
                return ast.literal_eval(node.value)
        raise AssertionError("scripts/build_demo.py no longer lists its files in a `files` variable.")

    def test_demo_scripts_only_import_files_the_demo_build_copies(self):
        shipped = set(self.demo_files())
        pending = ["demo.js"]
        while pending:
            name = pending.pop()
            source = (WEB / name).read_text(encoding="utf-8")
            for relative in re.findall(r"""(?:from\s+|import\s*\(\s*)['"]\./([^'"]+)['"]""", source):
                self.assertIn(relative, shipped, f"{name} imports ./{relative}, which scripts/build_demo.py does not copy; the demo would break.")
                if relative.endswith(".js") and relative not in pending and relative != name:
                    pending.append(relative)
            if len(pending) > 20:
                self.fail("Unexpected import cycle while checking the demo.")

    def test_demo_neither_links_nor_ships_the_manifest_icons_or_share_route(self):
        shipped = " ".join(self.demo_files())
        for needle in ("manifest", "icons", "apple-touch", "share"):
            self.assertNotIn(needle, shipped)
        links = [attrs.get("rel") for tag, attrs in head_tags(WEB / "demo.html") if tag == "link"]
        self.assertEqual(sorted(links), ["icon", "stylesheet"])
        workflow = (ROOT / ".github" / "workflows" / "demo-pages.yml").read_text(encoding="utf-8")
        for needle in ("manifest", "apple-touch", "/share", "icons/"):
            self.assertNotIn(needle, workflow)
        self.assertIn("IS_DEMO ? null : readShareTarget", (WEB / "app.js").read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
