#!/usr/bin/env python3
"""Generate private local configuration. Never overwrite an existing .env."""
from pathlib import Path
import os
import secrets

ROOT = Path(__file__).resolve().parent.parent
target = ROOT / ".env"
if target.exists():
    raise SystemExit(".env already exists and was left unchanged. Edit it directly to change configuration.")
password = secrets.token_urlsafe(24)
fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, "w") as f:
    f.write("# Keep this file private. It is excluded from git.\n")
    f.write(f"LA_ADMIN_PASSWORD={password}\n")
    f.write("LA_PUBLIC_URL=http://localhost:8787\nLA_DATA_DIR=./data\n")
    f.write("LA_OLLAMA_URL=\nLA_OLLAMA_MODEL=\n")
print("Created private .env configuration.")
print("Open .env locally to retrieve your generated owner password. It is not printed in logs.")
print("Run: docker compose up -d --build")
print("Then open http://localhost:8787 and sign in.")
