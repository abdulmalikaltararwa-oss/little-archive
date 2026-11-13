#!/usr/bin/env python3
"""Build a reproducible, reviewed runtime-only unpacked-extension ZIP."""
import argparse
from html.parser import HTMLParser
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import tempfile
import zipfile


ROOT = Path(__file__).resolve().parent.parent
# Add new runtime files deliberately; never sweep a browser profile, test
# fixture, temporary file, or credential into a public download.
RUNTIME_FILES = (
    "manifest.json", "background.js", "core.js", "page-context.js", "protocol.js",
    "adapters.js", "content.js", "popup.html", "popup.js", "popup.css",
)
MANIFEST_FIELDS = {
    "manifest_version", "name", "description", "version", "minimum_chrome_version",
    "permissions", "optional_host_permissions", "background", "action", "content_security_policy",
}
STRING = re.compile(r"(['\"])([^'\"\\\r\n]*)\1")
IMPORT = re.compile(r"\b(?:import|export)\s+(?:[^;'\"]*?\bfrom\s*)?(['\"])([^'\"\r\n]+)\1")


def _reference(owner, reference, files):
    if (not isinstance(reference, str) or not reference or
            any(c in reference for c in "\\%?#:") or any(ord(c) < 32 for c in reference)):
        raise ValueError(f"Unreviewed extension reference in {owner}.")
    path = PurePosixPath(reference)
    if path.is_absolute() or ".." in path.parts:
        raise ValueError(f"Extension reference escapes its package in {owner}.")
    name = str(PurePosixPath(owner).parent / path)
    if name not in RUNTIME_FILES or name not in files:
        raise ValueError(f"Missing or unreviewed runtime dependency in {owner}: {name}")


class _HTMLReferences(HTMLParser):
    def __init__(self, owner, files):
        super().__init__()
        self.owner, self.files = owner, files

    def handle_starttag(self, tag, attrs):
        for attribute, value in attrs:
            if attribute in {"src", "href", "poster"}:
                _reference(self.owner, value, self.files)
            elif attribute in {"srcset", "srcdoc"}:
                raise ValueError(f"Review new HTML resource handling in {self.owner} before packaging.")


def validate_runtime(files):
    """Check the static forms used by this small buildless extension.

    New manifest/resource mechanisms require an explicit packaging review;
    this deliberately does not pretend to be a general JavaScript bundler.
    """
    for name in RUNTIME_FILES:
        if name not in files:
            raise ValueError(f"Missing extension runtime file: {name}")
    manifest = json.loads(files["manifest.json"])
    if not isinstance(manifest, dict) or set(manifest) - MANIFEST_FIELDS:
        raise ValueError("Review new extension manifest fields before packaging.")
    if manifest.get("manifest_version") != 3:
        raise ValueError("The extension package requires Manifest V3.")
    background, action = manifest.get("background", {}), manifest.get("action", {})
    if (not isinstance(background, dict) or not isinstance(action, dict) or
            set(background) - {"service_worker", "type"} or background.get("type") != "module" or
            set(action) - {"default_title", "default_popup"}):
        raise ValueError("Review changed extension entry points before packaging.")
    for reference in (background.get("service_worker"), action.get("default_popup")):
        _reference("manifest.json", reference, files)
    for name in RUNTIME_FILES:
        text = files[name].decode("utf-8")
        if name.endswith(".html"):
            _HTMLReferences(name, files).feed(text)
        elif name.endswith(".js"):
            for match in IMPORT.finditer(text):
                _reference(name, match[2], files)
            for match in re.finditer(r"\b(?:import|getURL)\s*\(([^)]*)\)", text):
                argument = STRING.fullmatch(match[1].strip())
                if not argument:
                    raise ValueError(f"Review computed runtime references in {name} before packaging.")
                if argument[2]:  # getURL('') requests the extension origin.
                    _reference(name, argument[2], files)
            for match in re.finditer(r"\bfiles\s*:\s*\[([^]]*)\]", text):
                if STRING.sub("", match[1]).replace(",", "").strip():
                    raise ValueError(f"Review computed injected file names in {name} before packaging.")
                for reference in STRING.finditer(match[1]):
                    _reference(name, reference[2], files)
        elif name.endswith(".css") and re.search(r"@import\b|url\s*\(", text, re.IGNORECASE):
            raise ValueError(f"Review new stylesheet assets in {name} before packaging.")


def extension_files(root=ROOT):
    """Snapshot only the reviewed files and full license; refuse symlinks."""
    root = Path(root).resolve()
    directory = root / "extension"
    if directory.is_symlink() or not directory.is_dir():
        raise ValueError("Extension source must be a real directory in the checkout.")
    result = {}
    for name in (*RUNTIME_FILES, "INSTALL.md", "LICENSE"):
        source = root / "LICENSE" if name == "LICENSE" else directory / name
        if source.is_symlink() or not source.is_file() or not source.resolve().is_relative_to(root):
            raise ValueError(f"Missing or unsafe package source: {name}")
        result[name] = source.read_bytes()
    validate_runtime(result)
    return result


def build_extension(output, *, root=ROOT):
    files = extension_files(root)
    output = Path(output)
    if output.suffix != ".zip" or output.is_symlink():
        raise ValueError("Choose a regular .zip output path.")
    output.parent.mkdir(parents=True, exist_ok=True)
    staged = None
    try:
        descriptor, name = tempfile.mkstemp(prefix=".extension-package-", suffix=".zip", dir=output.parent)
        os.close(descriptor)
        staged = Path(name)
        with zipfile.ZipFile(staged, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
            for name, body in sorted(files.items()):
                info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
                info.create_system = 3
                info.external_attr = (stat.S_IFREG | 0o644) << 16
                archive.writestr(info, body, compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
        os.replace(staged, output)
    finally:
        if staged is not None:
            staged.unlink(missing_ok=True)
    return len(files)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "work" / "little-archive-extension.zip")
    args = parser.parse_args()
    try:
        count = build_extension(args.output)
    except (OSError, ValueError, TypeError) as exc:
        parser.exit(1, f"Extension packaging failed: {exc}\n")
    print(f"Built {args.output} ({count} reviewed files; manifest.json at the ZIP root).")


if __name__ == "__main__":
    main()
