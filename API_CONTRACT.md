# Little Archive v0.1 API contract

Independent self-hosted saved-content library. Single owner per instance, multiple source accounts. Backend Python 3.12+, FastAPI, sqlite3; frontend buildless ES modules, HTML/CSS; Chrome MV3 extension. No other product names or personal information in source, docs, fixtures, images, or launch copy.

## Conventions

Same-origin `/api`. JSON unless noted. Errors `{detail: string}`. Item IDs, collection IDs and run IDs are server UUID strings. All timestamps UTC ISO8601. Lists use `{items:[], total:0, limit:60, offset:0}`; collections/tags use their named arrays. Unknown fields rejected on mutations. Authenticated web writes require session cookie + `X-CSRF-Token` from `/api/auth/me` or login. Requests use credentials same-origin. Extension uses bearer token, restricted to extension endpoints. Never put tokens into URLs.

### Auth

- GET `/api/health` -> `{status:'ok', version:'0.1.0'}`.
- GET `/api/auth/me` -> `{authenticated:boolean, csrf_token?:string, version:'0.1.0'}`.
- POST `/api/auth/login` `{password}` -> `{authenticated:true, csrf_token}` + HttpOnly cookie. JSON and same-origin Origin required when supplied. CSRF token not required to login. Strong initial password is set in environment; no unauthenticated setup endpoint.
- POST `/api/auth/logout` -> `{ok:true}`.

### Item

```
{id, platform:'instagram'|'tiktok'|'web', source_account:'default', source_key,
 url, title, creator, caption, summary, notes, content_type:'post'|'video'|'article'|'image'|'link',
 preview_url:null|string, thumbnail_url:null|string, tags:string[],
 collections:[{id,name,kind:'source'|'local',platform}],
 favorite:boolean, status:'inbox'|'to_revisit'|'done'|'archived', needs_review:boolean,
 saved_at:null|string, created_at, updated_at, last_seen_at,
 evidence:[{kind:'caption'|'thumbnail_alt'|'user_text',text:string}],
 ai:null|{suggested_title,summary,topics:string[],content_type,evidence_level,needs_review,model,created_at}}
```

- GET `/api/items?q=&platform=&collection_id=&tag=&status=&favorite=true&needs_review=true&sort=recent|oldest|title|random&limit=60&offset=0`. q is keyword search, not semantic natural-language search. Empty filters omitted. All filters intersect. Default hides archived items; `status=archived` shows them. `sort=random` supports Rediscover. Return list shape above.
- GET `/api/items/{id}` -> full item.
- POST `/api/items` -> full item. Input `{url,title?,creator?,caption?,summary?,notes?,tags?:string[],collection_ids?:string[],preview_url?}`. Any HTTP(S) public URL may be saved as a web link; only URLs are stored, no server fetching. Platform is derived from canonical URL. No remote metadata promises.
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
- GET `/api/export?format=json|csv|html` -> download attachment. JSON is portable versioned `{format:'little-archive',version:1,exported_at,items:[...],collections:[...]}` and round-trippable with source/local collections, notes, tags, favorites, progress. Extension credentials/session hashes excluded. CSV documented flattened memberships. HTML Netscape bookmarks.
- GET `/api/backup` -> ZIP containing consistent sqlite snapshot, referenced local assets and manifest. Excludes authentication records/secrets. Endpoint requires authenticated session. Backup restore supported via offline CLI `python -m server.cli restore FILE` with separate destination/stopped server, not a dangerous public endpoint.
- POST `/api/demo` -> `{created:number}`. Explicitly adds synthetic demo items to authenticated instance; duplicate safe. No demo content preloaded in real instances.

### Extension

- POST `/api/extension/tokens` web session+CSRF, `{name}` -> `{id,name,token}`. Token shown once. Import-only scope.
- GET `/api/extension/tokens` web session -> `{tokens:[{id,name,created_at,last_used_at}]}`.
- DELETE `/api/extension/tokens/{id}` web session+CSRF -> `{ok:true}`.
- GET `/api/extension/status` bearer -> `{ok:true,version:'0.1.0',instance_id:string}`.
- POST `/api/extension/imports` bearer `{platform:'instagram'|'tiktok',source_account:string,scope:string}` -> `{run_id,instance_id}`.
- POST `/api/extension/imports/{run_id}/batches` bearer `{batch_id:string,sequence:int,items:[Observation]}` -> `{status:'applied',created,updated,skipped,replayed:boolean}`. Max 50 items, 256 KiB. Account/platform inherited from run and validated. Unique batch ID and run+sequence plus SHA256 normalized payload enforce idempotency/conflict. Idempotent replay after finish accepted, new batches after finish rejected.
- POST `/api/extension/imports/{run_id}/finish` bearer `{expected_batches:int,coverage:'partial'|'enumeration_exhausted',reason?:string}` -> `{ok:true,...counts}`. Reject gaps. Empty scan stays partial unless positively observed empty state; no automatic deletions.

