"""Read-only, bounded diagnostics. Never open Store or disclose private values."""
from datetime import datetime, timezone
from importlib import metadata
from pathlib import Path
import json
import os
import platform
import re
import shutil
import socket
import stat
import sys
import time

from . import __version__
from .config import Config
from .configuration import read_env_values
from .security import validate_password


CONFIG_KEYS = ("LA_ADMIN_PASSWORD", "LA_DATA_DIR", "LA_PUBLIC_URL", "LA_OLLAMA_URL", "LA_OLLAMA_MODEL", "LA_MODE", "LA_SUPABASE_URL")
DEPENDENCIES = ("fastapi", "uvicorn", "httpx", "Pillow")
HOSTED_DEPENDENCIES = ("PyJWT", "cryptography")


def check(identifier, status, code, summary, next_action=None, **details):
    result = {"id": identifier, "status": status, "code": code, "summary": summary}
    if next_action:
        result["next_action"] = next_action
    if details:
        result["details"] = details
    return result


def _response_json(client, url, limit, deadline):
    with client.stream("GET", url, headers={"Accept-Encoding": "identity"}) as response:
        if response.status_code != 200:
            raise ProbeFailure("service_rejected", "The configured model service rejected the health request.")
        if response.headers.get("content-encoding", "identity").strip().lower() not in {"", "identity"}:
            raise ProbeFailure("encoded_response", "The model health endpoint ignored the uncompressed-response requirement.")
        chunks, size = [], 0
        for chunk in response.iter_bytes(chunk_size=16 * 1024):
            size += len(chunk)
            if size > limit or time.monotonic() > deadline:
                raise ProbeFailure("response_limit", "The model health response exceeded its size or time limit.")
            chunks.append(chunk)
    try:
        return json.loads(b"".join(chunks))
    except (ValueError, UnicodeError, RecursionError) as exc:
        raise ProbeFailure("invalid_response", "The model service returned an unsupported health response.") from exc


def _hosted_checks(database):
    """Hosted mode has no owner library or password; accounts are never opened here."""
    rows = []
    if database.exists() or database.is_symlink():
        rows.append(check("database", "failed", "single_owner_library_present", "The data location holds a single-owner library, which hosted mode refuses to start beside.", "Choose a separate data directory for hosted mode."))
    else:
        rows.append(check("database", "passed", "per_account_libraries", "Hosted mode keeps one library per account. Diagnostics did not open or count them."))
    rows.append(check("owner_access", "passed", "identity_provider_sign_in", "Hosted mode verifies identity-provider access tokens; there is no owner password. Signing keys were not requested."))
    for name in HOSTED_DEPENDENCIES:
        try:
            rows.append(check("dependency_" + name.lower(), "passed", "dependency_installed", "A package required for hosted sign-in is installed.", package=name, version=metadata.version(name)))
        except metadata.PackageNotFoundError:
            rows.append(check("dependency_" + name.lower(), "failed", "dependency_missing", "A package required for hosted sign-in is missing.", "Install requirements.txt using the selected Python environment.", package=name))
    return rows


class ProbeFailure(ValueError):
    def __init__(self, code, summary):
        self.code, self.summary = code, summary
        super().__init__(summary)


