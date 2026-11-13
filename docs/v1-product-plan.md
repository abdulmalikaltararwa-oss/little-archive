# Little Archive v1: product and delivery plan

**Status: recommended product scope, not implemented features or a release announcement.**

Prepared 13 November 2026 after a read-only audit of source commit `45f04a1ef33abf9a99f634f77395b7a694e7c5b0`. The existing [verification record](verification.md) describes the passing automated matrix for `6fb4c1dbd6caa2127910ed8ccc5d305a9ed150f6`. Those results establish the behavior that was exercised; they do not establish account-wide discovery, a consumer Mac installer, classification quality, or every live platform layout.

This plan recommends a broader product target than the current explicit-view importer. It preserves the existing release evidence and [technical acceptance gates](release-gates.md). New work must earn its own acceptance results. No proposed capability below should be advertised as shipped until implemented and verified.

## 1. The product promise

Little Archive should let an owner bring accessible Instagram and TikTok saves into a private library, preserve original collections, organize them using a consistent personal category system, find them again, and retain control of the data.

The complete first-use journey is:

1. Install and create a private library.
2. Connect the browser with an understandable permission grant.
3. Review the source account and visible collection inventory.
4. Import the chosen inventory and see what was captured, incomplete, or unavailable.
5. Organize using original memberships, personal categories, and clearly sourced evidence.
6. Browse or search without losing place when editing.
7. Refresh imports, back up, update, and recover without losing the library.

The target audience is an individual with a substantial saved-content backlog. A single owner can connect multiple source accounts. Team permissions, a public social network, billing, and a general-purpose CRM are outside the proposed v1 scope.

Completeness is relative to an identified, observable source inventory. A successful scan cannot prove that a platform exposed every historical save. Deleted, inaccessible, unloaded, and unsupported content must remain explicit. Never turn an unknown expected total into a fabricated percentage.

## 2. What the audit established

The existing implementation already supplies authentication, SQLite storage and search, source and local collections, notes, topics, favorites, progress states, whole-library organization, a durable extension outbox, repeat-import deduplication, optional model jobs and review, portable exports, and consistent backup/recovery. Reuse these capabilities.

| Finding | Current implementation evidence | Product consequence |
| --- | --- | --- |
| Browser imports cover one selected view; the collection index is rejected and extension state holds one current run. | `assertSource` and `initialState` in [extension/core.js](../extension/core.js); start handler in [extension/background.js](../extension/background.js). | The owner must remember which collections remain. |
| Browser collection definitions arrive attached to post observations. | `ImportStart` in [server/models.py](../server/models.py); `begin_import` in [server/app.py](../server/app.py). | A confirmed empty browser collection cannot currently create its source collection row. Portable file imports already support empty collection definitions. |
| Unlabeled file records use the default source account; browser imports use the confirmed account. | `import_file` in [server/app.py](../server/app.py); item uniqueness and `apply_item` in [server/storage.py](../server/storage.py). | Importing an export and later enriching it through a named browser account can create separate identities. This needs deliberate reconciliation, not automatic cross-account merging. |
| Classification uses text and free-form topic strings. | [server/classifier.py](../server/classifier.py). | It does not yet consistently choose the owner's approved categories or understand unseen media. |
| A generic fallback title can satisfy the current text-presence check. | `apply_item` in [server/storage.py](../server/storage.py); `classify_item` in [server/classifier.py](../server/classifier.py). | Link-only records need a deterministic insufficient-evidence outcome before inference. |
| Editing/favoriting calls `refreshLibrary`, which reloads offset zero and replaces the loaded list. | `refreshLibrary`, `loadItems`, `renderItems`, and `renderCard` in [web/app.js](../web/app.js). | Long browsing sessions lose their loaded inventory after an ordinary action. |
| File imports execute synchronously inside the request; backup work holds the store lock through substantial archive work. | `import_file` in [server/app.py](../server/app.py); [server/backups.py](../server/backups.py). | Larger libraries need measured latency and bounded background work. |
| A closed narrow-screen sidebar is translated offscreen without an inert/hidden state. | `renderShell` in [web/app.js](../web/app.js); responsive rules in [web/styles.css](../web/styles.css). | Keyboard focus can reach navigation that is not visible. |
| Setup and recovery are terminal-oriented; the extension is loaded unpacked. | [scripts/setup.py](../scripts/setup.py), [server/cli.py](../server/cli.py), [extension/INSTALL.md](../extension/INSTALL.md). | Ordinary Mac installation and public extension distribution remain separate deliverables. |

