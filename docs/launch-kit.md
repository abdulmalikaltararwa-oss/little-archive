# Conditional 1.0 launch kit

Unpublished draft copy for the maintainer to use **only after all required [1.0 release gates](release-gates.md) pass and the stable release is published**. The public source repository and synthetic demo already exist; the stable 1.0 release does not. Replace release placeholders only with verified URLs, and use screenshots containing synthetic content.

Use the [verification record](verification.md) when describing test results. Do not turn a planned check into a completed claim, and do not describe synthetic-demo interactions as authenticated backend or real-account capture evidence.

## Repository description

Verified interactive demo: https://abdulmalikaltararwa-oss.github.io/little-archive/

A warm, self-hosted library for saved posts and links. Collections, search, notes, optional local AI, and an experimental browser importer. MIT licensed.

## Short announcement — publish after acceptance

Little Archive 1.0 is an open-source, self-hosted home for saved posts and links.

Keep your collections, add tags and notes, and actually find the things you saved. It runs on your own machine or server, with optional Ollama text suggestions and an experimental Chrome importer for selected Instagram/TikTok saved-content views.

Release and installation: REPLACE_WITH_VERIFIED_1_0_RELEASE_URL

Try the synthetic interface demo:
https://abdulmalikaltararwa-oss.github.io/little-archive/

I would love feedback on the browsing experience, import reliability, and self-hosting setup.

## Longer announcement — publish after acceptance

Saved links are easy to collect and easy to lose track of. Little Archive gives them a place you can browse again: a warm gallery, your original collections, useful tags, notes, favorites, and a simple “to revisit” workflow.

It is open source under MIT and designed for one private owner per self-hosted instance. The core uses Python, SQLite, and a buildless web interface. You can import supported exports, add links, upload local thumbnails, export your records, and download a backup. Optional text categorization runs through an Ollama service you configure.

The companion Chrome extension imports a saved-content view you explicitly select and reports its coverage. The release notes identify the views and browser versions accepted for this release. It does not promise every historical save or automatic all-collection synchronization.

Code and setup:
https://github.com/abdulmalikaltararwa-oss/little-archive

Stable release: REPLACE_WITH_VERIFIED_1_0_RELEASE_URL

If you try it, useful feedback includes your installation method, a synthetic reproduction of any issue, and what made an old save easier—or harder—to find. Please keep private exports and credentials out of public reports.

## Suggested demo sequence

1. Show the gallery with explicitly loaded synthetic demo content.
2. Filter a collection, then search a tag or title.
3. Open a card, add a note, and mark it To revisit.
4. Create a local collection and add a link to it.
5. Show the import and export controls.
6. If a local model is configured, show a suggestion being reviewed rather than presenting an unreviewed output as fact.

## Claims to avoid

- “Automatically imports every save from every account.”
- “Reads or understands every video.”
- “Official platform integration” unless a separately verified integration exists.
- “Audited,” “production hardened,” or “zero risk.”
- “Entirely offline” while demonstrating a source import or remote preview.
- “Free unlimited cloud service.” This is self-hosted software, with the operator's own resource costs.

## Optional services later

The maintainer could offer installation help, managed hosting, or support alongside the open-source code. Those services need their own scope, pricing, privacy terms, and operating processes. They are not included in the self-hosted application's setup or release claims.
