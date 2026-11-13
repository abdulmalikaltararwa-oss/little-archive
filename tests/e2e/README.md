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

The last command starts the isolated server and lists test cases without launching a browser. `LA_E2E_PYTHON` can select the Python executable. Other `LA_E2E_*` values and the application data/password/origin environment variables are generated or replaced by the harness, not supplied from a personal deployment.

## Assertions

The suite verifies:

- Incorrect passwords, protected endpoints, HttpOnly/SameSite session cookies, inaccessible JavaScript cookies, valid and invalid CSRF tokens, cross-origin and cross-site refusal, retained sessions after reload, sign-out revocation, cookie replay refusal, and recovery from a revoked session.
- Link creation, canonical URLs, editing titles/summaries/notes/topics, multilingual text, favorites with correct accessible labels, review/progress states, text search, source/topic filters, sorting, and persisted data after reload.
- Local collection creation, assignment, rename, color change, and deletion without deleting its saves; bulk favorites/topics/archive/restore; individual deletion.
- Real file upload and parsing, source collection preservation, empty local collections and colors, partial-coverage reporting, import activity, literal rendering of HTML-shaped text, actual JSON downloads, duplicate-free re-import, and invalid-file errors without data changes.
- Real PNG upload and authenticated serving, browser image decoding, persisted thumbnails, thumbnail removal, full backup download, ZIP checksums, SQLite integrity, asset inclusion, and removal of sessions, tokens, and password hashes from the downloadable snapshot.
- Narrow-screen navigation and editing, no horizontal page overflow, keyboard search, and remembered dark appearance.

Every page runs behind a network boundary that refuses and reports external HTTP requests; app requests still go to the real server. Uncaught browser errors fail the test. Tests execute serially, use unique synthetic identifiers, and assert only their own records. No retry hides a first-run failure.

The browser tests use loopback HTTP, so production HTTPS termination and the `Secure` cookie configuration are covered separately by the server/deployment tests. Browser engine coverage is not a claim that every Safari or Firefox release has been tested. The extension has a separate suite and configuration.

## CI results

`playwright-report/` contains a minimal safe HTML summary generated from JUnit after the tests. `test-results/` contains sanitized JUnit and text diagnostics. Traces, screenshots, and video are disabled because they could capture credentials. The harness redacts the generated password and long random token strings from console output and text artifacts, removes binary attachments after verification, and fails closed if report sanitization fails. Both directories are ignored by git. Never point this harness at real user data.

Playwright is pinned to **1.65.0** in the root package and lockfile. Version and CI conventions were checked against the primary sources:

- [Playwright v1.65.0 release](https://github.com/microsoft/playwright/releases/tag/v1.65.0)
- [Playwright continuous integration guidance](https://playwright.dev/docs/ci)
- [Playwright authentication and isolation guidance](https://playwright.dev/docs/auth)
