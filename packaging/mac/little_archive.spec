# -*- mode: python ; coding: utf-8 -*-
# PyInstaller recipe for Little Archive.app. Run through scripts/build_mac_app.py, which sets the
# LITTLE_ARCHIVE_* variables read below and checks the result.
import os
from pathlib import Path

from PyInstaller.utils.hooks import collect_submodules, copy_metadata

HERE = Path(SPECPATH).resolve()
ROOT = HERE.parents[1]
APP_NAME = "Little Archive"
ICON = os.environ["LITTLE_ARCHIVE_ICON"]
BUNDLE_ID = os.environ.get("LITTLE_ARCHIVE_BUNDLE_ID", "io.github.abdulmalikaltararwa-oss.little-archive")
VERSION = os.environ["LITTLE_ARCHIVE_VERSION"]

# `server/diagnostics.py` reads installed-package metadata, so ship it for the packages it names.
metadata = []
for distribution in ("fastapi", "uvicorn", "httpx", "Pillow"):
    metadata += copy_metadata(distribution)

analysis = Analysis(
    [str(HERE / "launcher_entry.py")],
    pathex=[str(ROOT), str(HERE)],
    binaries=[],
    # The same static files the Docker image serves, and the license text.
    datas=[(str(ROOT / "web"), "web"), (str(ROOT / "LICENSE"), ".")] + metadata,
    hiddenimports=collect_submodules("server") + collect_submodules("uvicorn") + ["little_archive_mac.gui"],
    excludes=["tkinter", "_tkinter", "turtle", "idlelib", "lib2to3", "pydoc_data", "test", "unittest"],
    noarchive=False,
)
archive = PYZ(analysis.pure)
executable = EXE(
    archive, analysis.scripts, [],
    exclude_binaries=True,
    name=APP_NAME,
    console=False,
    argv_emulation=False,
    target_arch=None,  # The architecture of the Python used to build; no universal2 claim.
    codesign_identity=None,  # PyInstaller applies an ad-hoc signature; there is no Developer ID.
    entitlements_file=None,
)
collected = COLLECT(executable, analysis.binaries, analysis.datas, strip=False, upx=False, name=APP_NAME)
app = BUNDLE(
    collected,
    name=f"{APP_NAME}.app",
    icon=ICON,
    bundle_identifier=BUNDLE_ID,
    version=VERSION,
    info_plist={
        "CFBundleName": APP_NAME,
        "CFBundleDisplayName": APP_NAME,
        "CFBundleShortVersionString": VERSION,
        "CFBundleVersion": VERSION,
        "NSHumanReadableCopyright": "Copyright © 2026 Little Archive contributors. MIT License.",
        "LSApplicationCategoryType": "public.app-category.productivity",
        "NSHighResolutionCapable": True,
        "LSMultipleInstancesProhibited": True,  # Opening the app again re-opens the running copy.
    },
)
