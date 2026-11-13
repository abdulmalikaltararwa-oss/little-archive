# Changelog

## Unreleased — Development toward 1.0

The implementation has passed all 12 automated acceptance jobs at commit `6fb4c1dbd6caa2127910ed8ccc5d305a9ed150f6`. A stable release remains held for live Instagram/TikTok capture and final Mac operator acceptance. See [the verification record](docs/verification.md) for exact evidence and boundaries.

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
