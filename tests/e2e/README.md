# Authenticated browser regression tests

These tests load the React interface (the build in `ui/dist`, exactly as the server serves it) and exercise the actual FastAPI server with Chromium, Firefox, and WebKit. They do not use the interactive demo, replace API responses, seed authenticated sessions, or contact Instagram, TikTok, or other external sites. They select by role, label and accessible name, the way a person or a screen reader finds things; the few ids and data attributes they use (`save-count`, `data-item-id`, `data-card-control`, `#view-title`, `#library-search`) are ones the interface exposes on purpose.

## Run

Use Node 22 or newer (CI uses 24) and Python 3.12 or newer from the project root. The server serves the built interface, so build it first; without a build the isolated server starts but every page is a one-line instruction to build it:

```sh
python3 -m pip install -r requirements.txt
(cd ui && npm ci && npm run build)
npm ci
npx playwright install --with-deps chromium firefox webkit
npm run test:e2e
```

Rebuild `ui/dist` after changing anything under `ui/`; the suite does not. The interface's own, smaller smoke suite (`cd ui && npm run test:e2e`) runs the demo page with no server.

`run.mjs` creates a new temporary data directory, generates a random owner password, selects an available loopback port, and starts the production-configured FastAPI app. The real interface signs in with that password. The harness stops the server and deletes its temporary data directory after the run. It does not reuse an existing instance or browser profile, and it disables optional external AI configuration. `Config.testing` remains false.

To select a browser or test without changing the isolation guarantees:

```sh
npm run test:e2e -- --project=webkit
npm run test:e2e -- --grep 'portable JSON'
npm run test:e2e -- --list
```

The last command starts the isolated server and lists test cases without launching a browser. `LA_E2E_PYTHON` can select the Python executable. The application data/password/origin environment variables are generated or replaced by the harness, not supplied from a personal deployment. Model settings stay disabled unless explicitly enabled for the separate gate below.

## Separate real-model browser gate

The AI browser test uses a real Ollama process already running on the CI host. (Its interface steps, which are the part that changes with the interface, can be rehearsed against any loopback stand-in that answers `/api/chat` with a valid classification object; that checks the browser flow, not inference.) It has its own configuration and is excluded from the core browser suite, so the core suite has no AI-related skips. Pull the model into the disposable service before running:

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
- Narrow-screen navigation and editing, no horizontal page overflow, keyboard search, and remembered dark appearance. A phone has no sidebar and no hamburger: a floating dock holds Library, Search, Save, Browse and Settings, and Browse opens a sheet that traps focus, closes with Escape, its close button or a press outside, and returns focus to the dock; a view chosen in it takes focus on the view's heading, and a dialog opened from it returns focus to that heading.
- The wall draws only the cards near the screen, so counts come from the heading and the Load more button, and cards are identified by their place in the set (`aria-posinset`) against the server's order. With every page of 260 synthetic records loaded: favoriting from a card and from the open save, persisted notes, the same card nodes and the same cards in the page, retained wall and panel scroll, focus kept on the control that was used and returned to the card that opened the save. A search-affecting edit refetches the whole loaded window in two bounded requests (200 and 60 records).
- Leaving the current Favorites filter: the card leaves, the rest keeps its place, the first card on screen does not move, focus goes to a card that is still on screen (never to the page), and a title edit that reorders a sorted list leaves the wall at the same reading position when the panel closes.
- Rediscover continuity when favoriting a result: the same sample of 60 out of 75 records stays in the same order, with no automatic loading and a Shuffle button instead of Load more.
- The next page loads by itself as the end of the wall comes near, once per page, and Load more stays for the keyboard.
- The address carries the view, the filters and the open save (`#/favorites?q=…&sort=title&item=…`): a reload or a new tab returns to it, Back and Forward move through it, and Back over unsaved edits asks first (one question per Back press) and leaves no duplicate history entry.
- Keyboard focus inside an open save survives the full record arriving late (the answer to the save's own request is held back, not changed, as a slow connection would).
- Dialogs trap the keyboard, lock the page's scroll (which needs the page's own style nonce to be accepted), and hand focus back where it came from; a selection on a phone takes the dock's place.
- Every screen (recipes, places, ask, guided import, unlock) and dialog (settings, palette, activity, organize, save, confirmation) opens under the page's Content-Security-Policy, with `style-src 'self' 'nonce-…'` and no `'unsafe-inline'`; any policy violation fails the test that caused it.
- The installable app: the manifest, icons and touch icon are served as declared and parse without errors in Chromium; a shared link opens the save dialog prefilled and saves nothing until Save is tapped, waits through sign-in, and keeps hostile text as text. On a phone, finger-sized touch targets (a 44px area around every control, including the dock, the sheets and the open save), 16px text in fields, no sideways scroll, and a Save button that stays in view on a short screen.
- The sign-in screen keeps its decorative field clear of the logo at five window sizes and on a phone.

Every page runs behind a network boundary that refuses and reports external HTTP requests; app requests still go to the real server. Uncaught browser errors fail the test. Tests execute serially, use unique synthetic identifiers, and assert only their own records. No retry hides a first-run failure.

The browser tests use loopback HTTP, so production HTTPS termination and the `Secure` cookie configuration are covered separately by the server/deployment tests. Browser engine coverage is not a claim that every Safari or Firefox release has been tested. The extension has a separate suite and configuration.

## CI results

`playwright-report/` contains a minimal safe HTML summary generated from JUnit after the tests. `test-results/` contains sanitized JUnit and text diagnostics. Traces, screenshots, and video are disabled because they could capture credentials. The harness redacts the generated password and long random token strings from console output and text artifacts, removes binary attachments after verification, and fails closed if report sanitization fails. Both directories are ignored by git. Never point this harness at real user data.

Playwright is pinned to **1.65.0** in the root package and lockfile. Version and CI conventions were checked against the primary sources:

- [Playwright v1.65.0 release](https://github.com/microsoft/playwright/releases/tag/v1.65.0)
- [Playwright continuous integration guidance](https://playwright.dev/docs/ci)
- [Playwright authentication and isolation guidance](https://playwright.dev/docs/auth)
