# Changelog

## Unreleased — Development toward 1.0

The first v1 foundation batch passed all 12 acceptance jobs at commit `505b93b0e07ceeb801ca62e9bb5ae2bd3cac5a6d` in [run 43484644844](https://github.com/abdulmalikaltararwa-oss/little-archive/actions/runs/43484644844). Six installation/recovery reports are retained with their provenance. The broader [v1 plan](docs/v1-product-plan.md) includes additional product/project work as well as live Instagram/TikTok capture and final Mac operator acceptance. See [the verification record](docs/verification.md) for exact evidence, corrected initial failures, and boundaries.

### Filing a link while saving it

- Saving a link is answered by a tray that offers the collections with the most saves and "To revisit" as one-tap chips, with Undo; it leaves after five seconds unless touched, and the save is opened from it rather than by itself. A link that is already in the library says when and where the first copy is instead of looking like a new save.

### Permission before anything is sent to an AI service

- **One question, once.** Before the first action that would send saved content to a service outside the person's server (suggestions, a closer read, a recipe card, places, a question to the archive), the interface says what would be sent and to which service, as the server reports it, and offers "Allow" and "Not now". "Not now" cancels the action. A self-hosted server with only a local model is not asked.
- **Kept with the library.** `ai_sharing_allowed` in `/api/settings` (per account on a hosted service); a switch in Settings withdraws it. `PATCH /api/settings` now writes only the fields it is given.
- **Enforced by the server.** Without the permission the server sends nothing to a hosted AI or transcription service: AI routes answer `403` `ai_permission_required` (the interface then asks the question), and queued jobs wait until it is given. Withdrawing it stops queued work from being sent. A self-hosted server with only a local model is unaffected.
- **Privacy policy and terms.** Linked from Settings, the unlock screen and the permission dialog, built from one site address (`ui/src/lib/site.ts`).

### The public site's pages and the store pack

- **Four plain pages** in `web/`: privacy policy, terms of use, support, and deleting an account (with a way to ask by email, for Google Play). No script, nothing loaded from another site, light and dark from the system setting. `scripts/build_demo.py` publishes them beside the demo, and the publishing workflow checks them with their own rules.
- **The contact address is set.** `hello@littlearchive.me`, so the four pages are published with the demo.
- **The terms and privacy pages after a review.** Google Play refunds are separated from App Store refunds, the liability limit no longer depends on having paid, a parent must agree for anyone under 18, and the privacy page says the server refuses AI work without permission. The review was done by an AI agent, not a lawyer; the operator's registered name, the host and the backup period are still to be filled in.
- **One contact address, set once.** The pages hold a token where the address goes; the address is `contact_email` in `web/site.json` and is written in when the site is built. While it is empty the pages are not published at all and the demo is built without them; the build stops if a token or a placeholder would be published, and refuses a value that is not an email address. The workflow's check and `scripts/release_check.py` hold the same rule.
- **`docs/store/`**: listing text for the App Store and Google Play with each field's limit counted, the privacy label and Data safety answers with the code they rest on, notes for the reviewers, the screenshot list and an ordered checklist for the owner.

### Paying on the web, a forgotten password and your own server

- **The unlock can be bought on the web through Tap Payments** (hosted service only, off until a key and a price are set: `LA_TAP_SECRET_KEY`, `LA_TAP_PRICE`, `LA_TAP_CURRENCY`). The server creates a charge on Tap's own page and unlocks the account only after Tap, asked for the charge by id, says it was captured for the amount, currency and account the server wrote down. A pay page at `/pay` signs the buyer in from the browser at the Supabase project and starts the payment; nothing in the apps links to it. A refund made in Tap's dashboard is not followed: an operator takes the purchase back by hand. Exercised against stand-ins and Tap's own example answers only; no Tap payment has been made.
- **The pay page shows the offer first and says who sells it.** `/pay` now opens on what is free beside what the unlock adds and the configured price, then sign-in, then the Pay button; beside that button it names the seller when `LA_SELLER_NAME` is set, and links the 14-day refund, the terms and the privacy policy on `LA_PUBLIC_SITE_URL`. What is sent to Tap is unchanged.
- **A forgotten password** (phone app, hosted accounts): "Forgot your password?" on the sign-in screen sends a reset link that opens the app on the same phone within a few minutes, where a new password is chosen. Every address gets the same answer, so the screen does not reveal which addresses have accounts. Run in tests against a stand-in only.
- **Connecting to your own server** (phone app): the screen says what the address must be, links the self-hosting guide, and explains the common failures in words written for someone setting up a server.

### Store review fixes in the phone app

- Version 1 is built for iPhone only. Continue with Apple asks for the email address only, not the name, and its button follows Apple's sizes for a custom button.
- The privacy manifest declares every collected data type and the file-timestamp API; camera and local-network purpose strings are in `Info.plist`.
- Android release builds are signed with a keystore kept outside the repository. The app's package version is 1.0.0, and it names the production address of the hosted service.

### A flower border, an empty library that teaches, Start cooking and a garden at sign-in

- A still row of text-art flowers marks where a page ends: at the true end of the wall, at the foot of the wide sidebar and under the library's empty states. Decoration only, hidden from assistive technology.
- An empty library shows how to save: in the phone app, the three steps of saving from another app's share sheet; in a browser, pasting a link and, on a self-hosted server, the companion extension.
- A save whose recipe card has steps has "Start cooking" pinned at the foot of its detail.
- The phone app's first-launch and sign-in screens have a band with a garden of text-art flowers. It sways only when motion is welcome and goes while the keyboard is up.

### Fixed

- Accepting an AI suggestion no longer makes the save look changed, so the next organize run does not queue the same save again (and, on a hosted account, count it against the allowance).

### The React interface is the interface (in development)

The web interface is the React app in `ui/`, served by the server, the Docker image, the Mac app and the public demo. The old buildless interface in `web/` is no longer served; its files stay in the repository because the interface and the phone app import a few of them (`utils.js`, the demo data and store, the display font, `transport.js`).

- **Server.** Serves a build from `webui/` beside `server/` (images and the Mac app) or `ui/dist/` (a checkout), whichever has an `index.html` first. With no build the API keeps working and every page answers with one line saying to run `npm ci && npm run build` in `ui/` (Node 22 or newer); the same sentence is logged at startup. Hashed files under `assets/` are cached for good, everything else is revalidated, and the demo page, dot folders and the build manifest are not served. The data directory, configuration file, public cache path and diagnostics refuse every place the interface can be served from, not only `web/`.
- **A stricter style policy.** The server's `style-src` is `'self' 'nonce-…'` with a fresh nonce for each page response; `'unsafe-inline'` is gone for styles. The libraries that add a `<style>` at run time (the dialog's scroll lock, the select's scrollbar rule, motion's pop layout, the segmented control) are given the nonce, and the page's first frame uses classes instead of style attributes. Every browser test now also fails on a policy violation, and one visits every screen and dialog to prove it. The public demo page (a static host cannot make a nonce) keeps `'unsafe-inline'` for styles and forbids every connection.
- **Docker.** A Node 24 stage runs `npm ci && npm run build` in `ui/` and the final Python image copies only the built folder to `/app/webui`: no Node, no npm packages and no interface source in the image, still non-root and read-only compatible. The two map tile settings are optional build arguments. The image build itself was not run here (no Docker daemon); the recipe's shape is pinned by tests and CI builds it.
- **Native installs** build the interface with `cd ui && npm ci && npm run build` ([self-hosting](docs/self-hosting.md#build-the-web-interface-native-installs)). `VITE_LA_TILE_URL` and `VITE_LA_TILE_ATTRIBUTION` name a map tile server for the Places screen at build time; tiles must be `https:`, and some public tile servers may refuse requests that carry no referrer.
- **Demo.** `scripts/build_demo.py` publishes `ui/dist/demo.html` and exactly the files it can load, worked out from the page and the build manifest, and holds the result to a fixed rule about what may be published; the workflow checks the artifact against that rule on its own. The demo's unlock screen no longer says everything is open: it says there is no account, that the self-hosted server is free, and marks no extra as open or locked.
- **Mac app.** `scripts/build_mac_app.py` finds a Node 22 or newer, builds the interface, stages it without the build manifest and demo page, and bundles it as `webui`. A bundle built this way ran its embedded server and served the interface; it was not opened as an application window.
- **CI.** A new interface job (type check, lint, build, unit tests, browser smoke test); every job that runs the server, the Python tests, the native install check or the demo build builds the interface first; Node 24 everywhere; `ui/**` triggers the image, validation and demo workflows.
- **Browser suite ported.** All eight authenticated specs (and the real-model gate) now drive the React interface by role and accessible name, assert the new behaviour where it differs (one bulk menu, in-app confirmations, a wall that draws only the cards near the screen and loads the next page by itself with Load more kept, an address that carries the view, filters and open save, the phone dock), and add coverage for the Back button, the dialogs' keyboard trap and scroll lock, and every screen under the page policy.
- **Fixes the browser suite found in the interface.** A favorite button kept the keyboard's focus instead of dropping it while saving, and focus inside an open save is kept when its full record arrives a moment after the panel opens (the form used to be replaced under the keyboard); the next page loaded by itself only after the end of the wall left and re-entered range, so a page that did not fill the screen never loaded more; one Back reported twice by a browser asked its question twice and left a copy of the open save in the history; closing a save restored the browser's old scroll position over the wall's own after a rename reordered the list; fields were 15px, not 16px, on touch (iOS zooms into them); a checkbox's label is now the whole row, and the "+" beside Collections has its own touch area; the top bar is as tall as its content plus the status bar or notch; the sign-in screen's flowers can no longer land on the logo.
- **Fixes the Firefox and Safari runs found in the interface.** Choosing a new sort scrolled the page to wherever the old first card landed (the reading position is now kept only within one view, and never in a shuffled one, which is a new draw each time); a dialog opened while nothing held focus (a shortcut pressed just after another dialog left) gave focus back to the page itself when it closed, which the focus rules forbid (it now goes to the view's heading); the open save's panel was rebuilt when its record arrived or a save was answered, which moved its scroll position in Firefox, lost a preview file chosen at that moment and dropped the keyboard's focus (it now stays mounted and focus is restored after React has drawn); the next page could be asked for twice, or before anything was scrolled, from a report measured for an earlier layout (and, with reduced motion on, from a layout that was a frame behind: reduced motion now switches transitions off instead of making them 0.001ms long).
- **`ui/src/data` is tracked.** A `data/` rule in `.gitignore` meant for runtime data also matched the interface's data layer, so it had never been committed and a clean checkout could not build. The one directory is now re-included, and `scripts/release_check.py` no longer treats it as runtime data.

### Understanding saves (in development)

An optional layer that turns a saved link into a title, summary, topics, a suggested folder and a searchable transcript, cheapest tier first. See [Understanding saves](docs/understanding.md). It is verified by fixture, fake-HTTP and API tests; the hosted Gemini and Groq request shapes were not exercised against the live services.

- Read the public page of a post from the details a visitor's browser receives (Open Graph, Twitter cards, JSON-LD, `<title>`, YouTube/TikTok oEmbed). The phone or browser can send the extraction or the raw HTML; the server parsing it never fetches anything.
- Optional server-side page reading, off by default, that refuses non-public addresses on every redirect hop, pins the connection to the validated address, limits size, time and content types, sends no cookies and identifies itself honestly.
- Keep the caption text and a re-encoded local cover; never store video.
- Provider interface for understanding with Ollama and a hosted Gemini provider (key from the environment, explicit selection, public text only by default). Batched model calls, a category from a fixed taxonomy and a suggested folder; labels (`text-only`, `caption-based`, `transcript-based`) are computed from the input.
- Transcripts as a new evidence kind: from the device, from the server when a caption is too thin (operator setting), or by an explicit "Read this more closely" deep read through Groq Whisper. Searchable through `q=`, with a `match_in` field saying where each result matched.
- Optional shared cache of results derived from public posts, keyed by canonical URL and the analysed public text, with per-kind field allowlists.
- A usage hook and local counters for model calls, tokens, audio seconds, bytes and cache hits, for metering.
- New routes: `POST /api/items/{id}/page`, `POST|DELETE /api/items/{id}/transcript`, `POST /api/items/{id}/deep-read`, `GET /api/enrichment/status`, `GET /api/enrichment/usage`. New additive tables `item_enrichment` and `enrich_usage`. Suggestions created before this change must be generated again before they can be accepted, because the suggestion fingerprint now includes the provider and prompt.

### Recipe cards, places, ask your archive and a guided backlog import (server side, in development)

Server routes, logic, tests and documentation only; no interface yet. Verified by automated tests with stub providers, a mock geocoder and synthetic exports; **no real model, geocoder, or Instagram or TikTok export was used**. See [understanding saves](docs/understanding.md) and [importing](docs/importing.md), and [API_CONTRACT.md](API_CONTRACT.md) for every shape.

- **Recipe cards for cook mode.** Title, servings, times, ingredients (quantity, unit, name, note, group) and steps (timer, ingredients used) with where each part came from. Read from a page's schema.org `Recipe` data first, then fixed text rules, then a provider that only selects spans: each span must appear in the text, quantities and timers are parsed by code, anything unverifiable is dropped and counted. The owner's edit is stored beside the extraction and always wins. Unit-safe scaling (`?servings=` or `?factor=`) with exact arithmetic, clean unit changes inside one system only, and stated rounding. `GET|PUT /api/items/{id}/recipe`, `DELETE .../recipe/edits`, `POST .../recipe/extract`, `GET /api/recipes`.
- **Places.** Name, kind, city, country, address and coordinates only when the save states them (structured data, a map link, or coordinates on the same line) or an operator-enabled, request-only Nominatim-compatible geocoder returns them, with its usage policy followed (identifying User-Agent, one request a second across all accounts, caching, minimal query). Never from a model. `GET|PUT /api/items/{id}/places`, `POST .../places/extract` and `.../places/geocode`, and `GET /api/places` with `bbox` and GeoJSON for a map. New settings `LA_GEOCODER_URL`, `LA_GEOCODER_CONTACT`, `LA_GEOCODER_MIN_INTERVAL_SECONDS`, `LA_GEOCODER_CACHE_DAYS`.
- **Ask your archive.** `POST /api/ask` ranks saves with BM25 plus a coverage and phrase re-rank (no embeddings), has a provider answer only from short passages, and returns the answer with citations whose quotes were checked word for word. No provider: the ranked saves, flagged. Nothing retrieved: "Nothing saved about that." Saves that give orders to a model are kept out of it, and an answer with any link, markup or unsupported content is not shown.
- **Guided backlog import.** Accepts the official Instagram or TikTok export as a ZIP or single file in resumable pieces, reads it without extracting anything (paths, symbolic links, encryption, compression ratio and size all checked; messages and other unrelated files never opened), shows a preview before anything is saved (counts per collection, new against already present, duplicates, unreadable entries), then imports as a job in batches of 100 with a durable cursor that survives a crash. Instagram JSON in the current and older layouts in any label language (with the byte-as-character text corruption repaired), Instagram HTML, TikTok JSON and TXT. `GET /api/imports/guides` serves the step-by-step instructions as data. `POST|GET /api/imports/archives`, `PUT .../chunks/{n}`, `POST .../finish`, `GET .../preview`, `POST .../commit`, `DELETE`. New setting `LA_IMPORT_MAX_ARCHIVE_MB`.
- **Fixes found on the way.** TikTok's own link form `tiktokv.com/share/video/<id>` is now a TikTok save (the TXT reader used to drop it and `normalize_url` filed it as a web link). The older single-file importer now reads the current Instagram saved-posts layout and TXT files with banner lines.
- **Hosted mode.** Recipes, places and ask need the account's unlock (`402` with `code: "unlock_required"`) and their model calls go through the existing usage hook; the guided import is not gated.
- **Schema.** Additive tables `item_recipe`, `item_places`, `geocode_cache` and `guided_imports`, created and upgraded in place when a library is opened (`features_schema_version`). A backup with or without them restores; the restore check, and one test that pinned the exact library schema, were extended for it.

### Native clients and hosted mode

Covered by automated tests only; not yet run against a live Supabase project or a container build. (The phone app has since been run against local servers; see below.) See [hosted mode](docs/hosted-mode.md) for the exact boundaries.

- Exchange the owner password for named, revocable, hashed full-access device tokens, so a native app can use every owner route without the cookie and CSRF flow. Extension import tokens keep their import-only scope.
- Add a public discovery route naming the server's mode and sign-in methods, and an account summary route.
- Add an opt-in hosted multi-user mode on the same server and routes: Supabase access tokens verified per request, one SQLite library and thumbnail folder per account, per-account storage quota and request-size limits, in-app account deletion, and an unlock/deep-read allowance interface with no payment provider attached.
- In hosted mode the understanding layer runs once per account library, with one worker thread serving every account's queue in turn. A closer read is the metered deep read; automatic transcription is off.
- Add PyJWT and cryptography as pinned dependencies for token verification.

### Hosted mode hardening and the one-time purchase (in development)

Covered by automated tests with stand-ins only (no real Supabase project, Apple or Google): see [hosted mode](docs/hosted-mode.md) for what was and was not run.

- Meter ordinary AI suggestions per account with daily and monthly allowances for free and unlocked accounts (`LA_HOSTED_SUGGESTIONS_*`), refund suggestions and closer reads whose work fails or is cancelled before it ran, and answer with `402`/`429` bodies that carry a `code` and a `limit` an app can show. `GET /api/account` gains `entitlements.suggestions` and `unlocked_via`.
- Account deletion also deletes the Supabase sign-in with the project's secret key (`LA_SUPABASE_SERVICE_KEY`, environment only): the intent is written first, the response says whether the sign-in is gone (`200`) or still pending (`202`, retried until Supabase confirms). Hosted mode refuses to start without the key unless `LA_HOSTED_ALLOW_LOGIN_SURVIVES_DELETION=true`.
- Per-address and per-account request budgets, a failed-sign-in budget, concurrency caps for exports, backups, imports, uploads and page reads, sign-in before the request body is read, stalled-upload timeouts, and an 8 KiB body limit for requests with no credential (both modes). New settings `LA_HOSTED_RATE_*`, `LA_HOSTED_TRUSTED_PROXY_HOPS`, `LA_HOSTED_HEAVY_*`.
- One-time purchase: `POST /api/purchases/apple` (StoreKit 2 JWS, checked against the bundled Apple Root CA - G3), `POST /api/purchases/google` (Play Developer API through a service account), restore, one purchase per account, App Store Server Notifications V2 and Google real-time notifications for refunds, `GET /api/purchases`. Hosted only. Configuration `LA_APPLE_*`, `LA_GOOGLE_*`; the ids are placeholders.
- Self-hosted device tokens now expire after 180 days without use (`LA_DEVICE_TOKEN_IDLE_DAYS`; `0` turns it off), with an optional hard lifetime and `expires_at` in the API. Existing tokens keep working. The `401` text for a device token now says it may have expired.
- The shared cache no longer shows an account that another account saved a post: page details are not shared in hosted mode, shared hits are counted like the work they stand in for, and an item never reports its transcript as coming from the cache. A full server disk answers `503` instead of the account's `507`.
- The page fetcher bounds inflated size (a gzip body is inflated under the byte limit instead of by the HTTP library), shares its time allowance across lookups and connections, refuses names that become addresses once normalised and scoped addresses, and lists the ranges Python versions disagree about.
- Recipe cards, places and ask-your-archive: every model call and uncached geocoder request is a *feature call* charged to the account against a daily and monthly allowance (`LA_HOSTED_FEATURE_CALLS_*`; 100 a day and 1,500 a month unlocked, none for free accounts, so the features stay part of the unlock), refunded on failure, with the same `402`/`429` answers; the guided import's staged upload now counts toward a hosted account's storage quota (refused at `create` with `507 storage_full` if it cannot fit); route-class request prices and concurrency caps cover the new routes.
- Mobile: `10.0.2.2` (the Android emulator's host) is accepted only by a development bundle (`LA_DEBUG_BUILD=1`); a test keeps the app's address check and both Android network configs in step.
- Deleting an account revokes its Sign in with Apple, when the operator sets the team's Sign in with Apple key (`LA_APPLE_SIGNIN_TEAM_ID`, `LA_APPLE_SIGNIN_KEY_ID`, `LA_APPLE_SIGNIN_CLIENT_ID` and `LA_APPLE_SIGNIN_PRIVATE_KEY_FILE` or `LA_APPLE_SIGNIN_PRIVATE_KEY`; all or none, and with none nothing changes). After an Apple sign-in the iOS app posts Apple's one-time authorization code to the new `POST /api/account/apple-authorization`; the server trades it with Apple and keeps the refresh token for that account, and deletion asks Apple once to revoke it before the Supabase sign-in is removed. Apple being unreachable never blocks a deletion (a warning is logged and the token is not kept), and the post never blocks a sign-in. `doctor` lists `apple_signin_revocation` once the key is set. No new dependency (PyJWT and cryptography sign the client secret). Run against stand-ins only: Apple's endpoints, a real key and a device were not used. The Swift change compiled in an Xcode 26.6 simulator build and the Android plugin compiled with `assembleDebug`; neither was run against Apple. The owner steps are in [the mobile app guide](docs/mobile-app.md#what-to-switch-on-and-create-the-owner-checklist).

### iOS and Android app (in development)

A Capacitor app in `mobile/` that runs the existing interface against a self-hosted server or the hosted service. See [the mobile app guide](docs/mobile-app.md). Run on the iOS simulator and an Android emulator against local servers; not run on a physical phone, a real Supabase project or a store build.

- First launch chooses a server (the hosted service or a typed address) after asking `/api/discovery`; sign-in exchanges the owner password for a device token, or uses Supabase email and password with token refresh. Credentials live in the Keychain or an Android Keystore-backed store.
- A transport in `web/transport.js` (bearer token, native HTTP, `/api` paths only, thumbnails through blob URLs) used only inside the app; `web/app.js` keeps its browser behaviour, and no server change or CORS allowance was needed.
- Share to Little Archive from the Android share sheet and an iOS Share Extension; the app opens the ordinary save dialog and nothing is saved until Save.
- Settings: sign out, switch server and, for a hosted account, delete the account (the Supabase Auth user is not removed; see the guide).
- Continue with Google (iOS and Android, through the system browser with PKCE) and Continue with Apple (iOS, the native sheet) for a hosted account, above the unchanged email and password form. Two small custom plugins (`SocialSignInPlugin.swift` with AuthenticationServices, `SocialSignInPlugin.java` with Custom Tabs and `androidx.browser`), the Sign in with Apple entitlement, an intent filter for `littlearchive://auth-callback`, and the flow in `mobile/src/social.js`: the PKCE verifier and the Apple nonce stay in memory for one attempt, only the app's own callback address is read and only as the answer to a sign-in that is waiting (on Android another app can send that address and make one attempt fail; it cannot sign anyone in), every request goes to the pinned Supabase URL and only after the server has named it, a provider that is not switched on gets a plain sentence, and an Apple sign-in with no email is a normal account. Whether Google is on is read from the project's settings (`GET /auth/v1/settings`), and only an answer that says it is off stops the sign-in; Google is asked to show its account chooser (`prompt=select_account`). The account screen has one lock, so a provider sign-in and an email sign-in cannot overlap, puts focus on the heading, the notice or the pressed button and never on the page, and says "Signing in…" once the sheet or the browser has closed. An Android sign-in that was cut off by the system says "Sign-in was interrupted. Try again." No server change (the server checks the access token only), no new config key, no secret in the app. The local Supabase stand-in answers the two grants; the guide has the owner checklist (Supabase, Google Cloud, Apple developer account). Google was run on the iOS simulator and an Android emulator against the stand-in; Apple's sheet, a physical device, a real project and real accounts were not run. Deleting an account does not revoke an Apple sign-in, the keyboard still slides the sign-in screen's top under the status bar (a second CSS fix was tried and reverted), and the Apple button is drawn in the page with a logo that is not Apple's supplied artwork and a title smaller than Apple suggests, a small App Review risk: all are in the guide's risks.
- The keyboard no longer slides the page under the status bar on iOS. The web view now ends at the top of the keyboard (a small container controller, `RootViewController` in `MainViewController.swift`, with no new dependency), so the page becomes shorter and scrolls as a page instead of the web view panning its visible area, which no fixed element could follow. The sign-in screens keep a strip of paper under the status bar, the field being typed in is brought back on screen when the page changes size, and the interface hides its dock while the keyboard is up (iOS only; a hardware keyboard's bar leaves it), and the bottom sheet stops under the status bar. This also fixes the same fault in the interface (the search field, the Save a link sheet, whose buttons were behind the keyboard). Run on an iPhone 17 Pro Max simulator (light, dark, landscape, a hardware keyboard's bar), an iPhone SE simulator and an Android emulator (unchanged natively; Capacitor already ends the web view at the keyboard there); not on a physical device, an iPad or any iOS before 26.5. What is left is in the guide's risks.

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
- No full-video archival, OCR, or semantic search. Speech transcription is optional and operator-configured. Sharing a link into Little Archive from a phone works through the phone app (Android and iOS) and the installed web app on Android.
- No multi-user workspace or project-operated hosting service.
- AI quality depends on the configured model and the text evidence actually available.
