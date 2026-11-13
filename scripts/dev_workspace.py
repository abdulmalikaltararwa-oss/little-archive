"""Owned contributor data, separate from production .env and LA_* settings.

Inspection is read-only and returns only relative paths and fixed diagnostics.
The helper can be imported without application dependencies or filesystem writes.
"""
from contextlib import contextmanager
from dataclasses import dataclass, field
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import stat
from uuid import uuid4

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8788
WORKSPACE_RELATIVE = Path("work") / "contributor-dev"
FORMAT = "little-archive-contributor-workspace"
CONFIG_LIMIT = 4096
MAX_TREE_ENTRIES = 10000
MAX_TREE_BYTES = 512 * 1024 * 1024
MAX_TREE_DEPTH = 12
SEED_KEY = "contributor_fixture_version"


class WorkspaceError(ValueError):
    """A fixed, credential-free explanation safe for local diagnostics."""


@dataclass(frozen=True)
class WorkspacePaths:
    repository: Path
    root: Path
    config: Path
    password: Path
    data: Path
    lock: Path


@dataclass(frozen=True)
class DevWorkspace:
    paths: WorkspacePaths
    metadata: dict = field(repr=False)


def workspace_paths(repo_root):
    supplied = Path(repo_root)
    if supplied.is_symlink():
        raise WorkspaceError("The repository directory must not be a symbolic link.")
    repository = supplied.resolve(strict=True)
    if not repository.is_dir():
        raise WorkspaceError("The repository directory is unavailable.")
    root = repository / WORKSPACE_RELATIVE
    return WorkspacePaths(repository, root, root / "config.json", root / "owner-password.txt", root / "data", root / "workspace.lock")


def _checked_stat(path, *, directory=False, private=False):
    try:
        info = path.lstat()
    except FileNotFoundError:
        raise WorkspaceError("The development workspace is incomplete or not initialized.") from None
    valid = stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)
    if not valid:
        raise WorkspaceError("Refusing a symbolic link or unexpected file type in the development workspace.")
    if hasattr(os, "getuid") and info.st_uid != os.getuid():
        raise WorkspaceError("The development workspace must be owned by the current user.")
    if not directory and info.st_nlink != 1:
        raise WorkspaceError("Refusing a hard-linked file in the development workspace.")
    if private and stat.S_IMODE(info.st_mode) & 0o077:
        raise WorkspaceError("Development configuration and credentials must be private to the current user.")
    return info


def _check_directories(paths):
    _checked_stat(paths.repository, directory=True)
    _checked_stat(paths.root.parent, directory=True)
    _checked_stat(paths.root, directory=True, private=True)
    _checked_stat(paths.data, directory=True)


def _read_private(path, limit):
    before = _checked_stat(path, private=True)
    if before.st_size > limit:
        raise WorkspaceError("Development configuration exceeds its supported size.")
    # A regular file can be replaced between lstat and open. O_NONBLOCK keeps a
    # substituted FIFO from hanging inspection before fstat rejects its identity.
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NONBLOCK", 0)
    fd = os.open(path, flags)
    try:
        opened = os.fstat(fd)
        if (before.st_dev, before.st_ino) != (opened.st_dev, opened.st_ino):
            raise WorkspaceError("Development configuration changed while it was being inspected.")
        value = os.read(fd, limit + 1)
        if len(value) > limit:
            raise WorkspaceError("Development configuration exceeds its supported size.")
        return value
    finally:
        os.close(fd)


def _fingerprint(paths):
    return hashlib.sha256(os.fsencode(str(paths.repository))).hexdigest()


def _read_workspace(paths):
    _check_directories(paths)
    try:
        metadata = json.loads(_read_private(paths.config, CONFIG_LIMIT))
    except (ValueError, UnicodeError, RecursionError):
        raise WorkspaceError("Development configuration is invalid; no existing files were adopted.") from None
    expected = {"format", "version", "repository_fingerprint", "workspace_id", "data_dir", "password_file", "seed_version"}
    if not isinstance(metadata, dict) or set(metadata) != expected:
        raise WorkspaceError("This directory is not an owned development workspace.")
    if (metadata["format"] != FORMAT or type(metadata["version"]) is not int or metadata["version"] != 1
            or metadata["repository_fingerprint"] != _fingerprint(paths)
            or metadata["data_dir"] != "data" or metadata["password_file"] != "owner-password.txt"
            or not isinstance(metadata["workspace_id"], str) or not re.fullmatch(r"[a-f0-9]{32}", metadata["workspace_id"])
            or type(metadata["seed_version"]) is not int or metadata["seed_version"] not in {0, 1}):
        raise WorkspaceError("This directory is not an owned development workspace for this checkout.")
    _read_password(paths)
    _read_private(paths.lock, 1)
    return DevWorkspace(paths, metadata)


