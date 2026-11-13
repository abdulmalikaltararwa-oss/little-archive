# Roadmap

Roadmap entries are intentions, not promises of a release date or current support.

## First stable release: in development

The first stable release targets a private, browsable library: authentication, source and local collections, keyword search, tags, notes, progress, file imports, explicit browser imports, optional model suggestions, and portable backup/export. The current internal version remains development software until the [1.0 release gates](release-gates.md) have passing evidence.

## Acceptance before 1.0

The complete automated matrix has passed, including authenticated browser flows, interrupted extension imports and browser restarts, real local-model inference, both Mac architectures, both container architectures, and update/rollback recovery. See the [verification record](verification.md) for the exact candidate and scope.

The remaining required acceptance connects the chosen Mac installation, normal Chrome permission consent, and real Instagram and TikTok saved-content views. Record these results without publishing private records, resolve any observed failures, then align and publish the stable package. The [Mac acceptance guide](mac-acceptance.md) gives this procedure.

## Ongoing quality work

- Add sanitized source-layout fixtures as the platforms change.
- Extend collection discovery and reconciliation where the source exposes sufficient evidence.
- Gather keyboard and assistive-technology feedback beyond the existing browser tests.
- Benchmark larger libraries and additional local text models, including multilingual examples.

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