These are source-review findings, not newly executed user tests. The passing tests remain valid for their recorded scope.

## 3. Required v1 workstreams

### A. Guided account importing and coverage

**Outcome:** the owner can see the intended inventory, import it in a guided sequence, and identify unfinished work.

Build an Imports screen with account, exact collection/view name, last attempt, last successful scan, observed unique count, coverage evidence, stop reason, and next action. Display scopes that the backend already records. Separate a saved connection from a recently verified reachable connection.

Add source-account records, a discovered scope inventory, and a persistent import plan above the existing per-view run/batch protocol. Discovery should have its own guarded operation for a selected collection index. Preserve a manual add/open-collection fallback when the source does not expose a reliable list. A guided sequence is acceptable; unrestricted unattended browsing is unnecessary.

Add an explicit source-collection observation independent of posts, including stable source identity and confirmed-empty evidence. Keep zero loaded records separate from a confirmed empty collection. The same post can belong to several original collections.

Provide a repeat action, such as **Refresh my saves**, that reuses the plan and makes incomplete scopes visible. Absence from any scan, including an observed-end scan, is missing-observation evidence rather than an instruction to delete a library item or source membership. Any proposed removal requires a separate reviewed reconciliation step.

**Acceptance:**

- Known inventories on both live platforms are compared with imported unique IDs and memberships.
- Controlled cases include ten collections, overlapping posts, duplicate names, a stable-ID rename, an empty collection, a failed view, and a delayed-loading grid.
- Browser restart, interruption, account switching, revoked permission, and revoked credentials preserve correct scope and provide an actionable next step.
- Confirmed empty collections survive import/export/backup/restore.
- No unknown account total is displayed as verified complete.

### B. File-to-browser reconciliation

**Outcome:** an account export can seed a library and browser capture can enrich the same records.

Add file preview/staging before commit: recognized format, selected saved-data sections, chosen source account, proposed item counts, collection information available, rejected rows, and size limits. Discard unrelated sections instead of importing them into the saved library.

Use a stable local source-account ID or an explicit alias mapping. Preserve imported labels as provenance. Provide a reviewed migration path for existing default-account imports. Collection names alone are insufficient evidence that two source collections are identical.

Add durable file-import jobs with bounded work, progress, cancellation, and a complete local rejection report. Retain resource limits and ZIP protections. Provide a clear supported path for larger exports rather than silently truncating or requiring users to split arbitrary record lists manually.

Persist only bounded, normalized saved-content records needed for the import. If an original upload must be staged temporarily, keep it in private storage and remove it after parsing. Define cleanup on completion, cancellation, expiry, and crash recovery. Keep rejection reports owner-only and exclude unrelated archive data.

**Acceptance:**

- Export import for account A followed by browser import for account A produces one item per canonical post, combined observed memberships, and preserved notes.
- The same post saved by account B remains separately scoped.
- Conflicting manual annotations and ambiguous collection matches require an explicit resolution.
- A cancelled or interrupted import can resume without duplicate writes.
- All rejected records have a reason; unrelated private archive sections are not retained.

### C. Personal categories and evidence-aware classification

**Outcome:** the second layer of organization follows the owner's vocabulary and remains easy to correct.

Keep these fields distinct:

| Layer | Meaning | Example |
| --- | --- | --- |
| Original collection | Observed source organization, preserved separately | Dinner ideas |
| Personal category | Owner-defined organizing label with stable ID | Food |
| Content kind | What the post is for, inferred only from available evidence | Recipe |
| Topics | Supporting searchable labels | Chicken, rice, quick dinner |
| Media format | Observed source format | Video |
| Progress | Owner's chosen state | To revisit |
| Evidence | What was actually captured or processed | Caption; no audio transcript |

Start with flat categories, optional descriptions, aliases, and explicit source-collection mappings. AI should choose allowed category IDs and propose additional topics separately. Original source memberships and manual corrections remain protected. Deterministic owner-created mappings can be applied without model inference.