def probe_ollama(config, *, client=None):
    """Only version/model-list GETs; no inference, downloads, or runtime changes."""
    if not config.ollama_url and not config.ollama_model:
        return check("local_ai", "passed", "ai_disabled", "AI is disabled; the core library can be used without a model.", network_requested=False)
    try:
        config.validate()
    except (ValueError, OSError, RuntimeError):
        return check("local_ai", "failed", "ai_configuration_invalid", "Model configuration is invalid.", "Set a valid origin and model together, or leave both empty.")
    try:
        import httpx
    except ImportError:
        return check("local_ai", "failed", "probe_dependency_missing", "The model probe requires the application's HTTP dependency.", "Install the locked application requirements first.")
    owned = client is None
    if owned:
        client = httpx.Client(timeout=httpx.Timeout(3, connect=2, write=2, pool=2), follow_redirects=False, trust_env=False)
    try:
        deadline = time.monotonic() + 6
        version = _response_json(client, config.ollama_url.rstrip("/") + "/api/version", 16 * 1024, deadline)
        runtime_version = version.get("version") if isinstance(version, dict) else None
        if not isinstance(runtime_version, str) or not re.fullmatch(r"[0-9]+(?:\.[0-9]+){1,3}(?:[-+][A-Za-z0-9.-]{1,40})?", runtime_version):
            raise ProbeFailure("invalid_response", "The model service did not return a supported version response.")
        body = _response_json(client, config.ollama_url.rstrip("/") + "/api/tags", 1024 * 1024, deadline)
        models = body.get("models") if isinstance(body, dict) else None
        if not isinstance(models, list) or len(models) > 512 or any(not isinstance(row, dict) for row in models):
            raise ProbeFailure("invalid_response", "The model service did not return a bounded model inventory.")
        requested = config.ollama_model
        aliases = {requested}
        if ":" not in requested.rsplit("/", 1)[-1]:
            aliases.add(requested + ":latest")
        selected = next((row for row in models if any(isinstance(row.get(key), str) and row[key] in aliases for key in ("name", "model"))), None)
        if selected is None:
            return check("local_ai", "failed", "model_missing", "The runtime is reachable, but the selected model is not in its inventory.", "Install the selected model in this runtime or select an installed model. Check from the backend's environment.", runtime_version=runtime_version, installed_model_count=len(models), inference_tested=False)
        known_remote = bool(selected.get("remote_host") or selected.get("remote_model") or requested.endswith(":cloud"))
        return check("local_ai", "warning" if known_remote else "passed", "remote_model_selected" if known_remote else "model_available",
                     "The selected model is present, but its metadata indicates remote processing." if known_remote else "The runtime is reachable and the selected model is present. Inference has not been tested.",
                     "Review the processing location and local-only runtime settings before sending library evidence.",
                     runtime_version=runtime_version, installed_model_count=len(models), inference_tested=False,
                     processing_location="remote_indicated" if known_remote else "unverified", local_processing_verified=False)
    except ProbeFailure as exc:
        return check("local_ai", "failed", exc.code, exc.summary, "Check the selected runtime's version, model inventory, and configuration.")
    except httpx.TimeoutException:
        return check("local_ai", "failed", "model_service_timeout", "The model service did not respond within the health-check deadline.", "Check that the runtime is running and reachable from the application backend.")
    except (httpx.HTTPError, OSError, ValueError, TypeError):
        return check("local_ai", "failed", "model_service_unreachable", "The configured model service could not be checked.", "Check the runtime and backend-to-runtime connection; no service settings were changed.")
    finally:
        if owned:
            client.close()


