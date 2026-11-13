"""Local operator commands. Environment values override an optional .env file."""
import argparse
import getpass
import json
import os
from pathlib import Path
import sys

from .config import Config
from .configuration import read_env_values


def load_env(path=Path(".env")):
    for key, value in read_env_values(path).items():
        os.environ.setdefault(key, value)


def _port(value):
    value = int(value)
    if not 1 <= value <= 65535:
        raise argparse.ArgumentTypeError("Use a port between 1 and 65535.")
    return value


def main(argv=None):
    parser = argparse.ArgumentParser(prog="little-archive")
    sub = parser.add_subparsers(dest="command", required=True)
    serve = sub.add_parser("serve", help="Start the private library")
    serve.add_argument("--host", default="127.0.0.1")
    serve.add_argument("--port", type=_port, default=8787)
    serve.add_argument("--env-file", type=Path, default=Path(".env"))
    restore = sub.add_parser("restore", help="Restore a verified backup into a NEW directory")
    restore.add_argument("archive")
    restore.add_argument("--destination", required=True)
    reset = sub.add_parser("reset-password", help="Reset the owner password and revoke sessions/tokens while the server is stopped")
    reset.add_argument("--env-file", type=Path, default=Path(".env"))
    setup = sub.add_parser("setup", help="Preview or create private configuration; does not install dependencies or start services")
    action = setup.add_mutually_exclusive_group()
    action.add_argument("--dry-run", action="store_true", help="Preview without writing; this is the default")
    action.add_argument("--apply", action="store_true", help="Create configuration only if it does not exist")
    setup.add_argument("--config", type=Path, default=Path(".env"))
    setup.add_argument("--data-dir", default="./data")
    setup.add_argument("--public-url", default="http://localhost:8787")
    setup.add_argument("--json", action="store_true", help="Print versioned results without secret values")
    doctor = sub.add_parser("doctor", help="Read-only configuration/filesystem diagnostics; no network requests by default")
    doctor.add_argument("--env-file", type=Path, default=Path(".env"))
    doctor.add_argument("--json", action="store_true", help="Print versioned, redacted diagnostic results")
    doctor.add_argument("--check-ai", action="store_true", help="Request bounded runtime-version/model-list checks; never inference or downloads")
    doctor.add_argument("--check-port", action="store_true", help="Check whether a local service accepts a connection; never stop it")
    doctor.add_argument("--port", type=_port, default=8787)
    args = parser.parse_args(argv)
    try:
        if args.command == "setup":
            from .bootstrap import setup_configuration
            result = setup_configuration(args.config, data_dir=args.data_dir, public_url=args.public_url, apply=args.apply)
            print(json.dumps(result, ensure_ascii=False, sort_keys=True) if args.json else result["summary"] + "\n" + result["next_action"])
            return 1 if result["status"] == "blocked" else 0
        if args.command == "doctor":
            from .diagnostics import diagnose
            result = diagnose(env_file=args.env_file, check_ai=args.check_ai, check_port=args.check_port, port=args.port)
            if args.json:
                print(json.dumps(result, ensure_ascii=False, sort_keys=True))
            else:
                print("Little Archive diagnostics: " + result["status"])
                for row in result["checks"]:
                    print(f"{row['status'].upper()} [{row['code']}] {row['summary']}")
                    if row.get("next_action"):
                        print("  " + row["next_action"])
                print("Read-only checks finished. No library, credentials, or configuration were changed.")
            return result["exit_code"]
        if args.command in {"serve", "reset-password"}:
            load_env(args.env_file)
        if args.command == "serve":
            import uvicorn
            # Fail clearly before starting the server if operator configuration is invalid.
            Config.from_env().validate()
            uvicorn.run("server.app:create_app", factory=True, host=args.host, port=args.port, workers=1, proxy_headers=False, access_log=False)
        elif args.command == "restore":
            from .backups import restore_backup
            manifest = restore_backup(args.archive, args.destination)
            print(f"Restored {manifest['items']} items into {Path(args.destination).resolve()}.")
            print("Set LA_DATA_DIR to that directory and set a new LA_ADMIN_PASSWORD before starting. Existing import tokens are revoked.")
        elif args.command == "reset-password":
            from .security import hash_password
            from .storage import Store
            password = getpass.getpass("New owner password (12+ characters): ")
            if password != getpass.getpass("Repeat password: "):
                raise ValueError("Passwords did not match.")
            encoded = hash_password(password)
            store = Store(Config.from_env())
            with store.transaction() as c:
                c.execute("UPDATE meta SET value=? WHERE key='password_hash'", (encoded,))
                c.execute("DELETE FROM sessions")
                c.execute("DELETE FROM extension_tokens")
                c.execute("UPDATE import_runs SET status='cancelled',coverage='partial' WHERE status='running'")
            print("Password changed. Sessions and extension tokens revoked. Update .env before a fresh-library restore.")
    except (ValueError, OSError) as exc:
        print(f"Little Archive: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
