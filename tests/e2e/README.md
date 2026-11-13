# Authenticated browser regression tests

These tests load the normal `index.html` application and exercise the actual FastAPI server with Chromium, Firefox, and WebKit. They do not use the interactive demo, replace API responses, seed authenticated sessions, or contact Instagram, TikTok, or other external sites.

## Run

Use Node 22 or newer and Python 3.12 or newer from the project root:

```sh
python3 -m pip install -r requirements.txt
npm ci
npx playwright install --with-deps chromium firefox webkit
npm run test:e2e
```

`run.mjs` creates a new temporary data directory, generates a random owner password, selects an available loopback port, and starts the production-configured FastAPI app. The real UI signs in with that password. The harness stops the server and deletes its temporary data directory after the run. It does not reuse an existing instance or browser profile, and it disables optional external AI configuration. `Config.testing` remains false.

To select a browser or test without changing the isolation guarantees:

```sh
npm run test:e2e -- --project=webkit
npm run test:e2e -- --grep 'portable JSON'
npm run test:e2e -- --list
```

The last command starts the isolated server and lists test cases without launching a browser. `LA_E2E_PYTHON` can select the Python executable. The application data/password/origin environment variables are generated or replaced by the harness, not supplied from a personal deployment. Model settings stay disabled unless explicitly enabled for the separate gate below.

## Separate real-model browser gate

The AI browser test uses a real Ollama process already running on the CI host. It has its own configuration and is excluded from the core browser suite, so the core suite has no AI-related skips. Pull the model into the disposable service before running:

```sh
LA_E2E_OLLAMA_URL=http://127.0.0.1:11434 \
LA_E2E_OLLAMA_MODEL=qwen3:0.6b \
npm run test:e2e:ai
```

The harness accepts only a loopback HTTP(S) model origin without credentials, a path, query, or fragment. Existing `LA_OLLAMA_*` configuration is ignored. This gate imports two synthetic captioned records through the UI, queues the complete filtered scope, waits for real inference, observes live progress, accepts one suggestion, dismisses the other, verifies persistence after reload, and verifies an unchanged requeue does not repeat inference. It preserves manual notes, existing topics, and original collections.

Infrastructure tests for model-origin restrictions and credential-safe reports run with `npm run test:e2e:infra` and require no browser.

## Assertions

The suite verifies:

- Incorrect passwords, protected endpoints, HttpOnly/SameSite session cookies, inaccessible JavaScript cookies, valid and invalid CSRF tokens, cross-origin and cross-site refusal, retained sessions after reload, sign-out revocation, cookie replay refusal, and recovery from a revoked session.
- Link creation, canonical URLs, editing titles/summaries/notes/topics, multilingual text, favorites with correct accessible labels, review/progress states, text search, source/topic filters, sorting, and persisted data after reload.
- Local collection creation, assignment, rename, color change, and deletion without deleting its saves; bulk favorites/topics/archive/restore; individual deletion.
- Organization of all 205 matching imported records while only 60 gallery cards are loaded, using a real server-side topic/collection operation, followed by sequential review across the complete scope.
- Real file upload and parsing, source collection preservation, empty local collections and colors, partial-coverage reporting, import activity, literal rendering of HTML-shaped text, actual JSON downloads, duplicate-free re-import, and invalid-file errors without data changes.
- Real PNG upload and authenticated serving, browser image decoding, persisted thumbnails, thumbnail removal, full backup download, ZIP checksums, SQLite integrity, asset inclusion, and removal of sessions, tokens, and password hashes from the downloadable snapshot.
- Narrow-screen navigation and editing, no horizontal page overflow, keyboard search, and remembered dark appearance.
- Gallery continuity with 240 of 260 synthetic records loaded: favorites from both cards and details, persisted notes, unchanged card nodes and inventory, retained gallery/drawer scroll, and return focus. A search-affecting edit refetches the loaded window in two bounded requests of 200 and 40 records.
- Removal from the current Favorites filter while retaining 120 loaded results, filling the window from the next matching record, preserving the visible scroll anchor, and moving focus to a remaining card; title edits update server-authoritative ordering without losing the loaded window.
- Rediscover continuity when favoriting a result: the same sample of 60 out of 75 records remains in the same order and at the same reading position.
- Closed narrow navigation is absent from keyboard and accessibility interaction; opening contains focus, close/Escape/scrim actions restore it, view selection focuses the heading, dialogs return to the menu, and resizing between narrow and desktop layouts preserves a usable keyboard target.

Every page runs behind a network boundary that refuses and reports external HTTP requests; app requests still go to the real server. Uncaught browser errors fail the test. Tests execute serially, use unique synthetic identifiers, and assert only their own records. No retry hides a first-run failure.

The browser tests use loopback HTTP, so production HTTPS termination and the `Secure` cookie configuration are covered separately by the server/deployment tests. Browser engine coverage is not a claim that every Safari or Firefox release has been tested. The extension has a separate suite and configuration.

## CI results

`playwright-report/` contains a minimal safe HTML summary generated from JUnit after the tests. `test-results/` contains sanitized JUnit and text diagnostics. Traces, screenshots, and video are disabled because they could capture credentials. The harness redacts the generated password and long random token strings from console output and text artifacts, removes binary attachments after verification, and fails closed if report sanitization fails. Both directories are ignored by git. Never point this harness at real user data.

Playwright is pinned to **1.65.0** in the root package and lockfile. Version and CI conventions were checked against the primary sources:

- [Playwright v1.65.0 release](https://github.com/microsoft/playwright/releases/tag/v1.65.0)
- [Playwright continuous integration guidance](https://playwright.dev/docs/ci)
- [Playwright authentication and isolation guidance](https://playwright.dev/docs/auth)
