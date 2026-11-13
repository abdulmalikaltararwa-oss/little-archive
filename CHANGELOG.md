# Changelog

## Unreleased — Development toward 1.0

The first v1 foundation batch passed all 12 acceptance jobs at commit `505b93b0e07ceeb801ca62e9bb5ae2bd3cac5a6d` in [run 43484644844](https://github.com/abdulmalikaltararwa-oss/little-archive/actions/runs/43484644844). Six installation/recovery reports are retained with their provenance. The broader [v1 plan](docs/v1-product-plan.md) includes additional product/project work as well as live Instagram/TikTok capture and final Mac operator acceptance. See [the verification record](docs/verification.md) for exact evidence, corrected initial failures, and boundaries.

### First v1 foundations

- Retain loaded gallery pages, scroll position, and useful keyboard focus after item edits and favorites; keep random samples stable when the edit does not change search/filter membership.
- Keep closed narrow navigation out of the accessibility tree and tab order; manage focus through opening, closing, dialogs, and viewport changes.
- Provide a separate, owner-marked contributor workspace with optional once-only synthetic seeding, redacted inspection, and bounded stopped-workspace cleanup.
- Add deterministic setup preview/creation and versioned read-only diagnostics for people and local coding assistants. Generated passwords remain in private files instead of terminal output.
- Add opt-in bounded Ollama version/model-inventory checks without inference or downloads; do not infer local processing from a local URL.
- Negotiate extension/server protocol capabilities before imports and retries, preserving pending batch bodies and identities. Retain explicitly labeled compatibility with the original 0.1.0 status contract.
- Extend native acceptance to the contributor/operator commands on Mac and Linux and add browser/extension regressions for the new behavior.
- Fix the responsive active-navigation target and removed-favorite focus fallback found by the first browser run; preserve the existing focus assertions. Correct the contributor test's equivalent `/var` and `/private/var` path comparison on macOS.
- Build a reproducible extension ZIP with reviewed runtime files, dependency validation, installation instructions, and the full license; run the extension browser suite against that extracted ZIP. Document updates through the same registered extension folder and identity.

### Included

- Private single-owner library with SQLite persistence.
- Responsive gallery, keyword search, collections, tags, notes, favorites, and progress states.
- Portable JSON import/export, CSV/TSV import, Netscape bookmarks import, and selected social-export parsers.
- Experimental Chrome importer for a user-selected Instagram or TikTok saved-content view.
- Bounded batches, idempotent retries, and import coverage reporting.
- Optional Ollama text suggestions with an explicit review flow.
- Local raster thumbnail uploads, optional browser-loaded remote previews, and backup/export tools.
- Docker and native Python setup, tests, contributor guidance, and privacy documentation.
- Whole-library and filtered organization across unloaded gallery pages, durable AI job counts, cancellation, retry, and sequential review.
- Native installation and offline recovery checks on Apple Silicon Mac, Intel Mac, and Linux; hardened container checks on native AMD64 and ARM64 runners.
- Authenticated Chromium, Firefox, and WebKit workflows; real packaged Chrome-extension workflows; real Ollama worker and browser acceptance.
- Two-revision Docker Compose update verification, preserving the original library, images, sessions, and import token; app removal with retained data; separate recovery of the previous revision from its pre-update backup.

### Reliability fixes verified before release

- Preserve stable Instagram collection identities and accept observed creator-qualified post links.
- Prefill an unambiguous visible collection name, with editable manual naming when the source view is ambiguous.
- Keep emoji-heavy text valid at field boundaries and retain annotation intent through portable JSON roundtrips.
- Improve observed media types without downgrading known video or image records on a generic refresh.
- Deduplicate topics before applying the unique-topic limit.
- Resume past already imported screens, reserve room for durable scanner status, and keep collection names from being mistaken for end markers.
- Verify idempotent retry after a server commit succeeds but its acknowledgement is lost, including a browser restart.

### Continuous verification

- The full release acceptance matrix runs on changes to application, extension, test, packaging, or workflow source on `main`, and remains available manually.
- Dependency lockfiles, both Compose filename extensions, Docker build exclusions, configuration examples, and all workflow files trigger the full matrix.
- Container and standalone demo builds include the project license; the standalone extension installation guide covers pairing and import scope.
- Public preview deployment is separate from a stable product release and contains synthetic records only.

### Known limitations

- Browser adapters depend on the current source layout and are experimental.
- No promise of automatic all-collection discovery or complete historical archive recovery.
- No automatic full-video archival, speech transcription, OCR, semantic search, or mobile share extension.
- No multi-user workspace or project-operated hosting service.
- AI quality depends on the configured model and the text evidence actually available.
