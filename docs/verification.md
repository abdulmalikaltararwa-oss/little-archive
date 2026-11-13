# Development verification toward 1.0

This records checks observed during development and the boundaries they establish. The current internal version is `0.1.0`; no stable release has been published. The [1.0 release gates](release-gates.md) define the remaining acceptance requirements. This is a verification record, not an independent security audit or a guarantee that every platform, model, or installation has been tested.

The successful GitHub **Checks** run is tied to commit [`85d50bf51504d047ab95fd48992d2e8589318616`](https://github.com/abdulmalikaltararwa-oss/little-archive/commit/85d50bf51504d047ab95fd48992d2e8589318616). Its **test** and **container** jobs passed: [view the run and logs](https://github.com/abdulmalikaltararwa-oss/little-archive/actions/runs/43388516184). Later source changes need their own verification; this result applies to that commit.

## Scope matrix

| Area | Method | Observed result | Boundary |
| --- | --- | --- | --- |
| Python behavior | Local `unittest` suite | **67 tests passed.** | Automated tests cover selected parser, classifier, API, storage, and backup behaviors. Passing tests do not establish behavior for every external export or deployment. |
| Frontend and extension logic | Local Node test suites | **33 tests passed in total.** | These exercise fixtures and isolated logic; they do not establish live platform compatibility. |
| GitHub CI | The linked Checks run | **test** and **container** jobs passed. | The recorded run applies to the linked commit, not all future changes. |
| Container packaging | GitHub runner built the Docker image and started a container | Build and container health smoke check passed. | This checks packaging, startup, and the health endpoint on the CI runner. It is not a full browser or production deployment test. |
| Shared web interface | Browser interaction with the actual application UI and an isolated synthetic adapter | Search, editing, favorites, JSON download, dark theme, and reset were checked as detailed below. | The adapter uses page memory; no authenticated application server was involved in this browser session. |
| Authentication in a browser | Full browser session through the real authenticated backend | **Not verified end to end in a browser.** | Automated API coverage is separate from a browser login, session, CSRF, and persistence flow. |
| Optional Ollama integration | Mocks and a local test server | Protocol handling and validation were exercised. | **No real Ollama model inference was verified.** Model quality, runtime, and resource use remain unmeasured. |
| Instagram and TikTok capture | Synthetic extension fixtures and logic tests | Automated tests passed. | **No live Instagram or TikTok capture was verified.** The importer remains experimental, with no complete-account coverage claim. |
| macOS Docker installation | Native Mac installation and launch | **Not run on macOS.** | The Linux CI container result does not establish a tested Docker Desktop experience on a Mac. |

## Browser observations

The [public synthetic demo](https://abdulmalikaltararwa-oss.github.io/little-archive/) was deployed successfully by [Pages run 43388893222](https://github.com/abdulmalikaltararwa-oss/little-archive/actions/runs/43388893222). Its gallery and post inspector were opened and checked at the published URL. The source and public demo contain synthetic examples only.

The browser checks used the shared frontend with the standalone synthetic demo adapter. This is the same interface used by the application, with backend calls handled by an isolated in-memory store. The session established the following behavior:

- Searching for `lemon` returned one matching result.
- Editing a note and setting the item to **Done** saved those changes in the active demo state.
- Favoriting an item increased the favorites count from **4 to 5**.
- A downloaded JSON export contained **15 items**. Inspection confirmed that the edited note, status, and favorite value were retained in the exported data.
- Dark theme and the demo reset interaction were checked.

The successful export demonstrates that the checked demo edits reached its export path. It does not establish database persistence or an authenticated browser-to-server round trip. Demo edits intentionally reset when the page is reloaded. Public screenshots, including the [gallery image](assets/gallery.jpg), contain synthetic content.

## Reproduce the automated checks

After following the development setup in the [README](../README.md), run:

```sh
.venv/bin/python -m unittest discover -s tests -v
node --test extension/tests/*.test.mjs
node --test web/*.test.mjs
python3 scripts/build_demo.py
python3 scripts/release_check.py
```

The [Checks workflow](../.github/workflows/checks.yml) defines the CI commands and container smoke check. The [publishing guide](publishing.md) explains how to preview or deploy the separate synthetic demo. Test counts can change as coverage is added; use the logs for the commit you are installing.

## Additional native development check

On 2026-11-13, the [native harness](native-verification.md) passed locally on Linux x86_64 with Python 3.12.14 and SQLite 3.53.1. It exercised real setup overwrite protection and permissions, CLI startup, authenticated HTTP CRUD/import/search/image operations, authenticated backup, process restart, offline password reset with old-credential invalidation, and offline restore with fresh credentials. Its owned temporary processes and data were removed successfully.

This run used a modified development worktree based on `85d50bf51504d047ab95fd48992d2e8589318616`; it is **not** a clean-commit CI result or a macOS result. The copied runtime source fingerprint was `cd57bc7cd770ba0fae19b585f4cbded4982e2d4b5a724a421eb0d1591bb04f61`. Candidate CI runs must separately establish Linux and both macOS architectures using the fresh-environment matrix.

## Remaining release work

The [packaged-container harness](container-verification.md) now supplies reproducible hardened AMD64/ARM64 runtime, persistence, and recovery checks. Its execution results must be recorded before counting that gate as passed. The earlier container health smoke did not run this new harness.

The other required acceptance checks include an authenticated browser session against a real instance, installation on a Mac, actual model inference through a configured Ollama service, and deliberate live extension captures on both supported source platforms. A read-only Instagram DOM inspection established 21 loaded post anchors with image alternative text and no `figcaption` elements; it did not exercise the extension-to-server import path. Record each completed check against its exact candidate and environment in the [release gates](release-gates.md).
