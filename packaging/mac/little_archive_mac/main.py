"""Entry point of the Little Archive Mac app."""
from __future__ import annotations

import logging
import sys

from . import core

_log = logging.getLogger("little_archive.launcher")
USAGE = """Little Archive for Mac

  Little Archive                      Open the app (what double-clicking does)
  Little Archive --cli doctor --env-file CONFIG --json
  Little Archive --cli reset-password --env-file CONFIG     (quit the app first)
  Little Archive --version

`--cli` runs the same operator commands as `python -m server.cli`, using the Python
bundled inside the app. CONFIG is `config.env` inside the library folder.
"""


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if argv[:1] == ["--cli"]:
        return core.run_server_cli(argv[1:])
    if argv[:1] in (["--version"], ["-V"]):
        from server import __version__
        print(f"{core.APP_NAME} {__version__}")
        return 0
    if argv[:1] in (["--help"], ["-h"]):
        print(USAGE)
        return 0
    try:
        paths = core.resolve_paths()
        core.configure_logging(paths)
    except core.LauncherError as exc:
        print(f"Little Archive: {exc}", file=sys.stderr)
        return 1
    instance = core.LibraryInstance(paths)
    try:
        existing = instance.existing_instance_url(wait=0.0)
    except core.LauncherError as exc:
        _log.error("Startup check failed: %s", exc)
        print(f"Little Archive: {exc}", file=sys.stderr)
        return 1
    if existing:
        # Launched a second time (for example by running the executable directly): do not
        # start another server, just show the one that is already running.
        _log.info("Another copy is already serving this library; opening it.")
        core.open_in_browser(existing)
        return 0
    from . import gui
    return gui.run(instance)
