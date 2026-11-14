"""Launcher logic for the Little Archive Mac app. No macOS frameworks are imported here."""
from __future__ import annotations

from contextlib import closing
from dataclasses import dataclass
import errno
import fcntl
import json
import logging
from logging.handlers import RotatingFileHandler
import os
from pathlib import Path
import socket
import sqlite3
import subprocess
import threading
import time
import urllib.request
from urllib.parse import urlsplit

APP_NAME = "Little Archive"
DEFAULT_PORT = 8787  # Matches the Docker/native default and the extension instructions.
LOOPBACK = "127.0.0.1"
SUPPORT_DIR_ENV = "LITTLE_ARCHIVE_SUPPORT_DIR"  # Testing only: use this folder as the library.
NO_BROWSER_ENV = "LITTLE_ARCHIVE_NO_BROWSER"  # Testing only: never launch the default browser.
_PASSWORD_KEY = "LA_ADMIN_PASSWORD"
_MODEL_KEYS = ("LA_OLLAMA_URL", "LA_OLLAMA_MODEL")
_log = logging.getLogger("little_archive.launcher")


class LauncherError(Exception):
    """A failure whose message is safe and useful to show to the owner."""


class AlreadyRunning(Exception):
    """Another copy of the app already serves this library at `url`."""

    def __init__(self, url):
        super().__init__(url)
        self.url = url


# --- Where things live -------------------------------------------------------------

@dataclass(frozen=True)
class AppPaths:
    root: Path      # The library: database, thumbnails, private configuration.
    log_dir: Path

    @property
    def database(self):
        return self.root / "library.sqlite3"

    @property
    def config_file(self):
        return self.root / "config.env"

    @property
    def lock_file(self):
        return self.root / ".instance.lock"

    @property
    def state_file(self):
        return self.root / ".instance.json"

    @property
    def prefs_file(self):
        return self.root / "launcher.json"

    @property
    def log_file(self):
        return self.log_dir / "little-archive.log"


def resolve_paths(environ=None, home=None):
    """The library is `~/Library/Application Support/Little Archive`, never the app bundle."""
    environ = os.environ if environ is None else environ
    override = environ.get(SUPPORT_DIR_ENV, "")
    if override:
        root = Path(override)
        if not root.is_absolute():
            raise LauncherError(f"{SUPPORT_DIR_ENV} must be an absolute folder path.")
        return AppPaths(root=root, log_dir=root / "logs")
    base = Path(home) if home is not None else Path.home()
    if not base.is_absolute():
        raise LauncherError("The home folder could not be determined.")
    return AppPaths(root=base / "Library" / "Application Support" / APP_NAME, log_dir=base / "Library" / "Logs" / APP_NAME)


def ensure_private_directory(path):
    path = Path(path)
    try:
        path.mkdir(parents=True, exist_ok=True, mode=0o700)
        if not path.is_dir():
            raise LauncherError("A file is in the way of the Little Archive folder. Move it, then open the app again.")
        if path.stat().st_uid == os.getuid():
            path.chmod(0o700)
    except OSError as exc:
        raise LauncherError(f"Little Archive cannot use its folder ({exc.strerror or 'access denied'}). Check that your account can write to it.") from exc
    return path


def origin_for(port):
    # `localhost` is what people type and what the extension instructions use. It must
    # match the address the browser opens exactly: the server checks the page origin.
    return f"http://localhost:{port}"


def _is_loopback_origin(url):
    try:
        parts = urlsplit(url)
        return (parts.scheme == "http" and parts.hostname in {"localhost", "127.0.0.1"} and parts.port is not None
                and parts.path in {"", "/"} and not parts.query and not parts.fragment and not parts.username)
    except (ValueError, TypeError):
        return False


# --- Choosing a port ---------------------------------------------------------------

def port_is_taken(port):
    """True if anything accepts connections on this loopback port, on IPv4 or IPv6.

    Either family matters: `localhost` can resolve to ::1, so a service there would
    answer the browser instead of this app. Wildcard listeners are caught as well.
    """
    for family, address in ((socket.AF_INET, "127.0.0.1"), (socket.AF_INET6, "::1")):
        try:
            probe = socket.socket(family, socket.SOCK_STREAM)
        except OSError:
            continue
        with probe:
            probe.settimeout(0.3)
            try:
                if probe.connect_ex((address, port)) == 0:
                    return True
            except OSError:
                continue
    return False


