#!/usr/bin/env python3
"""Run the app against an isolated, private contributor workspace."""
import argparse
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.dev_workspace import (
    DEFAULT_HOST,
    DEFAULT_PORT,
    WorkspaceError,
    clean_app_environment,
    cleanup_workspace,
    inspect_workspace,
    prepare_workspace,
    seed_workspace,
    server_config,
    workspace_lock,
)


def port_number(value):
    try:
        port = int(value)
    except ValueError:
        raise argparse.ArgumentTypeError("Use a port between 1 and 65535.") from None
    if not 1 <= port <= 65535:
        raise argparse.ArgumentTypeError("Use a port between 1 and 65535.")
    return port


def main(argv=None, *, repo_root=ROOT):
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--prepare", action="store_true", help="Create or reuse the private development workspace without starting a server.")
    mode.add_argument("--check", action="store_true", help="Inspect the development workspace without changing it.")
    mode.add_argument("--cleanup", action="store_true", help="Delete only this checkout's owned development workspace, while it is stopped.")
    parser.add_argument("--json", action="store_true", help="Return credential-free, relative-path status with --check.")
    parser.add_argument("--seed", action="store_true", help="Add the built-in synthetic fixture once; never reseed or overwrite later edits.")
    parser.add_argument("--host", choices=("127.0.0.1", "localhost", "::1"), default=DEFAULT_HOST, help="Loopback address only (default: 127.0.0.1).")
    parser.add_argument("--port", type=port_number, default=DEFAULT_PORT, help="Development port (default: 8788). PORT and LA_* environment settings are ignored.")
    parser.add_argument("--strictPort", action="store_true", help="Compatibility flag; an occupied port always causes startup to fail.")
    args = parser.parse_args(argv)
    if args.json and not args.check:
        parser.error("--json is only supported with --check.")
    if args.seed and (args.check or args.cleanup):
        parser.error("--seed cannot be combined with --check or --cleanup.")

    if args.check:
        status = inspect_workspace(repo_root)
        if args.json:
            print(json.dumps(status, sort_keys=True))
        else:
            print(f"Development workspace: {status['status']} ({status['path']}).")
            for message in status["errors"]:
                print(message)
        return 1 if status["status"] == "invalid" else 0

    try:
        if args.cleanup:
            cleanup_workspace(repo_root)
            print("Removed the owned development workspace at work/contributor-dev. Other libraries and configuration were left unchanged.")
            return 0

        workspace = prepare_workspace(repo_root)
        if args.seed:
            created = seed_workspace(workspace)
            print(f"Synthetic fixture: {created} records added; a previously seeded workspace is left unchanged.")
        print("Development data: work/contributor-dev/data")
        print("Private owner password: open work/contributor-dev/owner-password.txt locally in a text editor.")
        if args.prepare:
            print("Development workspace ready. Start with npm run dev (from an activated Python virtual environment).")
            return 0

        with workspace_lock(workspace), clean_app_environment():
            # The production CLI and its .env loader are deliberately not used.
            # An explicit Config prevents inherited deployment settings selecting
            # a personal library or a network/model destination.
            import uvicorn
            from server.app import create_app

            config = server_config(workspace, host=args.host, port=args.port)
            app = create_app(config)
            print(f"Open {config.public_url}; this contributor server accepts loopback connections only.", flush=True)
            uvicorn.run(app, host=args.host, port=args.port, workers=1, proxy_headers=False, access_log=False)
        return 0
    except WorkspaceError as exc:
        print(f"Development workspace: {exc}", file=sys.stderr)
        return 1
    except ImportError:
        print("Development dependencies are unavailable. Activate .venv and install requirements.txt before starting or seeding.", file=sys.stderr)
        return 1
    except OSError:
        print("Cannot access the development workspace or start its server. Check local permissions and whether the selected port is available.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