def _read_password(paths):
    try:
        password = _read_private(paths.password, 129).decode("ascii").rstrip("\n")
    except (ValueError, UnicodeError):
        raise WorkspaceError("The private development password file is invalid.") from None
    if not re.fullmatch(r"[A-Za-z0-9_-]{32,128}", password):
        raise WorkspaceError("The private development password file is invalid.")
    return password


def _write_private(path, data):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
    with os.fdopen(fd, "wb") as output:
        output.write(data)
        output.flush()
        os.fsync(output.fileno())


def _write_metadata(paths, metadata):
    _checked_stat(paths.config, private=True)
    temporary = paths.root / ("config-" + uuid4().hex + ".tmp")
    try:
        _write_private(temporary, (json.dumps(metadata, sort_keys=True) + "\n").encode())
        os.replace(temporary, paths.config)
    finally:
        if temporary.exists():
            temporary.unlink()


def prepare_workspace(repo_root):
    """Create only the fixed ignored workspace; preserve all existing owned data."""
    paths = workspace_paths(repo_root)
    if paths.root.parent.exists() or paths.root.parent.is_symlink():
        _checked_stat(paths.root.parent, directory=True)
    else:
        paths.root.parent.mkdir(mode=0o700)
    try:
        paths.root.mkdir(mode=0o700)
    except FileExistsError:
        return _read_workspace(paths)
    paths.data.mkdir(mode=0o700)
    metadata = {
        "format": FORMAT,
        "version": 1,
        "repository_fingerprint": _fingerprint(paths),
        "workspace_id": uuid4().hex,
        "data_dir": "data",
        "password_file": "owner-password.txt",
        "seed_version": 0,
    }
    # Publish the ownership configuration last. Interrupted setup is refused on
    # the next run, rather than adopting a partially populated personal folder.
    _write_private(paths.password, (secrets.token_urlsafe(32) + "\n").encode())
    _write_private(paths.lock, b"")
    _write_private(paths.config, (json.dumps(metadata, sort_keys=True) + "\n").encode())
    return _read_workspace(paths)


def _scan_owned_tree(paths):
    """Preflight before opening SQLite or deleting anything; never follow links."""
    root_info = _checked_stat(paths.root, directory=True, private=True)
    pending = [(paths.root, 0)]
    count = size = 0
    while pending:
        directory, depth = pending.pop()
        if depth > MAX_TREE_DEPTH:
            raise WorkspaceError("Development workspace nesting exceeds the safe operation limit.")
        with os.scandir(directory) as entries:
            for entry in entries:
                count += 1
                if count > MAX_TREE_ENTRIES:
                    raise WorkspaceError("Development workspace file count exceeds the safe operation limit.")
                info = entry.stat(follow_symlinks=False)
                if info.st_dev != root_info.st_dev:
                    raise WorkspaceError("Refusing a mounted filesystem inside the development workspace.")
                child = Path(entry.path)
                if stat.S_ISDIR(info.st_mode):
                    _checked_stat(child, directory=True)
                    pending.append((child, depth + 1))
                elif stat.S_ISREG(info.st_mode):
                    _checked_stat(child)
                    size += info.st_size
                    if size > MAX_TREE_BYTES:
                        raise WorkspaceError("Development workspace size exceeds the safe operation limit.")
                else:
                    raise WorkspaceError("Refusing a symbolic link or unexpected file type in the development workspace.")