def _bind(port):
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind((LOOPBACK, port))
    except OSError:
        sock.close()
        return None
    return sock


def bind_loopback_listener(preferred=()):
    """Bind a loopback-only socket on the first usable preferred port, else any free one.

    The bound socket is handed to the server instead of a port number, so nothing can
    take the port between choosing it and serving on it.
    """
    seen = set()
    for port in preferred:
        if not isinstance(port, int) or isinstance(port, bool) or not 1024 <= port <= 65535 or port in seen:
            continue
        seen.add(port)
        if port_is_taken(port):
            continue
        sock = _bind(port)
        if sock is not None:
            return sock, port
    for _ in range(20):
        sock = _bind(0)
        if sock is None:
            break
        port = sock.getsockname()[1]
        if not port_is_taken(port):
            return sock, port
        sock.close()
    raise LauncherError("Little Archive could not find a free local port. Close other programs and try again.")


# --- Small private files: remembered port, running-instance state -------------------

def _write_private_json(path, payload):
    temporary = path.with_name(path.name + f".{os.getpid()}.tmp")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump(payload, stream, sort_keys=True)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def _read_json(path):
    try:
        if path.lstat().st_size > 16 * 1024:
            return {}
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def saved_port(paths):
    value = _read_json(paths.prefs_file).get("port")
    return value if isinstance(value, int) and not isinstance(value, bool) and 1024 <= value <= 65535 else None


def _update_prefs(paths, **changes):
    try:
        _write_private_json(paths.prefs_file, {**_read_json(paths.prefs_file), **changes})
        return True
    except OSError:
        return False


def remember_port(paths, port):
    if not _update_prefs(paths, port=port):
        _log.warning("Could not remember the port; the next start will choose again.")


def welcome_acknowledged(paths):
    return _read_json(paths.prefs_file).get("welcome_acknowledged") is True


def acknowledge_welcome(paths):
    if not _update_prefs(paths, welcome_acknowledged=True):
        _log.warning("Could not record that the welcome window was shown; it may appear again.")


# --- One server per library --------------------------------------------------------

class InstanceLock:
    """An advisory lock on the library folder. The OS drops it if the app dies, so it never goes stale."""

    def __init__(self, path):
        self.path = Path(path)
        self._descriptor = None

    def acquire(self):
        descriptor = os.open(self.path, os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0), 0o600)
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            os.close(descriptor)
            if exc.errno in {errno.EWOULDBLOCK, errno.EAGAIN, errno.EACCES}:
                return False
            raise
        self._descriptor = descriptor
        return True

    def release(self):
        if self._descriptor is not None:
            try:
                fcntl.flock(self._descriptor, fcntl.LOCK_UN)
            finally:
                os.close(self._descriptor)
                self._descriptor = None

    @property
    def held(self):
        return self._descriptor is not None


def write_state(paths, port, version):
    _write_private_json(paths.state_file, {"pid": os.getpid(), "port": port, "url": origin_for(port), "version": version})


def read_state(paths):
    data = _read_json(paths.state_file)
    port, pid, url = data.get("port"), data.get("pid"), data.get("url")
    if (not isinstance(port, int) or isinstance(port, bool) or not 1 <= port <= 65535
            or not isinstance(pid, int) or isinstance(pid, bool) or url != origin_for(port)):
        return None
    return {"pid": pid, "port": port, "url": url}


def clear_state(paths):
    if _read_json(paths.state_file).get("pid") == os.getpid():
        try:
            paths.state_file.unlink()
        except FileNotFoundError:
            pass


def probe_health(url, timeout=1.5):
    """True only if a Little Archive server answers its health check on a loopback origin."""
    if not _is_loopback_origin(url):
        return False
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(url.rstrip("/") + "/api/health", timeout=timeout) as response:
            body = json.loads(response.read(4096))
            return response.status == 200 and isinstance(body, dict) and body.get("status") == "ok"
    except (OSError, ValueError):
        return False


