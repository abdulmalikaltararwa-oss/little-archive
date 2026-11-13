"""Small, explicit single-owner authentication primitives; no external identity service."""
import hashlib
import hmac
import secrets
from collections import defaultdict, deque
from threading import Lock
import time


def token_hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def validate_password(password: str) -> None:
    if not isinstance(password, str):
        raise ValueError("Use a text owner password.")
    if password == "replace-with-a-unique-password-of-at-least-12-characters":
        raise ValueError("Replace the example owner password, or run scripts/setup.py to generate private configuration.")
    if len(password) < 12 or len(password) > 1024:
        raise ValueError("Use an owner password between 12 and 1,024 characters.")
    try:
        password.encode("utf-8")
    except UnicodeError as exc:
        raise ValueError("Use an owner password that can be encoded as UTF-8.") from exc


def hash_password(password: str) -> str:
    validate_password(password)
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, n=16384, r=8, p=1, dklen=32)
    return f"scrypt$16384$8$1${salt.hex()}${digest.hex()}"


def verify_password(password: str, encoded: str) -> bool:
    try:
        algorithm, n, r, p, salt, expected = encoded.split("$")
        if algorithm != "scrypt" or len(password) > 1024:
            return False
        actual = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt), n=int(n), r=int(r), p=int(p), dklen=32)
        return hmac.compare_digest(actual.hex(), expected)
    except (ValueError, TypeError):
        return False


class RateLimiter:
    """Bound login attempts per peer. Use one server worker for this SQLite deployment."""
    def __init__(self, limit=10, window=900):
        self.limit, self.window = limit, window
        self._attempts = defaultdict(deque)
        self._lock = Lock()

    def consume(self, peer):
        now = time.monotonic()
        with self._lock:
            # Bound the map even when many different peers try logging in.
            if len(self._attempts) >= 10000 and peer not in self._attempts:
                stale = [key for key, attempts in self._attempts.items() if not attempts or attempts[-1] < now - self.window]
                for key in stale:
                    del self._attempts[key]
                if len(self._attempts) >= 10000:
                    return False
            q = self._attempts[peer]
            while q and q[0] < now - self.window:
                q.popleft()
            if len(q) >= self.limit:
                return False
            q.append(now)
            return True

    def clear(self, peer):
        with self._lock:
            self._attempts.pop(peer, None)