Add field-by-field review and grouped/bulk review with affected counts and samples. An owner should be able to accept topics while rejecting a proposed title or summary. Support topic rename/merge/removal and undo of bulk changes. Undo must not revert unrelated later note edits.

The existing model's `content_type` is a media-format enum and is not applied by the current accept operation. Resolve that contract deliberately: preserve trusted source format, and add a separate correctable content-kind field. Do not blindly replace observed video/image identity with an LLM guess.

Maintain typed evidence with source, capture time, extractor version, and content hash. Preserve useful captions/alternatives when a later observation contains only a link. Permit changed observations to enrich an already-seen post. Separate source collection names from local collection names in model input.

Classification fingerprints must include effective taxonomy/mapping versions, relevant manual-decision revisions, and extraction/model configuration. Revalidate allowed category IDs before applying a result. Category deletion, merge, or a manual correction must invalidate affected pending suggestions rather than reapply an obsolete decision.

Add a deterministic insufficient-evidence guard for fallback titles and empty metadata. For supported layouts, provide a bounded, explicit detail-page enrichment flow for rendered captions. Pause at source login/challenge/availability problems. Do not make private platform APIs or unrestricted backend URL fetching an implicit dependency.

Local thumbnail preservation should be an explicit import option where a preview can be retrieved through the supported access path. Store bounded validated images locally, include them in backups, and show a useful fallback if unavailable. Do not promise permanent storage of every third-party video. If live imports yield insufficient useful text for the intended categorization experience, implement and evaluate further permitted enrichment before claiming that goal is met.

**Acceptance:**

- Original collection names and memberships cannot be changed by classification.
- Categories, aliases, mappings, content kind, manual decisions, and evidence survive export and recovery.
- Sparse refreshes do not erase richer evidence; repeated unchanged evidence does not generate duplicate model work.
- Link-only fixtures are left unclassified with an explanation.
- A held-out, owner-labeled sample of 100–200 representative items includes English, Arabic, mixed-language, and thin-evidence cases.
- Proposed quality targets: at least 85% of emitted primary-category suggestions accepted without correction, and suggestions for at least 80% of the sample's adequately evidenced items. These are targets, not observed scores or universal accuracy claims.
- Label valid primary categories and evidence sufficiency before inspecting model output. A multi-category item can have several acceptable reference categories; count a primary prediction correct only if it belongs to that set. Correct link-only abstentions are reported separately, while abstentions on adequately evidenced items reduce coverage. Report overall suggestion coverage, abstention, errors, and acceptance by language/evidence group, separating deterministic mappings from model suggestions. If most real imports lack usable evidence, high conditional accuracy does not establish a useful categorization product.
- Evaluate the default local model on the target Mac for usefulness, memory, latency, and queue interruption. Passing two smoke inferences is not a quality evaluation.
- A stopped or missing model is identified by a connection check before a large batch is started. Manual organization remains fully usable without AI.

### D. Browsing, correction, and accessibility

**Outcome:** the owner can comfortably browse thousands of saves and correct organization without losing context.

Update changed records without resetting loaded pages or scroll position. Represent collection/search/item state in navigation so Back, Forward, reload, and direct links work. Keep account and platform context visible when source collection names collide. Add a searchable collection browser and useful creator/content-kind filters.

Complete bulk remove/move/merge operations and an undo path. Add a clearly labeled Trash flow or another recoverable deletion mechanism, with explicit permanent removal. Preserve the existing warm visual design; these improvements do not require a redesign or a different frontend framework.

Make closed navigation inert, preserve focus after changes, return focus to the originating control after dialogs, and provide restrained status announcements. Verify long labels, Arabic/English mixtures, narrow windows, zoom, keyboard-only operation, and Mac VoiceOver.

**Acceptance:**

- After loading several hundred records, editing/favoriting one retains the loaded inventory and the same visible position.
- Back/Forward/reload restore the intended collection, query, filters, and item.
- An owner can locate a collection among 250 collections through search.
- A bulk correction affects all matching records, including unloaded pages, and can be reversed without changing source memberships or unrelated newer edits.
- A keyboard/VoiceOver user can complete sign-in, browsing, editing, review, and bulk organization with no offscreen focus traps.

### E. Mac onboarding and browser distribution

