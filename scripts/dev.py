#!/usr/bin/env python3
"""Development entry point, using the same authentication as the production app."""
import argparse
import os
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
os.chdir(ROOT)
from server.cli import load_env

load_env()
parser = argparse.ArgumentParser()
parser.add_argument("--host", default="0.0.0.0")
parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", "8787")))
parser.add_argument("--strictPort", action="store_true", help="Compatibility flag; Uvicorn already refuses an occupied port.")
args = parser.parse_args()
import uvicorn

uvicorn.run("server.app:create_app", factory=True, host=args.host, port=args.port, workers=1, proxy_headers=False, access_log=False)