@contextmanager
def workspace_lock(workspace):
    """Hold an OS-released lock for the server, seeding, or owned cleanup."""
    try:
        import fcntl
    except ImportError:
        raise WorkspaceError("The contributor launcher currently supports macOS and Linux filesystem locking.") from None
    current = _read_workspace(workspace.paths)
    if current.metadata["workspace_id"] != workspace.metadata["workspace_id"]:
        raise WorkspaceError("The development workspace was replaced; stop and retry.")
    before = _checked_stat(current.paths.lock, private=True)
    fd = os.open(current.paths.lock, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0))
    try:
        opened = os.fstat(fd)
        if (before.st_dev, before.st_ino) != (opened.st_dev, opened.st_ino):
            raise WorkspaceError("The development workspace lock was replaced.")
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise WorkspaceError("The development workspace is in use. Stop its server before this operation.") from None
        _scan_owned_tree(current.paths)
        yield
    finally:
        os.close(fd)


def inspect_workspace(repo_root):
    """Return read-only diagnostics; paths are relative and secrets never escape."""
    relative = WORKSPACE_RELATIVE.as_posix()
    report = {
        "status": "missing", "path": relative, "config_path": relative + "/config.json",
        "password_path": relative + "/owner-password.txt", "data_dir": relative + "/data",
        "seeded": False, "errors": [],
    }
    try:
        paths = workspace_paths(repo_root)
        if not paths.root.exists() and not paths.root.is_symlink():
            # An unsafe parent is still a useful failure, even before setup.
            if paths.root.parent.exists() or paths.root.parent.is_symlink():
                _checked_stat(paths.root.parent, directory=True)
            return report
        workspace = _read_workspace(paths)
        _scan_owned_tree(paths)
        report.update(status="ready", seeded=workspace.metadata["seed_version"] == 1)
    except WorkspaceError as exc:
        report.update(status="invalid", errors=[str(exc)])
    except OSError:
        report.update(status="invalid", errors=["Cannot safely inspect the development workspace."])
    return report


def server_config(workspace, *, host=DEFAULT_HOST, port=DEFAULT_PORT):
    """Construct explicit local configuration; do not read .env or LA_* values."""
    if host not in {"127.0.0.1", "localhost", "::1"} or type(port) is not int or not 1 <= port <= 65535:
        raise WorkspaceError("Development serving requires a loopback host and a valid port.")
    current = _read_workspace(workspace.paths)
    if current.metadata["workspace_id"] != workspace.metadata["workspace_id"]:
        raise WorkspaceError("The development workspace was replaced; stop and retry.")
    from server.config import Config
    origin_host = "[::1]" if host == "::1" else host
    config = Config(data_dir=current.paths.data, admin_password=_read_password(current.paths), public_url=f"http://{origin_host}:{port}", ollama_url="", ollama_model="")
    config.validate()
    return config


@contextmanager
def clean_app_environment():
    """Prevent future environment-reading app code from inheriting production LA_* values."""
    saved = {key: value for key, value in os.environ.items() if key.startswith("LA_")}
    for key in saved:
        os.environ.pop(key, None)
    try:
        yield
    finally:
        for key in tuple(os.environ):
            if key.startswith("LA_"):
                del os.environ[key]
        os.environ.update(saved)


def seed_workspace(workspace):
    """Apply the original synthetic fixture once, atomically with a database marker."""
    with workspace_lock(workspace), clean_app_environment():
        from server.demo import demo_items
        from server.storage import Store
        store = Store(server_config(workspace))
        created = 0
        with store.transaction() as connection:
            if not connection.execute("SELECT 1 FROM meta WHERE key=?", (SEED_KEY,)).fetchone():
                for record in demo_items():
                    _, is_new = store.apply_item(connection, record, account="demo", portable=True)
                    created += int(is_new)
                connection.execute("INSERT INTO meta VALUES(?,?)", (SEED_KEY, "1"))
        current = _read_workspace(workspace.paths)
        if current.metadata["seed_version"] != 1:
            _write_metadata(current.paths, {**current.metadata, "seed_version": 1})
        return created


def cleanup_workspace(repo_root):
    """Remove only an owned, stopped, bounded tree at the fixed development path."""
    workspace = _read_workspace(workspace_paths(repo_root))
    if not getattr(shutil.rmtree, "avoids_symlink_attacks", False):
        raise WorkspaceError("Safe development cleanup is unavailable on this filesystem platform.")
    with workspace_lock(workspace):
        # The lock preflight validates every entry and all limits before removal.
        # Python's fd-based rmtree prevents traversing a replaced child symlink.
        shutil.rmtree(workspace.paths.root)
