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
- numeric host tricks (`2130706433`, `0x7f.1`, `127.1`), names that only become addresses once normalised (full-width digits, circled digits, ideographic full stops), scoped addresses (`%`) and single-label or local-by-convention names (`localhost`, `.local`, `.internal`) are refused;
- the connection is then made to the validated address, sending the original name as `Host` and as the TLS server name. A second DNS answer cannot move it (rebinding);
- at most 4 redirects by default, no https-to-http downgrade, a total time budget that also covers every name lookup and connection attempt (each gets what is left), a size limit (2 MiB for pages) that is applied to what is received and again to what is inflated (only gzip and deflate are understood; any other `Content-Encoding` is refused), and a content-type allowlist per call;
- no cookies are sent or kept, environment proxy settings are ignored, and the User-Agent states what it is: `LittleArchive/<version> (self-hosted link reader; reads public page details for its owner)`, with your contact address appended if you set `LA_FETCH_CONTACT`.

It does not rotate proxies, spoof a crawler or browser, solve challenges, or sign in. A site that refuses the request produces an error. It does not read `robots.txt`: a read is a link preview for one owner, started by that owner, not crawling. If that does not suit your deployment, leave fetching off. Instagram's pages carry a `noarchive` robots tag, which is guidance for search engines.

A [hosted service](hosted-mode.md#server-side-requests) lets many accounts steer this fetcher; that deployment was reviewed separately, and the review is recorded there.

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

The server finds a media URL on the page (Instagram's page exposed one when probed), downloads it within `LA_TRANSCRIBE_MAX_MB`, sends it to the configured transcription service (Groq's Whisper endpoint, or Google's Gemini API when `LA_TRANSCRIBE_PROVIDER=gemini`), keeps the text and drops the audio. Whisper is a dedicated speech recogniser; Gemini is a general model asked to write the words as said, and can occasionally tidy or paraphrase them. With Gemini the whole media file, picture included, is sent, and files over 14 MB are refused. YouTube pages expose no media file, and TikTok's public page exposed nothing on 14 Nov 2026, so those saves need a transcript from your device. A transcript is capped at 20,000 characters. Transcripts survive source refreshes and portable export and import.

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

## Recipe cards

A save that is a recipe can have a structured recipe card: title, servings, times, ingredients (quantity, unit, name, note, optional group) and ordered steps (text, optional timer, the ingredients each step uses), with where each part came from. It is meant for a cook mode, where a screen shows one step, its timer and its ingredients. Routes: `GET|PUT /api/items/{id}/recipe`, `DELETE /api/items/{id}/recipe/edits`, `POST /api/items/{id}/recipe/extract`, `GET /api/recipes`. Contract in [API_CONTRACT.md](../API_CONTRACT.md).

**Three ways to a recipe, in order of trust.** `POST .../recipe/extract` with `method: "auto"` takes the first that finds one:

1. **`jsonld`: the page's own schema.org `Recipe` data**, read by plain parsing when a page has been attached (`recipeIngredient`, `recipeInstructions` including sections, `recipeYield`, ISO 8601 times). No model. This is preferred whenever it exists.
2. **`rules`: fixed text rules** over a caption, transcript or note that sets out an "Ingredients" list and a "Method". No model. Only lines that are literally in the text. If the rules find ingredients but no method and a provider is configured, the provider is also asked and its answer is used only if it verifies more content.
3. **`ai`: a provider that selects spans.** The model is asked to *copy* ingredient and step spans out of the text, not to write a recipe. Everything it returns is then checked by code (below).

With no provider and no recipe text the answer is `found: false` with a reason (`ai_not_configured`, `no_text`, `no_recipe_found`). Asking for `method: "ai"` with no provider is a `503` with `code: "ai_not_configured"`. Nothing is ever made up to fill a gap.

**How a model's answer is checked.** Each ingredient and step carries a `quote` that must be found, word for word (ignoring case, accents and punctuation), in a field of the text the model was given; one that is not is dropped and counted (`dropped`). Quantity, unit, name and note are parsed from that quote by code, not taken from the model. A step's timer is computed from the step's own words (`10-12 minutes` gives 600 seconds, the shorter end, so a timer never overcooks) and its ingredient references are computed by matching ingredient names, whatever the model said. A serving count or a time is kept only if the model's quote for it is in the text. The title is the model's only if the text supports it, else the save's own title. A recipe is `is_recipe: true` only if the model said so *and* at least two ingredients were verified; otherwise `is_recipe: false` with a `reason`. `confidence` is `high` for schema.org data and the owner's own text, `medium` for rules or a model with ingredients and steps, `low` otherwise.

**Labels.** Every card has `provenance`: `method`, and for a model `evidence_level` (`caption-based`, `transcript-based`, `text-only`), `evidence_sources`, `evidence_note`, `provider` and `model`, computed from the input and never from the model, like every other suggestion here. Each ingredient and step says which field it came from; `evidence` says where the title, servings, times, ingredients and steps came from.

**Edits win.** `PUT` stores the owner's version beside the last extraction; it is never merged into it. A later extraction (even `force: true`) only replaces the extraction, and the response shows both, so the owner can look at what changed. `DELETE .../edits` goes back to the extraction. The server sets provenance and every computed field on a save, so what a `GET` returned can be sent back after editing. The same rule holds for places.

**Scaling is defined on the server and may be done on the client.** `GET .../recipe?servings=N` (or `?factor=F`) returns the recipe's ingredients scaled, as `scaled`; the stored recipe is never changed. A client that wants an instant slider can apply the same rules locally. The rules:

- One linear factor, `f = target / base`, in exact rational arithmetic (no floating-point drift). A recipe with no stated servings can be scaled by `factor` only (`409 servings_unknown` otherwise). `f` must be between 1/100 and 100.
- A quantity is multiplied by `f`; a range scales both ends.
- The unit may move to a neighbour **in the same dimension and system** when the result reads cleanly: 1000 g to 1 kg and back, 1000 ml to 1 l and back, 3 tsp to 1 tbsp, 4 tbsp to 1/4 cup, 16 oz to 1 lb, and the reverse when the amount falls below one of the larger unit. It **never** converts between metric and US units and never between weight and volume (that needs a density this data does not have).
- The result is rounded to an amount a cook can measure: cups, spoons and pounds to the nearest 1/8, 1/4, 1/3 or 1/2 that fits; grams and millilitres to 1 below 100, 5 above; kilograms and litres to 0.05; counts to a half below ten. `quantity` is the rounded amount, `exact` the exact amount in the same unit, `approximate` says the rounding moved it by more than 3 percent, and a count that is not whole (`4.5 eggs`) carries the warning `fractional_count`.
- An ingredient with no amount ("salt, to taste") is left as written and marked `scaled: false`.
- Times, temperatures and numbers written inside a step's text are **not** scaled, and neither is cooking time; a step's `ingredient_refs` say which scaled ingredients to show beside it. Seasoning, leavening and pan size do not always scale in step with the food, and the response says so.

## Places

A save can have the places it mentions: name, kind (`restaurant`, `cafe`, `bar`, `bakery`, `hotel`, `attraction`, `landmark`, `museum`, `park`, `beach`, `shop`, `market`, `venue`, `neighborhood`, `city`, `region`, `country`, `other`), city, region, country, address, a note, evidence (the field and the words) and optional coordinates. Routes: `GET|PUT /api/items/{id}/places`, `DELETE .../places/edits`, `POST .../places/extract`, `POST .../places/geocode`, and `GET /api/places` for the whole library (for a map).

**Coordinates are never invented.** They have three origins, and each is labelled in `coordinates.source`:

- `source`: the save itself states them. A page's structured data (`geo` on a `Place`, `LocalBusiness`, `Restaurant` and similar), a map link (Google Maps, Apple Maps and OpenStreetMap links that carry them, or a `geo:` URI), or a latitude and longitude written out on the same line as the place (three or more decimals, hemisphere letters honoured). A coordinate on a line of its own is not tied to any place; it is only counted (`unattached_coordinates`). Short links such as `maps.app.goo.gl` carry no coordinates and are not followed.
- `geocoder`: the operator's geocoder returned them, because the operator turned it on and the request asked for it (below).
- `user`: the owner typed them.

A model never supplies a coordinate. A place without coordinates is stored as it is.

**Extraction** takes schema.org places, then pin lines and map links by fixed rules (`📍 Café Central, Herrengasse 14, Vienna`, `Location: ...`), then, if a provider is configured, a model. A model's place must have its name in the text exactly as written, and a city, country or address it offers is kept only if the text states it (`unstated_fields_cleared` counts the rest); the creator's own account is never a place. The rules do not guess a city or country from a comma: they keep a house-numbered remainder as the address and anything else as a note. Edits win exactly as for recipes, and a place keeps its `id` across edits so a client can refer to it.

**Geocoding is opt-in twice.** It is off unless the operator sets `LA_GEOCODER_URL` (a Nominatim-compatible service) **and** `LA_GEOCODER_CONTACT` (an email address or URL the geocoder's operator can reach you at), and even then it runs only when a request asks (`geocode: true` on extract, or `POST .../places/geocode`). With it off, `geocode: true` returns `geocoding.reason: "geocoder_not_configured"` and the places are stored without coordinates; the dedicated route is a `503` with that code. The server follows [Nominatim's usage policy](https://operations.osmfoundation.org/policies/nominatim/): an identifying `User-Agent` carrying the contact; at most one request a second **across the whole process and every account** (the interval defaults to 1.1 s and cannot be set below 1 s); one request at a time; results cached per library (found for `LA_GEOCODER_CACHE_DAYS`, not found for a week), with errors never cached; no autocomplete and no bulk run (at most five places per request); and only the place's own name, address, city and country are sent, never the save, its link or its text. The public openstreetmap.org service is for light personal use; a hosted deployment with many accounts should run its own instance. Results come from OpenStreetMap data and carry an attribution string that a map should show.

**The map list.** `GET /api/places?bbox=minLon,minLat,maxLon,maxLat` returns places with coordinates inside the box (a box whose `minLon` is greater than its `maxLon` crosses the antimeridian), `kind=`, `q=` (name, city, country, address), `with_coordinates=true|false`, `limit`, `offset`, and `format=geojson` for a `FeatureCollection` of points. Archived saves are left out unless `include_archived=true`.

## Ask your archive

`POST /api/ask` answers a question from the owner's own saves and says where each part came from. It needs no embeddings and no vector store.

**Retrieval.** The question becomes content terms (stop words, question words and Arabic and English filler dropped; plurals and the Arabic definite article folded). The existing full-text index is asked for saves matching *any* term, ordered by BM25 with the title weighted 10, tags 5 and body 1 (so a natural question is not an impossible AND, which is what `GET /api/items?q=` does with a whole sentence). The best 60 are then re-ranked: `score = 0.45 coverage + 0.25 phrase + 0.30 position`, where *coverage* is the share of the question's terms the save matches, each weighted by the field that matched (title 1.0, tags 0.85, caption, transcript and summary 0.6, notes 0.5, creator 0.3), *phrase* is the share of adjacent question words that sit next to each other in the save, and *position* is the reciprocal of the BM25 rank. This is why a save that says "lemon" six times but never "pasta" ranks below one that has both. A long question must be matched by more than one stray word. Only short passages around the matched words are kept (at most 3 per save, 500 characters each, 12,000 in all, at most 12 saves); `context` reports what was sent and whether anything was left out.

**Answers.** With a provider, the model is given the question and those passages and must answer only from them, with citations. The answer is shown only if every check passes (below); otherwise the response is the ranked saves with `answered: false` and a `reason`. With **no provider** the response is `mode: "ranked_only"`, `reason: "ai_not_configured"` and the ranked saves, flagged as such. With **nothing retrieved** nothing is asked and the answer is "Nothing saved about that." (`mode: "no_results"`). A provider outage degrades to ranked saves (`reason: "ai_failed"`), never an error. Streaming is not offered. Each answer carries `evidence` (level, sources and a note about what it rests on) computed from the passages used.

**Saved text is untrusted.** A caption, page or transcript is written by someone else and may try to give the model orders. The defences, in order:

1. Nothing in a save is placed where instructions go. The model receives the owner's question and the passages as one JSON object, with throwaway references (`S1`, `S2`) in place of ids and links, so a save cannot name, request or leak another save, and text that imitates the end of the prompt stays inside its own string.
2. A save whose text looks like instructions to a model (ignore or disregard previous instructions, "you are now", system or developer prompt, chat-template markers, requests to reveal or send the library, and Arabic equivalents) is kept out of the model's context altogether and flagged `withheld_from_answer: "contains_instructions"` so the owner can see it. This is a first layer, not a guarantee.
3. The model has no tools and is told the text is data. Only saves that match the question are ever sent; the rest of the library is not in the prompt.
4. Whatever the model returns is validated before anything is shown. Every citation must name a reference that was supplied and quote it word for word from that save's own passages; the answer must share at least 40 percent of its content words with the passages it was given; and it may contain **no link, address, markup or identifier at all**. A save's own link is returned beside the answer (`citations[].url`), so a link never has to come from the model, and one a hostile save puts in the model's mouth is refused. An answer that fails any check is not shown.
5. With a hosted provider, passages come only from the post's own text (never the owner's notes) unless the operator allows more, exactly as for suggestions. A question that matches only the owner's private notes returns `reason: "no_shareable_text"` and nothing is sent.

These defences were tested against stub models that obey any instruction they can see, including one given a save worded to slip past the detector. They have not been tested against real models, which can fail in ways a stub cannot; treat the answer as a convenience and the citations as the evidence.

## Settings

All are environment variables (or `.env`). Everything is off or conservative unless set. Keys are read only from the environment, are never part of any response, and never appear in a URL. An invalid combination stops the server at start with a message naming the setting. `python -m server.cli doctor` checks them before you start, makes no network request, prints no values, and reports which optional features are on.

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
| `LA_TRANSCRIBE_PROVIDER` | `groq` if `LA_GROQ_API_KEY` is set, else none | `groq`, `gemini` or `none`. `gemini` reuses `LA_GEMINI_API_KEY` and sends the media file to Google's Gemini API; it is never chosen automatically. Files over 14 MB are refused with Gemini. |
| `LA_GEMINI_TRANSCRIBE_MODEL` | the value of `LA_GEMINI_MODEL` | Model used when Gemini transcribes. |
| `LA_GROQ_API_KEY` | none | Enables server transcription through Groq. |
| `LA_GROQ_MODEL` | `whisper-large-v3-turbo` | Speech-to-text model. |
| `LA_TRANSCRIBE_AUTO` | true | Allow the thin-caption rule to transcribe inside an analysis you started. |
| `LA_TRANSCRIBE_MAX_MB` | 24 | Largest media file sent for transcription (1 to 100). |
| `LA_TRANSCRIBE_MAX_MINUTES` | 15 | Longest video transcribed, when the page states a duration (1 to 120). |
| `LA_PUBLIC_CACHE` | false | Turn on the shared cache. |
| `LA_PUBLIC_CACHE_PATH` | `<data dir>/cache/public-posts.sqlite3` | Absolute path, for shared storage. |
| `LA_PUBLIC_CACHE_TTL_DAYS` | 30 | 1 to 365. |
| `LA_GEOCODER_URL` | none | A Nominatim-compatible geocoder (HTTPS, or loopback HTTP) for place coordinates. Off unless set; used only when a request asks. |
| `LA_GEOCODER_CONTACT` | none | Required with the URL: an email address or URL the geocoder's operator can reach. Sent only in the User-Agent. |
| `LA_GEOCODER_MIN_INTERVAL_SECONDS` | 1.1 | Wait between requests to one geocoder, shared by every account in the process. 1 to 60. |
| `LA_GEOCODER_CACHE_DAYS` | 30 | How long a found place is remembered, 1 to 365. |
| `LA_IMPORT_MAX_ARCHIVE_MB` | 512 (64 hosted) | Largest data export the guided import accepts, 1 to 4096. See [importing](importing.md#guided-backlog-import). |

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
| Recipe card | 100 ingredients, 100 steps, 96 KiB stored |
| Places per save | 30 (5 geocoded per request) |
| Text sent for a question | 12,000 characters, 12 saves, 500 characters a passage |
| Question | 3 to 500 characters |

## What was and was not verified

Verified by automated tests with no network: every extractor against fixtures, including hostile input; the fetcher's refusal rules with injected DNS and HTTP, including redirects to private addresses and rebinding-style answers; both providers against fake HTTP servers; batching, retries, metering, the thin-caption rule, the cache's isolation, search locations, the review flow, restart and cancellation behaviour, backup and restore with and without the new tables.

Verified by hand: the page shapes above (ten page requests on 14 Nov 2026); the fetcher's pinned-address TLS path and its refusals with the real resolver against one public site; the detail panel in a browser against a local instance with fake providers.

**Verified live on 14 Nov 2026, with synthetic content only:** Gemini suggestions (`gemini-3.5-flash-lite`, 15 demo saves in 2 calls) and Gemini transcription of generated speech in an audio file and in a video file.

**Not verified:** the Groq request shape follows its published reference (read on 14 Nov 2026) but was not exercised against the live service, because no key was used. The default Gemini model id is not confirmed to be available to every account. Server-side audio fetching from Instagram's media host was not attempted live. How well any model titles, tags or files real saves has not been measured.

### Recipes, places and ask

**Verified by automated tests with no network and no real model:** the ingredient, quantity, duration and serving parsers (English and Arabic digits and units); schema.org extraction from a synthetic page; the text rules; extraction through a stub provider whose invented ingredients, steps, serving counts and places are dropped; edits that win; the scaling rules, including unit changes that must not happen; every route in both server modes, the 402 for a locked hosted account, and that one account cannot read, change, list or geocode into another's data; the migration of a library written before these tables existed; that a backup with and without the new tables restores; the geocoder against a mock transport and a fake clock (identification, the shared one-a-second limit, caching of hits and misses, errors not cached, only the place's own words sent); retrieval and ranking, including that the literal search finds nothing for the same sentence; and the injection defences against stub models that obey whatever they can see.

**Not verified:** any of it against a real model. The prompts and output schemas for Ollama and Gemini were exercised only against mock HTTP. Real models may quote loosely (such answers are refused rather than shown) or answer in ways the stubs do not. The geocoder was never contacted, so the Nominatim request shape follows its published reference only. The ranking weights are reasoned, not tuned on a real library.

## For a hosted or multi-user deployment

The layer keeps its seams small so another part of the system can own users and billing:

- `build_enrichment(store, config)` builds everything for one library. Call it once per user's store.
- The shared cache is deliberately not per library. Point `LA_PUBLIC_CACHE_PATH` at storage all workers share.
- Usage events are the metering input; attach a sink instead of changing the pipeline.
- `UnderstandingWorker` extends `ClassificationWorker`, so queueing, cancelling and retrying come from the base class. It reads only its store and service.
- The schema is additive (`server/enrich/schema.py`) and idempotent; restore accepts a backup with or without it.
- Recipe cards, places and ask add their own additive tables (`server/enrich/features.py`: `item_recipe`, `item_places`, `geocode_cache`, `guided_imports`), created or upgraded in place when a library is opened and tracked by `features_schema_version` in `meta`. A library written by a newer version is refused rather than opened. Restore accepts a backup with or without them.
- In hosted mode these three features need the account's unlock (`402` with `code: "unlock_required"`); their model calls are recorded by the same usage hook, in the calling account's own ledger.
