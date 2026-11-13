# Launch kit

Draft copy for the maintainer to review and post. These are not records of published announcements. Replace release-specific links only with verified URLs, and use screenshots containing synthetic content.

## Repository description

A warm, self-hosted library for saved posts and links. Collections, search, notes, optional local AI, and an experimental browser importer. MIT licensed.

## Short announcement

I built Little Archive: an open-source, self-hosted home for saved posts and links.

Keep your collections, add tags and notes, and actually find the things you saved. It runs on your own machine or server, with optional Ollama text suggestions and an experimental Chrome importer for selected Instagram/TikTok saved-content views.

The first alpha is available here:
https://github.com/abdulmalikaltararwa-oss/little-archive

I would love feedback on the browsing experience, import reliability, and self-hosting setup.

## Longer announcement

Saved links are easy to collect and easy to lose track of. Little Archive gives them a place you can browse again: a warm gallery, your original collections, useful tags, notes, favorites, and a simple “to revisit” workflow.

It is open source under MIT and designed for one private owner per self-hosted instance. The core uses Python, SQLite, and a buildless web interface. You can import supported exports, add links, upload local thumbnails, export your records, and download a backup. Optional text categorization runs through an Ollama service you configure.

The companion Chrome extension is experimental. It imports a saved-content view you explicitly select and reports its coverage; it does not promise every historical save or automatic all-collection synchronization. That distinction matters, and improving it with reproducible fixtures is one of the next priorities.

Code and setup:
https://github.com/abdulmalikaltararwa-oss/little-archive

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

The maintainer could offer installation help, managed hosting, or support alongside the open-source code. Those services need their own scope, pricing, privacy terms, and operating processes. They are not included in this alpha's claims or setup.
