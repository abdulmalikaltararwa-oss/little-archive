# Native installation and recovery verification

The [native harness](../scripts/native_smoke.py) tests the Python application's real setup helper, CLI processes, HTTP API, persistence, password recovery, and offline restore on the host operating system. It complements the [container harness](container-verification.md): a Linux container does not test native macOS Python, SQLite, process, or filesystem behavior.

## Observed candidate result

All three native installation jobs passed on 2026-11-13 in [Release validation run 43397490019](https://github.com/abdulmalikaltararwa-oss/little-archive/actions/runs/43397490019), for clean candidate [`52adf28a5ac1f9a2baecf89442deb8e59577197c`](https://github.com/abdulmalikaltararwa-oss/little-archive/commit/52adf28a5ac1f9a2baecf89442deb8e59577197c). Each report records **7 checks passed and cleanup passed**.

| Runner target | Reported host | Python / SQLite | Evidence |
| --- | --- | --- | --- |
| `ubuntu-24.04` | Linux, `x86_64`; kernel `7.0.0-1017-azure` | `3.12.16` / `3.45.1` | [Job 131791895477](https://github.com/abdulmalikaltararwa-oss/little-archive/actions/runs/43397490019/job/131791895477), [retained JSON](evidence/52adf28a/native-ubuntu-24.04.json) |
| `macos-15` | macOS `15.8.2`, `arm64`; Darwin `24.6.0` | `3.12.10` / `3.49.1` | [Job 131791895506](https://github.com/abdulmalikaltararwa-oss/little-archive/actions/runs/43397490019/job/131791895506), [retained JSON](evidence/52adf28a/native-macos-arm64.json) |
| `macos-15-intel` | macOS `15.7.9`, `x86_64`; Darwin `24.6.0` | `3.12.10` / `3.49.1` | [Job 131791895387](https://github.com/abdulmalikaltararwa-oss/little-archive/actions/runs/43397490019/job/131791895387), [retained JSON](evidence/52adf28a/native-macos-intel.json) |

The workflow created a fresh Python 3.12 virtual environment and installed the pinned application requirements on each runner. All three reports identify the candidate commit, `source_worktree_modified: false`, and copied-source SHA-256 `03cffe6cadbd5c042a7b5bc127a2341c9dbf8c15a4500787fb34c4c65a207d34`. The [provenance index](evidence/52adf28a/README.md) records original artifact IDs and retained-file hashes.

These results establish the real native backend install/recovery paths described below. The [current verification matrix](verification.md) separately records passing authenticated browser and real-model suites. Docker Desktop on a physical Mac, native browser permission consent, and live Instagram/TikTok capture remain direct acceptance limits; they are not implied by a native Python pass.

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

That tests application setup and recovery using the current environment; it does not establish that the environment itself was freshly installed. The [Release validation workflow](../.github/workflows/release-validation.yml) creates a fresh Python 3.12 virtual environment and installs the locked requirements in separate Ubuntu, Apple Silicon macOS, and Intel macOS jobs. It runs on relevant source pushes to `main` and can also be dispatched manually. For a later candidate, retain each new report with its actual OS, architecture, Python/SQLite versions, and source identity.

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

Use the [current verification record](verification.md) for browser/model evidence and the [upgrade record](upgrade-verification.md) for the separately passing Linux Compose update, rollback, and retain-data removal gate. Physical-Mac Docker Desktop/operator acceptance, native extension permission consent, and live-account imports remain direct [release gates](release-gates.md).