Observation = `{url,title?:string,creator?:string,caption?:string,thumbnail_alt?:string,preview_url?:string,content_type?:string,saved_at?:string,collections?:[{source_key:string,name:string}]}`. No platform cookies, tokens, raw page HTML, or private API access. DOM text only; account must be explicitly bound before import. Remote previews optional and display client-side only when user enables them.

Extension popup: server URL + import token setup, open-app link, selected account and exact collection name input, start current saved/favorites/collection view, stop, resume, progress and queued count. Persistent bounded outbox storage.local TRUSTED_CONTEXTS, no sync. User-triggered current-scope collection scanner with incremental scroll, seen IDs, guardrails and honest coverage. Scoped host permissions requested at use time. Do not promise automatic discovery of every collection if not implemented.

### Settings and AI

- GET `/api/settings` -> `{remote_previews:boolean,ai_enabled:boolean,ai_model:string,ai_available:boolean}`. Ollama URL configured server-side by env, never from untrusted post data.
- PATCH `/api/settings` `{remote_previews?:boolean}` -> settings. Explicit warning that remote previews contact original media hosts. API keys not in client responses.
- POST `/api/ai/jobs` accepts exactly one of `{ids:string[]}` (max 200 selected IDs) or `{filters:{q?,platform?,collection_id?,tag?,status?,favorite?,needs_review?}}`. Empty filters select the entire non-archived library; filters have the same semantics as `GET /api/items`. Returns `{queued,matched,unchanged}`. Matching is independent of gallery pagination; unchanged evidence already queued/running/completed is not charged with another inference. Returns 503 if no model is configured.
- GET `/api/ai/jobs?limit=50&offset=0` -> `{jobs:[{id,item_id,title,status:'queued'|'running'|'completed'|'failed'|'cancelled',error,created_at,updated_at}],total,counts:{queued,running,completed,failed,cancelled},limit,offset}`. Counts describe the entire durable history, not only the current page. Limit 1–200.
- POST `/api/ai/jobs/cancel` -> `{cancelled}`. Cancels all queued/running jobs. An in-flight model request may finish but its result is discarded.
- POST `/api/ai/jobs/{id}/retry` -> `{queued}`. Retries a failed/cancelled job using the item's current evidence. Returns 409 for other states; unchanged work already queued or completed is not duplicated.
- POST `/api/items/{id}/ai/accept` -> item. Accept suggested summary/title only if not manually changed; merge topics into tags, needs_review false.
- POST `/api/items/{id}/ai/dismiss` -> item. Store dismissal fingerprint; keep manual fields.

### Parser module contract (agent owns server/importers.py)

`parse_import(data: bytes, filename: str) -> dict` returning `{items: list[dict], warnings:list[str]}`. Items normalize to `{url,title?,creator?,caption?,summary?,notes?,tags?:list[str],favorite?:bool,status?,saved_at?,source_account?,collections?:list[{name,kind:'source'|'local',source_key?:str}],preview_url?,thumbnail_alt?}`. Preserve exact source collection names. Export files import personal annotations; platform archives never overwrite existing user annotations. Include provenance flag `portable:bool` at result level. Strict resource/ZIP bounds; no archive extraction or external requests; reject traversal/symlink/bombs. Unrelated archive sections are ignored. Agent writes pure parser unittest tests.

### AI module contract (same agent owns server/classifier.py)

`classify_item(item:dict, base_url:str, model:str, client=None) -> dict` synchronous httpx call with timeout, no tools, structured JSON schema, think:false, stream:false; validate supported categories/topics/counts/lengths; evidence text from caption, alt, title and user notes, never claim video understanding; result suggested_title,summary,topics,content_type,evidence_level,needs_review,model. Only configured server URL. Root handles durable worker/job integration.

## UI design

Warm cream #F7F4EF, oat sidebar, sage #6F8A72, blush accent, charcoal text. Distinct own identity: small bookmark/flower monogram SVG, generous rounded cards and native system font. Responsive sidebar/gallery/detail drawer. Light/dark mode, keyboard search, empty/error/loading states, toast feedback, accessible forms/dialogs. Page is useful and beautiful with synthetic demo content. No external CDN/fonts/scripts. Use textContent for untrusted data; no raw source HTML insertion. All visible actions must work against API; avoid nonfunctional buttons.

## Public release boundaries

Version 0.1.0 alpha. Core web features fully functional and tested. Browser adapters explicitly experimental until live verified on platform layouts; users import one collection view at a time and preserved names, no marketing claim of universal automatic sync. No bundled private user records or old personal specification. MIT license. README, Docker quickstart, native Python quickstart, screenshots from synthetic demo, architecture, privacy/security, contributing, changelog, roadmap, launch drafts. Public GitHub target owner discovered: abdulmalikaltararwa-oss; proposed repo little-archive, verify availability before creation.
