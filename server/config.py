from dataclasses import dataclass
from pathlib import Path
import os
from urllib.parse import urlsplit


@dataclass(frozen=True)
class Config:
    data_dir: Path
    admin_password: str = ""
    public_url: str = "http://localhost:8787"
    ollama_url: str = ""
    ollama_model: str = ""
    session_hours: int = 24
    testing: bool = False

    @classmethod
    def from_env(cls):
        return cls(
            data_dir=Path(os.environ.get("LA_DATA_DIR", "./data")).resolve(),
            admin_password=os.environ.get("LA_ADMIN_PASSWORD", ""),
            public_url=os.environ.get("LA_PUBLIC_URL", "http://localhost:8787").rstrip("/"),
            ollama_url=os.environ.get("LA_OLLAMA_URL", "").rstrip("/"),
            ollama_model=os.environ.get("LA_OLLAMA_MODEL", ""),
        )

    def validate(self):
        public_files = (Path(__file__).resolve().parent.parent / "web").resolve()
        if Path(self.data_dir).resolve().is_relative_to(public_files):
            raise ValueError("LA_DATA_DIR must be outside the public web directory.")
        p = urlsplit(self.public_url)
        if p.scheme not in {"http", "https"} or not p.hostname or p.username or p.password or p.path not in {"", "/"} or p.query or p.fragment:
            raise ValueError("LA_PUBLIC_URL must be the application's HTTP(S) origin, without a path.")
        if p.scheme == "http" and p.hostname not in {"localhost", "127.0.0.1", "::1"} and not self.testing:
            raise ValueError("Use HTTPS for a non-loopback LA_PUBLIC_URL.")
        if bool(self.ollama_url) != bool(self.ollama_model):
            raise ValueError("Set both LA_OLLAMA_URL and LA_OLLAMA_MODEL, or neither.")
        if self.ollama_url:
            m = urlsplit(self.ollama_url)
            if m.scheme not in {"http", "https"} or not m.hostname or m.username or m.password or m.query or m.fragment or m.path not in {"", "/"}:
                raise ValueError("LA_OLLAMA_URL must be an operator-configured HTTP(S) origin.")
        if not 1 <= self.session_hours <= 168:
            raise ValueError("Session lifetime must be between one hour and seven days.")

    @property
    def secure_cookies(self):
        return self.public_url.startswith("https://")

    @property
    def allowed_hosts(self):
        return list({urlsplit(self.public_url).hostname, "localhost", "127.0.0.1", "::1"})
