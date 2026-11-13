# Native installation and recovery verification

The [native harness](../scripts/native_smoke.py) tests the Python application's real setup helper, CLI processes, HTTP API, persistence, password recovery, and offline restore on the host operating system. It complements the [container harness](container-verification.md): a Linux container does not test native macOS Python, SQLite, process, or filesystem behavior.

## Run the gate

Use Python 3.12 with the candidate requirements installed. For a clean dependency check, create a new temporary virtual environment; run these commands from the candidate checkout:

```sh
LA_NATIVE_VENV="$(mktemp -d)"
python3.12 -m venv "$LA_NATIVE_VENV"
"$LA_NATIVE_VENV/bin/pip" install -r requirements.txt
"$LA_NATIVE_VENV/bin/python" scripts/native_smoke.py --report work/native-verification.json
```

Use a new report filename if you retain another run; the harness refuses to overwrite an existing result. The temporary virtual environment remains available for inspecting dependency versions and can be removed after the check. It is separate from the harness's temporary application, which the harness stops and removes automatically.

If you already have an appropriately configured environment, the shorter command is:

```sh
.venv/bin/python scripts/native_smoke.py --report work/native-verification.json
```

That tests application setup and recovery using the current environment; it does not establish that the environment itself was freshly installed. The [Release validation workflow](../.github/workflows/release-validation.yml) creates a fresh Python 3.12 virtual environment and installs the locked requirements in separate Ubuntu, Apple Silicon macOS, and Intel macOS jobs. Record each job's actual report, including OS, machine architecture, and Python/SQLite versions, before marking that environment accepted.

## What is exercised

| Area | Acceptance check |
| --- | --- |
| Source isolation | Copy only `server`, `web`, the setup helper, dependency files, and the example configuration into an owned temporary directory. Do not copy a real `.env`, data directory, backup, or account export. Clear inherited `LA_*` settings for child processes. |
| Configuration | Run the real setup helper and capture its generated password privately. Require owner-only file permissions. Run setup again and require refusal without changing the existing configuration or its modification time. |
| CLI startup | Start the real `python -m server.cli serve` process on a random loopback port. Verify `.env` loading, the relative data directory, explicit environment precedence for the public origin, owner login, and rejected anonymous library access. |
| HTTP behavior | Create/read/edit/delete synthetic records; import a CSV record; search a Unicode note; upload a synthetic PNG; verify private asset access. |
| Backup | Download the real backup endpoint and verify ZIP integrity, manifest hashes, SQLite integrity, local-image inclusion, and removal of owner/session/token authentication material. |
| Restart | Stop and restart the CLI server. Preserve records, annotations, collections, local-image bytes, owner session, and instance identity. |
| Password recovery | Stop the server and run the real `reset-password` command. Feed its two prompts through private process input, not command arguments. Require no echoed secret, unchanged `.env`, preserved library content, revoked old password/session/token, and successful new-password login. |
| Offline restore | Stop the source process, invoke the real restore CLI into a nonexistent directory, and start it with a fresh owner password. Preserve content, empty collections, and image bytes; reject old credentials and create a new instance identity. |
| Cleanup and evidence | Stop only the harness's own processes and remove its temporary checkout/configuration/data. Write a credential-free report with each result, source fingerprint, host versions, and cleanup outcome. |

The report records the source Git commit when available and whether its worktree had changes. It also hashes the copied source, so a local development check is not silently represented as a test of the clean base commit. No generated password, cookie, CSRF value, import token, private database, or backup is included in the report.

## What it does not establish

A native backend pass is separate from authenticated browser interaction, real social-platform collection, optional model inference, and Docker Desktop. Even a passing Apple Silicon macOS job does not test a Docker Desktop GUI installation, a signed native app bundle, desktop packaging, sleep/resume, or automatic launch at login. The application currently supplies a browser interface and a Python server; it does not install a macOS background service.

Use the remaining [release gates](release-gates.md) for those distinct boundaries. Keep Docker Desktop acceptance and live-account import acceptance pending until they have been observed directly.
