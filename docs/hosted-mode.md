# Hosted mode

Hosted mode lets one Little Archive server hold a private library for each of many accounts. It is the same server, the same routes and the same JSON as a self-hosted instance; only sign-in and storage layout differ. People sign up and sign in through a [Supabase Auth](https://supabase.com/docs/guides/auth) project that the operator runs. The server never sees a password.

It is off unless you configure it. Without `LA_MODE=hosted`, a server is the single-owner library described in [self-hosting](self-hosting.md), unchanged.

**Status.** This mode is development software. It has been exercised by this repository's automated tests, using signing keys generated in the tests and a fake key endpoint, and by starting the real server process on loopback. It has **not** been run against a live Supabase project, used from a mobile app, load-tested, deployed in a container, or independently security-reviewed. The last section lists exactly what was and was not checked.

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
| `LA_OLLAMA_URL`, `LA_OLLAMA_MODEL` | no | empty | The operator's model service. Leave empty to offer no AI. |

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

`accounts.sqlite3` holds four small tables: unlock flags, the current month's deep-read counts, the ids of accounts with queued background work, and deletion records. Deep-read counts and deletion records are stored under a SHA-256 of the account id, not the id.

**Open libraries.** Up to `LA_HOSTED_OPEN_LIBRARIES` libraries are kept ready, least recently used first out. A library that a request or background job is still using is never opened a second time, even after it leaves that list. The setting bounds memory, not the number of accounts.

**Background work.** The AI job queue is per account: jobs are stored in the account's own database, the single worker takes one job from each account with queued work in turn, and each result is written back to the library it came from. The set of accounts with queued work is saved, so work resumes after a restart without opening every library. A library that is busy with its own request is skipped for that pass, and a library whose job fails unexpectedly (a full disk, an account deleted mid-job) is set aside until work is queued in it again; neither stops the other accounts' work.

## What a hosted server does not offer

- **Password sign-in, cookies and device tokens.** `/api/auth/login`, `/api/auth/logout` and `/api/auth/devices` answer `404`. A cookie is never a credential.
- **The Chrome extension flow.** Every `/api/extension/*` route answers `404`, and the extension-origin CORS allowance is off. Import tokens are looked up in a single owner library, which a hosted server does not have. People can still import export files through `/api/imports/file`.
- **The bundled web interface.** It signs in with the owner password, so a hosted server serves the API only and `/` answers `404`.
- **Per-account model settings.** The model service is the operator's, set by `LA_OLLAMA_URL` and `LA_OLLAMA_MODEL`. No request can change it. With it unset, AI routes answer `503`.
- **CORS.** No route sends CORS headers. Native HTTP clients do not need them. A browser client on another origin would need an explicit allow-list setting, which does not exist yet.

## Limits

**Storage.** Usage is the account's database plus its thumbnail files; `GET /api/account` reports it beside the quota. There are two layers:

- *An early refusal.* Before any `POST`, `PUT` or `PATCH`, the server answers `507` if usage plus the request body would pass the quota. A thumbnail is checked again after it is re-encoded, because the stored PNG can be much larger than the upload.
- *A hard ceiling.* Every write to an account's database runs with a page limit set in SQLite itself, so the database cannot grow past the ceiling whatever a request expands into (a small ZIP of large exports, say) and however many requests arrive at once. A write that would pass it is rolled back whole and answered `507`. The ceiling is the quota plus a margin, the larger of 256 KiB and one sixteenth of the quota. The margin lets the write that crosses the quota finish, and leaves room for clean-up.

Reads, exports, backups, deletes, cancelling AI jobs and deleting the account keep working at the limit, so an account can always make room or leave. An account's database file shrinks when content is deleted, so freed space returns to the disk. Two things sit outside the ceiling and are temporary: SQLite's write-ahead log during a large write, and backup staging files.

In hosted mode a thumbnail file is removed as soon as no item refers to it. (A self-hosted instance leaves such files in place, as before.)

**Request size.** Bodies over the configured limits get `413`: ordinary JSON, import files and thumbnail uploads each have their own setting above.

**Not limited by the server.** Put rate limiting and connection limits in the reverse proxy, and control sign-ups in Supabase:

- request rate, per account or per address, and the number of requests one account runs at once;
- the number of accounts, and so total disk use. Each new account costs about 150 KiB before it saves anything;
- memory for one request. An export is built in memory, so it is as large as the account's text. Decoding a thumbnail of the largest accepted dimensions (20 megapixels) was measured at well over 100 MiB for that request, from a 65 KiB upload. An import ZIP may expand to 64 MiB of text while it is parsed;
- concurrent backups. Each one stages a snapshot and an archive on disk until its download finishes;
- request bodies before sign-in. A body is read, up to the size limits above, before the token is checked.

A lower `LA_HOSTED_STORAGE_QUOTA_MB` bounds how large an account's export can be.

## Unlock and deep reads

The product has a free tier and a one-time paid unlock. The server can ask two things about an account through `server/entitlements.py`:

- `is_unlocked(user_id)`
- `consume_deep_reads(user_id, count)`, which records usage against this month's cap and refuses, changing nothing, when the cap would be passed. Counts reset on the first of each month, UTC; earlier months are not kept. A count is stored under a hash of the account id and survives account deletion until the month ends, so deleting an account and signing in again does not refill an allowance.

`SQLiteEntitlements` stores this in `accounts.sqlite3`. `MemoryEntitlements` is the same behaviour without persistence, for tests. A self-hosted instance uses `OwnerEntitlements`: always unlocked, never metered.

**No payment provider is integrated.** `set_unlocked(user_id, unlocked, source)` is the seam: a future purchase-verification webhook should verify the receipt with the store itself and then call it. No route sets the flag, and until that webhook exists the only way to unlock an account is to call that method from operator code on the server. `create_app(..., entitlements=...)` accepts another implementation of the same interface.

Today one operation is metered: queueing AI classification. Each newly queued job is one deep read, charged when it is queued, including a retry. Work that is already queued or complete is not charged again. A failed or cancelled job is not refunded. An account with no allowance that has not unlocked gets `402`; a request that would pass the month's cap gets `429` and queues nothing. Whether "deep read" should mean this operation is a product decision this code does not settle; the charge is one call in `server/app.py` (`ai_request`) and can move.

## Account deletion

`POST /api/account/delete` with `{"confirm":"DELETE"}` permanently removes the caller's account data from this server:

- the account directory: the library database, every thumbnail and any backup staging files;
- the account's unlock flag and queued-work entry.

The first step detaches the account directory in one atomic rename, so the library is unreachable from that moment even if a later step fails or the server stops. The content is then removed. Anything left unfinished (the deletion record, the bookkeeping) is completed at the next start, and the request answers `500` rather than claiming success. Any request or background job still holding that library fails from then on (`410`) and cannot recreate files.

Two things are kept, both under a hash of the account id and neither with any library content:

- a deletion record, for 30 days: the hash and the time of deletion. A token issued before that time is refused (`401`), including by a request that was already in flight, so a still-valid token on another device cannot keep using or recreate the library;
- this month's deep-read count, until the month ends.

Deletion here does **not**:

- delete the Supabase Auth user or end its sessions. The client or a trusted backend must do that through Supabase. Until it does, the person can sign in again, and a device that is still signed in will get a newer token the next time it refreshes; either starts a new, empty library with no unlock. A complete in-app account deletion needs both steps;
- reach copies outside the account directory: exports and backups the person downloaded, the operator's own backups of the data directory, or text already sent to the model service;
- restore a paid unlock. If the person returns, the purchase has to be re-verified through the same seam.

## Export, backup and restore

`GET /api/export` and `GET /api/backup` work for each account exactly as they do for an owner, and contain only that account's library. A backup is staged inside the account's own directory and needs free disk space for a snapshot plus the archive; the staging space is not counted against the quota. If the server stops during a backup, its staging folder stays in the account's `.backup-work/` until the account is deleted or the operator removes it.

An account's backup ZIP is an ordinary version-1 backup. Restoring one into a new self-hosted library with `python -m server.cli restore` is covered by the tests, which makes leaving the hosted service a supported path. Restoring a backup into a hosted account directory has not been tested and there is no route for it; the person can re-import a JSON export instead.

**Operator backups.** Back up the whole data directory. Either stop the server first, or snapshot each `library.sqlite3` and `accounts.sqlite3` with SQLite's backup mechanism; copying a live WAL-mode database file by file can produce a broken copy. A restored operator backup brings back accounts deleted after it was taken, so apply deletions again from your own records before putting such a restore into service.

## Operating notes

- Run one worker process. The sign-in key cache, the open-library list and the job worker are per process.
- There is no admin API and no route that lists accounts. Operator access is the filesystem.
- The operator can read every library. Nothing is end-to-end encrypted, and SQLite files are not encrypted by the application.
- If AI is enabled, every account's queued items are sent to the one model service the operator configured.
- Access logging is off by default, as in self-hosted mode. Tokens are never written to logs by the application; make sure the reverse proxy does not log `Authorization` headers.
- Each account directory is created with owner-only permissions, like the single-owner data directory.

## What was verified

By this repository's tests (`tests/test_contract_modes.py`, `tests/test_hosted_identity.py`, `tests/test_hosted_tenancy.py`, `tests/test_hosted_operator.py`), on Python 3.12 on macOS, with no network:

- the same API scenarios pass in both modes, and a scripted run of 29 requests returns the same statuses and JSON shapes in both;
- tokens signed with ES256, RS256 and HS256 keys generated in the tests are accepted; forged, tampered, expired, premature, wrong-audience, wrong-issuer, wrong-role, anonymous, API-key-shaped, `none`, algorithm-confused and malformed tokens are refused without creating a library;
- key caching, rotation, withdrawal and outage behaviour, using a fake key endpoint and a controlled clock, and the real key fetcher against a key set served on loopback;
- one account cannot read, change, list, export, back up or enumerate another's items, thumbnails, collections, tags, imports, jobs or settings;
- the storage quota and its hard ceiling, including an import that expands far beyond its upload and eight clients writing at once; the request-size limits; removal of unreferenced thumbnails; and that a slow upload or import in one account does not stall another;
- account deletion removes the account's files and records, leaves other accounts intact, blocks earlier tokens, and is completed at the next start after a simulated crash or a failed step;
- the job worker serves accounts in turn, writes results to the right library, resumes after a restart, skips a busy library, and survives a failing library and an account deleted mid-job;
- the monthly deep-read meter, including month rollover with a controlled clock and an account deleted and recreated within a month.

The real server process was also started in both modes on loopback and used with a device token and a locally signed access token, and a hosted process was put under twelve concurrent clients across six accounts while two of the accounts were deleted.

**Not verified:** a live Supabase project (the expected claims follow Supabase's documented token format and were not checked against real tokens), any mobile client, Linux or a container build with the two added packages, concurrent load, many thousands of accounts on one filesystem, restoring into a hosted account, and an independent security review.
