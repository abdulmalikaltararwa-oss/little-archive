# Little Archive v0.1 API contract

Independent self-hosted saved-content library. Single owner per instance, multiple source accounts. Backend Python 3.12+, FastAPI, sqlite3; frontend buildless ES modules, HTML/CSS; Chrome MV3 extension. Public fixtures and screenshots use synthetic content.

The same server has an opt-in hosted mode (`LA_MODE=hosted`): many accounts, one private library each, identical routes and JSON. Everything below applies to both modes unless a line says otherwise; the differences are collected under **Hosted mode**.

## Conventions

Same-origin `/api`. JSON unless noted. Errors `{detail: string}`. Item IDs, collection IDs and run IDs are server UUID strings. All timestamps UTC ISO8601. Lists use `{items:[], total:0, limit:60, offset:0}`; collections/tags use their named arrays. Unknown fields rejected on mutations. Authenticated web writes require session cookie + `X-CSRF-Token` from `/api/auth/me` or login. Requests use credentials same-origin. Extension uses bearer token, restricted to extension endpoints. Never put tokens into URLs.

**Native clients** send `Authorization: Bearer <token>` instead of a cookie: a full-access device token on a self-hosted instance, a Supabase access token on a hosted one. Every route below that needs the owner accepts either the cookie session + CSRF token or such a bearer token; the extension import routes accept only their own import token. A request that presents a `Bearer` credential is judged by it alone: an invalid one is `401` with `WWW-Authenticate: Bearer` even if a valid cookie accompanies it. Every `Authorization` header on the request is examined, and more than one bearer value is invalid. CSRF and Origin checks apply to cookie authentication only. An `Authorization` header with another scheme (a proxy's Basic auth) is ignored; a proxy that adds its own `Authorization: Bearer` header must strip it before this server. Credentials are read from that header or the session cookie only, never from a URL, body or other header.

**CORS:** no route sends CORS headers except the extension-origin allowance on `/api/extension/*` described below. Native HTTP clients do not need CORS; there is no setting to allow other web origins.

### Auth

- GET `/api/health` -> `{status:'ok', version:'0.1.0'}`.
- GET `/api/discovery` (public) -> `{name:'little-archive', version, api:1, mode:'self-hosted'|'hosted', auth}`. Self-hosted `auth` is `{methods:['password-session','device-token'], device_token_url:'/api/auth/devices'}`; hosted `auth` is `{methods:['supabase-jwt'], supabase_url}`. Nothing else is disclosed.
- GET `/api/auth/me` -> `{authenticated:boolean, csrf_token?:string, version:'0.1.0'}`. With a valid bearer token instead of a cookie: `{authenticated:true, version, auth:'device-token', device:{id,name}}` (self-hosted) or `{authenticated:true, version, auth:'supabase-jwt', user_id}` (hosted). An invalid bearer token gives `{authenticated:false, version}`.
- POST `/api/auth/login` `{password}` -> `{authenticated:true, csrf_token}` + HttpOnly cookie. JSON and same-origin Origin required when supplied. CSRF token not required to login. Strong initial password is set in environment; no unauthenticated setup endpoint.
- POST `/api/auth/logout` -> `{ok:true}`. With a device token it revokes that token.
- POST `/api/auth/devices` `{password, name}` -> `{id, name, token, created_at}`. Exchanges the owner password for a full-access device token (`lad_…`), shown once and stored only as a hash in `devices.sqlite3` beside the library, never in the library database or a backup. No cookie is set. Same protections as login: the shared limit of 10 password attempts per peer per 15 minutes across both routes (`429` + `Retry-After`), and a foreign `Origin` or cross-site fetch is refused. At most 20 devices. Max body 8 KiB.
- GET `/api/auth/devices` -> `{devices:[{id,name,created_at,last_used_at,current:boolean}]}`. `last_used_at` is refreshed at most once a minute.
- DELETE `/api/auth/devices/{id}` -> `{ok:true}`. The offline password reset revokes every device token.
- GET `/api/account` -> `{mode, user_id:null|string, storage:{used_bytes, quota_bytes:null|number}, entitlements:{unlocked:boolean, deep_reads:{period:'YYYY-MM', used, limit:null|number, remaining:null|number}}}`. A self-hosted owner is unlocked with no quota or cap (`null`).

Device tokens never expire on their own; revoke them. A device token and an extension import token are different credentials in different tables: neither is accepted where the other is expected.

### Item

```
{id, platform:'instagram'|'tiktok'|'web', source_account:'default', source_key,
 url, title, creator, caption, summary, notes, content_type:'post'|'video'|'article'|'image'|'link',
 preview_url:null|string, thumbnail_url:null|string, tags:string[],
 collections:[{id,name,kind:'source'|'local',platform}],
 favorite:boolean, status:'inbox'|'to_revisit'|'done'|'archived', needs_review:boolean,
 saved_at:null|string, created_at, updated_at, last_seen_at,
 evidence:[{kind:'caption'|'thumbnail_alt'|'user_text'|'transcript',text:string}],
 ai:null|{suggested_title,summary,topics:string[],content_type,category,suggested_folder,evidence_level:'text-only'|'caption-based'|'transcript-based',evidence_sources:string[],evidence_note,needs_review,provider,model,created_at}}
```

`transcript` evidence is an automatic transcript of the post's audio, not a description of what is shown. `evidence_level`, `evidence_sources` and `evidence_note` are computed by the server from the input that was supplied, never from the model's answer, and say what a suggestion rests on (the pictures and video are never claimed to have been seen). `category` is one of the fixed taxonomy (Food & Recipes, Travel & Places, Health & Fitness, Style & Beauty, Home & DIY, Tech & Tools, Learning & Ideas, Business & Money, Art & Design, Music & Film, Humor & Memes, News & Culture, Family & Pets, Other). `suggested_folder` is one of the owner's local collections or a category name, empty for "Other". Items stored before these fields existed keep their older `ai` shape.

Responses that return one full item (`GET /api/items/{id}` and every mutation that returns the item) also carry a derived, read-only `enrichment`: `{page:null|{source:'client'|'client_html'|'server_fetch',at,content_type,has_video:boolean,duration_seconds}, transcript:null|{source:'client'|'groq'|'cache'|'imported',language,seconds,chars}, transcript_needed:boolean, transcript_reason:'thin_caption'|'caption_sufficient'|'has_transcript'|'not_video', deep_read:{available:boolean,reason:''|'transcription_not_configured'|'page_fetch_disabled'|'already_has_transcript'|'in_progress',state:''|'queued'|'running'|'failed',error:string}}`. List responses and exports do not include it.

- GET `/api/items?q=&platform=&collection_id=&tag=&status=&favorite=true&needs_review=true&sort=recent|oldest|title|random&limit=60&offset=0`. q is keyword search, not semantic natural-language search. Empty filters omitted. All filters intersect. Default hides archived items; `status=archived` shows them. `sort=random` supports Rediscover. Return list shape above. q also searches transcripts and accepted summaries; when q is non-empty every returned item carries `match_in:string[]`, the fields where the words were found, from `title|caption|alt_text|transcript|summary|notes|tags|creator`. `match_in` describes the returned page and never changes which items match.
- GET `/api/items/{id}` -> full item.
- POST `/api/items` -> full item. Input `{url,title?,creator?,caption?,summary?,notes?,tags?:string[],collection_ids?:string[],preview_url?}`. Any HTTP(S) public URL may be saved as a web link; creating an item only stores the URL and never fetches it. Reading the page is a separate, explicit call (see Understanding). Platform is derived from canonical URL. No remote metadata promises.
- PATCH `/api/items/{id}` -> full item. Allowed `{title,notes,summary,tags,favorite,status,needs_review,collection_ids}`; `collection_ids` edits local memberships only, existing source memberships preserved. Omitted fields unchanged.
- DELETE `/api/items/{id}` -> `{ok:true}`. Deletes local record only, never source save. UI confirms.
- POST `/api/items/{id}/thumbnail` raw PNG/JPEG/WebP bytes, max 8 MiB, valid raster decoded/re-encoded. Returns full item.
- DELETE `/api/items/{id}/thumbnail` -> full item.
- POST `/api/items/bulk` `{ids?:string[], filters?:{q?,platform?,collection_id?,tag?,status?,favorite?,needs_review?}, action:'favorite'|'unfavorite'|'archive'|'restore'|'tag'|'collection', value?:string}` -> `{updated:number}`. Supply exactly one of `ids` (max 200) or `filters` (all matching records, regardless of loaded gallery pages). Empty filters target the non-archived library. The operation is atomic; `restore` sets inbox, and `collection` requires a local collection ID while preserving source memberships.

### Collections, tags, stats

- GET `/api/collections` -> `{collections:[{id,name,kind,platform,source_account,color,count}]}`.
- POST `/api/collections` `{name,color?}` -> collection (kind local).
- PATCH `/api/collections/{id}` `{name?,color?}` -> collection. Local only.
- DELETE `/api/collections/{id}` -> `{ok:true}`. Local only; items remain.
- GET `/api/tags` -> `{tags:[{name,count}]}`.
- GET `/api/stats` -> `{total,favorites,to_revisit,needs_review,archived,collections,platforms:{instagram,tiktok,web}}`.

### Imports and export

- POST `/api/imports/file?filename=...` raw file bytes, max 16 MiB. JSON, CSV, Netscape bookmarks HTML, selected ZIP JSON/CSV/TXT content. Normalized parser contract below. Returns `{run_id,created,updated,skipped,errors:string[],coverage:'partial'|'enumeration_exhausted'}`.
- GET `/api/imports` -> `{imports:[{id,source,source_account,status,coverage,created,updated,skipped,error,started_at,finished_at,scopes:[]}]}`.
- GET `/api/export?format=json|csv|html` -> download attachment. JSON is portable versioned `{format:'little-archive',version:1,exported_at,items:[...],collections:[...]}` and round-trippable with source/local collections, notes, tags, favorites, progress. Boolean `manual_title` and `manual_summary` preserve edit intent, including a deliberately blank summary; older exports retain fallback inference. Extension credentials/session hashes excluded. CSV documented flattened memberships. HTML Netscape bookmarks.
- GET `/api/backup` -> ZIP containing consistent sqlite snapshot, referenced local assets and manifest. Excludes authentication records/secrets. Endpoint requires authenticated session. Backup restore supported via offline CLI `python -m server.cli restore FILE` with separate destination/stopped server, not a dangerous public endpoint.
- POST `/api/demo` -> `{created:number}`. Explicitly adds synthetic demo items to authenticated instance; duplicate safe. No demo content preloaded in real instances.

### Extension

Self-hosted only; every route in this section answers `404` in hosted mode. "web session" below also means a device token.

- POST `/api/extension/tokens` web session+CSRF, `{name}` -> `{id,name,token}`. Token shown once. Import-only scope.
- GET `/api/extension/tokens` web session -> `{tokens:[{id,name,created_at,last_used_at}]}`.
- DELETE `/api/extension/tokens/{id}` web session+CSRF -> `{ok:true}`.
- GET `/api/extension/status` bearer -> `{ok:true,version:'0.1.0',instance_id:string,extension_protocol:{name:'little-archive.extension',versions:{'1':{capabilities:['current_view_imports','idempotent_batches','exact_batch_finish','source_collection_memberships','partial_coverage'],limits:{max_batch_items:50,max_batch_bytes:262144}}}}}`. `version` is the application release; the separate protocol declaration determines import compatibility.
- POST `/api/extension/imports` bearer `{platform:'instagram'|'tiktok',source_account:string,scope:string}` -> `{run_id,instance_id,protocol_version:1}`.
- POST `/api/extension/imports/{run_id}/batches` bearer `{batch_id:string,sequence:int,items:[Observation]}` -> `{status:'applied',created,updated,skipped,replayed:boolean}`. Max 50 items, 256 KiB. Account/platform inherited from run and validated. Unique batch ID and run+sequence plus SHA256 normalized payload enforce idempotency/conflict. Idempotent replay after finish accepted, new batches after finish rejected.
- POST `/api/extension/imports/{run_id}/finish` bearer `{expected_batches:int,coverage:'partial'|'enumeration_exhausted',reason?:string}` -> `{ok:true,created,updated,skipped,coverage}`. Require exactly the committed sequence set `0..expected_batches-1`. Every zero-batch scan stays partial, including a source-reported empty view; no automatic deletions.

**Import protocol 1:** new clients discover `/status` before pairing, starting, resuming, sending each batch, and finishing. They select version `1`, require the five listed capabilities and limits of at least 50 items/262144 bytes, then send `X-Little-Archive-Protocol: 1` on the three import POST endpoints. The server accepts only an absent header (historical version 1) or exactly one header value `1`; other explicit values receive HTTP 409 before import data changes. The protocol header is allowed in the existing extension-origin CORS preflight only; CORS never grants credentialed access.

**Backwards policy:** the current extension recognizes the original status shape only when `extension_protocol` is absent and `version` is exactly `0.1.0`. It displays a legacy compatibility notice and sends historical headerless payloads. A present but malformed declaration never enters this fallback. Other missing/unsupported declarations, missing required capabilities, or reduced limits stop uploads with update guidance. Older extensions remain supported by the server's headerless version 1 path. This is a narrow, tested compatibility policy, not a promise that arbitrary application releases are interchangeable.

The handshake does not change JSON batch bodies, IDs, sequences, or normalized-payload digests. New browser run checkpoints record `protocolVersion:1`; original checkpoints without this field are recognized as historical version 1 without rewriting their queued bodies. Unsupported checkpoint formats/versions are retained and rejected. A compatibility failure keeps the outbox for an explicit retry after compatible software is restored; it never silently re-batches or discards observations. Instance identity, source scope and token binding remain enforced. See [extension protocol and upgrade behavior](docs/extension-protocol.md) for the complete compatibility matrix and verification boundaries.

Observation = `{url,title?:string,creator?:string,caption?:string,thumbnail_alt?:string,preview_url?:string,content_type?:string,saved_at?:string,collections?:[{source_key:string,name:string}]}`. No platform cookies, tokens, raw page HTML, or private API access. DOM text only; account must be explicitly bound before import. Remote previews optional and display client-side only when user enables them.

Extension popup: server URL + import token setup, open-app link, selected account and exact collection name input, start current saved/favorites/collection view, stop, resume, progress and queued count. Persistent bounded outbox storage.local TRUSTED_CONTEXTS, no sync. User-triggered current-scope collection scanner with incremental scroll, seen IDs, guardrails and honest coverage. Scoped host permissions requested at use time. Do not promise automatic discovery of every collection if not implemented.

### Understanding (page details, transcripts, deep reads)

All owner session plus CSRF on writes, or a bearer credential as described under Conventions. Design, limits and privacy in `docs/understanding.md`. Errors `{detail}` with 404 (no such item), 409 (not enabled or not possible), 413 (HTML too large), 422 (nothing usable, wrong post, invalid input), 502 (the page or a provider could not be reached; messages never include internal addresses, response bodies or keys).

- POST `/api/items/{id}/page` -> full item. Exactly one of `{extraction:{title?,creator?,creator_url?,caption?,thumbnail_url?,video_url?,canonical_url?,content_type?,published_at?,duration_seconds?,language?,site_name?}}` (details the client extracted), `{html:string, oembed?:object}` (raw page up to 2 MB, optionally the oEmbed JSON the client fetched; the server parses it) or `{fetch:true}` (the server reads the public page itself; 409 unless the operator enabled `LA_FETCH_ENABLED`). Text is cleaned and bounded; a client extraction whose `canonical_url` names another post is refused. Empty fields on the item are filled, nothing the owner wrote or imported is replaced, a login wall or a page for a different post changes nothing and returns 422. Creating an item and importing never call this.
- POST `/api/items/{id}/transcript` `{text,language?,seconds?,source?:'on_device'|'client'}` -> full item. Stores the text as `transcript` evidence (max 20,000 characters, replaces any earlier transcript) and indexes it for `q`. DELETE `/api/items/{id}/transcript` -> full item.
- POST `/api/items/{id}/deep-read` -> `{queued:1}`. The explicit "Read this more closely": queues a job that finds the post's media on its public page, transcribes it in memory (the media is never stored) and then analyses the save from the transcript. 409 with the reason when `enrichment.deep_read.available` is false. The job appears in `/api/ai/jobs`; the result is an ordinary suggestion to accept or dismiss.
- GET `/api/enrichment/status` -> `{page:{client_extraction,client_html,server_fetch,html_max_bytes},analysis:{provider,model,hosted,batch_size,evidence_mode:'full'|'public'|null},transcription:{provider,auto,client_transcripts,max_audio_minutes},deep_read:{available},shared_cache:{enabled}}`. Booleans and names only: no keys, URLs or paths.
- GET `/api/enrichment/usage?since=` -> `{model_calls,input_tokens,output_tokens,audio_seconds,bytes_fetched,page_reads,page_fetches,transcriptions,deep_reads,cache_hits,by_provider:[{provider,model,kind,events,model_calls,audio_seconds}],since}`. Local counters of what each tier used, for metering; nothing is limited or billed.

### Settings and AI

- GET `/api/settings` -> `{remote_previews:boolean,ai_enabled:boolean,ai_model:string,ai_available:boolean,ai_provider:''|'ollama'|'gemini',ai_hosted:boolean,page_fetch_enabled:boolean,transcription_available:boolean,shared_cache_enabled:boolean}`. `ai_enabled` is true for any configured provider; `ai_hosted` is true when post text is sent to a third-party service. Provider, URL and keys are configured server-side by env, never from untrusted post data.
- PATCH `/api/settings` `{remote_previews?:boolean}` -> settings. Explicit warning that remote previews contact original media hosts. API keys not in client responses.
- POST `/api/ai/jobs` accepts exactly one of `{ids:string[]}` (max 200 selected IDs) or `{filters:{q?,platform?,collection_id?,tag?,status?,favorite?,needs_review?}}`. Empty filters select the entire non-archived library; filters have the same semantics as `GET /api/items`. Returns `{queued,matched,unchanged}`. Matching is independent of gallery pagination; unchanged evidence already queued/running/completed is not charged with another inference. Returns 503 if no AI provider is configured. Jobs run through the configured provider (Ollama, or hosted Gemini); a provider that allows it receives several saves per model call. A video whose caption is too thin may first be transcribed when the operator allows automatic transcription, as part of the same job.
- GET `/api/ai/jobs?limit=50&offset=0` -> `{jobs:[{id,item_id,title,status:'queued'|'running'|'completed'|'failed'|'cancelled',error,created_at,updated_at}],total,counts:{queued,running,completed,failed,cancelled},limit,offset}`. Counts describe the entire durable history, not only the current page. Limit 1–200.
- POST `/api/ai/jobs/cancel` -> `{cancelled}`. Cancels all queued/running jobs. An in-flight model request may finish but its result is discarded.
- POST `/api/ai/jobs/{id}/retry` -> `{queued}`. Retries a failed/cancelled job using the item's current evidence. Returns 409 for other states; unchanged work already queued or completed is not duplicated.
- POST `/api/items/{id}/ai/accept` -> item. Accept suggested summary/title only if not manually changed; merge topics into tags, file the save under `ai.suggested_folder` (an existing local collection, or a new local collection for a fixed category name), needs_review false.
- POST `/api/items/{id}/ai/dismiss` -> item. Store dismissal fingerprint; keep manual fields.

### Hosted mode

Enabled only by `LA_MODE=hosted` with `LA_SUPABASE_URL`; configuration, tenancy, limits and verification boundaries are in [docs/hosted-mode.md](docs/hosted-mode.md).

- **Auth:** every route except `/api/health`, `/api/discovery` and `/api/auth/me` requires `Authorization: Bearer <Supabase access token>`. The server verifies signature (ES256/RS256 via the project's JWKS, or HS256 with the legacy secret when configured), algorithm, `iss`, `aud`, `exp`, `iat`, a UUID `sub`, `role:'authenticated'`, and not `is_anonymous`. Failure is `401` + `WWW-Authenticate: Bearer`; unreachable signing keys are `503` + `Retry-After`. Cookies are never credentials.
- **Library:** chosen only by the verified `sub`. Another account's item, collection, job, run or thumbnail ID behaves as nonexistent (`404`, or `400` where a referenced collection/item is validated).
- **Not available (`404`):** `/api/auth/login`, `/api/auth/logout`, `/api/auth/devices*`, all `/api/extension/*`, and the bundled web UI.
- POST `/api/account/delete` `{confirm:'DELETE'}` -> `{deleted:true}`. Permanently deletes the caller's library, thumbnails and unlock flag. Tokens issued before the deletion are then `401`. This month's deep-read count is kept under a hash until the month ends. Self-hosted: `404`. The Supabase user is not deleted by this route.
- **Storage quota:** `POST`/`PUT`/`PATCH` answer `507` when the library's usage plus the request body would pass the quota, except `/api/account/delete` and `/api/ai/jobs/cancel`. Any write that would grow the library's database past its hard ceiling (the quota plus a margin) is rolled back whole and also answers `507`. Reads, exports, backups and deletes continue.
- **Request size (`413`):** JSON 512 KiB, import file 8 MiB, thumbnail 4 MiB by default; all three configurable.
- **Deep reads:** POST `/api/items/{id}/deep-read` charges one deep read when it queues a closer read. `402` if the account has no allowance and has not unlocked; `429` if the month's cap is used (nothing is queued). Its other answers (`404`, `409`) are unchanged and charge nothing. Ordinary suggestions (`/api/ai/jobs`) are not deep reads and are not metered. No route can set `unlocked`.
- **Understanding:** each account has its own understanding service, usage counters and job queue; `/api/enrichment/usage` reports the caller's own. Provider, fetch and cache settings are the operator's and apply to every account. Automatic transcription is off: a transcript is made only by a closer read or sent by the client. `/page` and `/transcript` bodies are capped at the smaller of 3 MiB and the import limit.
- `410` if the library is deleted while a request is in flight.

### Parser module contract (`server/importers.py`)

`parse_import(data: bytes, filename: str) -> dict` returning `{items: list[dict], warnings:list[str]}`. Items normalize to `{url,title?,creator?,caption?,summary?,notes?,tags?:list[str],favorite?:bool,status?,saved_at?,source_account?,collections?:list[{name,kind:'source'|'local',source_key?:str}],preview_url?,thumbnail_alt?}`. Preserve exact source collection names. Export files import personal annotations; platform archives never overwrite existing user annotations. Include provenance flag `portable:bool` at result level. Strict resource/ZIP bounds; no archive extraction or external requests; reject traversal/symlink/bombs. Unrelated archive sections are ignored. Pure parser tests cover supported shapes and resource limits.

### AI module contract (`server/classifier.py`, `server/enrich/`)

Providers share one interface (`server/enrich/understanding.py`): `identity()`, `max_batch`, and `analyze(batch:list[AnalysisInput]) -> (list[AnalysisOutcome], ProviderUsage)`; implementations `OllamaProvider` and `GeminiProvider`. Evidence text comes from title, creator, caption, alt text, transcript and (only for a local provider, or when the operator opts in) the owner's notes and collection names. Results are validated strictly; `evidence_level`, `evidence_sources` and `evidence_note` are computed from the input. Every tier reports what it used through `Metering.record(...)` (`server/enrich/usage.py`). `classify_item` remains the stable single-item Ollama entry point over the same code:

`classify_item(item:dict, base_url:str, model:str, client=None) -> dict` synchronous httpx call with timeout, no tools, structured JSON schema, think:false, stream:false; validate supported categories/topics/counts/lengths; evidence text from caption, alt, title and user notes, never claim video understanding; result suggested_title,summary,topics,content_type,evidence_level,needs_review,model. Only the configured server URL is used. The server integrates durable jobs and review state.

## UI design

Warm cream #F7F4EF, oat sidebar, sage #6F8A72, blush accent, charcoal text. Distinct own identity: small bookmark/flower monogram SVG, generous rounded cards and native system font. Responsive sidebar/gallery/detail drawer. Light/dark mode, keyboard search, empty/error/loading states, toast feedback, accessible forms/dialogs. Page is useful and beautiful with synthetic demo content. No external CDN/fonts/scripts. Use textContent for untrusted data; no raw source HTML insertion. All visible actions must work against API; avoid nonfunctional buttons.

## Public release boundaries

The release target is a verified stable 1.0. Internal metadata remains 0.1.0 while the required acceptance gates are being completed; no stable release has been published. See `docs/release-gates.md` and `docs/verification.md` for evidence tied to each candidate. Browser adapters require live validation for their supported layouts; imports preserve one explicitly selected view and its collection name at a time. Do not claim universal automatic synchronization. The public repository contains the MIT-licensed source, installation and recovery guides, synthetic screenshots, architecture, privacy/security documentation, contribution guidance, changelog, and conditional launch copy. It contains no private saved-post records.
