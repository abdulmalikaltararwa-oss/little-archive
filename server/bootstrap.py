"""Preview or create initial private configuration; never overwrite a library."""
from pathlib import Path
import os
import secrets
import stat
import tempfile
import unicodedata

from . import __version__
from .config import Config


def _result(status, code, summary, next_action, *, applied=False):
    return {
        "format": "little-archive-setup", "schema_version": 1,
        "application_version": __version__, "status": status, "code": code,
        "summary": summary, "next_action": next_action, "applied": applied,
        "credentials_in_output": False,
    }


def setup_configuration(config_file=Path(".env"), *, data_dir="./data",
                        public_url="http://localhost:8787", apply=False):
    """Create configuration only. Dependencies, runtime and data are untouched.

    Paths are local inputs, not echoed into shareable JSON. Existing configuration
    is retained even when new options are supplied. A separate update operation
    is required to change an existing installation.
    """
    target = Path(config_file)
    try:
        public_web = Path(__file__).resolve().parent.parent / "web"
        if target.resolve().is_relative_to(public_web.resolve()):
            return _result("blocked", "configuration_in_public_directory", "Configuration cannot be placed in the public web directory.", "Choose a private configuration location outside web.")
        existing = target.lstat()
    except FileNotFoundError:
        existing = None
    except (OSError, ValueError, RuntimeError):
        return _result("blocked", "configuration_unreadable", "The configuration location cannot be inspected.", "Check the selected directory's permissions.")
    if existing is not None:
        if not stat.S_ISREG(existing.st_mode):
            return _result("blocked", "configuration_not_regular", "The selected configuration is not a regular file.", "Choose a private regular configuration file; symbolic links are not followed.")
        return _result("unchanged", "configuration_exists", "Existing configuration was retained; new setup options were not applied.", "Run doctor against this configuration before starting the library.")
    try:
        if not target.parent.is_dir():
            return _result("blocked", "configuration_parent_missing", "The configuration's parent directory does not exist.", "Create a private parent directory, then repeat the preview.")
        data_value = str(data_dir)
        if not data_value or data_value != data_value.strip() or any(unicodedata.category(c) in {"Cc", "Cs", "Zl", "Zp"} for c in data_value):
            raise ValueError("Invalid data directory.")
        # Configuration is plain dotenv, without interpolation. Quote-boundary
        # ambiguity must not change the intended filesystem path when reloaded.
        if data_value[0] in "\"'" or data_value[-1] in "\"'":
            raise ValueError("Invalid data directory.")
        config = Config(data_dir=Path(data_value).resolve(), public_url=public_url)
        config.validate()
        database = config.data_dir / "library.sqlite3"
        if database.exists() or database.is_symlink():
            return _result("blocked", "existing_library", "A library already exists at the selected data location.", "Use its existing configuration and recovery instructions; fresh setup will not replace its credentials.")
        if config.data_dir.exists() and not config.data_dir.is_dir():
            raise ValueError("The data location is not a directory.")
    except (ValueError, OSError, RuntimeError):
        return _result("blocked", "invalid_configuration", "The selected origin or data location is not valid for a private library.", "Use an HTTP loopback or HTTPS origin and a data directory outside web, without control characters.")
    if not apply:
        return _result("planned", "configuration_will_be_created", "Setup will create one private configuration file with a generated owner password. It will not start services or create library data.", "Repeat with --apply to create the configuration, or choose different setup options.")
    password = secrets.token_urlsafe(32)
    content = (
        "# Private Little Archive configuration. Do not share or commit.\n"
        f"LA_ADMIN_PASSWORD={password}\nLA_PUBLIC_URL={public_url}\n"
        f"LA_DATA_DIR={data_value}\nLA_OLLAMA_URL=\nLA_OLLAMA_MODEL=\n"
    )
    staged = None
    try:
        # Write completely before publishing the name. A hard link is atomic and
        # refuses an existing destination, unlike replace/rename. A killed setup
        # can leave an ignored private staging file, never a partial active .env.
        descriptor, staged_name = tempfile.mkstemp(prefix=".env.setup-", dir=target.parent)
        staged = Path(staged_name)
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.link(staged, target, follow_symlinks=False)
    except FileExistsError:
        return _result("unchanged", "configuration_exists", "Another setup created the configuration; it was retained unchanged.", "Run doctor against the existing configuration.")
    except (OSError, UnicodeError):
        return _result("blocked", "configuration_write_failed", "The private configuration could not be published completely.", "Check permissions and free disk space on a filesystem supporting hard links, then repeat the preview.")
    finally:
        if staged is not None:
            try:
                staged.unlink()
            except OSError:
                pass
    return _result("created", "configuration_created", "Private configuration was created. The generated owner password is stored only in that file.", "Open the configuration locally to retrieve the password, run doctor, then start the library using the documented native or Docker path.", applied=True)
