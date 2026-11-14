"""How the server finds and serves the built interface (server/webui.py).

These tests use a small synthetic build in a temporary folder, so they need no Node and cannot be broken by a
change to the interface itself. The real build is checked in test_installable_app.py.
"""
from pathlib import Path
import re
import tempfile
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from server import webui
from server.app import create_app
from server.config import Config


INDEX = '<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="utf-8">\n    <script src="./theme-init.js"></script>\n  </head>\n  <body><div id="app"></div></body>\n</html>\n'
NONCE = re.compile(r'<meta property="csp-nonce" nonce="([A-Za-z0-9_-]{16,})">')
PASSWORD = "test-owner-password-2026"


def write_build(folder: Path, marker: str = "") -> Path:
    (folder / "assets").mkdir(parents=True)
    (folder / ".vite").mkdir()
    (folder / "index.html").write_text(INDEX + marker, encoding="utf-8")
    (folder / "demo.html").write_text("<!doctype html><title>demo</title>", encoding="utf-8")
    (folder / "theme-init.js").write_text("// theme", encoding="utf-8")
    (folder / "manifest.webmanifest").write_text('{"name": "Little Archive"}', encoding="utf-8")
    (folder / "assets" / "main-AbCd1234.js").write_text("export {};", encoding="utf-8")
    (folder / ".vite" / "manifest.json").write_text("{}", encoding="utf-8")
    return folder


class ServedBuildTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="little-archive-webui-")
        self.root = Path(self.temporary.name)
        self.build = write_build(self.root / "webui")
        for name, value in (("PACKAGED", self.build), ("CHECKOUT", self.root / "no-checkout")):
            patcher = patch.object(webui, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        config = Config(data_dir=self.root / "data", admin_password=PASSWORD, public_url="http://testserver", testing=True)
        self.client = TestClient(create_app(config))
        self.client.__enter__()
        self.addCleanup(self.temporary.cleanup)
        self.addCleanup(self.client.__exit__, None, None, None)

    def policy(self, response):
        return {part.split(" ", 1)[0]: part.split(" ", 1)[1] if " " in part else "" for part in response.headers["content-security-policy"].split("; ")}

    def test_the_page_is_served_at_the_root_the_index_and_the_share_target(self):
        for path in ("/", "/index.html", "/share", "/share?title=%3Cb%3E&text=%3Cscript%3Ealert(1)%3C%2Fscript%3E&url=javascript%3Aalert(1)"):
            with self.subTest(path=path):
                response = self.client.get(path)
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.headers["content-type"].split(";")[0], "text/html")
                self.assertEqual(response.headers["cache-control"], "no-store")
                self.assertNotIn("alert(1)", response.text, "the query is never read or echoed")
                self.assertEqual(NONCE.sub("", response.text), INDEX)
        self.assertEqual(self.client.head("/share?url=https%3A%2F%2Fexample.com%2F").status_code, 200)

    def test_each_page_has_its_own_nonce_and_the_style_policy_names_only_that_nonce(self):
        seen = set()
        for _ in range(3):
            response = self.client.get("/")
            nonce = NONCE.search(response.text).group(1)
            seen.add(nonce)
            self.assertEqual(self.policy(response)["style-src"], f"'self' 'nonce-{nonce}'")
        self.assertEqual(len(seen), 3)
        # The nonce stands in the page only; no response ever lists an unrestricted inline allowance.
        for path in ("/", "/share", "/api/health", "/manifest.webmanifest", "/assets/main-AbCd1234.js", "/nothing-here"):
            with self.subTest(path=path):
                self.assertNotIn("unsafe-inline", self.client.get(path).headers["content-security-policy"])

    def test_the_rest_of_the_policy_is_unchanged_on_pages_and_other_responses(self):
        page, other = self.policy(self.client.get("/")), self.policy(self.client.get("/api/health"))
        self.assertEqual(other["style-src"], "'self'")
        page["style-src"] = other["style-src"] = ""
        self.assertEqual(page, other)
        self.assertEqual(
            page | {"style-src": "'self'"},
            {"default-src": "'self'", "script-src": "'self'", "style-src": "'self'", "img-src": "'self' data: https:", "connect-src": "'self'", "font-src": "'self'",
             "object-src": "'none'", "base-uri": "'none'", "frame-ancestors": "'none'", "form-action": "'self'"},
        )
        for header in ("x-content-type-options", "x-frame-options", "referrer-policy", "permissions-policy"):
            self.assertEqual(self.client.get("/").headers[header], self.client.get("/api/health").headers[header], header)

    def test_files_are_served_with_the_right_type_and_caching(self):
        manifest = self.client.get("/manifest.webmanifest")
        self.assertEqual(manifest.status_code, 200)
        self.assertEqual(manifest.headers["content-type"].split(";")[0], "application/manifest+json")
        self.assertEqual(manifest.headers["cache-control"], "no-cache")
        hashed = self.client.get("/assets/main-AbCd1234.js")
        self.assertEqual(hashed.status_code, 200)
        self.assertEqual(hashed.headers["cache-control"], "public, max-age=31536000, immutable")
        self.assertEqual(self.client.get("/theme-init.js").headers["cache-control"], "no-cache")
        self.assertEqual(self.client.get("/theme-init.js", headers={"If-None-Match": self.client.get("/theme-init.js").headers["etag"]}).status_code, 304)

    def test_the_demo_page_build_tooling_and_dot_files_are_not_served(self):
        for path in ("/demo.html", "/assets/demo.html", "/.vite/manifest.json", "/.vite", "/assets/.hidden", "/assets/../../etc/passwd", "/%2e%2e/%2e%2e/etc/passwd", "/assets/%2e%2e/index.html", "/nothing-here"):
            with self.subTest(path=path):
                self.assertEqual(self.client.get(path).status_code, 404)

    def test_there_is_no_write_surface_on_the_page_routes(self):
        for path in ("/", "/share", "/index.html"):
            self.assertEqual(self.client.post(path).status_code, 405, path)

    def test_a_rebuild_is_picked_up_without_a_restart(self):
        (self.build / "index.html").write_text(INDEX.replace('id="app"', 'id="rebuilt"'), encoding="utf-8")
        self.assertIn('id="rebuilt"', self.client.get("/").text)


class BuildLocationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="little-archive-webui-")
        self.root = Path(self.temporary.name)
        self.addCleanup(self.temporary.cleanup)

    def app(self, packaged, checkout):
        for name, value in (("PACKAGED", packaged), ("CHECKOUT", checkout)):
            patcher = patch.object(webui, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        config = Config(data_dir=self.root / "data", admin_password=PASSWORD, public_url="http://testserver", testing=True)
        client = TestClient(create_app(config))
        client.__enter__()
        self.addCleanup(client.__exit__, None, None, None)
        return client

    def test_the_packaged_build_wins_over_a_checkouts(self):
        packaged = write_build(self.root / "packaged", "<!-- packaged -->")
        checkout = write_build(self.root / "checkout", "<!-- checkout -->")
        client = self.app(packaged, checkout)
        self.assertIn("<!-- packaged -->", client.get("/").text)

    def test_a_checkouts_build_is_used_when_nothing_is_packaged(self):
        checkout = write_build(self.root / "checkout", "<!-- checkout -->")
        client = self.app(self.root / "absent", checkout)
        self.assertIn("<!-- checkout -->", client.get("/").text)

    def test_a_folder_without_an_index_is_not_a_build(self):
        (self.root / "empty").mkdir()
        checkout = write_build(self.root / "checkout", "<!-- checkout -->")
        client = self.app(self.root / "empty", checkout)
        self.assertIn("<!-- checkout -->", client.get("/").text)

    def test_with_no_build_the_pages_say_how_to_make_one_and_the_api_still_works(self):
        with self.assertLogs("little_archive", level="ERROR") as logged:
            client = self.app(self.root / "absent", self.root / "also-absent")
        self.assertEqual([record.getMessage() for record in logged.records], [webui.MISSING])
        for path in ("/", "/index.html", "/share"):
            with self.subTest(path=path):
                response = client.get(path)
                self.assertEqual(response.status_code, 503)
                self.assertEqual(response.text, webui.MISSING)
                self.assertEqual(response.headers["content-type"].split(";")[0], "text/plain")
        self.assertEqual(client.get("/app.js").status_code, 404)
        self.assertEqual(client.get("/api/health").status_code, 200)
        self.assertEqual(len(webui.MISSING.splitlines()), 1)
        self.assertIn("npm ci && npm run build", webui.MISSING)
        self.assertIn("ui/", webui.MISSING)
        self.assertIn("Node 22", webui.MISSING)

    def test_the_old_interface_is_never_served(self):
        client = self.app(self.root / "absent", self.root / "also-absent")
        for path in ("/app.js", "/styles.css", "/utils.js", "/demo.html", "/fonts/fraunces-soft.woff2"):
            self.assertEqual(client.get(path).status_code, 404, path)


class PublicDirectoryTests(unittest.TestCase):
    def test_every_place_the_interface_can_be_served_from_is_a_public_directory(self):
        root = Path(__file__).resolve().parents[1]
        names = {path.relative_to(root).as_posix() for path in webui.public_directories()}
        self.assertEqual(names, {"webui", "ui/dist", "web"})
        self.assertTrue(webui.is_public(root / "ui" / "dist" / "assets" / "secret"))
        self.assertTrue(webui.is_public(root / "web" / "x"))
        self.assertFalse(webui.is_public(root / "ui" / "src"))
        self.assertFalse(webui.is_public(root / "data"))


class ImageRecipeTests(unittest.TestCase):
    """The image is built in CI and by operators, not here. These pin the shape of its recipe."""

    def setUp(self):
        self.root = Path(__file__).resolve().parents[1]
        self.dockerfile = (self.root / "Dockerfile").read_text(encoding="utf-8")
        stages = re.split(r"(?m)^FROM ", self.dockerfile)[1:]
        self.assertEqual(len(stages), 2)
        self.build, self.final = stages

    def test_the_interface_is_built_in_a_node_stage_from_web_and_ui_only(self):
        self.assertRegex(self.build, r"^node:24\S* AS interface")
        for line in ("COPY web ./web", "npm --prefix ui ci", "npm --prefix ui run build"):
            self.assertIn(line, self.build)
        self.assertEqual(re.findall(r"(?m)^COPY (?!--)(\S+)", self.build), ["web", "ui/package.json", "ui"])

    def test_only_the_built_files_reach_the_final_image_which_stays_non_root(self):
        self.assertTrue(self.final.startswith("python:3.12-slim"))
        self.assertIn(f"COPY --from=interface --chown=archive:archive /build/ui/dist ./{webui.PACKAGED.name}", self.final)
        self.assertEqual(re.findall(r"(?m)^COPY (?:--chown=\S+ )?(?!--)(\S+)", self.final), ["requirements.txt", "server", "LICENSE"])
        self.assertNotRegex(self.final, r"\b(npm|node)\b")
        self.assertIn("rm -rf ui/dist/.vite", self.build)
        self.assertRegex(self.final, r"(?m)^USER archive$")
        self.assertIn("/app", self.final)

    def test_the_build_context_keeps_what_the_interface_build_needs_and_drops_the_rest(self):
        lines = {line.strip() for line in (self.root / ".dockerignore").read_text(encoding="utf-8").splitlines() if line.strip() and not line.startswith("#")}
        for dropped in ("**/node_modules", "ui/dist", "mobile", "tests", "data"):
            self.assertIn(dropped, lines)
        for needed in ("web", "ui", "ui/src", "ui/src/data", "server", "LICENSE"):
            self.assertNotIn(needed, lines)
        self.assertTrue((self.root / "ui" / "src" / "data" / "archive.ts").is_file())

    def test_compose_runs_the_image_read_only_without_a_writable_interface_folder(self):
        for name in ("compose.yaml", "compose.image.yaml"):
            text = (self.root / name).read_text(encoding="utf-8")
            self.assertIn("read_only: true", text)
            self.assertNotIn("webui", text)


if __name__ == "__main__":
    unittest.main()