def find_running_instance(paths, wait=0.0):
    """URL of the healthy server another copy of the app is running, waiting up to `wait` seconds."""
    deadline = time.monotonic() + wait
    while True:
        state = read_state(paths)
        if state and probe_health(state["url"]):
            return state["url"]
        if time.monotonic() >= deadline:
            return None
        time.sleep(0.25)


# --- Browser and logging -----------------------------------------------------------

def open_in_browser(url, environ=None):
    environ = os.environ if environ is None else environ
    if environ.get(NO_BROWSER_ENV):
        _log.info("Browser launch skipped (%s is set).", NO_BROWSER_ENV)
        return False
    if not _is_loopback_origin(url):
        return False
    try:
        subprocess.run(["/usr/bin/open", url], check=False, timeout=10, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return True
    except (OSError, subprocess.SubprocessError):
        _log.warning("Could not ask macOS to open the default browser.")
        return False


def configure_logging(paths, level=logging.INFO):
    """Log to ~/Library/Logs. The owner password is never passed to any logger."""
    ensure_private_directory(paths.log_dir)
    handler = RotatingFileHandler(paths.log_file, maxBytes=512 * 1024, backupCount=2, encoding="utf-8")
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
    root = logging.getLogger()
    root.addHandler(handler)
    root.setLevel(level)
    try:
        paths.log_file.chmod(0o600)
    except OSError:
        pass
    return handler


# --- The library: first-run configuration, owner password, server ------------------

@dataclass(frozen=True)
class Library:
    config: object
    first_run: bool


def prepare_library(paths, port):
    """Create the private configuration on first run (reusing `server.bootstrap`) and build the server config.

    `setup_configuration` writes a random owner password into `config.env` with owner-only
    permissions and never prints it. Inherited `LA_*` process variables are ignored: only the
    app's own configuration file is read, and the folder and origin are fixed by the app.
    """
    from server.bootstrap import setup_configuration
    from server.config import Config
    from server.configuration import read_env_values

    ensure_private_directory(paths.root)
    first_run = not paths.database.exists()
    result = setup_configuration(paths.config_file, data_dir=str(paths.root), public_url=origin_for(DEFAULT_PORT), apply=True)
    if result["status"] == "blocked" and result["code"] != "existing_library":
        # A library without our configuration is still opened; every other block is a real problem.
        raise LauncherError(f"{result['summary']} {result['next_action']}")
    try:
        values = read_env_values(paths.config_file)
    except ValueError as exc:
        raise LauncherError(f"The private configuration file could not be read. {exc}") from exc
    effective = {key: values[key] for key in (_PASSWORD_KEY, *_MODEL_KEYS) if key in values}
    effective["LA_DATA_DIR"] = str(paths.root)
    effective["LA_PUBLIC_URL"] = origin_for(port)
    config = Config.from_env(effective)
    try:
        config.validate()
    except ValueError as exc:
        raise LauncherError(str(exc)) from exc
    return Library(config=config, first_run=first_run)


def read_owner_password(paths):
    """The password generated at first run, or None if the file is gone. Only ever shown in a window."""
    from server.configuration import read_env_values
    try:
        return read_env_values(paths.config_file).get(_PASSWORD_KEY) or None
    except ValueError:
        return None


class ServerRunner:
    """Runs the library server on an already-bound socket in a background thread."""

    def __init__(self, config, sock):
        self.config, self.sock = config, sock
        self.server = self.thread = self.error = None

    def start(self, timeout=30.0):
        import uvicorn
        from server.app import create_app

        app = create_app(self.config)
        settings = uvicorn.Config(app, log_config=None, access_log=False, proxy_headers=False, workers=1, loop="asyncio",
                                  http="h11", ws="none", lifespan="on", timeout_graceful_shutdown=5)
        self.server = uvicorn.Server(settings)
        self.thread = threading.Thread(target=self._run, name="little-archive-server", daemon=True)
        self.thread.start()
        deadline = time.monotonic() + timeout
        while not self.server.started:
            if not self.thread.is_alive() or time.monotonic() > deadline:
                self.stop(2)
                raise LauncherError("The Little Archive server did not start. See the log for details.")
            time.sleep(0.05)

    def _run(self):
        try:
            self.server.run(sockets=[self.sock])
        except BaseException as exc:
            self.error = exc
            _log.exception("The server stopped with an error.")

    @property
    def running(self):
        return bool(self.thread and self.thread.is_alive() and self.server and self.server.started and not self.server.should_exit)

    def stop(self, timeout=10.0):
        if self.server is not None:
            self.server.should_exit = True
        if self.thread is not None and self.thread.is_alive():
            self.thread.join(timeout)
            if self.thread.is_alive():
                self.server.force_exit = True
                self.thread.join(3)
        try:
            self.sock.close()
        except OSError:
            pass


def checkpoint_library(paths):
    """Fold the write-ahead log into library.sqlite3 so the file alone holds everything after quitting.

    Runs only after the server has stopped, while this app still holds the library lock.
    """
    try:
        if paths.database.exists():
            with closing(sqlite3.connect(paths.database, timeout=5)) as connection:
                connection.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    except sqlite3.Error:
        _log.warning("Could not checkpoint the library database on quit; its write-ahead log is kept and is applied on the next start.")


def _friendly_server_error(exc):
    message = str(exc)
    if _PASSWORD_KEY in message:
        return ("This library has no owner password and the app has no saved one, so it cannot be opened. "
                "See docs/mac-app.md for how to set one with the bundled command-line tool.")
    if "owner password" in message:
        return f"The password saved in this library's config.env cannot be used. {message}"
    return message


class LibraryInstance:
    """Everything the app does except draw windows: lock, configure, serve, clean up."""

    def __init__(self, paths, environ=None):
        self.paths = paths
        self.environ = os.environ if environ is None else environ
        self.lock = InstanceLock(paths.lock_file)
        self.runner = None
        self.port = None
        self.first_run = False

    @property
    def url(self):
        return origin_for(self.port) if self.port else None

    def existing_instance_url(self, wait=0.0):
        """URL of another copy serving this library, without taking the lock. None if there is none."""
        ensure_private_directory(self.paths.root)
        probe = InstanceLock(self.paths.lock_file)
        if probe.acquire():
            probe.release()
            return None
        return find_running_instance(self.paths, wait)

    def start(self):
        from server import __version__

        ensure_private_directory(self.paths.root)
        if not self.lock.acquire():
            url = find_running_instance(self.paths, wait=15.0)
            if url:
                raise AlreadyRunning(url)
            raise LauncherError("Little Archive is already open for this library but is not responding. Quit it from the Dock, then open it again.")
        sock = None
        try:
            sock, port = bind_loopback_listener([saved_port(self.paths), DEFAULT_PORT])
            library = prepare_library(self.paths, port)
            runner = ServerRunner(library.config, sock)
            runner.start()
        except BaseException as exc:
            if sock is not None:
                sock.close()
            self.lock.release()
            if isinstance(exc, ValueError):
                raise LauncherError(_friendly_server_error(exc)) from exc
            if isinstance(exc, OSError):
                raise LauncherError(f"Little Archive could not open its library ({exc.strerror or 'file error'}). Check the folder's permissions and free space.") from exc
            raise
        self.runner, self.port, self.first_run = runner, port, library.first_run
        remember_port(self.paths, port)
        write_state(self.paths, port, __version__)
        _log.info("Serving the library on %s (first run: %s).", self.url, self.first_run)

    @property
    def running(self):
        return bool(self.runner and self.runner.running)

    def owner_password(self):
        return read_owner_password(self.paths)

    def needs_welcome(self):
        """Show the welcome window (with the password) until the owner has clicked through it once.

        This is not tied to the library being new: if a first start failed or the app was quit
        before the window was read, the password must still be shown the next time.
        """
        return not welcome_acknowledged(self.paths) and self.owner_password() is not None

    def acknowledge_welcome(self):
        acknowledge_welcome(self.paths)

    def stop(self):
        runner, self.runner = self.runner, None
        if runner is not None:
            runner.stop()
            checkpoint_library(self.paths)
        clear_state(self.paths)
        self.lock.release()


def run_server_cli(arguments):
    """Run `server.cli` (doctor, reset-password, restore) with the bundled Python."""
    from server.cli import main
    return main(arguments)
