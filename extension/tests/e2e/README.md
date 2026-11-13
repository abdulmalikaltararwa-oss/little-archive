# Packaged extension integration tests

This suite builds the runtime-only ZIP with `scripts/package_extension.py`, extracts that generated package into an owned temporary directory, and loads it as a Manifest V3 extension into a new Chromium profile. It communicates with the real FastAPI application and is separate from the fast DOM/helper tests under `extension/tests/*.test.mjs`.

## Run in GitHub Actions

Use Node.js 22 or 24 and Python 3.12, install the root Python requirements and run `npm ci` at the repository root. The shared test dependency is pinned to `@playwright/test` **1.65.0** in the root package and lock file. Then run:

```sh
npx playwright install --with-deps chromium
xvfb-run --auto-servernum node tests/e2e/run.mjs --config extension/tests/e2e/playwright.config.mjs
```

The shared server harness creates a temporary data directory and a random owner password at runtime. These tests log in through the real authentication API and create a separate random import token for each browser profile. They revoke that token and remove the profile afterward. No password or token is committed to the repository.

The worker-scoped package fixture uses the harness's `LA_E2E_PYTHON` interpreter (`python3` by default), with argument-array subprocess calls and no shell. It builds and extracts only its own temporary ZIP, keeps the extracted extension path unchanged during browser-restart cases, and removes that temporary package directory afterward. This makes a missing runtime dependency in the downloadable ZIP fail the same eleven browser cases; no source-folder fallback is used.

Test discovery without launching Chromium:

```sh
npx playwright test --config extension/tests/e2e/playwright.config.mjs --list
```

The suite uses a headed bundled Chromium under Xvfb so the real toolbar popup exists. It does not connect to any installed browser, existing profile, or real platform account. No extension source or manifest is patched for testing. `Extensions.triggerAction` opens the actual toolbar action and obtains Chrome's normal `activeTab` grant. The popup's real sender identity, script injection, service-worker messages, durable storage and HTTP requests all remain in the production path.

## Cases

| Case | Observable assertion |
| --- | --- |
| Instagram image grid | Twenty-one synthetic image links with alternative text and no figcaptions become twenty-one database items; exact Unicode collection names survive. |
| Duplicate refresh | A second real popup import updates those same item IDs, retains personal edits, and preserves one source collection. |
| Incremental scrolling | Scrolling adds two cards to an initial fifty-one; the worker sends batches of 50, 1 and 2 with consecutive zero-based sequences, each within 256 KiB. |
| Preset collection workflow | All posts followed by two source collection views preserves exact names and overlapping memberships without duplicating posts or removing an earlier membership. |
| Collection names | Collection URLs use the observed display-slug/numeric-ID shape. A single visible H3 prefills an editable exact name; ambiguous headings leave the field empty for manual verification. |
| TikTok Favorites | Video and photo URLs produce separate items with caption and thumbnail-alt provenance; a duplicate video link is ignored. |
| Login guard | A visible password prompt stops the scanner before it sends saved-card batches. |
| Favorites guard | A selected Posts tab remains rejected even when the user confirms the popup checkbox. |
| Pause and resume | A different collection cannot resume a bound run; the original view reopens at the top, traverses twelve already-known virtualized cards, imports the next new card, and finishes with partial coverage. |
| Durable network recovery | A loopback relay drops a batch response after the real server commits it. The same disk-backed outbox survives a full Chromium restart and sends the identical batch again; the real server reports an idempotent replay. |
| Original protocol compatibility | The relay removes only status protocol metadata to reproduce the known original 0.1.0 declaration. The actual popup displays legacy mode and sends real headerless imports. |
| Incompatible protocol recovery | With a real committed batch still pending, an unsupported status declaration blocks any further batch POST. Restoring protocol 1 sends the unchanged batch bytes and records an idempotent replay. |

All Instagram and TikTok navigation responses are fulfilled with handwritten HTML. Every other web request is blocked, except the single ephemeral loopback relay. Host resolution is also disabled for external names. Images use inline data URLs. The relay forwards only `/api/extension/*` to the real local backend. Its explicit fault modes drop a committed batch's response or rewrite only protocol discovery metadata; import mutation responses always come from the real backend. The legacy case reproduces the original status contract and headerless writes against the current server, not execution of a historical server binary.

## Boundaries of the evidence

The 21-card Instagram fixture mirrors **structural observations only** from a read-only check of a rendered Saved All Posts grid: `main`, post-shaped anchor URLs, descendant images with alternative text, and zero figcaptions. A separate read-only collection check established a display-slug/numeric-ID URL shape and an H3 collection heading; it did not expose a loaded post grid or prove enumeration. The fixtures' accounts, post IDs, numeric collection IDs, text, collection names and HTML are entirely synthetic. Their explicit end markers and incremental-loading behavior are controlled test cases, not claims about Instagram's current pagination UI.

The browser's native optional-host consent bubble is **not automated**. In the fresh test profile, Chromium's own Extensions settings API grants exactly `http://127.0.0.1/*` before the real popup runs its unchanged `permissions.request()` flow. This avoids broad host grants and avoids faking the Chrome APIs. Source-host access still comes from the real toolbar action. A manual release check must still cover the native consent prompt.

The restart test proves durable recovery across a complete browser process restart. It does not claim to reproduce every idle-suspension timing or operating-system crash. These fixtures also do not establish live account access, automatic discovery of all collections, current TikTok layout compatibility, or complete enumeration of any real saved library.

Passing CI is required before describing these cases as verified. Adding this suite or passing test discovery alone is not an executed browser test result. CI retains list/JUnit results and synthetic diagnostics on failure, with the connection configuration omitted. Browser profiles, authentication state, request traces, videos and credentials must not be uploaded as artifacts. The shared harness sanitizes results before generating its HTML overview; the extension configuration does not enable Playwright's raw HTML reporter.

## Primary references

- [Playwright extension guide](https://playwright.dev/docs/chrome-extensions): persistent Chromium contexts, unpacked extensions and service workers.
- [Playwright 1.65 release notes](https://playwright.dev/docs/release-notes#version-165): pinned runner release and supported Node versions.
- [Chrome DevTools Protocol definitions](https://github.com/ChromeDevTools/devtools-protocol/blob/master/json/browser_protocol.json): `Extensions.triggerAction`, `Target`, `Runtime` and `Input` commands.
- [Chromium extension management implementation](https://chromium.googlesource.com/chromium/src/+/HEAD/chrome/browser/extensions/api/developer_private/developer_private_functions.cc): the test profile's exact-host permission setup.

References were checked on 2026-11-13. Pin upgrades deliberately and rerun the complete browser suite; Chromium's extension automation and platform DOM layouts can change independently.
