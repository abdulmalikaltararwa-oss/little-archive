# Roadmap

Roadmap entries are intentions, not promises of a release date or current support.

The [recommended v1 product, open-source, and delivery plan](v1-product-plan.md) is the master plan for the proposed public release. Its 22 deliverables cover guided account importing, personal categories, ordinary Mac installation, self-hosting, recovery, local AI setup, installation by a local coding assistant, English/Arabic accessibility, and a maintainable contributor/release workflow. Proposed additions are not yet implemented or included in the current passing verification results.

## First stable release: in development

The current foundation includes authentication, source and local collections, keyword search, topics, notes, progress, file imports, explicit-view browser imports, optional model suggestions, and portable backup/export. The broader recommended v1 completes the capture-to-recovery journey and public project experience described in the master plan. The current internal version remains development software until both the existing [technical release gates](release-gates.md) and the new agreed product/project acceptance criteria have passing evidence.

## Acceptance before 1.0

The complete automated matrix has passed, including authenticated browser flows, interrupted extension imports and browser restarts, real local-model inference, both Mac architectures, both container architectures, and update/rollback recovery. See the [verification record](verification.md) for the exact candidate and scope.

For the current explicit-view implementation, remaining direct acceptance connects the chosen Mac installation, normal Chrome permission consent, and real Instagram and TikTok saved-content views. The [Mac acceptance guide](mac-acceptance.md) gives that procedure. The broader recommended v1 also requires the additional implementation, quality evaluation, public installation, accessibility, contributor, and recovery gates in the master plan. Passing the older procedure alone will not establish those new capabilities.

## Ongoing quality work

- Add sanitized source-layout fixtures as the platforms change.
- Complete the planned collection discovery and reconciliation where the source exposes sufficient evidence.
- Gather keyboard and assistive-technology feedback beyond the existing browser tests.
- Benchmark larger libraries and additional local text models, including multilingual examples.
- Keep user, contributor, assistant-setup, and release instructions aligned with tested artifacts.

## Possible later features

- Optional OCR of local image assets.
- Local speech transcription for user-provided media.
- Local semantic search with an evaluated embedding model.
- A mobile share extension or share-target workflow.
- Additional source adapters built through the same explicit import contract.
- Additional backup encryption options; configurable bounded retention belongs to the recommended v1.
- Shared collections or multiple owners, with a deliberate permissions model.

## Product principles

Keep the user's source organization recognizable. Preserve edits across refreshes. Report incomplete coverage plainly. Keep optional network destinations visible. Build useful local behavior even when a source adapter breaks. Prefer tested recovery over claims of universal automatic synchronization.
