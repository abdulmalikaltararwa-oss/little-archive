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


def delete_account(account_id, confirmed=False):
    """Delete one hosted account at a person's request, by exactly the path `POST /api/account/delete` takes.

    The application is assembled as the server assembles it (so every piece of bookkeeping that follows a deletion is in place)
    but never started: no port is opened and no background work runs. What is printed names no key, token or email address.
    """
    from .account_deletion import remove_account
    from .app import create_app
    from .identity import valid_user_id
    config = Config.from_env()
    if not config.hosted:
        raise ValueError("delete-account is for hosted mode. A self-hosted library is removed by deleting its data directory.")
    try:
        user_id = valid_user_id(account_id)
    except ValueError:
        raise ValueError("That is not an account id. It is the UUID of the account's sign-in.") from None
    app = create_app(config)
    libraries, purchases = app.state.libraries, app.state.purchases
    had_library = (libraries.users / user_id / "library.sqlite3").is_file()
    held = len(purchases.store.listed(user_id)) if purchases is not None else 0
    print(f"Account {user_id}: " + ("a library is on this server" if had_library else "no library is on this server") + f", {held} purchase record(s).")
    if not confirmed and input("This cannot be undone. Type DELETE to delete the account: ").strip() != "DELETE":
        print("Nothing was deleted.")
        return 1
    outcome = remove_account(libraries, app.state.auth_deletions, user_id)
    print("Deleted from this server: the library and its thumbnails, the unlock, purchase and payment records, and any Sign in with Apple token (revoked at Apple if configured).")
    print("Kept, as for every deletion: a deletion record and this period's usage counts, both under a hash, and any purchase a store took back, with no account on it.")
    if outcome == "done":
        print("The sign-in was deleted at the identity provider.")
    elif outcome == "pending":
        print("The sign-in could NOT be deleted at the identity provider yet. It is on record and is retried when the server next runs.")
    else:
        print("The sign-in was NOT deleted: this server has no LA_SUPABASE_SERVICE_KEY. Delete the user in the Supabase dashboard.")
    print("If the server was running, restart it now: it only learns of this deletion when it starts.")
    return 0 if outcome == "done" else 2


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
    remove = sub.add_parser("delete-account", help="Hosted mode: permanently delete one account, as its owner could from the app. Run it while the server is stopped")
    remove.add_argument("account_id", help="The account's id (a UUID, the `sub` of its sign-in)")
    remove.add_argument("--env-file", type=Path, default=Path(".env"))
    remove.add_argument("--yes", action="store_true", help="Do not ask for confirmation")
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
        if args.command in {"serve", "reset-password", "delete-account"}:
            load_env(args.env_file)
        if args.command == "serve":
            import uvicorn
            # Fail clearly before starting the server if operator configuration is invalid.
            Config.from_env().validate()
            uvicorn.run("server.app:create_app", factory=True, host=args.host, port=args.port, workers=1, proxy_headers=False, access_log=False)
        elif args.command == "delete-account":
            return delete_account(args.account_id, confirmed=args.yes)
        elif args.command == "restore":
            from .backups import restore_backup
            manifest = restore_backup(args.archive, args.destination)
            print(f"Restored {manifest['items']} items into {Path(args.destination).resolve()}.")
            print("Set LA_DATA_DIR to that directory and set a new LA_ADMIN_PASSWORD before starting. Existing import tokens are revoked.")
        elif args.command == "reset-password":
            from .devices import DeviceTokens
            from .security import hash_password
            from .storage import Store
            config = Config.from_env()
            if config.hosted:
                raise ValueError("Hosted mode has no owner password; accounts sign in through the identity provider.")
            password = getpass.getpass("New owner password (12+ characters): ")
            if password != getpass.getpass("Repeat password: "):
                raise ValueError("Passwords did not match.")
            encoded = hash_password(password)
            store = Store(config)
            with store.transaction() as c:
                c.execute("UPDATE meta SET value=? WHERE key='password_hash'", (encoded,))
                c.execute("DELETE FROM sessions")
                c.execute("DELETE FROM extension_tokens")
                c.execute("UPDATE import_runs SET status='cancelled',coverage='partial' WHERE status='running'")
            DeviceTokens(config.data_dir).revoke_all()
            print("Password changed. Sessions, device tokens and extension tokens revoked. Update .env before a fresh-library restore.")
    except (ValueError, OSError) as exc:
        print(f"Little Archive: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
