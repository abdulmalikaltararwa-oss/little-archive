#!/usr/bin/env python3
"""Check the source package for missing release files and accidental runtime data."""
from pathlib import Path
import json
import subprocess
import sys

from package_extension import extension_files

root = Path(__file__).resolve().parent.parent
required = ["README.md", "LICENSE", "SECURITY.md", "CONTRIBUTING.md", "CHANGELOG.md", "Dockerfile", "compose.yaml", "requirements.txt", "requirements-lock.txt", ".env.example", "ui/index.html", "ui/demo.html", "ui/package.json", "ui/package-lock.json", "ui/src/main.tsx", "ui/src/data/archive.ts", "ui/public/icon.svg", "ui/public/theme-init.js", "ui/public/manifest.webmanifest", "ui/public/icons/icon-192.png", "ui/public/icons/icon-512.png", "ui/public/icons/icon-maskable-512.png", "ui/public/apple-touch-icon.png", "extension/manifest.json", "docs/launch-kit.md", "docs/self-hosting.md", "docs/phone.md", "web/privacy.html", "web/terms.html", "web/support.html", "web/delete-account.html", "web/pages.css", "web/fonts/fraunces-soft.woff2", "web/site.json"]
errors = ["Missing required file: " + p for p in required if not (root / p).is_file()]
manifest_path = root / "extension/manifest.json"
if manifest_path.is_file():
    manifest = json.loads(manifest_path.read_text())
    if manifest.get("manifest_version") != 3:
        errors.append("Extension must use Manifest V3.")
    forbidden = {"cookies", "debugger", "history", "webRequest"}
    if forbidden.intersection(manifest.get("permissions", [])):
        errors.append("Extension asks for an unnecessary sensitive permission.")
    for p in [manifest.get("background", {}).get("service_worker"), manifest.get("action", {}).get("default_popup")]:
        if p and not (root / "extension" / p).is_file():
            errors.append("Missing extension entry point: " + p)
# The public pages name one contact address, set in web/site.json and written in by the demo build. A page that names
# an address itself, or a setting that is not an address, would publish something nobody chose.
try:
    from build_demo import CONTACT_TOKEN, SITE_PAGES, site_contact
    site_contact(root / "web")
    for page in SITE_PAGES:
        text = (root / "web" / page).read_text(encoding="utf-8") if (root / "web" / page).is_file() else ""
        if text.count(CONTACT_TOKEN) != 1 or "[owner to set]" in text:
            errors.append(f"web/{page} must hold {CONTACT_TOKEN} once, where the contact address goes, and no address of its own.")
except SystemExit as exc:
    errors.append("Public pages: " + str(exc))
try:
    extension_files(root)
except (OSError, ValueError, TypeError) as exc:
    errors.append("Extension package validation failed: " + str(exc))
tracked = subprocess.run(["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], cwd=root, capture_output=True, check=True).stdout.decode().split("\0")
# ui/src/data is the interface's data layer (source code), not a runtime data directory.
INTERFACE_DATA_LAYER = ("ui", "src", "data")
for name in filter(None, tracked):
    p = Path(name)
    folders = p.parts[3:] if p.parts[:3] == INTERFACE_DATA_LAYER else p.parts
    if p.name == ".env" or p.suffix in {".sqlite", ".sqlite3", ".db", ".zip"} or any(x in folders for x in {"data", "node_modules", "__pycache__", "dist"}):
        errors.append("Runtime/private file in source package: " + name)
if errors:
    print("\n".join(errors), file=sys.stderr)
    raise SystemExit(1)
print(f"Release source checks passed ({len(required)} required files).")
