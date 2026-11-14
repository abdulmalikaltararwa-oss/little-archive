#!/usr/bin/env python3
"""Build Little Archive.app (plus a .zip and a .dmg) for the Mac this runs on.

The app bundles Python 3.12, the server and the web interface with PyInstaller, so the
person who opens it needs no Python, Docker or terminal. Output goes to the gitignored
`dist-mac/`; intermediate files go to the gitignored `.mac-build/`. Nothing is signed with a
Developer ID or notarized: the app gets an ad-hoc signature only. See docs/mac-app.md.

    python3 scripts/build_mac_app.py --python /path/to/python3.12

This script uses only the standard library. It creates its own virtual environment from
packaging/mac/requirements-build.txt, which needs network access to install packages.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import plistlib
import re
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent
MAC = ROOT / "packaging" / "mac"
BUILD = ROOT / ".mac-build"
OUTPUT = ROOT / "dist-mac"
APP_NAME = "Little Archive"
BUNDLE = f"{APP_NAME}.app"
MACHO_MAGIC = {b"\xcf\xfa\xed\xfe", b"\xfe\xed\xfa\xcf", b"\xca\xfe\xba\xbe", b"\xbe\xba\xfe\xca"}


def say(message):
    print(f"==> {message}", flush=True)


def run(command, **options):
    print("    $ " + " ".join(str(part) for part in command), flush=True)
    return subprocess.run([str(part) for part in command], check=True, **options)


def fail(message):
    raise SystemExit(f"build_mac_app: {message}")


def application_version():
    match = re.search(r'__version__\s*=\s*"([^"]+)"', (ROOT / "server" / "__init__.py").read_text(encoding="utf-8"))
    if not match:
        fail("could not read the version from server/__init__.py")
    return match.group(1)


def is_python_312(candidate):
    try:
        result = subprocess.run([str(candidate), "-c", "import sys; print(sys.version_info[:2] == (3, 12))"], capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.SubprocessError):
        return False
    return result.returncode == 0 and result.stdout.strip() == "True"


def find_python(requested):
    candidates = [requested] if requested else [
        shutil.which("python3.12"), "/opt/homebrew/bin/python3.12", "/usr/local/bin/python3.12",
        "/Library/Frameworks/Python.framework/Versions/3.12/bin/python3.12",
    ]
    for candidate in filter(None, candidates):
        if is_python_312(candidate):
            return Path(candidate)
    fail("Python 3.12 is required (it is the runtime the server is tested with and the one bundled). "
         "Install it, for example `brew install python@3.12`, then pass it with --python /path/to/python3.12.")


def prepare_environment(python):
    environment = BUILD / "venv"
    interpreter = environment / "bin" / "python"
    if not interpreter.exists() or not is_python_312(interpreter):
        shutil.rmtree(environment, ignore_errors=True)
        say("Creating the build environment")
        run([python, "-m", "venv", environment])
    say("Installing pinned build dependencies (network access needed on the first run)")
    run([interpreter, "-m", "pip", "install", "--disable-pip-version-check", "--quiet", "-r", MAC / "requirements-build.txt"])
    return interpreter


def make_icon(interpreter):
    folder = BUILD / "icon"
    shutil.rmtree(folder, ignore_errors=True)
    say("Rendering the app icon from web/icon.svg")
    run([interpreter, MAC / "make_icon.py", ROOT / "web" / "icon.svg", folder / "icon.iconset"])
    icns = folder / f"{APP_NAME}.icns"
    run(["iconutil", "-c", "icns", "-o", icns, folder / "icon.iconset"])
    return icns


def build_bundle(interpreter, icon, version):
    work, dist = BUILD / "pyinstaller-work", BUILD / "pyinstaller-dist"
    shutil.rmtree(work, ignore_errors=True)
    shutil.rmtree(dist, ignore_errors=True)
    say("Bundling Python, the server and the web interface with PyInstaller")
    environment = {**os.environ, "LITTLE_ARCHIVE_ICON": str(icon), "LITTLE_ARCHIVE_VERSION": version}
    run([interpreter, "-m", "PyInstaller", "--noconfirm", "--clean", "--distpath", dist, "--workpath", work, MAC / "little_archive.spec"], env=environment, cwd=ROOT)
    app = dist / BUNDLE
    if not app.is_dir():
        fail("PyInstaller did not produce the app bundle")
    return app


def mach_o_files(app):
    for folder, names_directories, names in os.walk(app):
        names_directories[:] = [name for name in names_directories if not os.path.islink(os.path.join(folder, name))]
        for name in names:
            path = Path(folder, name)
            if path.is_symlink() or not path.is_file():
                continue
            try:
                with open(path, "rb") as stream:
                    if stream.read(4) in MACHO_MAGIC:
                        yield path
            except OSError:
                continue


def version_tuple(text):
    return tuple(int(part) for part in text.split("."))


def macos_minimum_in(otool_output):
    """The macOS deployment target in `otool -l` output as a version tuple, or None."""
    found, command, platform_name = None, "", ""
    for line in otool_output.splitlines():
        parts = line.split()
        if len(parts) != 2:
            continue
        if parts[0] == "cmd":
            command, platform_name = parts[1], ""
        elif command == "LC_BUILD_VERSION" and parts[0] == "platform":
            platform_name = parts[1]
        elif command == "LC_BUILD_VERSION" and parts[0] == "minos" and platform_name in {"1", "MACOS"}:
            found = version_tuple(parts[1])
        elif command == "LC_VERSION_MIN_MACOSX" and parts[0] == "version":
            found = version_tuple(parts[1])
    return found


def minimum_macos(app):
    """The highest macOS version any bundled binary was built to require."""
    highest, source = (0,), None
    for path in mach_o_files(app):
        found = macos_minimum_in(subprocess.run(["otool", "-l", str(path)], capture_output=True, text=True).stdout)
        if found is not None and found > highest:
            highest, source = found, path
    if source is None:
        fail("could not read the minimum macOS version from the bundled binaries")
    return ".".join(str(part) for part in highest), source


def run_quietly(command):
    """Run a chatty tool, showing its output only if it fails."""
    print("    $ " + " ".join(str(part) for part in command), flush=True)
    result = subprocess.run([str(part) for part in command], capture_output=True, text=True)
    if result.returncode != 0:
        print(result.stdout + result.stderr, file=sys.stderr)
        fail(f"{command[0]} failed with status {result.returncode}")
    return result


def sign_ad_hoc(app):
    say("Applying an ad-hoc signature (no Developer ID, not notarized)")
    run_quietly(["codesign", "--force", "--deep", "--sign", "-", "--timestamp=none", app])
    run_quietly(["codesign", "--verify", "--deep", "--strict", app])
    print("    codesign --verify --deep --strict: passed")


def directory_bytes(path):
    total = 0
    for folder, _, names in os.walk(path):
        for name in names:
            item = Path(folder, name)
            if not item.is_symlink():
                total += item.stat().st_size
    return total


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def source_revision():
    try:
        head = subprocess.run(["git", "rev-parse", "HEAD"], cwd=ROOT, capture_output=True, text=True, check=True).stdout.strip()
        dirty = bool(subprocess.run(["git", "status", "--porcelain"], cwd=ROOT, capture_output=True, text=True, check=True).stdout.strip())
        return head, dirty
    except (OSError, subprocess.SubprocessError):
        return None, None


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--python", help="Path to a Python 3.12 interpreter (default: look for python3.12)")
    parser.add_argument("--clean", action="store_true", help="Delete .mac-build (including the build environment) first")
    parser.add_argument("--no-archives", action="store_true", help="Build only the .app; skip the .zip and .dmg")
    args = parser.parse_args(argv)
    if sys.platform != "darwin":
        fail("this builds a macOS app and must run on a Mac")
    for tool in ("codesign", "iconutil", "ditto", "hdiutil", "otool"):
        if not shutil.which(tool):
            fail(f"{tool} was not found; install the Xcode command line tools (xcode-select --install)")
    if args.clean:
        shutil.rmtree(BUILD, ignore_errors=True)
    BUILD.mkdir(exist_ok=True)
    version, architecture = application_version(), platform.machine()
    interpreter = prepare_environment(find_python(args.python))
    icon = make_icon(interpreter)
    built = build_bundle(interpreter, icon, version)

    minimum, binary = minimum_macos(built)
    say(f"Lowest macOS the bundled binaries allow: {minimum} (set by {binary.name})")
    plist_path = built / "Contents" / "Info.plist"
    with open(plist_path, "rb") as stream:
        info = plistlib.load(stream)
    info["LSMinimumSystemVersion"] = minimum
    with open(plist_path, "wb") as stream:
        plistlib.dump(info, stream)
    sign_ad_hoc(built)

    OUTPUT.mkdir(exist_ok=True)
    final = OUTPUT / BUNDLE
    shutil.rmtree(final, ignore_errors=True)
    run(["ditto", built, final])
    artifacts = {}
    if not args.no_archives:
        stem = f"Little-Archive-{version}-macos-{architecture}"
        archive = OUTPUT / f"{stem}.zip"
        archive.unlink(missing_ok=True)
        say("Creating the .zip")
        run(["ditto", "-c", "-k", "--keepParent", "--sequesterRsrc", final, archive])
        image = OUTPUT / f"{stem}.dmg"
        image.unlink(missing_ok=True)
        say("Creating the .dmg")
        staging = BUILD / "dmg-staging"
        shutil.rmtree(staging, ignore_errors=True)
        staging.mkdir()
        run(["ditto", final, staging / BUNDLE])
        (staging / "Applications").symlink_to("/Applications")
        run(["hdiutil", "create", "-quiet", "-volname", APP_NAME, "-srcfolder", staging, "-fs", "HFS+", "-format", "UDZO", "-ov", image])
        shutil.rmtree(staging, ignore_errors=True)
        artifacts = {archive.name: archive, image.name: image}
        (OUTPUT / "SHA256SUMS").write_text("".join(f"{sha256(path)}  {name}\n" for name, path in artifacts.items()), encoding="utf-8")
    revision, dirty = source_revision()
    bundled_python = subprocess.run([str(interpreter), "-c", "import platform; print(platform.python_version())"], capture_output=True, text=True).stdout.strip()
    report = {
        "application_version": version, "architecture": architecture, "macos_build_host": platform.mac_ver()[0],
        "minimum_macos_from_binaries": minimum, "bundled_python": bundled_python,
        "source_revision": revision, "source_tree_modified": dirty, "signature": "ad-hoc (not Developer ID, not notarized)",
        "app_bytes": directory_bytes(final), "artifacts": {name: {"bytes": path.stat().st_size, "sha256": sha256(path)} for name, path in artifacts.items()},
    }
    (OUTPUT / "build-info.json").write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    say("Done")
    print(f"    App:      {final} ({report['app_bytes'] / 1e6:.1f} MB on disk)")
    for name, path in artifacts.items():
        print(f"    Archive:  {path} ({path.stat().st_size / 1e6:.1f} MB)")
    print("    This build is not signed with a Developer ID and is not notarized; see docs/mac-app.md for Gatekeeper.")


if __name__ == "__main__":
    main()
