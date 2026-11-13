"""Bounded dotenv reading without shell expansion or persistent side effects."""
from pathlib import Path
import os
import stat


MAX_ENV_BYTES = 64 * 1024


def read_env_values(path=Path(".env")):
    path = Path(path)
    try:
        info = path.lstat()
    except FileNotFoundError:
        return {}
    if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_ENV_BYTES:
        raise ValueError("Configuration must be a regular file under 64 KiB.")
    try:
        descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
        with os.fdopen(descriptor, "rb") as stream:
            if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
                raise ValueError("Configuration must remain a regular file.")
            raw = stream.read(MAX_ENV_BYTES + 1)
        if len(raw) > MAX_ENV_BYTES:
            raise ValueError("Configuration exceeds the size limit.")
        text = raw.decode("utf-8")
    except (OSError, UnicodeError) as exc:
        raise ValueError("Configuration could not be read as UTF-8 text.") from exc
    result = {}
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        key, sep, value = line.partition("=")
        if not sep or not key.startswith("LA_") or not key.replace("_", "").isalnum():
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
            value = value[1:-1]
        # Preserve the historical first-definition-wins behavior. Never execute
        # expansions, source the file, or expose its values in diagnostics.
        result.setdefault(key, value)
    return result
