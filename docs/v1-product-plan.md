# Little Archive v1: product, open-source, and delivery plan

**Status: v1 target in implementation; proposed scope and delivered foundations are distinguished below. No stable release has been announced.**

Prepared 13 November 2026 after a read-only audit of source commit `45f04a1ef33abf9a99f634f77395b7a694e7c5b0`. The existing [verification record](verification.md) describes the passing automated matrix for `6fb4c1dbd6caa2127910ed8ccc5d305a9ed150f6`. Those results establish the behavior that was exercised; they do not establish account-wide discovery, a consumer Mac installer, classification quality, or every live platform layout.

This plan recommends a broader product target than the current explicit-view importer. It preserves the existing release evidence and [technical acceptance gates](release-gates.md). New work must earn its own acceptance results. No proposed capability below should be advertised as shipped until implemented and verified.

Expanded to include public installation, contributors and maintainers, English/Arabic accessibility, guided local AI, and installation by a local AI coding assistant. The goal is a complete, supportable first release within a published scope. Capabilities not identified as delivered in the progress table remain proposed scope.

### Implementation progress

The first foundation batch implements the following subset. Its verification status is maintained in [the verification record](verification.md); implementation alone does not complete the full v1 gates.

| Deliverable | Delivered foundation | Remaining acceptance or scope |
| --- | --- | --- |
| V1-02 | Loaded gallery continuity after edits/favorites and narrow-navigation focus handling, with browser regressions. | Direct Mac VoiceOver acceptance and broader navigation/history work in D remain separate. Search-affecting edits can reselect a random Rediscover sample. |
| V1-16 | Isolated loopback contributor workspace, synthetic seed, private credentials, read-only check, and bounded cleanup. | Independent newcomer contribution rehearsal remains a public-project gate. |
| V1-17 | Explicit extension protocol/capability handshake and tested preservation of pending payloads; narrow legacy compatibility. | Versioned DB migrations, portable-format evolution, and broader migration policy remain open. |
| V1-09 / V1-22 | Configuration preview/creation, read-only doctor, bounded optional model inventory probe, operator guide, and repository assistant instructions. | GUI setup, runtime/model download, inference/quality evaluation, and an independent local-assistant installation remain open. |

The existing source audit below records the pre-foundation behavior. Consult these progress notes and current source when assessing a finding that has since been addressed. Commands implemented in [operator setup](operator-setup.md) supersede the illustrative command names in the proposed scope.

