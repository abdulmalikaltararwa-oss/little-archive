# Understanding saves

A bare link tells you little. The understanding layer turns a save into something with a real title, a short summary, topics, a suggested folder and, where it helps, a searchable transcript. It is built in tiers, cheapest first, and every tier past the first is optional.

Nothing in this layer runs unless you or your server's operator asks for it, and a save is only changed by what you accept. Everything it adds is labelled with what it was based on. A text model never watches a video: when it reads a caption it says so, and when it reads a transcript of the audio it says that, and that it still did not see the pictures.

| Tier | What it does | Needs |
| --- | --- | --- |
| 1. Read the public page | Reads the same page details a visitor's browser receives: creator, caption, title, cover, canonical link, type. | Nothing, when your device sends the page. |
| 2. Where the page comes from | Your device sends it, or (opt-in) the server fetches it. | `LA_FETCH_ENABLED` for server fetching only. |
| 3. Keep a copy | Stores the caption text and a re-encoded local cover. The original URL stays on the save. | Nothing extra. |
| 4. Understand from text | Title, summary, topics, type and a folder, from the text that exists. | Ollama, or the hosted Gemini provider. |
| 5. Transcribe only when needed | A transcript from your device, or from the server when a caption is too thin or you ask. | `LA_GROQ_API_KEY` and `LA_FETCH_ENABLED` for server transcription. |
| 6. Shared cache | One analysis per public post for everyone. | `LA_PUBLIC_CACHE`. |

## Tier 1: reading the public page

`server/enrich/extract.py` is a set of pure functions: HTML (or an oEmbed JSON object) in, one normalised dictionary out. It does no network or database work, so every extractor is tested from synthetic fixtures in `tests/fixtures/pages/`. It reads Open Graph and Twitter-card meta tags, JSON-LD, schema.org `itemprop` meta tags, `<title>`, and the open oEmbed endpoints of YouTube and TikTok. It does not read a page's embedded application state, and it does not use Instagram's oEmbed endpoint, which now needs an app token.

The result has: `title`, `creator`, `creator_url`, `caption`, `thumbnail_url`, `video_url` (only a real media file, never an embed page), `canonical_url`, `content_type`, `published_at`, `duration_seconds`, `language`, `site_name`, which sources contributed, and whether it was `usable`. A login wall, a bot-check page, or a page whose canonical link names a different post is reported as unusable and attaches nothing.

All text is untrusted. Control characters and bidirectional overrides are removed, lengths are bounded, URLs must be http(s) without credentials, markup stays text, and malformed or hostile input cannot raise.

### What the public pages returned when they were probed

Ten polite page requests (plus one redirect hop) with a descriptive User-Agent, no cookies and no sign-in, were made on 14 Nov 2026 from a single developer machine, to learn the shapes. These are observations about that moment and that vantage point, not promises about any platform. A data-centre address may be treated differently.

- **YouTube** (watch page and oEmbed): both answered. oEmbed gave title, channel name and link, and a 480x360 thumbnail. The page (about 1.4 MB) carried Open Graph and Twitter tags, a duration and upload date as `itemprop` meta tags, a JSON-LD `VideoObject` with few fields, and a canonical link. Its `og:video` URL is an embed page, not a media file, so the server cannot get audio from YouTube.
- **TikTok**: oEmbed answered with JSON containing only an embed id and a player iframe. It had no title, author or thumbnail. The page (about 430 KB) had no Open Graph tags and no JSON-LD; its content sits in page script state, which is deliberately not read. Today, TikTok details have to come from your device.
- **Instagram**: the post page answered 200 without a login for a public post and carried Open Graph tags in the form `<caption> - @handle on <date>`, an `og:image`, an `og:video` media URL, a canonical link, and `robots: noarchive, noimageindex`. Its `<title>` was just "Instagram". The oEmbed endpoint redirected to an HTML sign-in page rather than JSON.
- **A generic web page** (an encyclopedia article): Open Graph title and image only, plus a JSON-LD `Article` without a description. The page body is not read, so such a save keeps a title and cover but has no description.

Older Instagram and TikTok description shapes are also parsed because earlier captures and cached pages use them. Those shapes are covered by synthetic fixtures; they were not observed in the probes.

## Tier 2: where the page content arrives

`POST /api/items/{id}/page` takes exactly one of:

