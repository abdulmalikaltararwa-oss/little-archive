# Contributing to Little Archive

Thanks for helping make saved content easier to use. Small, focused changes are welcome.

## Before changing code

Read [API_CONTRACT.md](API_CONTRACT.md) and the [architecture guide](docs/architecture.md). Keep source facts, user annotations, and AI suggestions separate. Never add personal platform exports or credentials to a fixture.

For an adapter change, include a minimal synthetic or sanitized fixture showing the supported page structure. State what the adapter can establish and what remains unknown. Do not claim complete coverage from a scroll timeout alone.

## Start an isolated development library

Use Python 3.12 on macOS or Linux; this is the currently verified Python version. Other Python versions need separate verification before being added to the support matrix. Node.js 22 is used for the JavaScript tests and npm shortcuts. From a fresh checkout:

```sh
python3.12 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
npm ci
npm run dev -- --seed
```

Open `http://127.0.0.1:8788`. Open `work/contributor-dev/owner-password.txt` in your local text editor and use that password to sign in. The launcher creates this private file without printing the credential to logs or JSON. Keep its contents out of screenshots, issues, and assistant conversations.

The contributor launcher stores its configuration and library in the ignored `work/contributor-dev` directory. It creates the directory with owner-only access and its configuration/password files with mode `0600`. It does not read a personal `.env` or inherited `LA_*` deployment settings. The optional model connection is disabled in this workspace; AI changes can use the separate [real-model test workflow](tests/e2e/README.md). Production installation and operator configuration remain documented in the [README](README.md).

`--seed` adds the original synthetic fixture once. Subsequent launches, preparations, and seed requests preserve notes, corrections, deleted fixture records, credentials, and other development data. Omit `--seed` for an initially empty library. Use synthetic data for contributor work.

After the first run, start again with:

```sh
source .venv/bin/activate
npm run dev
```

`python scripts/dev.py` is the equivalent entry point. It always binds to a loopback address. To use another local port, pass `--port 8790`; the `PORT` environment variable is ignored, and an occupied port causes startup to fail instead of silently selecting another port.

### Prepare, inspect, or reset development data

Prepare configuration and optional synthetic records without starting a server:

```sh
python scripts/dev.py --prepare --seed
```

Inspect the workspace without changing files or starting a server:

```sh
python scripts/dev.py --check --json
```

This status output contains relative paths and fixed diagnostics, without passwords, deployment environment values, or private library contents. Inspection also works before initialization and without installing application dependencies.

To discard this checkout's development library, stop its server with `Ctrl-C`, then run:

```sh
python scripts/dev.py --cleanup
```

Cleanup targets only the fixed `work/contributor-dev` directory with a valid ownership marker for this checkout. It refuses a running workspace, symlinks, hard-linked files, unknown ownership, and trees beyond its bounded limits (10,000 entries, 512 MiB, or 12 nested directory levels). A refused cleanup leaves the existing files in place. Personal configuration, production libraries, backups, and other files under `work` are outside this command's target. Run `npm run dev -- --seed` afterward for a fresh synthetic workspace and new private credentials.

An existing unmarked directory or a workspace copied from another checkout is not adopted automatically. Inspect it locally before deciding how to move or remove it. Do not point development tools at a personal library to work around an ownership check.

## Run checks

With the virtual environment activated:

```sh
python -m unittest discover -s tests -v
npm run test:extension
npm run test:web
npm run test:e2e:infra
```

The [browser testing guide](tests/e2e/README.md) explains browser installation and authenticated end-to-end tests. Those test runners create their own isolated temporary instances; they do not require the contributor server to be running.

Run the app locally and check the affected interaction. For visual changes, include a screenshot with synthetic content, and check keyboard navigation and a narrow viewport. For a parser or security boundary, add a focused regression test that demonstrates the failure being fixed.

The [Release validation workflow](.github/workflows/release-validation.yml) exercises authenticated browsers, the packaged extension against synthetic views, hardened containers on AMD64/ARM64, native Linux/macOS setup and recovery, and a real local model. The [release gates](docs/release-gates.md) also require separately recorded live-platform and target-machine acceptance. Do not mark a gate complete just because its test script exists or a narrower fixture test passes.

## Pull requests

Explain the problem, the resulting behavior, and how you verified it. Call out a database migration, new network destination, new extension permission, or change to export compatibility. Avoid unrelated refactors in the same pull request.

Keep dependencies small and necessary. The browser UI and extension intentionally work without a build system. Do not add analytics, remotely loaded scripts, external fonts, or silent hosted-model fallback.

## Sensitive reports

Follow [SECURITY.md](SECURITY.md) for vulnerabilities. Do not publish private saved content, screenshots of another person's account, passwords, tokens, or session information in an issue.

## Licensing

Contributions are accepted under this repository's MIT license. Contribute only code and assets you have permission to contribute; retain required third-party notices.
