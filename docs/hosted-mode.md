# Hosted mode

Hosted mode lets one Little Archive server hold a private library for each of many accounts. It is the same server, the same routes and the same JSON as a self-hosted instance; only sign-in and storage layout differ. People sign up and sign in through a [Supabase Auth](https://supabase.com/docs/guides/auth) project that the operator runs. The server never sees a password.

It is off unless you configure it. Without `LA_MODE=hosted`, a server is the single-owner library described in [self-hosting](self-hosting.md), unchanged.

**Status.** This mode is development software. It has been exercised by this repository's automated tests, using signing keys generated in the tests and a fake key endpoint, and by starting the real server process on loopback. It has **not** been run against a live Supabase project, Apple's App Store, Google Play, load-tested, deployed in a container, or independently security-reviewed. Everything about purchases and about deleting a Supabase sign-in was exercised only against stand-ins (see [What was verified](#what-was-verified)). The [mobile app](mobile-app.md) was used against it on the iOS simulator with a local stand-in for Supabase Auth (sign-up, sign-in, token refresh, account deletion); no real mobile device was used. The last section lists exactly what was and was not checked.

## Configure

Hosted mode reads its settings from the environment or the `--env-file`, like the rest of the server. No project is built in.

| Setting | Required | Default | Meaning |
| --- | --- | --- | --- |
| `LA_MODE` | yes | `self-hosted` | Set to `hosted` to enable this mode. |
| `LA_SUPABASE_URL` | yes | none | Your project's origin, for example `https://<ref>.supabase.co`. HTTPS only, except a loopback address for a local Supabase stack. Signing keys are fetched from `<this>/auth/v1/.well-known/jwks.json`. |
| `LA_SUPABASE_JWT_SECRET` | no | empty | The project's legacy shared JWT secret. Set it only if the project still signs access tokens with HS256. Empty means HS256 tokens are refused. |
| `LA_SUPABASE_JWT_AUDIENCE` | no | `authenticated` | The `aud` claim an access token must carry. |
| `LA_SUPABASE_JWT_ISSUER` | no | `<LA_SUPABASE_URL>/auth/v1` | The exact `iss` claim, if it differs from the derived value. |
| `LA_PUBLIC_URL` | yes | `http://localhost:8787` | The service's own origin, as for a self-hosted instance. It also sets the accepted `Host` names. |
| `LA_DATA_DIR` | yes | `./data` | Where account libraries live. It must not already hold a single-owner library. |
| `LA_HOSTED_STORAGE_QUOTA_MB` | no | `500` | Storage limit for each account, in MiB. |
| `LA_HOSTED_MAX_JSON_KB` | no | `512` | Largest ordinary request body, in KiB. |
| `LA_HOSTED_MAX_UPLOAD_MB` | no | `8` | Largest import file, in MiB (self-hosted allows 16). |
| `LA_HOSTED_MAX_THUMBNAIL_MB` | no | `4` | Largest thumbnail upload, in MiB (self-hosted allows 8). |
| `LA_HOSTED_OPEN_LIBRARIES` | no | `64` | How many account libraries are kept ready in memory. |
| `LA_HOSTED_DEEP_READS_MONTHLY` | no | `300` | Fair-use cap on deep reads each month for an unlocked account. |
| `LA_HOSTED_FREE_DEEP_READS_MONTHLY` | no | `0` | Deep reads each month for an account that has not unlocked. |
| `LA_HOSTED_SUGGESTIONS_DAILY_FREE`, `LA_HOSTED_SUGGESTIONS_MONTHLY_FREE` | no | `25`, `300` | Ordinary AI suggestions (titles, folders, summaries) an account that has not unlocked may queue per UTC day and per UTC month. `0` makes them part of the unlock. |
| `LA_HOSTED_SUGGESTIONS_DAILY_UNLOCKED`, `LA_HOSTED_SUGGESTIONS_MONTHLY_UNLOCKED` | no | `200`, `3000` | The same for an unlocked account (the fair-use cap). |
| `LA_HOSTED_FEATURE_CALLS_DAILY_UNLOCKED`, `LA_HOSTED_FEATURE_CALLS_MONTHLY_UNLOCKED` | no | `100`, `1500` | Model calls and geocoder requests made for recipe cards, places and ask-your-archive, per UTC day and month, for an unlocked account. |
| `LA_HOSTED_FEATURE_CALLS_DAILY_FREE`, `LA_HOSTED_FEATURE_CALLS_MONTHLY_FREE` | no | `0`, `0` | The same for an account that has not unlocked. `0` keeps those features part of the unlock; above zero opens them to free accounts with that allowance. |
| `LA_HOSTED_RATE_ADDRESS_PER_MINUTE` | no | `600` | Requests per minute from one address. `0` turns it off. |
| `LA_HOSTED_RATE_ACCOUNT_PER_MINUTE` | no | `300` | Requests per minute from one account; an export, import, upload or page read costs more than one. `0` turns it off. |
| `LA_HOSTED_RATE_AUTH_FAILURES` | no | `30` | Failed sign-ins (forged or malformed tokens; an expired token does not count) one address may make per ten minutes before further failures answer `429`. `0` turns it off. |
| `LA_HOSTED_TRUSTED_PROXY_HOPS` | no | `0` | How many reverse proxies in front of this server append to `X-Forwarded-For`. With `0` the socket's address is used and the header is ignored. Set it to the real number, or every client behind your proxy shares one address budget. |
| `LA_HOSTED_HEAVY_PER_ACCOUNT`, `LA_HOSTED_HEAVY_OVERALL` | no | `2`, `8` | Exports, backups, imports and thumbnail uploads running at once, per account and for the whole service. |
| `LA_SUPABASE_SERVICE_KEY` | yes, see below | none | The project's secret key (`sb_secret_...`, or the legacy `service_role` key), used only to delete a person's sign-in when they delete their account. Environment only. Never logged, shown, returned or stored. |
| `LA_HOSTED_ALLOW_LOGIN_SURVIVES_DELETION` | no | `false` | Lets the server start without the secret key (a development stack with no real project). Deleting an account then leaves its sign-in in place, and says so. |
| `LA_APPLE_SIGNIN_TEAM_ID`, `LA_APPLE_SIGNIN_KEY_ID`, `LA_APPLE_SIGNIN_CLIENT_ID` | no, all or none | none | The Apple developer team's 10-character Team ID, the 10-character Key ID of its Sign in with Apple key, and the app's bundle id (the same value as `LA_APPLE_BUNDLE_ID`, without the Team ID). With the key below they let account deletion revoke the person's Sign in with Apple. See [Account deletion](#account-deletion). |
| `LA_APPLE_SIGNIN_PRIVATE_KEY_FILE` or `LA_APPLE_SIGNIN_PRIVATE_KEY` | with the three above | none | The Sign in with Apple key: the absolute path of the `.p8` file, outside the source tree, or the file's contents (line breaks may be written as `\n`). One of the two, not both. Read at start, held in memory only. Never logged, shown, returned or stored. |
| `LA_APPLE_BUNDLE_ID`, `LA_APPLE_PRODUCT_ID` | no | `app.littlearchive.mobile`, `unlock_full` | Placeholders: the app's bundle id and the one-time product's id. Change them to the real ones. |
| `LA_APPLE_ENVIRONMENTS` | no | `Production` | `Production`, or `Production,Sandbox` while the app is in review or TestFlight (sandbox purchases are free to make, so leave it off otherwise). |
| `LA_APPLE_APP_ID` | no | `0` | The app's numeric App Store id. If set, a notification must carry it. |
| `LA_GOOGLE_PACKAGE_NAME`, `LA_GOOGLE_PRODUCT_ID` | no | `app.littlearchive.mobile`, `unlock_full` | The same placeholders for Google Play. |
| `LA_GOOGLE_SERVICE_ACCOUNT_FILE` | no | none | Absolute path to a Google service account key file, outside the source tree. Without it Google purchases answer `503` (`not_configured`). |
| `LA_GOOGLE_ALLOW_TEST_PURCHASES` | no | `false` | Accept purchases made by licence testers (free). |
| `LA_GOOGLE_RTDN_AUDIENCE`, `LA_GOOGLE_RTDN_SERVICE_ACCOUNT` | no | none | Both or neither: what Google's real-time notification push must be signed for. Needs the service account file. |
| `LA_TAP_SECRET_KEY` | no | none | The Tap Payments secret key (`sk_test_...` or `sk_live_...`) for [selling the unlock on the web](#paying-on-the-web-with-tap). Environment only. Never logged, shown, returned or stored. Without it and the price, the Tap routes answer `503` (`not_configured`). |
| `LA_TAP_PRICE`, `LA_TAP_CURRENCY` | with the key | none, `KWD` | What the unlock costs, as a decimal with at most the currency's own places: three for `KWD`, `BHD`, `OMR` and `JOD` (`2.500`), two for `SAR`, `AED`, `QAR`, `EGP`, `USD`, `EUR` and `GBP`. At least `0.100` for KWD. Set the key and the price together, or neither. |
| `LA_TAP_RETURN_URL` | no | `<LA_PUBLIC_URL>/api/purchases/tap/return` | Where Tap sends the buyer's browser afterwards (Tap adds `?tap_id=`). Leave it empty to use this server's own small page. HTTPS, no query. |
| `LA_TAP_MERCHANT_ID` | no | none | Only for a Tap account with more than one merchant: the one the money goes to. |
| `LA_OLLAMA_URL`, `LA_OLLAMA_MODEL` | no | empty | The operator's model service. Leave empty to offer no AI. |
| The [understanding settings](understanding.md) | no | off | `LA_AI_PROVIDER`, `LA_GEMINI_*`, `LA_GROQ_*`, `LA_FETCH_*`, `LA_PUBLIC_CACHE*` and the rest work as documented there and apply to every account. `LA_TRANSCRIBE_AUTO` is ignored: see "The understanding layer" below. |

`LA_SUPABASE_SERVICE_KEY` is required, and the server refuses to start without it, unless `LA_HOSTED_ALLOW_LOGIN_SURVIVES_DELETION=true` says that is intended. The reason is in [Account deletion](#account-deletion): without it a person can delete their library in the app and still be able to sign in, which App Store guideline 5.1.1(v) does not allow and which the app cannot fix on its own. A missing key is a configuration mistake that is silent until a store review or a user finds it, so it is refused at start, and `doctor` names it (`supabase_admin_key`), instead of being left to a response field that a client may not show.

`LA_ADMIN_PASSWORD` must be absent: hosted mode has no owner, and the server refuses to start if one is set. Likewise, `LA_SUPABASE_*` settings without `LA_MODE=hosted` stop a self-hosted server from starting, so a half-switched configuration cannot look like it is in effect.

Start it the same way as any instance, with one worker:

```sh
.venv/bin/pip install -r requirements.txt
.venv/bin/python -m server.cli doctor --env-file hosted.env
.venv/bin/python -m server.cli serve --env-file hosted.env --host 127.0.0.1 --port 8787
```

Put a TLS-terminating reverse proxy in front of it. The Compose files in this repository are for single-owner instances (they require an owner password) and were not adapted or tested for hosted mode.

`doctor` understands hosted mode. It reports `identity_provider_sign_in` instead of an owner password check and `per_account_libraries` instead of a database check, confirms the two sign-in packages are installed, and fails with `single_owner_library_present` if the data directory holds an owner library. It does not contact Supabase or open any account's library.

## Sign-in

A client signs in with Supabase and sends the resulting access token on every request:

```
Authorization: Bearer <supabase access token>
```

`GET /api/discovery` needs no credentials and tells a client which mode a server is in, which sign-in methods it accepts, and, in hosted mode, the Supabase URL it trusts.

### What is verified on every request

- **Signature.** With the project's published signing keys (ES256 on P-256, or RS256 with a key of at least 2048 bits), found by the token's key id. If `LA_SUPABASE_JWT_SECRET` is set, HS256 tokens are accepted as well and verified with that secret.
- **Algorithm.** Only those three. `none` and every other algorithm are refused. The server chooses the key from the algorithm family, never the reverse: a published public key is used only for the asymmetric algorithm its own type implies, and the shared secret only for HS256. A key embedded in or referenced by the token is ignored.
- **Issuer and audience.** `iss` must equal the configured issuer exactly. `aud` must be the single configured audience.
- **Time.** `exp` and `iat` are required whole numbers; `nbf` is honoured. Ten seconds of clock leeway.
- **Subject.** `sub` must be a canonical lowercase UUID. It is the account id.
- **Kind of token.** `role` must be `authenticated`, and `is_anonymous` must be absent or exactly `false`. This rejects the project's own anon and service-role API keys, which are signed with the same legacy secret, and anonymous sign-ins.
- **Deletion.** A token issued before its account was deleted is refused (see Account deletion).

A request that fails any check gets `401` with `WWW-Authenticate: Bearer` and no detail about which check failed.

### What is not verified

- **Session revocation.** The server does not ask Supabase whether a session was signed out. A token stays valid here until it expires. Keep access-token lifetimes short in the Supabase project.
- **Email confirmation, MFA level, bans.** Whatever Supabase requires before it issues a token is all that is required. No `aal`, `amr` or `email_verified` claim is inspected.
- **How the person signed in.** Email and password, Google and Apple all end in the same kind of access token, and the server verifies that and nothing about which provider made it. It does not read `app_metadata`, the provider or the email, so [Continue with Google and Apple](mobile-app.md#continue-with-google-and-apple) needed no server change.
- **Authorization inside Supabase.** Row-level security, database roles and app metadata play no part. The Supabase database is not used at all.
- **The identity behind the account id.** The server stores no email address or name. It cannot tell two accounts belong to one person.

### Signing keys

Keys are fetched from the project's key endpoint on first use and kept for ten minutes. A token naming an unknown key id (a rotation) triggers an earlier fetch, at most once every thirty seconds, so made-up key ids cannot be used to make the server send requests. If the endpoint is unreachable, the last key set is honoured for up to an hour, then requests get `503` with `Retry-After` rather than `401`, so a client does not treat an outage as a sign-out. The fetch is one bounded GET (64 KiB, at most 16 keys, eight seconds) that follows no redirects and ignores proxy environment variables. Private key members in a key set are never loaded, and a malformed entry is skipped without discarding the others.

Only one fetch runs at a time, and it does not hold up requests whose key is already known: they keep verifying against the keys in memory. Only a server that has no keys yet waits for the fetch in flight.

Rotating a key in Supabase therefore needs no restart, provided the new key is published before it starts signing. Changing `LA_SUPABASE_JWT_SECRET` does need a restart.

## Tenancy

Each account has its own SQLite database and its own thumbnail folder:

```
<LA_DATA_DIR>/accounts.sqlite3              service bookkeeping, no library content
<LA_DATA_DIR>/users/<account uuid>/library.sqlite3
<LA_DATA_DIR>/users/<account uuid>/assets/<sha256>.png
<LA_DATA_DIR>/users/<account uuid>/.backup-work/
```

The account id from the verified token is the only thing that selects a library. It is matched against the UUID pattern before it is used as a single path component, and a symbolic link in place of an account directory is refused. Nothing a client sends, whether a header, a query parameter, a body field or a path, can name another account. Because every account's database has the same schema as a single-owner library, items, search, collections, imports, AI jobs, export and backup all run the existing queries inside the caller's own file. There is no shared table to filter and no tenant column to forget. Identical thumbnails uploaded by two accounts are stored twice, so a known image digest reveals nothing about another account.

A library is created empty the first time an account makes an authenticated request.

`accounts.sqlite3` holds small tables of service bookkeeping and no library content: unlock flags, the current month's deep-read counts and the current day's and month's suggestion counts, the ids of accounts with queued background work, deletion records, sign-in deletions still owed to the identity provider, which purchase unlocked which account (and which the store took back), the payments started at Tap (account id, charge id, amount, state), and the store notifications already acted on. Counts and deletion records are stored under a SHA-256 of the account id, not the id.

**Open libraries.** Up to `LA_HOSTED_OPEN_LIBRARIES` libraries are kept ready, least recently used first out. A library that a request or background job is still using is never opened a second time, even after it leaves that list. The setting bounds memory, not the number of accounts.

**Background work.** The AI job queue is per account: jobs are stored in the account's own database, one worker thread takes one group of jobs from each account with queued work in turn, and each result is written back to the library it came from. The set of accounts with queued work is saved, so work resumes after a restart without opening every library. A library that is busy with its own request is skipped for that pass, and a library whose job fails unexpectedly (a full disk, an account deleted mid-job) is set aside until work is queued in it again; neither stops the other accounts' work.

## The understanding layer

[Understanding saves](understanding.md) (page details, suggestions, transcripts, closer reads) works in hosted mode with the same routes. What differs:

- **One service per account.** Each account library gets its own understanding service, job queue and usage counters, built when the library is opened. The routes use the service of the library the caller's token resolved to; there is no service-wide instance a route could fall back to. `GET /api/enrichment/usage` reports the caller's own counters.
- **Settings are the operator's.** The AI provider, its keys, server-side page reading and the cache are set once in the environment and apply to every account. No request can change them. With no provider set, AI routes answer `503`.
- **A closer read is the metered deep read.** `POST /api/items/{id}/deep-read` takes one from the account's monthly allowance when it queues work (see the next section).
- **No automatic transcription.** `LA_TRANSCRIBE_AUTO` is forced off, so a transcript is made only by a closer read or sent by the client. Otherwise queueing ordinary suggestions for short-captioned videos would spend transcription with no allowance check.
- **Ordinary suggestions are metered per account.** `POST /api/ai/jobs` (and a retry) queue as many suggestions as the account's daily and monthly allowance has room for, see [Suggestion allowances](#suggestion-allowances). Free and unlocked accounts have different, configurable limits.
- **Server-side page reading** (`LA_FETCH_ENABLED`), if the operator turns it on, lets any account make the server request any public address it can name: the page of a saved link, and the cover a page details object points at. It is bounded per account by the request budget, a concurrency cap (two page reads at once per account, sixteen overall), and the fetcher's own limits, which were re-examined for a public service: see [Server-side requests](#server-side-requests).
- **The shared cache** (`LA_PUBLIC_CACHE`), if turned on, is one file for the whole service at `<LA_DATA_DIR>/public-posts.sqlite3` unless a path is set. It holds only what was derived from public posts. Sharing it between accounts could tell an account that someone else on the service had saved a post, so, in hosted mode: page details are never shared (a hit is instant, a miss is a network read, which would be a timing oracle, and they are cheap to read again); the usage counters count a shared hit as the operation it stands in for and (only while the cache is on) do not record tokens, bytes or seconds, so they read the same either way; and an item's transcript never says it came from the cache. What is shared are transcripts and suggestions for identical public text, which cost real money to make. The difference that remains is how long a job takes: a suggestion answered from the cache finishes on the next pass of the worker, one that needs the model takes the model's time. An account that queues a job for an address and times it can therefore learn that some account asked for that same text before. The attacker needs an account, a post whose exact public text it can reproduce, and a suggestion allowance for each guess (25 a day on the free tier). Leave the cache off if that matters.
- **Stored covers** count toward the storage quota like thumbnails, are refused when they would pass it, and are removed when no item uses them.

## Recipe cards, places, ask and the guided import

These are the same routes as self-hosted, scoped to the caller's own library like every other route. They differ in two ways.

**The unlock gates recipes, places and ask.** Every route of the three (`/api/items/{id}/recipe*`, `/api/recipes`, `/api/items/{id}/places*`, `/api/places`, `/api/ask`) answers `402` to an account that has not unlocked, with the body `{"detail": "This comes with the full unlock.", "code": "unlock_required", "feature": "recipes" | "places" | "ask"}`, before anything is read, stored or sent to a model. `GET /api/features` (not gated) tells a client in advance: `unlocked`, and `locked` per feature. A self-hosted owner is never gated. Their model calls go through the usage hook and appear in the account's own `/api/enrichment/usage`, and are now also **capped per account** (see Feature calls below). The guided import is not gated: bringing your saves in is part of the free product.

**The guided import stages one export at a time.** The file is sent in pieces no larger than the request limit allows (`LA_HOSTED_MAX_JSON_KB` less 8 KiB, at most 256 KiB), stored under the account's own directory, limited to 64 MiB (`LA_IMPORT_MAX_ARCHIVE_MB` changes it), and removed when the import finishes, is cancelled or is rejected, or when the account is deleted. **Staged files count toward the storage quota** while they exist (`Store.staged_bytes`, part of the `used_bytes` that `GET /api/account` reports and that the early `507` check uses): a file that cannot fit is refused when the import is created (`507`, `code: storage_full`), and further pieces are refused with the ordinary storage `507` once the account is full; cancelling frees the room. The database's own hard ceiling is *not* reduced by the staged bytes, so an account's total disk use can pass its quota by the staged file (at most 64 MiB, plus the same again for a few seconds while the pieces are joined) and no more: that is the bound, and it is why one import at a time and 64 MiB are limits and not defaults to be raised lightly. The import job runs in a background thread per import (at most two at once in the process) and writes through the same quota-limited connection as every other write, so a library that fills up stops the job cleanly (`state: failed`, resumable). Geocoding, if the operator enables it, shares one one-request-a-second limiter across every account.

### Feature calls

Recipe cards, places and ask-your-archive spend the operator's money in two ways: a model call (extraction with `method` `ai`, or `auto` when rules and page data found nothing; every `POST /api/ask` that has saves to answer from) and a request to the geocoder (only one that is not answered from the library's own cache). Each is one **feature call**. Every one of them is charged to the account just before it is made, through the same mechanism as ordinary suggestions (`Entitlements.reserve`, family `features`): a daily and a monthly allowance, refunded when the provider fails or answers something that is not a JSON object, with a never-refunded attempts count (three times the daily limit) so failures cannot be repeated without end. An answer that arrives and is then judged unusable against the saved text (nothing in it survives the checks) still counts: the call was made.

Defaults, all configurable (`LA_HOSTED_FEATURE_CALLS_DAILY_UNLOCKED` and `_MONTHLY_UNLOCKED`, `_DAILY_FREE` and `_MONTHLY_FREE`): an unlocked account 100 a day and 1,500 a month; a free account **0**, which is why the three features answer `402 unlock_required` to it. An operator who sets both free allowances above zero opens the features to free accounts with that small allowance (`GET /api/features` then reports `locked: false` for them). An unlocked account whose allowance an operator set to zero is told the limit is reached (`429`), not to unlock. Counting is per account, under a hash, and reported by `GET /api/account` as `entitlements.feature_calls`.

Answers (`Refusal` bodies, so the same shape as everything else): `402 unlock_required` with `feature` (`recipes`, `places`, `ask`); `429` `feature_calls_daily_limit`, `feature_calls_monthly_limit` or `feature_calls_attempts_limit`, each with a `limit` object and `Retry-After`. Reading, editing and extraction by page data or text rules cost nothing and are never refused for an allowance. These routes are also inside the per-address and per-account request budgets: recipe extraction costs 5 tokens and a geocoding or place-extraction request 5 (and one at a time per account, four at once overall, because a geocoder request waits its turn at a limiter that every account shares), `POST /api/ask` 3, finishing a guided-import upload 10 (and counted with exports and imports for concurrency, since it joins and reads a file of up to 64 MiB), committing one 5.

What is not capped: the guided import job itself, which writes through the account's quota-limited connection but not through a rate limit once started; two such jobs run at once in the process, so two accounts can occupy both and make other accounts' imports wait.

## What a hosted server does not offer

- **Password sign-in, cookies and device tokens.** `/api/auth/login`, `/api/auth/logout` and `/api/auth/devices` answer `404`. A cookie is never a credential.
- **The Chrome extension flow.** Every `/api/extension/*` route answers `404`, and the extension-origin CORS allowance is off. Import tokens are looked up in a single owner library, which a hosted server does not have. People can still import export files through `/api/imports/file`.
- **The bundled web interface.** It signs in with the owner password, so a hosted server serves the API only and `/` answers `404`.
- **Per-account model settings.** The model service is the operator's, set by `LA_OLLAMA_URL` and `LA_OLLAMA_MODEL`. No request can change it. With it unset, AI routes answer `503`.
- **CORS.** No route sends CORS headers. Native HTTP clients do not need them, and the [mobile app](mobile-app.md#why-native-http-and-no-server-change) uses one. A browser client on another origin would need an explicit allow-list setting, which does not exist yet.

## Limits

**Storage.** Usage is the account's database plus its thumbnail files; `GET /api/account` reports it beside the quota. There are two layers:

- *An early refusal.* Before any `POST`, `PUT` or `PATCH`, the server answers `507` if usage plus the request body would pass the quota. A thumbnail is checked again after it is re-encoded, because the stored PNG can be much larger than the upload.
- *A hard ceiling.* Every write to an account's database runs with a page limit set in SQLite itself, so the database cannot grow past the ceiling whatever a request expands into (a small ZIP of large exports, say) and however many requests arrive at once. A write that would pass it is rolled back whole and answered `507`. The ceiling is the quota plus a margin, the larger of 256 KiB and one sixteenth of the quota. The margin lets the write that crosses the quota finish, and leaves room for clean-up.

Reads, exports, backups, deletes, cancelling AI jobs and deleting the account keep working at the limit, so an account can always make room or leave. An account's database file shrinks when content is deleted, so freed space returns to the disk. Two things sit outside the ceiling and are temporary: SQLite's write-ahead log during a large write, and backup staging files.

In hosted mode a thumbnail file is removed as soon as no item refers to it. (A self-hosted instance leaves such files in place, as before.)

**Request size.** Bodies over the configured limits get `413`: ordinary JSON, import files and thumbnail uploads each have their own setting above. Page details and transcripts (`/page`, `/transcript`) may be up to 3 MiB, or the import limit if that is smaller. A purchase proof or store notification is capped at 128 KiB. A request that carries nothing that could be a credential (no `Authorization` header and no cookie) may bring at most 8 KiB, in both modes. A body must keep arriving (30 seconds without a byte ends it with `408`) and be complete within five minutes.

**Sign-in before the body.** In hosted mode a request that carries a body (`POST`, `PUT`, `PATCH`) is authenticated before its body is read. No token, a malformed one or a forged one is answered `401` without the server reading, or buffering, a byte of the body; the verified identity is kept for the route, which does not verify it again. Before this, a body of up to the size limits (8 MiB for an import) was held in memory before the token was looked at. The two store-notification routes, which have no account, and the `/api/auth/*` and `/api/extension/*` routes, which answer `404` in this mode, are not asked for a token.

## Server-side requests

With `LA_FETCH_ENABLED=true` the server makes outbound requests that an account steers: the page of any saved link, a cover image named in page details, and, for a closer read, a video. `server/enrich/netfetch.py` is the only code that does it. For a service where anyone with an account can ask, it was re-examined; what it enforces on every request and every redirect hop:

- `http` and `https` only, ports 80 and 443 only, no credentials in the address; a `%` zone in an address, numeric spellings of addresses (decimal, octal, hex, short forms) and names that only become addresses after normalisation (full-width digits, ideographic full stops, circled digits) are refused;
- every address a name resolves to must be globally routable: loopback, private, link-local (including `169.254.169.254`), shared (`100.64.0.0/10`, which holds Alibaba's metadata address), reserved, multicast, `168.63.129.16` (Azure's host service), IPv6 unique-local (which holds AWS's IPv6 metadata address), and addresses that embed an IPv4 one (mapped, translated, NAT64, 6to4, Teredo) are refused, and one mixed answer is refused whole; the list is written out, so the answer does not depend on which Python release's idea of "global" is running;
- the name is resolved once per hop and the connection is made to that validated address, with the original name as `Host` and TLS server name, so a second DNS answer (rebinding) cannot redirect it; each redirect is validated again from scratch, up to four, never from `https` to `http`;
- the total time allowance covers every lookup and connection attempt (each gets what is left, not a fresh timeout), not only the download;
- a response is read undecoded and inflated here under the same byte limit: a gzip or deflate body that would expand past the limit is stopped as it is produced (a 200 MiB bomb was measured at under 8 MiB of allocation; the library's own decoder inflated each received chunk in full before the limit was applied), any other `Content-Encoding` is refused;
- a small content-type allowlist per call, no cookies sent or kept, no proxy environment, an honest user agent.

What it cannot do from inside the process: it cannot bound the system resolver (a name server that never answers holds one thread for the resolver's own timeout, bounded here only by the concurrency caps), it does not use an allowlist of hosts (any public address can be read, so an account can use the server to request public URLs: rate limited and capped, but not prevented), and it does not know about private ranges that are only private to your network if they look public. Deny the service's route to private networks and metadata addresses at the firewall too.

The server's other outbound requests go to fixed hosts that no account chooses, each with no redirects followed and no proxy environment: the Supabase project (signing keys, and deleting a sign-in), Google's Play Developer API when configured, and `https://appleid.apple.com` (`/auth/token` and `/auth/revoke`) when the Sign in with Apple key is configured ([Account deletion](#account-deletion)). An account can cause a request to Apple only by posting an authorization code, at most ten an hour.

## Rate limits and concurrency

All in this process's memory (see "Operating notes" for what that means with more than one process).

- **Per address:** `LA_HOSTED_RATE_ADDRESS_PER_MINUTE` requests a minute, applied to every request before anything else, except `/api/health`. Over it: `429`, `code: rate_limited`, `scope: address`, `Retry-After`. The address is the socket's peer unless `LA_HOSTED_TRUSTED_PROXY_HOPS` says proxies are in front, in which case it is the entry that many places from the right of `X-Forwarded-For` (what your proxies appended; what a client wrote is never believed). The two store-notification routes have their own budget of 60 a minute per address.
- **Per account:** `LA_HOSTED_RATE_ACCOUNT_PER_MINUTE`, charged once the account is known. Most requests cost 1; an export, backup, import or thumbnail upload costs 10, a server-side page read 5, queueing suggestions or a closer read 3. `429`, `code: rate_limited`, `scope: account`.
- **Concurrency:** one account may have `LA_HOSTED_HEAVY_PER_ACCOUNT` exports, backups, imports, thumbnail uploads or guided-import finishes running at once and the service `LA_HOSTED_HEAVY_OVERALL` (`429 too_many_concurrent`, or `503 server_busy` when it is the service as a whole that is full); page reads by the server have their own caps (2 per account, 16 overall). A place is given back when the response has finished, or failed. These requests also hold the account's library lock while they run, so that account's other requests wait for them; other accounts are not affected.
- **Failed sign-ins:** a forged, malformed or wrong-audience token costs one of `LA_HOSTED_RATE_AUTH_FAILURES` a ten-minute budget kept per address. When it is spent, further failures answer `429` (`code: auth_rate_limited`) instead of `401`, and a refused attempt keeps the debt, so hammering keeps it closed. A valid token is never refused for what other clients behind the same address did, an expired token is not a failure (a phone refreshes one every hour), and a request with no token at all is not either (the address budget covers it).

What this does not do: it does not stop a flood that the reverse proxy and the network should absorb (verifying a forged token still costs the server a signature check), and, being in memory, it forgets everything on a restart. Put volumetric limits in the proxy and the firewall.

Not limited by the server:

- the number of accounts, and so total disk use. Each new account costs about 170 KiB before it saves anything. Control sign-ups in Supabase;
- memory for one request. An export is built in memory, so it is as large as the account's text. Decoding a thumbnail of the largest accepted dimensions (20 megapixels) was measured at well over 100 MiB for that request, from a 65 KiB upload, and an import ZIP may expand to 64 MiB of text while it is parsed. The concurrency caps bound how many of these run at once (default 8 overall);
- concurrent backups beyond those caps. Each one stages a snapshot and an archive on disk until its download finishes.

A lower `LA_HOSTED_STORAGE_QUOTA_MB` bounds how large an account's export can be.

## The unlock, deep reads and suggestions

The product has a free tier and a one-time paid unlock. The server asks three things of an account through `server/entitlements.py`:

- `is_unlocked(user_id)`, set only by server code: a verified purchase (below), or an operator through `set_unlocked`. No route sets it from what a client says.
- `consume_deep_reads(user_id, count)` and `refund_deep_reads`, the monthly cap on closer reads.
- `reserve_suggestions(user_id, wanted)` and `refund_suggestions`, the daily and monthly allowance of ordinary suggestions.

`SQLiteEntitlements` stores them in `accounts.sqlite3`. `MemoryEntitlements` is the same behaviour without persistence, for tests. A self-hosted instance uses `OwnerEntitlements`: always unlocked, never metered. `create_app(..., entitlements=...)` accepts another implementation. Counts are kept under a hash of the account id and survive account deletion until their period ends, so deleting an account and signing in again does not refill an allowance.

### Deep reads

One deep read is charged when `POST /api/items/{id}/deep-read` queues a closer read; a request refused for another reason (no transcription configured, one already in progress) charges nothing. An account with no allowance that has not unlocked gets `402` (`unlock_required`, `feature: deep_reads`); an account whose month's cap is used gets `429` (`deep_reads_exhausted`) and nothing is queued. The charge sits on the queueing itself (`tenancy.AccountWorker.adopt`), so any future route that queues a closer read is metered too.

**Refunds.** The charge is given back when the job fails before it produced a transcript (no page to read, no audio, the transcription service failed), and when the job is cancelled while it is still waiting. It is not given back once the transcript exists, even if the suggestion made from it then failed, because the person has the words and the transcription was paid for; and not when a job that had already started is cancelled. A cancelled closer read can be asked for again. A refund goes to the current month's count and never below zero; a job queued on the last day of a month that fails on the first therefore refunds a unit of the new month.

### Suggestion allowances

Ordinary suggestions (title, folder and summary from the understanding provider) are the other thing that costs money per use. `POST /api/ai/jobs` and `POST /api/ai/jobs/{id}/retry` charge one for each item that really needs a new job; an item that already has its suggestion, or has a job queued or running, costs nothing, so asking again for the same items is free.

Defaults, all configurable: a free account may queue 25 a day and 300 a month, an unlocked account 200 a day and 3,000 a month (a day and a month are UTC). The counts are of suggestions queued, not of model calls: a failed one is given back (below), and the whole thing is per account, so one account cannot spend another's. A request is queued as far as the allowance reaches:

- some room: `200` with the usual `{queued, matched, unchanged}` plus `skipped` (how many were not queued) and `limit` (see the contract), so the app can say "12 of 40 queued; the rest tomorrow";
- none: `429` with `code: suggestions_daily_limit`, `suggestions_monthly_limit` or `suggestions_attempts_limit`, a `limit` object and `Retry-After` set to the seconds until the count starts again;
- a free allowance of `0`: `402` `unlock_required` with `feature: suggestions`, which makes suggestions part of the unlock.

**Refunds, and why they are bounded.** A suggestion is given back when its job fails and when it is cancelled while still waiting, from the daily and monthly counts. A third count, of attempts per day, is never given back and stops at three times the daily limit: work that fails after it has cost something (a model answer that cannot be used) could otherwise be repeated without end. Asking for items that need nothing gives back its attempts too. Work that had started when it was cancelled is not refunded: its model request may already have been made.

`GET /api/account` reports all three counts, with `resets_at` for each period.

### Purchases

`POST /api/purchases/apple` and `POST /api/purchases/google` take the store's proof, verify it on the server and call `set_unlocked`. Identifiers are configuration (the defaults, `app.littlearchive.mobile` and `unlock_full`, are placeholders). **Nothing in this section was exercised with a real transaction, a real certificate from Apple, a real Google service account or a real notification: every test generates its own certificates, keys and answers.** What the tests show is that the code does what its checks say, and what it refuses is refused; they do not show that it accepts what the stores actually send. The formats were taken from Apple's and Google's documentation and from Apple's open source server library, and need a first sandbox purchase on each platform to confirm.

**Apple.** The app sends the StoreKit 2 signed transaction (`VerificationResult.jwsRepresentation`) as `{signed_transaction}`. The server checks: it is an ES256 JWS carrying a three-certificate chain whose last certificate is, byte for byte, the bundled Apple Root CA - G3 ([`server/purchases/AppleRootCA-G3.cer`](../server/purchases/AppleRootCA-G3.cer), downloaded from `https://www.apple.com/certificateauthority/AppleRootCA-G3.cer`, SHA-256 `63343abfb89a6a03ebb57e9b3f5fa7be7c4f5c756f3017b3a8c488c3653e9179`, the value Apple lists at `https://support.apple.com/en-us/105116`; the fingerprint is pinned in the code and checked when the file is loaded); each certificate was issued by the next (name and ECDSA signature, SHA-256 or stronger) and was valid when the transaction was signed; the intermediate may sign certificates and carries Apple's marker `1.2.840.113635.100.6.2.1`, the leaf may not and carries `1.2.840.113635.100.6.11.1`; the leaf's P-256 key signed the JWS. Then the payload: `bundleId`, `productId`, `type` of `Non-Consumable`, `environment` (`Production` only unless `LA_APPLE_ENVIRONMENTS` says more) and the revocation fields (`revocationDate` present means refunded or revoked). Not checked: certificate revocation (OCSP or CRLs), which Apple's own library does only when asked to go online; the refund state is carried by the transaction and by notifications instead.

**Google.** The app sends `{product_id, purchase_token}`. The server never believes the token: it asks the Google Play Developer API (`purchases.products.get`) with a service account whose key file is named by `LA_GOOGLE_SERVICE_ACCOUNT_FILE` (read at start-up, held only in memory, never shown, never in this repository), and acts on the answer: purchased (`unlocked`, and the purchase is acknowledged if the app has not done so; Google refunds an unacknowledged purchase after three days), pending (`202`, nothing unlocked yet), cancelled (`409` `purchase_revoked`). A licence tester's purchase is refused unless `LA_GOOGLE_ALLOW_TEST_PURCHASES` says otherwise. The service account must be invited in the Play Console with permission to view financial data and manage orders; that setup was not done or tried. The token is never stored, only its SHA-256.

**Tagging a purchase with the account (recommended for the app).** StoreKit's `appAccountToken` can be set to the account's UUID, and Google's obfuscated account id to the SHA-256 (lowercase hex) of that UUID. The server records whether the tag matched. It does not refuse a mismatch, because it must not strand a person whose account was deleted and recreated (see below); the rule that stops sharing is the binding.

**One purchase, one account.** A purchase unlocks the first account that presents a proof of it and stays bound to it. The same account presenting it again is a **restore**: `200` with `restored: true`, nothing changes. A different account gets `409` `purchase_bound_elsewhere`. The consequence is that two app accounts under one Apple ID cannot both be unlocked by one purchase, and a person who signed up twice must sign in to the first. The way out is to delete the account that holds it: deleting an account **releases** its purchases, so the same purchase can unlock a new account, except a purchase the store took back, which stays marked and unlocks nobody. The record names the account by its id (as the unlock flag always has), is deleted with the account, and holds for a Google purchase only a hash of the token.

**Taking a purchase back.**

- *App Store Server Notifications V2*: `POST /api/purchases/apple/notifications` with `{signedPayload}`, verified by the same chain as a transaction, and checked for the app's bundle id, an allowed environment and (if `LA_APPLE_APP_ID` is set) the app's id. `REFUND` and `REVOKE` revoke the purchase; `REFUND_REVERSED` reinstates it; `ONE_TIME_CHARGE`, `TEST`, `REFUND_DECLINED`, `CONSUMPTION_REQUEST` and everything else are acknowledged and ignored. Each notification is acted on once (its `notificationUUID`), and an event older than the last one that set a purchase's state is ignored. A refund that arrives before the person ever redeemed the purchase is recorded, and redeeming it afterwards fails. Configure the URL in App Store Connect. Not built: Apple's consumption-information reply, and asking Apple's Server API for a transaction (which needs a key from App Store Connect), so there is no pull path for Apple; without notifications a refund is only noticed when the app presents a newer transaction that carries `revocationDate`.
- *Google real-time developer notifications*: a Pub/Sub push to `POST /api/purchases/google/notifications`, authenticated by the OpenID token Pub/Sub attaches (checked against Google's published keys, for the audience and service account in `LA_GOOGLE_RTDN_AUDIENCE` and `LA_GOOGLE_RTDN_SERVICE_ACCOUNT`). A notification only says something changed, so for a cancelled one-time product or a voided purchase the server asks Google again and acts on that answer; a message that claims a cancellation while Google says the purchase stands changes nothing. If Google cannot be asked it answers `503` so the push is retried. The same re-check can be run by hand: `PurchaseService.reverify_google(token)`.
- *An operator's hand*: `PurchaseService.revoke(provider, purchase_key)` takes a purchase back (Apple's original transaction id, or the SHA-256 of a Google token). A hand revocation is not undone by an older store event.
- *A restore after the fact*: presenting the proof of a purchase the store took back is `409` `purchase_revoked`.

An account stays unlocked while any of its purchases is active. An unlock an operator set by hand (`source: manual`) is never rewritten or undone by a purchase or a refund. `GET /api/purchases` lists the account's purchases and whether it is unlocked.

### Paying on the web with Tap

The same unlock can be bought in a browser through [Tap Payments](https://developers.tap.company) (Kuwait). The server never sees a card: it creates a charge with `source.id = "src_all"`, which makes Tap show its own hosted page with every method the merchant account has switched on (KNET, cards, Apple Pay and so on), and sends the buyer there. It is off until `LA_TAP_SECRET_KEY` and `LA_TAP_PRICE` are set; until then every route below answers `503` `purchases_unavailable` (`provider: tap`, `reason: not_configured`), and the return page says the payment could not be checked. **None of this was run against Tap, not even its sandbox: Tap is a dictionary in the tests, and the real HTTP client was exercised against a transport that plays Tap's API.** The shapes come from Tap's API reference and need a first test-key payment to confirm.

- `POST /api/purchases/tap/start` `{email, name?}`, signed in. The server writes the payment down (the account, the configured price and currency, a reference it makes itself), creates the charge, and answers `{unlocked: false, provider: "tap", status: "pending", url}`; the client opens `url`, which is always on one of Tap's own hosts. Tap requires a name and an email for its receipt; the server passes them on and keeps neither. An account that is already unlocked gets `{unlocked: true, status: "unlocked", url: null}` and no charge. Asking again within twenty minutes while the first page is still open answers that same page, so two taps on Buy cannot become two payments.
- `GET /api/purchases/tap/return?tap_id=chg_...` is where Tap sends the buyer's browser. It carries no sign-in, so the id is only a hint. The answer is a small plain HTML page: payment received, not confirmed yet, not completed, could not be checked, or not found.
- `POST /api/purchases/tap/notifications` is Tap's webhook. The server gives Tap this address with every charge (`post.url`), so there is nothing to enter in Tap's dashboard. The body must carry Tap's `hashstring` header (an HMAC-SHA256 keyed with the secret key); a wrong or missing one is `401` and Tap is not asked. A correctly signed body is still not believed: it is only a prompt to ask Tap about that charge.
- `POST /api/purchases/tap/confirm` `{tap_id}`, signed in, for a client that wants the answer as JSON: `200` unlocked, `202` while Tap has not finished, `409` `purchase_not_paid` (with Tap's `status`) for a payment that ended unpaid, `409` `purchase_bound_elsewhere` for another account's charge.

All three ways in end in one function, which unlocks only when: the charge is one this server started (an unknown id is refused without asking Tap); Tap, asked for the charge by id, says `CAPTURED` (every other status, and any word Tap adds later, is unpaid); the amount and currency are the configured ones and the ones written down when the payment was started; the order reference (in `reference.order` and again in `metadata`) and the account id Tap returns are the ones the server sent; and the charge's `live_mode` matches the key. The account unlocked is always the one that started the payment, whoever opens the return address. The same charge settles once: afterwards the answer is on file (`restored: true`) and Tap is not asked again. The unlock is recorded with source `tap` and is in `accounts.sqlite3`, so it survives a restart.

What it does not do. Refunds are not followed: refund in Tap's dashboard, then take the purchase back with `PurchaseService.revoke("tap", "<charge id>")`. A payment whose buyer never returns and whose webhook never arrives stays unsettled until someone opens the return address or the account starts again (which checks the open payment first); there is no scheduled re-check. Deleting an account deletes its payment records, so a Tap payment cannot unlock a new account afterwards; that is for an operator's hand. A charge paid at a price the operator changed while the buyer was on Tap's page is refused (the amount must be the configured one), so change `LA_TAP_PRICE` when nobody is paying, or unlock such a buyer by hand.

**Setting it up.**

1. In Tap's dashboard, copy the secret key. Start with the test key (`sk_test_...`): a test key never moves money, and **an account that pays with a test card is unlocked for real on that server**, so never leave a test key on the production service.
2. Set `LA_TAP_SECRET_KEY`, `LA_TAP_PRICE` and, if not KWD, `LA_TAP_CURRENCY`. `doctor` reports `tap_payments` as configured or not, and nothing else about it.
3. `LA_PUBLIC_URL` must be the public HTTPS address, because the return page and the webhook are built from it: `https://<your service>/api/purchases/tap/return` and `https://<your service>/api/purchases/tap/notifications`. Let both through the reverse proxy without a sign-in. On a loopback address no webhook is asked for, and a payment is settled by the buyer's return alone.
4. Apple Pay appears on Tap's page only after the domain is verified for Apple Pay in Tap's dashboard and Apple Pay is enabled on the merchant account. That is done with Tap, not in this server, and was not tried.
5. Test with the test key: start a payment, pay on Tap's page with one of Tap's test cards (KNET: choose the test bank, card `8888880000000001`, expiry `09/30`, PIN `1234`, which Tap's testing-cards page lists as captured; check that page for the current cards), and check that the return page says the payment was received and that `GET /api/account` reports `unlocked_via: "tap"`. Then decline one and check that nothing unlocks.
6. Switch to the live key only when the price is final.

**How a buyer reaches it.** A hosted server has no web interface and no browser sign-in yet, so there is no pay page a visitor can open: `start` needs the account's access token, which today only the phone app holds. The app has no button for it, on purpose (the stores' rules on outside payment are the owner's decision). Until a signed-in web page exists, the route can be reached only by a client that holds the account's sign-in, for example a support tool or a future account page on the web, which calls `start` and sends the browser to `url`.

## Account deletion

`POST /api/account/delete` with `{"confirm":"DELETE"}` permanently removes the caller's account, in this order:

1. **The intent is written down first** (`auth_deletions` in `accounts.sqlite3`: the account id, until the sign-in is gone).
2. **The library is deleted** from this server: the account directory (database, thumbnails, backup staging) and its unlock flag, queued-work entry and purchases. The first step detaches the directory in one atomic rename, so the library is unreachable from that moment even if a later step fails or the server stops; the rest is completed at the next start. A token issued before the deletion is `401` from then on, including for a request already in flight.
3. **The Supabase sign-in is deleted** with the project's secret key (`DELETE /auth/v1/admin/users/{id}`, one request, no redirects followed). Answers: `200` with `{"deleted": true, "auth_user_deleted": true}` when it is gone (Supabase saying the user no longer exists counts as gone); `202` with `{"deleted": true, "auth_user_deleted": false, "auth_deletion": "pending", "detail": ...}` when the library is deleted and the sign-in could not be yet; `200` with `"auth_deletion": "not_configured"` when the operator chose to run without the key.

**Why this order and these failure rules.** Library first means a failure can only leave a sign-in that still works, which the server knows about and keeps trying to remove, never a library nobody can reach or a login whose data has silently gone. A `202` is not an error to retry by hand: the server retries on its own thread, after 30 seconds and doubling up to once an hour, and again at every start, until Supabase confirms, and every step is safe to repeat. If the person signs in again in the meantime they get a new, empty library, and it is deleted with the sign-in when that succeeds. A refused key (`401` or `403` from Supabase) is logged as an error that names `LA_SUPABASE_SERVICE_KEY` and nothing else, and retried, so an operator who fixes it finishes the deletions that were waiting. The key is never in a log line, an error, a response, `repr`, a diagnostics report or the database; the retry record holds the account id and a short reason code, and is removed when the sign-in is gone.

**Sign in with Apple is revoked too, when configured.** Apple expects an app that offers Sign in with Apple to revoke the person's Apple tokens when they delete their account (guideline 5.1.1(v), technical note TN3194). With the four `LA_APPLE_SIGNIN_*` settings in place ([the owner steps](mobile-app.md#what-to-switch-on-and-create-the-owner-checklist)):

- After an Apple sign-in the app posts Apple's one-time authorization code to `POST /api/account/apple-authorization`. The server trades it at `https://appleid.apple.com/auth/token` (form fields `client_id`, `client_secret`, `code`, `grant_type=authorization_code`; the client secret is an ES256 JWT signed with the key, good for five minutes, made for that one request) and keeps the refresh token Apple returns, one per account, the newest, in `accounts.sqlite3` (`apple_signin_tokens`). Answers: `{"stored": true}`; `400` `apple_code_refused` when Apple does not accept the code; `503` `apple_unavailable` when Apple cannot be reached or refuses the key (logged as an error that names the settings); `429` after ten codes from one account in an hour. The app ignores all of them: signing in does not depend on this.
- Deleting the library takes the token out of the database and asks Apple to revoke it (`POST …/auth/revoke`, `token_type_hint=refresh_token`), **once**, as the library's records are removed (step 2) and so before the Supabase sign-in is deleted (step 3). This happens wherever a library is deleted: the delete request, a retried sign-in deletion (which also covers a person who signed in with Apple again in the meantime), and a deletion finished at the next start.
- **Apple failing never blocks the deletion.** Unreachable, slow (the request gives up after ten seconds), a `5xx`, a refused key: the library and the sign-in are deleted all the same, the response is what it would have been, and a warning is logged with a short reason and no identifier (a refused key is an error that names the settings). The token is not kept for a later try: it left the database before Apple was asked, so neither Apple's answer nor a crash leaves an Apple token behind for a deleted account. A code whose trade with Apple was still in flight when the account was deleted is revoked and dropped when the trade returns. The cost is that an Apple outage at that moment means that sign-in is not revoked; the person can end it under Settings, their Apple Account, Sign in with Apple. A token Apple no longer honours counts as revoked.
- The refresh token, the authorization code, the key and the client secrets are in no log line, error, response, `repr` or diagnostics report. A refresh token is of no use without a client secret signed by the key, which is not in the database. Nothing checks that the Apple identity behind a code is the one the account signed in with: an account can only ever cause its own record, and so only an Apple sign-in whose code it holds, to be revoked.
- **Without the settings nothing changes**: the route answers `{"stored": false}`, no request goes to Apple, and deletion is as described above. `doctor` lists `apple_signin_revocation` (passed) only when the settings are present, and does not read the key or contact Apple. An account that has no token on record (it signed in with Apple before the settings were there, or its code never arrived) is deleted without a word to Apple. If the settings are removed later, a token already kept is dropped with its account and a warning says Apple was not asked.

Verified only against stand-ins (`tests/test_hosted_apple_signin.py`): a scripted Apple client inside the application, and the real client against a scripted transport with a key made in the test, its client secret checked with the public key. The request shapes follow Apple's "Generate and validate tokens", "Revoke tokens" and "Creating a client secret" pages; Apple's servers have not been asked, with a real key or any other.

Why the key is required at start rather than only reported in a response: see Configure. Verified only against a stand-in; the request follows Supabase's published client libraries and API-key guide (the `apikey` header for a `sb_secret_` key, plus a bearer header for the legacy JWT `service_role` key, and `should_soft_delete: false`), and a live project has not been asked.

Two things are kept after a deletion, both under a hash of the account id and neither with any library content: a deletion record for 30 days (the time of deletion; a token issued before it is refused, so a still-valid token on another device cannot recreate the library), and this month's counts of deep reads and suggestions until their periods end. A purchase the store took back is also kept, with no account on it.

Deletion does **not** reach copies outside the account directory: exports and backups the person downloaded, the operator's own backups of the data directory, or text already sent to the model service. It does not restore a paid unlock to the person's next account by itself: the purchase has to be presented again.

## Export, backup and restore

`GET /api/export` and `GET /api/backup` work for each account exactly as they do for an owner, and contain only that account's library. A backup is staged inside the account's own directory and needs free disk space for a snapshot plus the archive; the staging space is not counted against the quota. If the server stops during a backup, its staging folder stays in the account's `.backup-work/` until the account is deleted or the operator removes it.

An account's backup ZIP is an ordinary version-1 backup. Restoring one into a new self-hosted library with `python -m server.cli restore` is covered by the tests, which makes leaving the hosted service a supported path. Restoring a backup into a hosted account directory has not been tested and there is no route for it; the person can re-import a JSON export instead.

**Operator backups.** Back up the whole data directory. Either stop the server first, or snapshot each `library.sqlite3` and `accounts.sqlite3` with SQLite's backup mechanism; copying a live WAL-mode database file by file can produce a broken copy. A restored operator backup brings back accounts deleted after it was taken, so apply deletions again from your own records before putting such a restore into service.

## Operating notes

- Run one worker process. The sign-in key cache, the open-library list, the job worker, **and every rate limit, failure budget and concurrency cap** are per process and in memory. With more than one process, or more than one machine, each keeps its own counts (the limits then multiply by the number of processes, a failure budget can be spent once per process, and a restart empties them); a shared store (Redis or similar) or the reverse proxy would have to hold them, and this code has no such store. The suggestion, deep-read and purchase records are in the database and are the same for every process that shares the data directory, but SQLite on a network filesystem is not supported.
- Behind a reverse proxy, set `LA_HOSTED_TRUSTED_PROXY_HOPS`. `uvicorn` is started with `proxy_headers=False`, so without it the address of every request is the proxy's, and the per-address limit applies to everyone at once.
- Point the stores' notifications at `https://<your service>/api/purchases/apple/notifications` (App Store Connect) and `.../google/notifications` (a Pub/Sub push subscription with the audience and service account you configured). Both are public routes; each is judged by its own signature, rate limited per address, and capped at 128 KiB. Tap needs no address entered: the server sends `.../tap/notifications` with every charge, and that route and `.../tap/return` must be reachable without a sign-in (see [Paying on the web with Tap](#paying-on-the-web-with-tap)).
- A host that runs the server should deny it any route to private networks and cloud metadata addresses at the firewall as well: the page fetcher refuses them, but a second layer costs nothing.
- There is no admin API and no route that lists accounts. Operator access is the filesystem.
- The operator can read every library. Nothing is end-to-end encrypted, and SQLite files are not encrypted by the application.
- If AI is enabled, every account's queued items are sent to the one model service the operator configured.
- Access logging is off by default, as in self-hosted mode. Tokens are never written to logs by the application; make sure the reverse proxy does not log `Authorization` headers.
- Each account directory is created with owner-only permissions, like the single-owner data directory.

## What was verified

By this repository's tests (`tests/test_contract_modes.py`, `tests/test_hosted_identity.py`, `tests/test_hosted_tenancy.py`, `tests/test_hosted_operator.py`), on Python 3.12 on macOS, with no network:

- the same API scenarios pass in both modes, and a scripted run of 35 requests returns the same statuses and JSON shapes in both;
- tokens signed with ES256, RS256 and HS256 keys generated in the tests are accepted; forged, tampered, expired, premature, wrong-audience, wrong-issuer, wrong-role, anonymous, API-key-shaped, `none`, algorithm-confused and malformed tokens are refused without creating a library;
- key caching, rotation, withdrawal and outage behaviour, using a fake key endpoint and a controlled clock, and the real key fetcher against a key set served on loopback;
- one account cannot read, change, list, export, back up or enumerate another's items, thumbnails, collections, tags, imports, jobs or settings;
- the storage quota and its hard ceiling, including an import that expands far beyond its upload and eight clients writing at once; the request-size limits; removal of unreferenced thumbnails; and that a slow upload or import in one account does not stall another;
- account deletion removes the account's files and records, leaves other accounts intact, blocks earlier tokens, and is completed at the next start after a simulated crash or a failed step;
- the job worker serves accounts in turn, writes results to the right library, resumes after a restart, skips a busy library, and survives a failing library and an account deleted mid-job;
- page details, transcripts, closer reads and usage counters stay inside the caller's account, and a closer read is charged to the monthly allowance exactly when it queues work;
- the monthly deep-read meter, including month rollover with a controlled clock and an account deleted and recreated within a month.

The real server process was also started in both modes on loopback and used with a device token and a locally signed access token, and a hosted process was put under twelve concurrent clients across six accounts while two of the accounts were deleted.

The understanding layer's own tests run in single-owner mode. In hosted mode its page reading from a client, transcripts sent by a client, suggestions with a faked model, and the closer-read request were exercised; server-side page fetching, real transcription, the Gemini and Groq providers and the shared cache were **not** exercised in hosted mode.

**Added with the purchase, deletion and limit work** (`tests/test_hosted_metering.py`, `test_hosted_limits.py`, `test_hosted_account_deletion.py`, `test_hosted_purchases.py`, `test_google_play.py`, `test_hosted_shared_cache.py`, `test_netfetch_hardening.py`, `test_device_expiry.py`), on Python 3.14 on macOS (the container image uses 3.12, which was not run), with no network except loopback:

- suggestion allowances: daily and monthly windows with a controlled clock, partial grants, the attempts count, failure and cancellation refunds through the real worker, deep-read refunds (including the case where the transcript exists), and the response bodies and `Retry-After` values;
- rate limits with a controlled clock, address spoofing through `X-Forwarded-For`, per-account prices, concurrency caps held open by a blocked export in another thread, places given back after a failure, the failed-sign-in budget (including that expiry and a deleted account's token are not failures), and that a request with a body is not read at all unless it carries a valid token (checked at the ASGI level by counting calls to `receive`);
- account deletion against a stand-in Supabase on 127.0.0.1: the exact request, both key shapes, success, already gone, `5xx`, `401`/`403`, unreachable, a redirect that must not be followed, retry with backoff, a retry after a restart, a library recreated in between, a library deletion that failed part-way; and that the key is in no response, log, repr, report or file;
- purchases with certificates generated in the tests: about forty ways a proof can be wrong, each refused (and, by mutation, each check shown to be what refuses it), restore, a second account, refund and reversal, event order, de-duplication, two purchases, a hand-made unlock; Google with a dictionary standing in for Play, and the real HTTP client against a transport that plays Google's token endpoint and API; the push-token check with keys made here;
- Tap payments (`tests/test_hosted_tap.py`) with a dictionary standing in for Tap, and the real HTTP client against a transport that plays Tap's API: a captured charge unlocks the account that started it; a wrong amount, currency, account, order reference or mode, every unpaid status, a charge this server never started, a replayed charge, another account's charge and a forged or merely well-signed webhook unlock nobody; the unlock survives a restart; with no key the routes say so; and the key is in no response, log, repr or doctor report;
- the shared cache and the full-disk answer; the fetcher against decompression bombs (a 200 MiB gzip body was measured to stay under 8 MiB of allocation), exhausted time allowances, hosts that become addresses once prepared, and ranges that Python versions disagree about;
- device tokens expiring, and a devices file from the previous release still working.

**Added with Sign in with Apple revocation** (`tests/test_hosted_apple_signin.py`), on Python 3.14 on macOS, with no network: the code traded and the token kept per account and replaced by a newer one; deletion asking Apple before Supabase; six ways Apple can fail, none blocking the deletion or leaving the token behind; a retried sign-in deletion revoking a token made in between; the feature off making no client and no request; the request and client-secret shapes from the real client; every setting's refusal; and that the code, the token and the key are in no response, log, repr or report, and the token in no database file after a deletion.

**Not verified:** Apple's real certificates or any real transaction, notification or sandbox purchase; Apple's real `/auth/token` and `/auth/revoke` with a real Sign in with Apple key; Google's real API, service account, key set or Pub/Sub push; Tap's real API, hosted page, webhook or `hashstring`, with a test key or a live one, and Apple Pay on Tap's page; a live Supabase admin call; more than one process; the container build; Python 3.12; load; a live Supabase project (the expected claims follow Supabase's documented token format and were not checked against real tokens), any mobile client, Linux or a container build with the two added packages, concurrent load, many thousands of accounts on one filesystem, restoring into a hosted account, and an independent security review.
