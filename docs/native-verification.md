# Native installation and recovery verification

The [native harness](../scripts/native_smoke.py) tests the Python application's real setup helper, CLI processes, HTTP API, persistence, password recovery, and offline restore on the host operating system. It complements the [container harness](container-verification.md): a Linux container does not test native macOS Python, SQLite, process, or filesystem behavior.

## Observed candidate result

All three native installation jobs passed on 2026-11-13 in [Release validation run 43484644844](https://github.com/abdulmalikaltararwa-oss/little-archive/actions/runs/43484644844), for clean candidate [`505b93b0e07ceeb801ca62e9bb5ae2bd3cac5a6d`](https://github.com/abdulmalikaltararwa-oss/little-archive/commit/505b93b0e07ceeb801ca62e9bb5ae2bd3cac5a6d). Each report records **8 lifecycle checks passed and cleanup passed**, including the new deterministic setup preview and read-only redacted diagnostics check.

| Runner target | Reported host | Python / SQLite | Evidence |
| --- | --- | --- | --- |
| `ubuntu-24.04` | Linux, `x86_64`; kernel `7.0.0-1017-azure` | `3.12.16` / `3.45.1` | [Job 132089743681](https://github.com/abdulmalikaltararwa-oss/little-archive/actions/runs/43484644844/job/132089743681), [retained JSON](evidence/505b93b0/native-ubuntu-24.04.json) |
| `macos-15` | macOS `15.8.2`, `arm64`; Darwin `24.6.0` | `3.12.10` / `3.49.1` | [Job 132089743821](https://github.com/abdulmalikaltararwa-oss/little-archive/actions/runs/43484644844/job/132089743821), [retained JSON](evidence/505b93b0/native-macos-arm64.json) |
| `macos-15-intel` | macOS `15.7.9`, `x86_64`; Darwin `24.6.0` | `3.12.10` / `3.49.1` | [Job 132089743880](https://github.com/abdulmalikaltararwa-oss/little-archive/actions/runs/43484644844/job/132089743880), [retained JSON](evidence/505b93b0/native-macos-intel.json) |

The workflow created a fresh Python 3.12 virtual environment and installed the pinned application requirements on each runner. All three reports identify application version `0.1.0`, the candidate commit, `source_worktree_modified: false`, and copied-source SHA-256 `463542e0c3d930a818a8536cc7d217c565516cca4724888c7dc3735f8e219758`. The [provenance index](evidence/505b93b0/README.md) records original artifact IDs and retained-file hashes.

Each native job also passed **16 contributor-workspace tests and 18 operator-setup tests**, recorded in the linked job's logs separately from its 8-check lifecycle report. These modules are repeated on each operating system and are already included in the overall Python regression suite; they are not additional unique test cases. They exercise isolated synthetic development state, credential redaction, idempotence, bounded cleanup, configuration preview/creation, and read-only diagnostics on both Mac architectures and Linux.

The [earlier `6fb4c1db` evidence](evidence/6fb4c1db/README.md) remains a historical baseline with 7 native lifecycle checks per platform. The current results above come from fresh execution of `505b93b0`; the earlier pass is not reused as evidence for the changed source.

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
