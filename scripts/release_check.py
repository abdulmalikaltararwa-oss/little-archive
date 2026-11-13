#!/usr/bin/env python3
"""Check the source package for missing release files and accidental runtime data."""
from pathlib import Path
import json
import subprocess
import sys

root = Path(__file__).resolve().parent.parent
required = ["README.md", "LICENSE", "SECURITY.md", "CONTRIBUTING.md", "CHANGELOG.md", "Dockerfile", "compose.yaml", "requirements.txt", "requirements-lock.txt", ".env.example", "web/index.html", "web/app.js", "web/styles.css", "web/icon.svg", "extension/manifest.json", "docs/launch-kit.md", "docs/self-hosting.md"]
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
tracked = subprocess.run(["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], cwd=root, capture_output=True, check=True).stdout.decode().split("\0")
for name in filter(None, tracked):
    p = Path(name)
    if p.name == ".env" or p.suffix in {".sqlite", ".sqlite3", ".db", ".zip"} or any(x in p.parts for x in {"data", "node_modules", "__pycache__"}):
        errors.append("Runtime/private file in source package: " + name)
if errors:
    print("\n".join(errors), file=sys.stderr)
    raise SystemExit(1)
print(f"Release source checks passed ({len(required)} required files).")