**Outcome:** a Mac user can install and maintain the app without operating the backend manually; a self-hosting user can deploy a versioned package.

Keep the existing Python/SQLite backend and web interface. Add a thin Mac application/launcher that owns the backend lifecycle and presents the same interface. Select its wrapper and Python packaging approach through a small packaging proof: bundled runtime, clean-machine launch, loopback communication, signing of nested executables, and graceful shutdown. A full SwiftUI rewrite is unnecessary.

First-run setup should create or select a private library, configure owner access, explain the data location, pair the browser, offer optional model configuration, and establish a first backup. Application data belongs outside the signed app bundle. Support reopening after quit/reboot, explicit start-at-login preference, clean shutdown, and migration of an existing library. Closing a window and quitting the background service must have clear behavior.

Replace routine manual token handling with an expiring, single-use pairing exchange. Show the exact instance origin, retain explicit Chrome host consent, issue an import-scoped device credential, and expose revocation. Rate-limit pairing attempts and bind them to the intended instance/device. No platform passwords or platform session-cookie transfer is needed.

For general public Chrome distribution, prepare a Web Store package, listing, privacy disclosure, permission explanation, and update process. Chrome documents unpacked loading for development/personal use; ordinary direct installation on macOS uses the Web Store, while self-hosted packed extensions require enterprise policy. [Chrome distribution](https://developer.chrome.com/docs/extensions/how-to/distribute).

For the recommended Mac distribution outside the App Store, sign all bundled executables with Developer ID, the required Hardened Runtime settings, and secure timestamps; notarize and staple the distributed app or disk image. Apple documents these requirements; notarization is distinct from App Review. Publisher credentials and external review are delivery dependencies, not evidence already obtained. [Apple notarization](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution).

Publish immutable versioned self-hosting images for supported architectures, with a minimal Compose setup, checksums, and clear upgrade instructions. Do not make self-hosting depend on an account operated by this project. Preserve source/unpacked installation for contributors.

**Acceptance:**

- A person on a clean supported Mac installs the downloaded package, creates a library, connects Chrome, and imports a known view without editing environment files.
- The actual downloaded/quarantined app launches through the normal Gatekeeper flow. Test each binary architecture advertised.
- Quit/reopen/reboot, an occupied port, a backend failure, a missing model, and a declined browser permission have understandable outcomes.
- Pairing codes expire and cannot be replayed; device revocation stops further imports.
- A self-hosting operator installs the exact published version, upgrades, and recovers using documented commands.
- Public install links refer to approved, tested artifacts. A submitted store listing is not a completed distribution gate.

### F. Recovery, capacity, and maintenance

**Outcome:** the library remains responsive during maintenance and can be recovered without specialist knowledge.

Add backup status, last verified success, an optional owner-configured schedule/destination, bounded retention, and actionable failures. A second copy on the same disk protects against some mistakes but does not establish protection from disk loss. Make that distinction visible when choosing a backup destination.

Provide restore preflight and a recovery assistant that validates a backup and creates a separate recovered library. The Mac launcher can manage the offline handoff. Keep new recovery credentials and the original library intact until the recovered copy is checked.

Introduce explicit versioned schema migrations before new taxonomy/account/job tables ship. Back up before migration, fail safely, and test recovery using the previous application plus a pre-update backup. Do not infer future migration safety from the existing same-schema upgrade rehearsal.

Move expensive import/archive work out of request-critical sections. Use durable bounded jobs, small transactions, appropriate SQLite locking, and measured query/index improvements. Profile before introducing a new database or distributed queue.

Add actionable model/import/service health states, disk-space checks, storage usage, and an owner-triggered diagnostic export that excludes private post text, URLs, account labels, credentials, and environment contents. Default analytics remains absent.

**Proposed capacity targets, not measured results:**

- At least 10,000 saves and 250 collections on an identified Apple Silicon Mac with 16 GB memory; measure a 50,000-record stress case and publish actual limits.
- First useful gallery within two seconds after the local server is ready; record cold application startup separately. Typical local search/filter API responses should finish within 500 ms at the 95th percentile; also report input-to-visible-results latency, including debounce and rendering. Model inference and remote platform latency are measured separately.
- Reference fixture: 10,000 records, 250 collections, 5,000 distinct local previews of approximately 128 KiB each, a declared mix of empty/1 KiB/16 KiB captions, and at least 25% Arabic or mixed-language records. Save the generated fixture manifest, versions, and hardware. Measure idle browsing and browsing during a 1,000-record import and a backup. Add observed real-world caption/image distributions after the initial source baseline; the reference fixture alone is not proof for every library.
- Browsing remains usable during imports and backup creation; the DOM and upload/archive memory use remain bounded.
- The actual owner's inventory must fall within the tested capacity before that installation is accepted.

**Recovery acceptance:** corrupt archive, insufficient disk space, process interruption, an existing destination, restored image integrity, fresh credentials, update failure, and recovery onto another installation all have observed results. Preserve the current strict restore boundaries.

## 4. Platform constraints that affect the scope

Meta's reviewed Instagram overview describes professional-account APIs and lists publishing, moderation, messaging, and related capabilities. No saved-library endpoint was documented in the overview and capability/permission listings reviewed. This is a scoped finding, not an exhaustive claim about every integration. Do not present an Instagram OAuth button as a verified way to import personal Saved collections. [Meta overview](https://developers.facebook.com/documentation/instagram-platform/overview).

TikTok's Data Portability API is currently limited to data from EEA/UK users, even though applicants can be located elsewhere. Its Full Archive table lists favorite-video dates and landing-page links; the narrower Activity table does not list favorites, and favorite collection memberships/media bytes are not documented in the favorite-video entry. Both Data Portability and Login Kit approval are required. Treat this as an optional regional connector; verify the approved scope and actual response before promising a favorites integration. [Availability](https://developers.tiktok.com/products/data-portability-api/), [data types](https://developers.tiktok.com/docs/en/data-portability-data-types), and [approvals](https://developers.tiktok.com/docs/en/data-portability-api-get-started).

Browser capture and user-provided exports remain the proposed baseline. Verify the permitted access path, current layouts, and real results. Platform changes require adapter maintenance. Do not bypass login challenges or silently substitute a hidden private API.

## 5. Build order and decision gates

| Stage | Work | Exit condition |
| --- | --- | --- |
| 1. Observe the real journey | Private Mac installation and both live source views; measure inventory size and evidence availability. Fix immediate browsing/focus regressions and record baseline performance/keyboard behavior. | Known records and memberships are captured and compared; the supported layout and major evidence gaps are recorded. |
| 2. Complete import integrity | Introduce versioned migrations first, then accounts, scope inventory, guided plan, independent collection observations, file preview/reconciliation, and durable file jobs. | The multi-collection and file-plus-browser acceptance cases pass, including empty collections and interruptions. |
| 3. Complete organization | Personal taxonomy, media-format/content-kind separation, evidence enrichment, grouped review, bulk correction/undo. | Representative held-out categorization reaches the stated target; manual corrections and source organization survive refresh and recovery. |
| 4. Complete delivery | Mac wrapper/onboarding, pairing, immutable images, extension store preparation, signing and downloaded-artifact verification. | A fresh user can install and complete the first import through the advertised installation path. |
| 5. Exercise sustained use | Capacity, background operations, backup/recovery assistant, accessibility, migration/recovery verification, diagnostic export. | Published performance/recovery targets pass on supported environments; observed material failures are fixed. |
| 6. Freeze and release | Final version alignment, exact-artifact tests, release notes, known limits, screenshots, source and checksums. | All required gates have evidence for the final runtime/package; publish 1.0.0 and then the announcement. |

Stages overlap where dependencies allow: distribution preparation can run alongside import and taxonomy work. Do not freeze an import architecture before observing both source platforms. Do not evaluate categorization on synthetic rich captions alone if real imports are mostly link-only.

The release clock follows completed evidence, not an arbitrary date. Store review, signing access, live accounts, and representative user feedback are external dependencies; their turnaround should not be presented as an engineering guarantee.

## 6. Concrete release acceptance

Before a stable announcement, require:

- The current automated suites plus meaningful new tests for each added failure mode.
- Completed live Instagram and TikTok capture-to-library checks for each advertised view.
- All expected records and memberships in the known test inventories accounted for; no unexplained duplicate or silent omission.
- Correct empty collections, account isolation, repeat imports, archive reconciliation, and preserved manual annotations.
- Classification usefulness measured separately from model/API integration; evidence limits remain visible.
- Clean installation and normal permission consent through the advertised Mac/extension distribution path.
- Upgrade, schema migration, pre-update rollback, corruption/low-space handling, and recovery onto another installation.
- Large-library performance and Mac keyboard/VoiceOver acceptance.
- A small private release-candidate pilot: proposed target of five representative users for seven days, with no unresolved data-loss or authentication-boundary defect. Observe at least four of five complete first import without developer intervention; treat the result as a usability signal, not a statistical guarantee.
- Security review of any new pairing, local service bridge, file/media processing, migration, and update-signing boundaries.
- Versioned artifacts, dependency/third-party notices, checksums, an accurate support matrix, privacy documentation, and issue/reporting instructions.

The private pilot is an acceptance phase for the completed intended v1 scope. It is not a substitute for finishing required features or evidence.

## 7. Valuable additions after the core v1

| Addition | Why it may be valuable | Why it can follow v1 |
| --- | --- | --- |
| Smart collections / saved filters | Keep dynamic groups such as untried recipes or learning material. | Depends on consistent categories and filter semantics; small follow-up once those are stable. |
| Rediscovery and personal digests | Bring useful older saves back into attention. | Start from the existing Rediscover feature; evaluate actual use before building a recommendation system. |
| Semantic search | Find an item from a remembered concept when exact words are unavailable. | Requires an evaluated multilingual embedding/index lifecycle and useful captured evidence. |
| Local OCR and user-provided media transcription | Recover text unavailable in captions. | Adds processing, model, storage, provenance, and resource work. Pull forward only if required by the agreed categorization promise and real evidence gaps. |
| Mobile capture/share integration | Save into the same library while using a phone. | Adds another distribution, authentication, and synchronization surface. |
| Official regional TikTok portability connector | An additional approved transfer path for eligible users. | Region, scope, review, and OAuth architecture need separate verification. |
| Managed hosting and paid support | Charge for convenience, operation, recovery, and support around the open-source product. | Requires service operations, customer isolation, billing, cost controls, and a separate privacy/support commitment. |

Defer team workspaces, public sharing networks, a full native UI rewrite, additional social platforms, chat-with-library, and universal video downloading. Choose later features from repeated user problems after v1 has proven the capture-to-recovery journey.

## 8. Immediate implementation backlog

| ID | Deliverable | Depends on | Acceptance reference |
| --- | --- | --- | --- |
| V1-01 | Live-source/private Mac baseline and supported-layout inventory | Working owner browser and private instance | A; stage 1 |
| V1-02 | Preserve loaded gallery/scroll; fix closed-navigation focus | Existing UI | D |
| V1-03 | Versioned migrations and stable source-account records | Reviewed data model | B, F |
| V1-04 | Collection inventory, import plans, empty collection observations | V1-01, V1-03 | A |
| V1-05 | Export preview, account reconciliation, durable file jobs | V1-03 | B |
| V1-06 | Personal taxonomy, content kind, mappings, correction persistence | V1-03 | C |
| V1-07 | Evidence states, changed-observation enrichment, local previews | V1-01, V1-04 | C |
| V1-08 | Field/bulk review, merge/remove/move, undo and recoverable deletion | V1-06 | C, D |
| V1-09 | Model health/setup and held-out categorization evaluation | V1-06, V1-07 | C |
| V1-10 | Mac packaging proof, first-run setup, backend lifecycle | Existing backend; publisher signing access for distribution | E |
| V1-11 | Pairing, connection health, device revocation, store package | V1-10 origin/lifecycle contract | E |
| V1-12 | Backup destination/status/schedule, restore preflight/assistant | V1-03, V1-10 | F |
| V1-13 | Final capacity, keyboard/VoiceOver, and diagnostics regression; baseline measurement starts at V1-01/V1-02 | V1-04 through V1-12 for final acceptance | D, F |
| V1-14 | Private acceptance pilot, final artifact verification, 1.0 release | All required workstreams | Section 6 |

Preserve the current implementation where it already meets the requirement. Keep proposed features, source-review findings, automated results, and direct user observations visibly distinct throughout delivery.
