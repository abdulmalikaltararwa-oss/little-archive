# Roadmap

Roadmap entries are intentions, not promises of a release date or current support.

## Initial release

The initial alpha focuses on a private, browsable library: authentication, source and local collections, keyword search, tags, notes, progress, file imports, explicit browser imports, optional model suggestions, and portable backup/export.

## Next validation work

- Expand sanitized Instagram and TikTok layout fixtures.
- Record live adapter checks against specific platform layouts without publishing private records.
- Improve collection discovery and reconciliation only where the source exposes sufficient evidence.
- Exercise interrupted imports, browser worker restarts, and recovery on different machines.
- Review accessibility with keyboard and assistive-technology users.
- Benchmark large libraries and representative local text models, including multilingual examples.

## Possible later features

- Optional OCR of local image assets.
- Local speech transcription for user-provided media.
- Local semantic search with an evaluated embedding model.
- A mobile share extension or share-target workflow.
- Additional source adapters built through the same explicit import contract.
- Stronger backup encryption and configurable retention.
- Shared collections or multiple owners, with a deliberate permissions model.

## Product principles

Keep the user's source organization recognizable. Preserve edits across refreshes. Report incomplete coverage plainly. Keep optional network destinations visible. Build useful local behavior even when a source adapter breaks. Prefer tested recovery over claims of universal automatic synchronization.
