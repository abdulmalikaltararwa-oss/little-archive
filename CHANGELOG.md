# Changelog

## Unreleased — Development toward 1.0

The current source is a development build. A stable release will be published after the release gates are verified.

### Included

- Private single-owner library with SQLite persistence.
- Responsive gallery, keyword search, collections, tags, notes, favorites, and progress states.
- Portable JSON import/export, CSV/TSV import, Netscape bookmarks import, and selected social-export parsers.
- Experimental Chrome importer for a user-selected Instagram or TikTok saved-content view.
- Bounded batches, idempotent retries, and import coverage reporting.
- Optional Ollama text suggestions with an explicit review flow.
- Local raster thumbnail uploads, optional browser-loaded remote previews, and backup/export tools.
- Docker and native Python setup, tests, contributor guidance, and privacy documentation.

### Known limitations

- Browser adapters depend on the current source layout and are experimental.
- No promise of automatic all-collection discovery or complete historical archive recovery.
- No automatic full-video archival, speech transcription, OCR, semantic search, or mobile share extension.
- No multi-user workspace or project-operated hosting service.
- AI quality depends on the configured model and the text evidence actually available.
