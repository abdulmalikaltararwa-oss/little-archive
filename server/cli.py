"""Local operator commands. Environment values override an optional .env file."""
import argparse
import getpass
import os
from pathlib import Path
import sys

from .config import Config


def load_env(path=Path(".env")):
    if not path.is_file():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        key, sep, value = line.partition("=")
        if not sep or not key.startswith("LA_") or not key.replace("_", "").isalnum():
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
            value = value[1:-1]
        os.environ.setdefault(key, value)


def main():
    load_env()
    parser = argparse.ArgumentParser(prog="little-archive")
    sub = parser.add_subparsers(dest="command", required=True)
    serve = sub.add_parser("serve", help="Start the private library")
    serve.add_argument("--host", default="127.0.0.1")
    serve.add_argument("--port", type=int, default=8787)
    restore = sub.add_parser("restore", help="Restore a verified backup into a NEW directory")
    restore.add_argument("archive")
    restore.add_argument("--destination", required=True)
    sub.add_parser("reset-password", help="Reset the owner password and revoke sessions/tokens while the server is stopped")
    args = parser.parse_args()
    try:
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
