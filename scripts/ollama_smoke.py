#!/usr/bin/env python3
"""Exercise the real application worker against a real operator-supplied Ollama.

Only synthetic records are created. Credentials and the library are temporary;
the model service must already be running and have the requested model pulled.
"""
import argparse
from http.cookiejar import CookieJar
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import sys
import tempfile
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, build_opener, HTTPCookieProcessor, ProxyHandler


ROOT = Path(__file__).resolve().parent.parent


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:11434")
    parser.add_argument("--model", default="qwen3:0.6b")
    parser.add_argument("--timeout", type=int, default=240)
    args = parser.parse_args()
    if args.timeout < 30 or args.timeout > 900:
        parser.error("Use a timeout between 30 and 900 seconds.")
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    base = f"http://127.0.0.1:{port}"
    password = secrets.token_urlsafe(32)
    csrf = ""
    opener = build_opener(ProxyHandler({}), HTTPCookieProcessor(CookieJar()))

    def api(path, method="GET", data=None, expected=200):
        headers = {"Origin": base}
        if csrf:
            headers["X-CSRF-Token"] = csrf
        if data is not None:
            headers["Content-Type"] = "application/json"
        request = Request(base + "/api" + path, data=json.dumps(data).encode() if data is not None else None, headers=headers, method=method)
        try:
            response = opener.open(request, timeout=20)
        except HTTPError as error:
            response = error
        with response:
            if response.status != expected:
                raise AssertionError(f"{method} {path} returned {response.status}; expected {expected}.")
            return json.loads(response.read())

    with tempfile.TemporaryDirectory(prefix="little-archive-model-check-") as folder:
        env = {**os.environ, "LA_ADMIN_PASSWORD": password, "LA_PUBLIC_URL": base,
               "LA_DATA_DIR": str(Path(folder) / "data"), "LA_OLLAMA_URL": args.url,
               "LA_OLLAMA_MODEL": args.model, "PYTHONUNBUFFERED": "1"}
        diagnostic = subprocess.run(
            [sys.executable, "-m", "server.cli", "doctor", "--check-ai", "--json", "--env-file", str(Path(folder) / "absent.env")],
            cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30,
        )
        if diagnostic.returncode != 0:
            raise AssertionError("The real model's read-only version/inventory probe failed.")
        report = json.loads(diagnostic.stdout)
        probe = next(row for row in report["checks"] if row["id"] == "local_ai")
        assert probe["code"] == "model_available" and probe["details"]["inference_tested"] is False
        assert probe["details"]["local_processing_verified"] is False
        assert not (Path(folder) / "data").exists(), "Model diagnosis initialized a library."
        assert password.encode() not in diagnostic.stdout + diagnostic.stderr, "Model diagnosis disclosed a credential."
        with open(Path(folder) / "server.log", "wb") as log:
            process = subprocess.Popen([sys.executable, "-m", "server.cli", "serve", "--port", str(port)], cwd=ROOT, env=env, stdout=log, stderr=log)
            try:
                deadline = time.monotonic() + 30
                while True:
                    if process.poll() is not None:
                        raise AssertionError("The isolated application did not start.")
                    try:
                        api("/health")
                        break
                    except (URLError, ConnectionError, TimeoutError):
                        if time.monotonic() >= deadline:
                            raise AssertionError("Application startup timed out.")
                        time.sleep(0.25)
                csrf = api("/auth/login", "POST", {"password": password})["csrf_token"]
                records = [
                    {"url": "https://example.com/synthetic-recipe", "title": "Weeknight lemon pasta",
                     "caption": "A simple pasta recipe using lemon juice, olive oil, parsley, and reserved pasta water. Cook pasta, toss with the sauce, and serve warm.",
                     "notes": "Synthetic test note: try this recipe on Friday.", "tags": ["my-label"]},
                    {"url": "https://example.com/synthetic-design", "title": "A quiet reading corner",
                     "caption": "Interior design ideas for a small reading nook: a comfortable armchair, a warm lamp, and a low shelf for books.",
                     "notes": "Synthetic test note: keep my own title and notes.", "tags": ["my-label"]},
                ]
                items = [api("/items", "POST", record) for record in records]
                assert api("/ai/jobs", "POST", {"ids": [item["id"] for item in items]})["queued"] == 2
                deadline = time.monotonic() + args.timeout
                while True:
                    jobs = api("/ai/jobs")["jobs"]
                    if any(job["status"] == "failed" for job in jobs):
                        raise AssertionError("The real model classification failed. Inspect the model service configuration and supported response schema.")
                    if len(jobs) == 2 and all(job["status"] == "completed" for job in jobs):
                        break
                    if time.monotonic() >= deadline:
                        raise AssertionError("Real model classification timed out.")
                    time.sleep(1)
                current = [api("/items/" + item["id"]) for item in items]
                for record, item in zip(records, current):
                    assert item["ai"] and item["ai"]["suggested_title"]
                    assert item["ai"]["summary"] and item["ai"]["topics"]
                    assert item["ai"]["evidence_level"] == "caption-based"
                    assert item["title"] == record["title"] and item["notes"] == record["notes"]
                    assert item["tags"] == ["my-label"] and item["needs_review"]
                accepted = api(f"/items/{items[0]['id']}/ai/accept", "POST")
                assert accepted["notes"] == records[0]["notes"] and accepted["title"] == records[0]["title"]
                assert "my-label" in accepted["tags"] and not accepted["needs_review"]
                api("/items/" + items[1]["id"], "PATCH", {"notes": "Synthetic changed context."})
                api(f"/items/{items[1]['id']}/ai/accept", "POST", expected=409)
                api(f"/items/{items[1]['id']}/ai/dismiss", "POST")
                assert api("/items/" + items[1]["id"])["ai"] is None
                print(json.dumps({"status": "passed", "model": args.model, "real_inferences": 2,
                                  "checks": ["read-only real model inventory probe", "real worker completion", "structured suggestions", "evidence provenance", "review before changes", "manual annotation preservation", "acceptance", "stale suggestion rejection", "dismissal"]}))
            finally:
                process.terminate()
                try:
                    process.wait(timeout=8)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()


if __name__ == "__main__":
    main()