Reading guide: [product and users](#1-the-product-promise), [required features](#3-required-v1-workstreams), [local model setup](#g-guided-local-ai-setup), [coding-assistant setup](#h-installation-by-a-local-ai-coding-assistant), [open-source project](#4-building-a-useful-public-open-source-project), [build order](#6-build-order-and-decision-gates), [release acceptance](#7-concrete-release-acceptance), and [22-item backlog](#9-implementation-backlog).

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

### Who should be able to use it

| Audience or surface | Recommended v1 commitment | Evidence required before advertising support |
| --- | --- | --- |
| Everyday Mac owner | A downloadable app with first-run setup, library management, optional local AI, and browser pairing. | Actual downloaded application accepted on every advertised macOS/CPU combination; no terminal required for the normal journey. |
| Self-hosting owner | Versioned Linux AMD64/ARM64 container images, a short Compose setup, and documented update/recovery. | Fresh install, update, backup, restore, and removal while retaining data using published artifacts. |
| Desktop web user | The same private library in supported Chrome, Firefox, and Safari versions, including a Windows web client. | Publish tested versions and minimums; direct Safari/Mac acceptance supplements the existing WebKit-engine tests. |
| Desktop social capture | Chrome companion extension for explicitly accepted Instagram/TikTok views. | Normal installation and permission consent plus live checks for the advertised views. Firefox/Safari capture is a separate future deliverable. |
| Mobile web user | Browse, search, annotate, and organize through a reachable private HTTPS instance. | Real narrow-screen and touch acceptance. A Mac library bound to loopback is not automatically accessible from a phone. Explain the desktop import path. |
| Modest-hardware or no-AI user | Complete import, manual organization, mappings, search, export, and recovery without a model or project account. | The complete core journey passes with AI disabled. Installed local content remains usable without Internet access. |
| Contributor or local coding-assistant user | A documented source setup, isolated synthetic library, predictable commands, and useful diagnostics. | A fresh environment can install, run checks, make a small change, and clean up without touching a personal library or using a social account. |

Maintain a support matrix with **supported**, **experimental**, and **not provided** entries. Distinguish the UI browser, capture extension, server host, Mac application, model runtime, and source layout. Native Windows/Linux desktop packages, mobile capture, remote offline synchronization, and every model provider are outside the first release. Do not turn a manifest's minimum browser version into a claim that it was actually tested.

Use the existing Python/SQLite backend and shared interface for all supported paths. Keep the current MIT license and original identity. No paid AI, hosted project account, or telemetry service should be required for the core product. Owner-chosen integrations remain explicit.

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
| Model availability is inferred from configured strings; setup writes empty model settings. | `current_settings` in [server/app.py](../server/app.py), [server/config.py](../server/config.py), [scripts/setup.py](../scripts/setup.py). | A configured endpoint may be unavailable, missing its model, or unsuitable for the task. There is no guided installation or model-health probe. |
| Development startup loads the ordinary environment and defaults to an all-interface bind. | [scripts/dev.py](../scripts/dev.py). | Contributors and coding assistants need a distinct, loopback-only synthetic workspace by default. |

These are source-review findings, not newly executed user tests. The passing tests remain valid for their recorded scope. Existing community files include a license, contribution guide, security policy, and issue forms; repository settings such as private reporting and branch protection have not been audited by this planning work.

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

Adopt WCAG 2.2 AA as the accessibility target, with task-based manual checks and an honest statement of evaluated scope. An automated scan or engine test is not a conformance claim. W3C defines accessibility conformance through testable success criteria. [WCAG overview](https://www.w3.org/WAI/standards-guidelines/wcag/).

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

Publish versioned self-hosting images for supported architectures, with recorded digests, digest-pinned Compose examples, checksums, and clear upgrade instructions. A version tag alone does not establish immutability. Do not make self-hosting depend on an account operated by this project. Preserve source/unpacked installation for contributors.

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

### G. Guided local AI setup

**Outcome:** a person can use an existing local model or follow a guided setup, understand where processing happens, and verify usefulness before starting a large job.

Keep Ollama as the first supported runtime because the existing classifier already uses its chat protocol. Introduce a small provider interface for probing, listing models, inference, cancellation behavior, and structured-output validation. Other local providers can be added through separately tested adapters; protocol resemblance alone is insufficient to advertise compatibility.

Offer three clear choices: **Use my installed model**, **Help me set up local AI**, and **Continue without AI**. The last choice is permanent unless the owner revisits settings; it must not produce repeated upgrade prompts.

The guided flow should:

1. Detect the supported runtime at the selected endpoint from the backend's execution environment. Check a known local address or owner-provided destination; do not scan the network. Distinguish native Mac, a host runtime accessed by a container, and a runtime running next to a remote server.
2. Show installed models, runtime version, model identity/digest, processing location, and capability results. For a local Mac runtime, open the official installer if needed and resume the guide afterward. For a self-hosted backend, provide the matching server/container setup instructions and check the resulting service from that backend; installing on the browser's computer does not install beside a remote server. Reuse an existing runtime without silently changing its global settings or quitting a service used by another app.
3. Offer a small evaluated model set. Show official model license, download source, expected download/storage size, and measured or clearly estimated memory/latency before the owner chooses a download. Do not include model weights in the application package by default. Record the exact model and redistribution decision separately from the application's MIT license.
4. Show download progress, available space, retry, and the cancellation behavior actually supported by the runtime. Do not claim a model download was stopped merely because the client stopped displaying it. Preserve an existing selected model if a new download fails.
5. Run a synthetic structured-output test, then offer a small owner-selected sample for reviewing actual category suggestions. Successful connectivity is not a classification-quality result.
6. Save the chosen configuration through the authenticated setup interface. Show ready, runtime stopped, model missing, incompatible output, busy, timeout, and resource-failure states with an actionable next step. Allow the owner to change models, pause work, or disable AI while continuing to use the library.

Keep inexpensive reachability/model checks separate from an explicit inference test, and show when health was last checked. Define precedence between managed settings and operator environment overrides. Apply configuration changes atomically, explain overrides and required restarts, and preserve credentials/data paths. Opening Settings should not silently trigger an inference or restart a shared runtime.

The model provider must receive only the evidence needed for classification. Model output remains validated data; it cannot execute tools, change source collection facts, or control installation. Model identity/configuration changes invalidate affected pending suggestions and are recorded in the evaluation and provenance.

Ollama supports listing installed models and their metadata. It also supports disabling its cloud features. A loopback URL alone does not establish that inference stays on the machine. The recommended local-only setup must select local weights and disable cloud inference; show an unverified processing location honestly when an existing owner-managed runtime cannot be checked. Never silently fall back to a hosted model. [Model listing](https://docs.ollama.com/api/tags), [local-only configuration](https://docs.ollama.com/faq).

For Mac, evaluate a native model runtime with the app rather than assuming Docker will provide the same GPU behavior; Ollama's current documentation identifies the Docker Desktop macOS GPU limitation. For self-hosting, document the backend-to-runtime route and use a private service network or a deliberately configured host connection. Do not expose an unauthenticated model endpoint merely to make detection succeed. [Ollama runtime guidance](https://docs.ollama.com/faq).

**Acceptance:**

- Fresh native Mac and supported self-host installations can connect an existing model, identify a missing runtime, complete the guided installation/download path, and skip AI.
- Tests cover a stopped runtime, missing model, occupied endpoint, low disk space, interrupted download, incompatible response, inference timeout, and model change during queued work.
- The selected model passes the language/evidence quality evaluation in C on declared hardware. The existing small CI smoke model is not automatically the product recommendation.
- After installation and model download, a local-only inference check passes with outbound network access blocked; the library also remains usable with the runtime stopped.
- Manual categories, source mappings, bulk organization, search, export, and recovery pass without AI configuration.

### H. Installation by a local AI coding assistant

**Outcome:** someone can ask an assistant running on their computer to set up Little Archive using the same maintained setup path a person can run directly.

The assistant's reasoning model and Little Archive's optional classification model are independent. This path assumes an already working supported local assistant and its model. The assistant must also be able to install the library with classification AI disabled; connecting a classification runtime is a separate optional step.

Publish a concise repository `AGENTS.md` and an assistant setup guide describing supported environments, release selection, commands, expected results, data locations, and recovery. Keep installation instructions separate from development instructions. A local assistant should be able to install a released artifact without modifying application source. A browser chat can explain these steps, but running them on a person's Mac requires a local tool connection or local assistant; browser presence alone is insufficient.

Share deterministic setup and diagnostic operations between the future GUI, documented CLI, and assistant guide. The first foundation implements configuration-only `setup --dry-run` / `setup --apply`, read-only `doctor --json`, and the operator guide; see [the actual command contract](operator-setup.md). Full application/runtime installation and GUI integration remain open. Keep versioned JSON results, stable exit/reason codes, prerequisites, bounded timeouts, and suggested next actions. Generate reference documentation from the actual command interface where practical.

Dry-run and doctor must be read-only, including their initialization paths. Do not construct a store or service that creates a database, performs migrations, or requeues work merely to inspect it. Keep synthetic inference as a separately requested operation. Diagnostic output must be bounded and redact secrets by construction.

The assistant workflow should inspect the supported environment, choose a pinned release, show the planned install/data/model locations, execute setup, run a synthetic health check, and hand the owner the local application URL. Credentials are entered through local setup, never requested in an assistant conversation. Avoid logging generated secrets or including them in JSON diagnostics. Use the same account and browser-consent steps as the normal user journey.

Rerunning setup must preserve an existing library, credentials, and configuration. Repair, update, migration, restore, uninstall, and optional model download are distinct operations with previews appropriate to their effects. Keep ordinary installation free of system-wide permission changes. Never teach an assistant to solve a failure by exposing services, overwriting user configuration, or deleting the library.

A development mode should use an isolated synthetic data directory and loopback binding, never automatically reuse the owner's environment or library. Keep an agent's diagnostic access narrow: versions, health, counts, and reason codes are enough for setup; saved post contents and account sessions are unnecessary. An MCP server with library read/write access is a separate future feature, not a prerequisite for assistant-assisted installation.

**Acceptance:**

- The direct documented command path and at least one advertised local-model-powered coding-assistant workflow install a fresh supported environment using synthetic data, including an installation with Little Archive's classification AI disabled.
- A second setup run leaves an existing library and annotations intact; failed prerequisites, an occupied port, and a missing runtime produce specific next actions.
- Dry-run and doctor leave files, schema versions, and queued work unchanged; an interrupted configuration update leaves a valid recoverable configuration.
- Structured output and retained transcripts contain no owner password, device token, environment contents, or private saved content.
- The guide can be followed without an AI subscription, vendor-specific account, or undocumented maintainer help. Support is limited to the workflows actually exercised; it is not a claim that every model can administer the machine correctly.

## 4. Building a useful public open-source project

### 4.1. Task-oriented documentation and a useful demo

Make the README an entrance with four obvious paths: **Try the demo**, **Install on Mac**, **Self-host**, and **Contribute**. State the current release status, supported capture paths, no-AI behavior, data ownership, and known limitations before architecture details.

Version user documentation alongside the release. Cover first import, coverage explanations, preserving original categories, file/browser reconciliation, organizing without AI, optional model setup, backing up, restoring on another installation, updating, and recognizing common failures. Include essential local help in the Mac package. Error messages should link to the relevant task, not send everyone to a general troubleshooting page.

Keep the public demo synthetic and on the advertised interface version. Provide an optional short tour and a downloadable synthetic import fixture with overlapping collections, both languages, thin evidence, and representative content kinds. Explain reset-on-reload and which operations need a private installation. The demo should lead to installation without implying that it is connected to the viewer's social accounts.

**Acceptance:** a newcomer chooses the correct installation path, imports the sample, organizes it, and recovers a backup using the published instructions. Links and screenshots match the released interface. A visitor can tell which data and actions are demonstrations.

### 4.2. English, Arabic, and accessible participation

Move user-interface strings into translation resources before adding substantial new onboarding text. Provide English and human-reviewed Arabic for the app, extension, onboarding, primary errors, and essential import/recovery instructions. Add a language choice before sign-in and in settings. Use logical CSS, correct right-to-left layout, localized dates/numbers/plurals, and language-independent IDs and error codes.

Preserve user-written text and source names exactly; changing interface language does not translate or rename the owner's collections. Test mixed-direction labels, long names, empty states, dialogs, import progress, keyboard use, zoom, touch, and VoiceOver. Keep color contrast readable in the existing soft visual design and convey status through text/icons as well as color. Publish the evaluated accessibility scope and any remaining limitations.

Document how to contribute and review translations without running a social import. Other languages can be community additions after their review. Interface translation, classification-language quality, and source-layout support are separate entries in the support matrix.

**Acceptance:** primary tasks pass in English and Arabic, including direction changes, preserved user content, focus, and recovery. A translator can add a fixture string and run the relevant checks from the contribution guide.

### 4.3. A clean contributor setup

Provide one documented development entry point that creates its own ignored synthetic workspace, generated local credentials, and loopback service. It must not load the personal production environment by default. Include supported Python/Node versions, locked dependencies, a small fixture, optional large/multilingual fixtures, and an explicit cleanup command that can only remove the development workspace.

Document fast checks, one affected browser case, actual packaged-extension tests, and the separately optional model suite. A contributor should not need real Instagram/TikTok access, private exports, AI keys, or model downloads to fix an ordinary UI/parser issue. Use the existing lightweight frontend and shared backend; a framework rewrite is not a contribution prerequisite.

Keep example configuration free of secrets. Make first issues genuinely bounded, with an observable acceptance criterion and links to relevant code/tests. Welcome documentation, translation, accessibility, and source-fixture contributions alongside application code. Require small PRs to explain the problem, resulting behavior, and meaningful verification.

**Acceptance:** a newcomer follows the guide from a fresh clone, starts the synthetic app, changes one behavior, runs its relevant check, and cleans up without touching a personal installation.

### 4.4. Stable contracts and maintainable source adapters

Version the extension/server protocol, portable export format, backup manifest, database schema, adapter contract, and durable outbox state explicitly. Keep their versions distinct from the application marketing version. Add a capability handshake so an independently updated extension can identify a compatible self-hosted server. Publish which current/previous combinations are supported; incompatible combinations pause with guidance while retaining pending work.

Never silently regenerate batch IDs or recanonicalize an already-queued payload that may have been committed by the server. Test pending-work migration, old exports/backups, source-account migration, and compatibility with the previous supported client/server version. Check machine-readable schemas against actual models. Resolve existing documentation/implementation differences, including zero-batch completion semantics, before treating the contract as stable.

Define a small reviewed, bundled adapter interface: identify the source view/account/scope; report readiness; discover visible scopes; extract typed observations; request bounded navigation; and provide a stop reason with evidence. Declare adapter ID/version, supported layouts/locales, and capabilities. Keep authentication, permissions, outbox, and transport in the shared engine. Adapters should not receive general credential or arbitrary network authority.

Maintain handwritten synthetic fixtures for loading, login/challenge, unsupported views, confirmed empty views, delayed grids, overlaps, renamed scopes, mixed-language text, hostile markup, and interrupted coverage. Record adapter/view/version and fixture provenance; do not publish real personal exports or copied private page contents. Require a targeted actual-extension PR check when adapter/scanner changes can affect capture. Live acceptance remains necessary before advertising a new supported view, but contributors need not give maintainers access to their account.

Platform breakage should produce typed states such as unsupported layout, permission revoked, server unreachable, incompatible protocol, or no observed end. Keep existing records, manual organization, file imports, and recovery usable. Publish the last live validation date and scope. Provide an owner-triggered redacted diagnostic report with versions/counts/reasons/timings, without raw HTML, captions, source URLs, account labels, or credentials.

**Acceptance:** a synthetic additional adapter can use the existing engine without changes to authentication/outbox/transport. Supported client/server combinations and interrupted queue migrations pass. A broken adapter cannot erase records or mislabel an account as empty. No runtime plugin marketplace or remote executable selector feed is needed for v1.

### 4.5. Support, maintenance, and project ownership

Keep the MIT license, contribution licensing, and third-party notices clear. Add a short support guide, PR template, code of conduct with a real reporting route, and maintainer/release guide. GitHub identifies these community files as useful project infrastructure; their presence alone does not establish product quality. [Community profiles](https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions/about-community-profiles-for-public-repositories).

Start with maintainer-led decisions and a public roadmap marked proposed, accepted, implemented, verified, or released. Identify who reviews compatibility, database, permission, network, and release changes. Use a few practical labels: confirmed bug, adapter breakage, documentation, accessibility, help wanted, and good first issue. Give contributors credit and close scope decisions with reasons. Avoid elaborate governance or multiple support channels before there is a community to sustain them.

Verify the actual private vulnerability-reporting path and maintainer notifications. A `SECURITY.md` file does not itself enable GitHub private reporting. Publish supported versions and a best-effort response policy that the maintainers can sustain; do not invent a contact address or guarantee an unstaffed SLA. Keep ordinary support reports synthetic/redacted. [GitHub private reporting](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/configure-for-a-repository).

Maintain dependency updates for Python, Node, containers, and workflow actions, with reviewed changes and relevant checks. Verify branch rules require checks that actually run on PRs, including fork contributions without secrets. Do not require a push-only release job on every documentation PR or automatically merge dependency changes that bypass compatibility/recovery gates.

Keep issue scope tied to user outcomes. Paid managed hosting, paid operational support, and voluntary sponsorship are possible later services around the same open-source core; they are not requirements for public v1. Installation, manual organization, export, and recovery should remain useful without a paid account. Do not make a pricing or service-availability promise before building its operations.

**Acceptance:** a newcomer can report a reproducible issue or make a small PR; a private security report reaches the designated maintainer through the documented channel; another maintainer can follow the release, recovery, and withdrawal procedure. Repository settings must be checked, not inferred from files.

### 4.6. Releases users can identify and maintain

For every supported distribution, publish a version, source commit, exact artifacts/digests, checksums, dependency/third-party notices, compatibility, installation/update/recovery instructions, and known limitations. Produce a machine-readable dependency inventory with the release. Test fresh downloads of the actual packages, including Mac quarantine/signing behavior and the packaged extension. Align demo/docs/screenshots with that release.

Lock and review workflow dependencies using a mechanism verified in this repository. GitHub's current generated `actions.lock` mechanism can cover action dependencies, including transitive ones; reusable workflows need separate pinning, and the mechanism does not pin runner images or every build input. Full commit-SHA references remain an alternative. Dependency locking is the requirement; a specific new mechanism is not an independent product feature. [Workflow dependency locking](https://docs.github.com/en/actions/concepts/security/workflow-dependency-lockfiles).

Prefer enabling immutable GitHub releases before the first stable publication: build and verify everything, create a draft, attach all final assets, then publish. This protects the release tag and attached assets; it does not freeze container registry tags. Record and install container digests separately. Build provenance attestations can add source/workflow evidence, but are not a security audit, test result, or proof of fully reproducible builds. Checksums, matching source, and exact-artifact verification are required regardless of the chosen publication mechanism. [Immutable releases](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases).

Define a practical compatibility/support policy before 1.0: supported server/extension pairs, import/export versions, preserved user data on updates, and recovery through the previous application plus pre-update backup. A breaking data change must have an explicit migration and recovery path. Make adapter fixes and security patches possible without forcing a redesign or unrelated feature rollout.

**Acceptance:** an operator can identify and verify a downloaded release, install an exact container digest, update and recover using the guide, and report its version without disclosing private data. A second maintainer can reproduce the documented release procedure and distinguish source artifacts, tested artifacts, and later rebuilt ones.

## 5. Platform constraints that affect the scope

Meta's reviewed Instagram overview describes professional-account APIs and lists publishing, moderation, messaging, and related capabilities. No saved-library endpoint was documented in the overview and capability/permission listings reviewed. This is a scoped finding, not an exhaustive claim about every integration. Do not present an Instagram OAuth button as a verified way to import personal Saved collections. [Meta overview](https://developers.facebook.com/documentation/instagram-platform/overview).

TikTok's Data Portability API is currently limited to data from EEA/UK users, even though applicants can be located elsewhere. Its Full Archive table lists favorite-video dates and landing-page links; the narrower Activity table does not list favorites, and favorite collection memberships/media bytes are not documented in the favorite-video entry. Both Data Portability and Login Kit approval are required. Treat this as an optional regional connector; verify the approved scope and actual response before promising a favorites integration. [Availability](https://developers.tiktok.com/products/data-portability-api/), [data types](https://developers.tiktok.com/docs/en/data-portability-data-types), and [approvals](https://developers.tiktok.com/docs/en/data-portability-api-get-started).

Browser capture and user-provided exports remain the proposed baseline. Verify the permitted access path, current layouts, and real results. Platform changes require adapter maintenance. Do not bypass login challenges or silently substitute a hidden private API.

## 6. Build order and decision gates

| Stage | Work | Exit condition |
| --- | --- | --- |
| 1. Observe and establish foundations | Private Mac/source baseline; support matrix; source/evidence inventory; browsing/focus fixes; performance baseline; isolated contributor workspace. Begin localization structure, packaging proof, and protocol review. | Known records and memberships are compared; evidence gaps and supported targets are recorded; contributors can reproduce synthetic behavior. |
| 2. Complete import integrity | Introduce versioned migrations and compatibility contracts, then accounts, scope inventory, guided plans, independent collection observations, file preview/reconciliation, and durable jobs. Refactor adapters behind their tested interface. | Multi-collection and file-plus-browser cases pass, including empty scopes, interruption, and client/server version handling. |
| 3. Complete organization and local AI | Personal taxonomy, content kinds, evidence enrichment, grouped review, bulk correction/undo, local-model wizard, no-AI journey, and classification evaluation. | Correctable organization survives refresh/recovery; manual use is complete; the default model reaches measured quality/resource targets. |
| 4. Complete public delivery | Mac onboarding/lifecycle, browser pairing, versioned images, store/signing work, assistant setup/doctor, translated help, and accurate demo. Maintain user docs with each feature. | Fresh users and the advertised local assistant can install through documented paths; primary English/Arabic journeys work. |
| 5. Exercise sustained use and maintainership | Capacity, background work, backup/recovery assistant, accessibility, protocol/migration regression, diagnostics, private reporting, contributor/release rehearsals, and representative pilot. | Published targets pass; ordinary users, self-hosters, contributors, and maintainers complete their tasks; material observed failures are fixed. |
| 6. Freeze and release | Final version alignment, exact-artifact acceptance, notes/support matrix, notices/dependency inventory, screenshots, source, checksums, and publication settings. | All required product/project gates have evidence for the final runtime/package; publish 1.0.0 and then an accurate announcement. |

Stages overlap where dependencies allow. Use four implementation streams after agreeing the shared data/protocol contracts: import integrity; organization/interface/local AI; packaging/onboarding/recovery; and contribution/documentation/localization/release quality. A stream owns its tests and user instructions. Start publisher preparation, translation structure, performance measurements, and contributor setup early rather than leaving them until release week.

Settle a small number of open choices through evidence: the Mac wrapper/bundled-runtime approach, advertised OS/browser minimums, observed source layouts and enrichment needs, the default model and its license/resource profile, and the current/previous protocol support window. Do not freeze an import architecture before observing both source platforms or evaluate categorization on synthetic rich captions alone if real imports are mostly link-only.

The release clock follows completed evidence, not an arbitrary date. Store review, signing access, live accounts, and representative user feedback are external dependencies; their turnaround should not be presented as an engineering guarantee.

## 7. Concrete release acceptance

Before a stable announcement, require:

- The current automated suites plus meaningful new tests for each added failure mode.
- Completed live Instagram and TikTok capture-to-library checks for each advertised view.
- All expected records and memberships in the known test inventories accounted for; no unexplained duplicate or silent omission.
- Correct empty collections, account isolation, repeat imports, archive reconciliation, and preserved manual annotations.
- Classification usefulness measured separately from model/API integration; evidence limits remain visible.
- Guided local AI setup passes on each supported execution environment, including local-only operation and a model failure. The complete core journey also passes without AI.
- Clean installation and normal permission consent through the advertised Mac/extension distribution path.
- A fresh source setup, deterministic diagnostics, and the advertised local coding-assistant installation work without personal accounts or private data. Existing installations survive a repeated setup.
- Upgrade, schema migration, pre-update rollback, corruption/low-space handling, and recovery onto another installation.
- Large-library performance, English/Arabic primary journeys, and Mac keyboard/VoiceOver acceptance; actual advertised browsers and devices have recorded checks.
- A small private release-candidate pilot: proposed target of five representative users for seven days, including at least two non-developer Mac owners, a fresh self-hoster, an Arabic-interface user, a keyboard/screen-reader user, and a person leaving AI disabled. Characteristics may overlap. With source accounts signed in and a known accessible collection available, observe at least four of five complete first import without developer intervention. Observe later retrieval, correction, refresh, and recovery as well. There must be no unresolved data-loss or authentication-boundary defect. This is a usability signal, not a statistical guarantee.
- Security review of any new pairing, local service bridge, file/media processing, migration, and update-signing boundaries.
- Versioned artifacts, dependency inventory/third-party notices, checksums, supported protocol pairs, an accurate support matrix, privacy documentation, and working issue/private-reporting routes.
- A newcomer completes a small contribution using synthetic data; a maintainer follows the documented release/recovery procedure. Required PR checks and notification settings are verified in the actual repository.

The private pilot is an acceptance phase for the completed intended v1 scope. It is not a substitute for finishing required features or evidence.

## 8. Valuable additions after the core v1

| Addition | Why it may be valuable | Why it can follow v1 |
| --- | --- | --- |
| Smart collections / saved filters | Keep dynamic groups such as untried recipes or learning material. | Depends on consistent categories and filter semantics; small follow-up once those are stable. |
| Rediscovery and personal digests | Bring useful older saves back into attention. | Start from the existing Rediscover feature; evaluate actual use before building a recommendation system. |
| Semantic search | Find an item from a remembered concept when exact words are unavailable. | Requires an evaluated multilingual embedding/index lifecycle and useful captured evidence. |
| Local OCR and user-provided media transcription | Recover text unavailable in captions. | Adds processing, model, storage, provenance, and resource work. Pull forward only if required by the agreed categorization promise and real evidence gaps. |
| Mobile capture/share integration | Save into the same library while using a phone. | Adds another distribution, authentication, and synchronization surface. |
| Official regional TikTok portability connector | An additional approved transfer path for eligible users. | Region, scope, review, and OAuth architecture need separate verification. |
| More local-model providers and a scoped assistant integration | Reuse other runtimes and enable deliberate assistant access to the library. | Evaluate provider capabilities and add explicit authentication/read/write boundaries; installation instructions do not require an MCP service. |
| Managed hosting and paid support | Charge for convenience, operation, recovery, and support around the open-source product. | Requires service operations, customer isolation, billing, cost controls, and a separate privacy/support commitment. |

Defer team workspaces, public sharing networks, a full native UI rewrite, additional social platforms, chat-with-library, and universal video downloading. Choose later features from repeated user problems after v1 has proven the capture-to-recovery journey.

## 9. Implementation backlog

These 22 deliverables form the recommended scope. IDs are stable references, not a strict execution order. V1-14 is the final release gate and depends on all other required deliverables. Expand each into small reviewable issues with its referenced acceptance criteria; do not mark an item complete because a scaffold or test file exists.

| ID | Deliverable | Depends on | Acceptance reference |
| --- | --- | --- | --- |
| V1-01 | Live-source/private Mac baseline, evidence sampling, and supported-layout inventory | Working owner browser and private instance | A; section 6, stage 1 |
| V1-02 | Preserve loaded gallery/scroll; fix closed-navigation focus | Existing UI | D |
| V1-03 | Versioned migrations and stable source-account records | Reviewed data model; V1-17 contract decisions | B, F |
| V1-04 | Collection inventory, import plans, empty collection observations | V1-01, V1-03 | A |
| V1-05 | Export preview, account reconciliation, durable file jobs | V1-03 | B |
| V1-06 | Personal taxonomy, content kind, mappings, correction persistence | V1-03 | C |
| V1-07 | Evidence states, changed-observation enrichment, local previews | V1-01, V1-04 | C |
| V1-08 | Field/bulk review, merge/remove/move, undo and recoverable deletion | V1-06 | C, D |
| V1-09 | Local AI wizard, provider probe/download/test, no-AI acceptance, and held-out quality evaluation | Setup/probe work starts early; final quality depends on V1-06, V1-07 | C, G |
| V1-10 | Mac packaging proof, first-run setup, backend lifecycle | Existing backend; publisher signing access for distribution | E |
| V1-11 | Pairing, connection health, device revocation, store package | V1-10 origin/lifecycle contract; V1-17 | E |
| V1-12 | Backup destination/status/schedule, restore preflight/assistant | V1-03, V1-10 | F |
| V1-13 | Final capacity, keyboard/VoiceOver, browser/device, and diagnostics regression; baseline starts at V1-01/V1-02 | V1-04 through V1-12 and V1-19 for final acceptance | D, F; 4.2 |
| V1-14 | Representative private pilot, final artifact verification, 1.0 release | All other required deliverables V1-01–V1-13 and V1-15–V1-22 | Section 7 |
| V1-15 | Public support matrix, task-oriented docs/local help, demo, synthetic newcomer fixture | Start now; align with finished install/import/organization behavior | Section 1; 4.1 |
| V1-16 | Isolated contributor setup, focused check guide, safe cleanup, small starter issues | Existing app and synthetic tests | 4.3 |
| V1-17 | Versioned schemas, capability handshake, old-client/outbox/export compatibility | Current protocol audit; before data/protocol changes | 4.4 |
| V1-18 | Bundled adapter interface, fixture catalog, typed breakage states, targeted extension PR gate | V1-01, V1-17 | 4.4 |
| V1-19 | Translation structure, English/Arabic interface and essential guides, accessibility acceptance | Structure starts early; content review follows UI stabilization | D; 4.2 |
| V1-20 | Support/contribution/maintainer policy, verified private reporting, sustainable dependency review | Existing community files; repository administrator access for settings | 4.5 |
| V1-21 | Locked release dependencies, artifact manifests/digests/notices, verified PR gates, release handbook/rehearsal | V1-10, V1-11, V1-17, V1-20 for final release rehearsal | 4.6 |
| V1-22 | Shared deterministic setup/doctor, assistant guide, repository agent instructions, tested local-assistant workflow | V1-10 install/lifecycle contract; V1-16 sandbox; reuse V1-09 probe only for optional model setup | H |

Preserve the current implementation where it already meets the requirement. Keep proposed features, source-review findings, automated results, and direct user observations visibly distinct throughout delivery.