def diagnose(*, env_file=Path(".env"), environment=None, check_ai=False, check_port=False, port=8787, model_client=None):
    """Inspect config/filesystem; optional explicit GET/connect probes only.

    The library database is never opened, including in SQLite read-only mode:
    opening an active WAL database can touch shared-memory files. Header presence
    is useful evidence, but is not presented as a full integrity/authentication test.
    """
    environment = dict(os.environ if environment is None else environment)
    checks = []
    supported_python = sys.version_info[:2] == (3, 12)
    old_python = sys.version_info < (3, 12)
    checks.append(check("python", "passed" if supported_python else "failed" if old_python else "warning", "python_supported" if supported_python else "python_too_old" if old_python else "python_version_unverified", "Python 3.12 is the packaged and verified source runtime. Other versions require separate verification.", version=platform.python_version()))
    for name in DEPENDENCIES:
        try:
            version = metadata.version(name)
            if not re.fullmatch(r"[A-Za-z0-9.!+_-]{1,80}", version):
                raise metadata.PackageNotFoundError(name)
            checks.append(check("dependency_" + name.lower(), "passed", "dependency_installed", "A required application package is installed.", package=name, version=version))
        except metadata.PackageNotFoundError:
            checks.append(check("dependency_" + name.lower(), "failed", "dependency_missing", "A required application package is missing.", "Install requirements.txt using the selected Python environment.", package=name))
    values = {}
    try:
        if Path(env_file).resolve().is_relative_to((Path(__file__).resolve().parent.parent / "web").resolve()):
            raise ValueError("Configuration is in the public directory.")
        values = read_env_values(env_file)
        checks.append(check("configuration_file", "passed" if Path(env_file).exists() else "warning", "configuration_read" if Path(env_file).exists() else "configuration_absent", "Configuration values were read without executing expansions." if Path(env_file).exists() else "No configuration file was found; environment values and defaults are being inspected."))
        if Path(env_file).exists() and os.name != "nt" and stat.S_IMODE(Path(env_file).stat().st_mode) & 0o077:
            checks.append(check("configuration_permissions", "warning", "configuration_permissions_broad", "The configuration file is readable by more than its owner.", "Restrict the private configuration file to owner access."))
    except (ValueError, OSError, RuntimeError):
        checks.append(check("configuration_file", "failed", "configuration_unreadable", "Configuration is not a readable bounded regular UTF-8 file.", "Check the chosen file's type, size, encoding, and permissions. No values were printed."))
    effective = {**values, **environment}
    sources = {key: "environment" if key in environment else "file" if key in values else "default" for key in CONFIG_KEYS}
    try:
        config = Config.from_env(effective)
        config.validate()
        checks.append(check("configuration", "passed", "configuration_valid", "Configured origins and the data location passed validation.", sources=sources))
    except (ValueError, OSError, RuntimeError, TypeError):
        checks.append(check("configuration", "failed", "configuration_invalid", "An origin, model setting, mode setting, or data location is invalid.", "Use an HTTP loopback or HTTPS public origin, keep data outside web, and configure both model fields or neither. Hosted mode also needs its identity-provider settings and no owner password.", sources=sources))
        config = None
    if config is not None:
        data = config.data_dir
        database = data / "library.sqlite3"
        try:
            if data.exists() and not data.is_dir():
                checks.append(check("data_directory", "failed", "data_location_not_directory", "The configured data location is not a directory.", "Select a private directory outside web."))
            else:
                nearest = data
                for _ in range(128):
                    if nearest.exists() or nearest.parent == nearest:
                        break
                    nearest = nearest.parent
                writable = os.access(nearest, os.W_OK | os.X_OK)
                checks.append(check("data_directory", "passed" if writable else "failed", "data_location_accessible" if writable else "data_location_not_writable", "The data location or nearest existing parent is accessible." if writable else "The data location cannot be written by this process.", "The library directory will be created only when the server starts." if writable and not data.exists() else None, exists=data.exists()))
                free = shutil.disk_usage(nearest).free
                checks.append(check("disk_space", "warning" if free < 256 * 1024 * 1024 else "passed", "disk_space_low" if free < 256 * 1024 * 1024 else "disk_space_available", "Less than 256 MiB is free at the data location." if free < 256 * 1024 * 1024 else "Free disk space is available at the data location.", "Model downloads and backups need additional space; this is not a capacity guarantee.", free_bytes=free))
            if config.hosted:
                checks.extend(_hosted_checks(database))
            elif database.is_symlink():
                checks.append(check("database", "failed", "database_symlink", "The database path is a symbolic link; diagnostics did not follow it.", "Review the data location before starting the application."))
            elif database.exists():
                if not database.is_file():
                    checks.append(check("database", "failed", "database_not_regular", "The database path is not a regular file.", "Review the selected library directory."))
                else:
                    with database.open("rb") as stream:
                        header = stream.read(16)
                    checks.append(check("database", "passed" if header == b"SQLite format 3\x00" else "failed", "sqlite_header_present" if header == b"SQLite format 3\x00" else "database_header_unrecognized", "A SQLite header is present. Schema, contents, and recovery integrity were not inspected." if header == b"SQLite format 3\x00" else "The existing database header is not recognized; it was left untouched."))
            else:
                checks.append(check("database", "passed", "library_not_initialized", "No library database exists. Diagnostics did not create one."))
            password = config.admin_password
            if config.hosted:
                pass  # Reported above: accounts sign in through the identity provider.
            elif password:
                try:
                    validate_password(password)
                    checks.append(check("owner_access", "passed", "owner_password_configured", "An owner password is configured and passes startup validation."))
                except ValueError:
                    checks.append(check("owner_access", "failed", "owner_password_invalid", "The configured owner password does not pass startup validation.", "Replace the example placeholder and use a private password between 12 and 1,024 characters."))
            elif database.exists():
                checks.append(check("owner_access", "warning", "existing_authentication_unchecked", "An existing database is present; its stored owner authentication was not inspected.", "Use the normal sign-in or documented stopped-server password recovery."))
            else:
                checks.append(check("owner_access", "failed", "owner_password_missing", "An owner password is needed before a new library can start.", "Run setup --dry-run, then setup --apply, or provide a private owner password locally."))
        except (OSError, ValueError):
            checks.append(check("filesystem", "failed", "filesystem_unreadable", "The library location could not be inspected completely.", "Check permissions and the selected data location. No database operations were performed."))
        if check_ai:
            checks.append(probe_ollama(config, client=model_client))
        else:
            checks.append(check("local_ai", "skipped" if config.ollama_url else "passed", "ai_not_probed" if config.ollama_url else "ai_disabled", "Model settings are present; no network request or inference was made." if config.ollama_url else "AI is disabled; the core library can be used without a model.", "Use --check-ai for bounded version and model-list requests." if config.ollama_url else None))
    if check_port:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=1):
                occupied = True
        except ConnectionRefusedError:
            occupied = False
        except OSError:
            occupied = None
        checks.append(check("loopback_port", "warning" if occupied is not False else "passed", "port_occupied" if occupied else "port_not_accepting" if occupied is False else "port_unchecked", "A service accepts connections on the selected loopback port; its identity was not checked." if occupied else "No service accepted the loopback connection at check time." if occupied is False else "The selected loopback port could not be checked.", "An occupied port may be your running archive. Check its identity before starting another service; diagnostics never stop services.", port=port))
    failed = any(row["status"] == "failed" for row in checks)
    warnings = any(row["status"] == "warning" for row in checks)
    return {
        "format": "little-archive-diagnostics", "schema_version": 1,
        "application_version": __version__, "checked_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "status": "blocked" if failed else "attention" if warnings else "ok", "exit_code": 1 if failed else 0,
        "read_only": True, "network_checks_requested": bool(check_ai or check_port),
        "private_values_included": False, "checks": checks,
    }