- `extraction`: details your device already extracted (the phone app fetches the page on the device, because Instagram often blocks data-centre addresses). The server cleans them again and checks that they name the same post as the save.
- `html` (optionally with `oembed`): raw HTML your device fetched, up to 2 MB. Sending only the document head is enough. The server parses it.
- `fetch: true`: the server reads the page itself. **Off by default.** Without `LA_FETCH_ENABLED=true` this returns 409 and the server never contacts the page.

Saving a link with `POST /api/items` still only stores the URL.

### The opt-in server fetcher

`server/enrich/netfetch.py` is used only when enabled, and only for these reads: the page, a YouTube/TikTok oEmbed answer, the cover image, and the media file of a deep read. For every request and every redirect hop:

- http and https only, ports 80 and 443 only, no credentials in the URL;
- the host name is resolved by the server, and **every** returned address must be public. Loopback, private, link-local, shared-address, reserved, multicast and documentation ranges are refused, as are cloud metadata addresses and IPv6 forms that embed an IPv4 address (IPv4-mapped, NAT64, 6to4, Teredo). A name that resolves to a mix of public and private addresses is refused;
- numeric host tricks (`2130706433`, `0x7f.1`, `127.1`) and single-label or local-by-convention names (`localhost`, `.local`, `.internal`) are refused;
- the connection is then made to the validated address, sending the original name as `Host` and as the TLS server name. A second DNS answer cannot move it (rebinding);
- at most 4 redirects by default, no https-to-http downgrade, a total time budget, a size limit (2 MiB for pages), and a content-type allowlist per call;
- no cookies are sent or kept, environment proxy settings are ignored, and the User-Agent states what it is: `LittleArchive/<version> (self-hosted link reader; reads public page details for its owner)`, with your contact address appended if you set `LA_FETCH_CONTACT`.

It does not rotate proxies, spoof a crawler or browser, solve challenges, or sign in. A site that refuses the request produces an error. It does not read `robots.txt`: a read is a link preview for one owner, started by that owner, not crawling. If that does not suit your deployment, leave fetching off. Instagram's pages carry a `noarchive` robots tag, which is guidance for search engines.

Tests use an injected resolver and transport (no network). The refusal rules were also checked with the real resolver, and one real request to a public site confirmed that pinned-address connections still verify the certificate against the host name.

## Tier 3: keeping a copy

When a page is read, empty fields on the save are filled and nothing you wrote is replaced:

- **Caption**: kept as the caption and as source-text evidence, only if the save had none.
- **Creator, content type, preview link**: filled when empty or generic.
- **Title**: replaced only while it is the placeholder ("Saved Instagram post") and you have not set your own. If the page has no title, the start of the caption is used.
- **Cover**: with server fetching on, the cover is downloaded, decoded, bounded to 1600 px and re-encoded as PNG by the same validation as a manual upload, then stored locally. What is stored is never the downloaded bytes. Without server fetching, your device can still upload a cover with the existing thumbnail route.
- **Video**: never stored. A video fetched for transcription lives in memory while it is sent to the transcription provider and is then dropped.

The original URL stays on the save as the link back to the source.

## Tier 4: understanding from text

