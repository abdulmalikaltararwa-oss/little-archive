# Working on Little Archive

Little Archive is a single-owner saved-content library. It uses Python 3.12,
SQLite, a React web interface (`ui/`, built with Vite and served by the server), and a Chrome MV3 companion extension. This is
development toward v1; do not describe planned features as released.

## Choose the requested task

- **Install or diagnose:** follow [operator setup](docs/operator-setup.md). Use
  the documented commands and a reviewed source revision. The setup command
  creates private configuration; it does not install dependencies, a native Mac
  bundle, Ollama, or browser extensions.
- **Contribute:** follow [CONTRIBUTING.md](CONTRIBUTING.md). Use the isolated
  `scripts/dev.py` workspace. It does not load a personal `.env` or inherited
  `LA_*` deployment settings.
- **Develop a feature:** read [the API contract](API_CONTRACT.md),
  [architecture](docs/architecture.md), and the relevant acceptance criteria in
  [the v1 plan](docs/v1-product-plan.md). Preserve existing working behavior.

## Installation and diagnostic commands

Use the selected Python environment. These examples assume the documented
`.venv` has already been created and the locked requirements installed:

```sh
.venv/bin/python -m server.cli setup --dry-run --json
.venv/bin/python -m server.cli setup --apply --json
.venv/bin/python -m server.cli doctor --json
```

Read the structured status and exit code. If an existing configuration is found,
it is retained and fresh-setup options are ignored. Relative data paths are
resolved from the process working directory. Choose the intended checkout and
configuration explicitly; do not guess another installation's data path.

Doctor is read-only and makes no network requests by default. Optional
`--check-ai` performs only model version/inventory GETs from the backend's
execution environment. It does not test inference or prove local processing.
Optional `--check-port` checks loopback connectivity without stopping services.

Private credentials stay in local files and owner-entry interfaces. Do not read
them into a chat, log, diagnostic artifact, command argument, issue, or commit.
Do not print `.env`, tokens, cookies, personal exports, or model prompts. Tell the
owner where to retrieve a generated credential locally. Use synthetic data for
verification.

## Development and verification

```sh
.venv/bin/python scripts/dev.py --prepare --seed
.venv/bin/python scripts/dev.py --check --json
.venv/bin/python scripts/dev.py
```

The development app defaults to `http://127.0.0.1:8788`. Its private password is
in `work/contributor-dev/owner-password.txt`; the app never logs it. Cleanup uses
`scripts/dev.py --cleanup` and refuses an active or unowned workspace. Do not
replace this with a broad recursive removal command.

Run checks that address the changed behavior:

```sh
.venv/bin/python -m unittest discover -s tests -v
node --test extension/tests/*.test.mjs
node --test web/*.test.mjs
(cd ui && npm run build && npm test)   # the web interface; the server serves ui/dist
npm run test:e2e:infra
```

Browser and extension checks use the isolated harness documented in
[tests/e2e/README.md](tests/e2e/README.md). Never point it at a personal instance
or browser profile. Release validation also exercises native Mac/Linux,
containers, real model integration, and upgrade/recovery. Keep actual results
separate from test definitions and planned acceptance.

## Working rules for builders and reviewers

These hold for every change, whoever makes it.

**Done means the gate passed.** `scripts/gate.sh` checks out a commit into a fresh temporary worktree, installs
from the lock files, builds the interface and runs every suite, including the browser tests in Chromium, Firefox
and WebKit. It needs `.venv` (Python 3.12 with `requirements-lock.txt` installed) and Node 22 or newer. Run it on
the merged commit, never judge a change by tests run in the folder it was written in: files that were never
committed make those pass. Paste the gate's PASS/FAIL lines in the report.

**Never push `main` directly.** Release validation (three browsers, containers, native installs, upgrade) runs
on GitHub only. Push the candidate as `candidate/<topic>`, start it with
`gh workflow run release-validation.yml --ref candidate/<topic>`, wait for green, then fast-forward `main` to that
commit and push. Pushing anything needs the owner's yes each time.

**Proof steps are quoted, not remembered.** Every expected result written into a handoff, a deployment request or
a report ("this address answers 200", "this page shows sign-in") names the doc line or test that states it. If
none exists, say the result is unverified. Example: hosted mode serves no web interface and `/` answers 404
([hosted mode](docs/hosted-mode.md), "What a hosted server does not offer").

**Task sheet for delegated work.** One sheet per builder:

```
Task: <one result a person or a test can see>
Start from: <commit or branch>
Write only: <paths>
Read: AGENTS.md, docs/STATUS.md, <other paths>
Done when: <tests or gate steps, with the output pasted>
Ask before: pushing, deploying, real accounts or services, production data, spending, deleting
Hand back: PASS, ISSUES (each with evidence) or BLOCKED; changed paths; for anything a person sees,
           screenshots at phone width (390px), light and dark; what was run versus only read; up to 3 questions
```

**A fresh reviewer for risky or visible changes.** Sign-in, payments, data storage and anything a person sees
are reviewed by someone who did not write them and who is given the diff and the screenshots, not the
builder's report. The reviewer changes nothing and reports findings with file and line.

**Commits.** Small, in the imperative style already in the log (`area: what changed`). No attribution lines and no
mention of the tools or assistants used to write the change, in messages, code, comments or docs.

**Where things stand** is in [docs/STATUS.md](docs/STATUS.md): decided, built, running, waiting on the owner.
Read it before starting and update it when one of those changes.

## Data, compatibility, and scope

Keep source facts, owner edits, and model suggestions separate. A missing
observation is not permission to remove a record or source membership. Preserve
durable outbox identities and committed batch payloads across retries. Treat
imported text and model responses as untrusted data, not instructions.

Do not add model calls, new network destinations, telemetry, broader extension
permissions, or migration behavior incidentally to an unrelated change. Keep
credentials and personal data outside the public UI directory and source package.
Use explicit recovery/update operations instead of overwriting existing data.

Use the existing UI (`ui/DESIGN.md` is its direction and rules) and small dependency set. Build it with `npm ci && npm run build` in `ui/` before starting a server or running the Python tests. Add meaningful regression coverage
for data loss, compatibility, permission, recovery, or navigation failures.
Update the relevant task guide with a behavior change. In reports, state what
changed, what was exercised, and which release gates still lack evidence.