`server/enrich/understanding.py` defines one provider interface with two implementations: `OllamaProvider` (your own server, as before) and `GeminiProvider` (Google's Gemini over its HTTP API). `server/classifier.py` keeps its original `classify_item` entry point and now calls the same code.

Each result has a title (up to 100 characters asked for), a one-to-two sentence summary, up to eight topics, a content type, a **category** from this fixed list, and a **suggested folder**:

Food & Recipes, Travel & Places, Health & Fitness, Style & Beauty, Home & DIY, Tech & Tools, Learning & Ideas, Business & Money, Art & Design, Music & Film, Humor & Memes, News & Culture, Family & Pets, Other.

The suggested folder is a collection you already have if one matches, otherwise the category name (nothing for "Other"). Accepting a suggestion files the save there and creates the collection if it is a fixed category you do not have yet. Dismissing files nothing. The review flow is unchanged: suggestions wait for you, stale ones are refused, and a manual title or summary is never overwritten.

### What the model is sent

- **Local provider (Ollama), shared cache off:** the post's text plus your notes and your collection names, as it has always been. The model may name one of your collections as the folder.
- **Hosted provider (Gemini), or the shared cache on:** only text that comes from the post: title (unless you wrote it), creator, caption, image alt text, and any transcript. Not your notes, not your own text, not your collection names. The folder is then matched to your collections on your server, by name. Set `LA_AI_SHARE_PRIVATE_CONTEXT=true` to give a hosted provider the full context anyway (the shared cache still forces the public-only form).

### Evidence labels

The label stored with every suggestion is computed from what was supplied, never from what the model says:

- `text-only`: title or your own text only.
- `caption-based`: a caption (or a page description) was available.
- `transcript-based`: a transcript of the audio was available.

`evidence_sources` lists the inputs and `evidence_note` says it in a sentence, for example "Based on the caption and a transcript of the audio. The audio was transcribed, but the pictures and video themselves were not seen." The prompt also forbids claiming to have watched anything.

### Batching and cost

With a provider that allows it (Gemini, default 8 per call, `LA_AI_BATCH_SIZE`), queued saves go to the model several to a call, and one bad answer is retried on its own. Ollama takes one save per request. With the shared cache on, saves with identical public text in the same run are analysed once.

## Tier 5: transcripts

A transcript is evidence of a new kind, `transcript`. It can come from:

1. **Your device**: `POST /api/items/{id}/transcript`. Free for you and not dependent on the server.
2. **The server, when a transcript is needed**: a video whose caption and title together carry fewer than 40 letters or digits (links, hashtags, mentions and emoji do not count) and that has no transcript. This only runs inside an analysis you asked for, and only with a transcription key and server fetching on. `LA_TRANSCRIBE_AUTO=false` turns it off. If it fails it falls back to the text that exists, records why, and does not retry by itself.
3. **A deep read you ask for**: "Read this more closely" in the detail panel, or `POST /api/items/{id}/deep-read`. Available when transcription is configured, server fetching is on and the save has no transcript.

The server finds a media URL on the page (Instagram's page exposed one when probed), downloads it within `LA_TRANSCRIBE_MAX_MB`, sends it to Groq's Whisper endpoint, keeps the text and drops the audio. YouTube pages expose no media file, and TikTok's public page exposed nothing on 14 Nov 2026, so those saves need a transcript from your device. A transcript is capped at 20,000 characters. Transcripts survive source refreshes and portable export and import.

## Shared cache

Optional (`LA_PUBLIC_CACHE=true`), meant for a deployment where many people save the same public posts. It is a separate SQLite file (default `<data dir>/cache/public-posts.sqlite3`, or `LA_PUBLIC_CACHE_PATH` on shared storage), never part of a library or its backups.

- **Keyed by the canonical post URL**, and an analysis entry also by a hash of the exact public text that was analysed plus the provider, model and prompt version. Someone else is only served a result for text identical to their own, so a made-up caption cannot change what another person sees.
- **Only public-derived fields.** Each kind of entry has an allowlist (`server/enrich/cache.py`); notes, tags, collections, favourites, status, accounts and the suggested folder cannot be stored, and the analysis it reads is made from public text only.
- **Only the server's own reads** are cached as page details and transcripts. Something your device supplied is not.
- Entries expire after `LA_PUBLIC_CACHE_TTL_DAYS` (30).

Why this is safe for private data: nothing in a cache entry came from a person's private notes or organization, and nothing in it says who saved the post. The residual risk is that someone with access to the cache file can see which public posts were analysed; protect the file like the library.

## Search

Keyword search (`q=`) already indexed captions, summaries, notes and tags. Transcripts are indexed the moment they are stored. When `q` is used, each returned save also has `match_in`, the fields where the words were found (`title`, `caption`, `alt_text`, `transcript`, `summary`, `notes`, `tags`, `creator`). It describes the page of results you are looking at and never changes which saves match. An unaccepted suggestion is not searched.

## Usage hook

Every tier reports what it used through `server/enrich/usage.py`: model calls, input and output tokens, audio seconds, bytes fetched, and cache hits, per event, with `deep_read` set when the user asked for it. A local ledger (table `enrich_usage`) counts them and `GET /api/enrichment/usage` returns the totals. A hosted deployment attaches its own sink with `service.meter.add_sink(sink)`; a failing sink never breaks a save or a job. Nothing here limits, blocks or bills anything.

## Settings

All are environment variables (or `.env`). Everything is off or conservative unless set. Keys are read only from the environment, are never part of any response, and never appear in a URL.

| Variable | Default | Meaning |
| --- | --- | --- |
| `LA_AI_PROVIDER` | `ollama` if `LA_OLLAMA_URL` is set, else none | `ollama`, `gemini` or `none`. A hosted key never activates by itself: `LA_GEMINI_API_KEY` without `LA_AI_PROVIDER=gemini` is a startup error. |
| `LA_GEMINI_API_KEY` | none | Google Gemini API key. |
| `LA_GEMINI_MODEL` | `gemini-3.5-flash-lite` | Model id. The default is taken from Google's published model list on 14 Nov 2026; set your own if it changes. |
| `LA_AI_BATCH_SIZE` | 8 | Saves per Gemini call, 1 to 20. Ollama always uses 1. |
| `LA_AI_SHARE_PRIVATE_CONTEXT` | false | Let a hosted provider also receive notes and collection names. |
| `LA_FETCH_ENABLED` | false | Allow the server to read public pages, covers and media itself. |
| `LA_FETCH_TIMEOUT_SECONDS` | 10 | Per-request read timeout (2 to 60). The total budget is twice this, at least 20 s. |
| `LA_FETCH_MAX_BYTES` | 2097152 | Page size limit (64 KiB to 8 MiB). |
| `LA_FETCH_MAX_REDIRECTS` | 4 | 0 to 8. |
| `LA_FETCH_CONTACT` | none | Contact URL or address appended to the User-Agent. |
| `LA_GROQ_API_KEY` | none | Enables server transcription through Groq. |
| `LA_GROQ_MODEL` | `whisper-large-v3-turbo` | Speech-to-text model. |
| `LA_TRANSCRIBE_AUTO` | true | Allow the thin-caption rule to transcribe inside an analysis you started. |
| `LA_TRANSCRIBE_MAX_MB` | 24 | Largest media file sent for transcription (1 to 100). |
| `LA_TRANSCRIBE_MAX_MINUTES` | 15 | Longest video transcribed, when the page states a duration (1 to 120). |
| `LA_PUBLIC_CACHE` | false | Turn on the shared cache. |
| `LA_PUBLIC_CACHE_PATH` | `<data dir>/cache/public-posts.sqlite3` | Absolute path, for shared storage. |
| `LA_PUBLIC_CACHE_TTL_DAYS` | 30 | 1 to 365. |

## Limits

| Limit | Value |
| --- | --- |
| HTML accepted from a client | 2 MB (send only the head) |
| oEmbed object from a client | 64 KiB |
| Page size read by the server | `LA_FETCH_MAX_BYTES`, default 2 MiB |
| Cover image | 8 MiB, 20 megapixels, re-encoded to at most 1600 px |
| Media for transcription | `LA_TRANSCRIBE_MAX_MB`, default 24 MB |
| Transcript length | 20,000 characters |
| Text per save sent to a model | about 14,000 characters (6,000 when batching) |
| Redirects, ports | 4 by default, 80 and 443 only |

## What was and was not verified

Verified by automated tests with no network: every extractor against fixtures, including hostile input; the fetcher's refusal rules with injected DNS and HTTP, including redirects to private addresses and rebinding-style answers; both providers against fake HTTP servers; batching, retries, metering, the thin-caption rule, the cache's isolation, search locations, the review flow, restart and cancellation behaviour, backup and restore with and without the new tables.

Verified by hand: the page shapes above (ten page requests on 14 Nov 2026); the fetcher's pinned-address TLS path and its refusals with the real resolver against one public site; the detail panel in a browser against a local instance with fake providers.

**Not verified:** the Gemini and Groq request shapes follow their published references (read on 14 Nov 2026) but were not exercised against the live services, because no keys were used. The default Gemini model id is not confirmed to be available to every account. Server-side audio fetching from Instagram's media host was not attempted live. How well any model titles, tags or files real saves has not been measured.

## For a hosted or multi-user deployment

The layer keeps its seams small so another part of the system can own users and billing:

- `build_enrichment(store, config)` builds everything for one library. Call it once per user's store.
- The shared cache is deliberately not per library. Point `LA_PUBLIC_CACHE_PATH` at storage all workers share.
- Usage events are the metering input; attach a sink instead of changing the pipeline.
- `UnderstandingWorker` extends `ClassificationWorker`, so queueing, cancelling and retrying come from the base class. It reads only its store and service.
- The schema is additive (`server/enrich/schema.py`) and idempotent; restore accepts a backup with or without it.
