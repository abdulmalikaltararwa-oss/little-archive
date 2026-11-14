# Privacy and data flow

Little Archive is self-hosted by default. The repository does not operate a central account service or an application analytics endpoint. Your configured instance is the destination for your library data.

This page describes a self-hosted instance, where you are both the owner and the operator. The same software can also be run by someone else as a hosted service for many accounts; the last section says what is different there.

## Data stored by your instance

The database can contain saved URLs, source-account labels, creator labels, available captions or alternative text, original collection names and memberships, local tags, notes, favorites, progress, AI suggestions, and import history. Local thumbnail files are stored separately and referenced by the database.

If you use the [understanding layer](understanding.md), it can also contain the public details read from a post's page (title, creator, caption, link to the cover and, when exposed, to a media file), transcripts of a post's audio, a re-encoded local copy of its cover, and counters of what each step used (model calls, tokens, audio seconds). Video and audio files are never stored. A read page's raw HTML is not stored either, only the normalised details.

Authentication data is stored separately from exported content. Treat the entire data directory as sensitive even when session or token values are hashed. A device token for a phone or other native app gives full access to the library, like the owner password; revoke it when you stop using that device. Revocation is an API call today (`DELETE /api/auth/devices/{id}`); the bundled settings page does not list devices yet. The application does not independently encrypt its SQLite database. Use storage and backup protection appropriate for your machine or server.

## Browser extension

You explicitly choose a source view and configure the receiving instance. The extension can read supported visible saved-content data in that view and retain a bounded pending queue locally until the server acknowledges it. It does not request your social-platform password or export the platform's session cookies.

An import token is a credential for your Little Archive instance. Verify the instance URL before entering it. Revoke the token from settings when you remove the extension or no longer trust a device.

## Remote previews

Remote previews are off initially. If enabled, your browser may request stored preview URLs from third-party media hosts. Those requests disclose network information such as your IP address to the receiving host and are subject to the browser's network policies. A remote URL may also contain an expiring access parameter.

By default the server does not fetch saved URLs at all. Only if the operator turns on page reading (see below) does it request a saved URL, and then only through the restricted fetcher described there. A local thumbnail upload provides an alternative to loading a remote preview. Opening the original post is also an explicit online action in your browser.

## Reading public pages (optional)

The default is unchanged: saving a link stores the URL, and nothing contacts the page. Page details can reach the server in two ways.

- **From your device.** A phone or browser that fetched the page sends either the details it extracted or the raw HTML. The server parses it and never contacts the page. The page was requested from your device, in the same way your browser would, so the platform sees your device's address.
- **From the server, only if the operator sets `LA_FETCH_ENABLED=true`.** When you ask for it, the server requests the page (and, for YouTube and TikTok, their open oEmbed answer, the cover image, and for a deep read the media file) from the server's network address, so the platform sees the server's address, not yours. The requests carry no cookies, no account and no sign-in, and identify themselves as Little Archive. They are limited to public web addresses (see the [SSRF rules](understanding.md#the-opt-in-server-fetcher)). Anything that cannot be reached that way is simply not read. Raw HTML and downloaded media are not kept.

Platforms may treat automated requests from a server differently from a person's browser. Respect each platform's terms when you decide whether to enable it. The fetcher does not read `robots.txt`.

## Transcripts (optional)

A transcript can be made on your device and sent to your server, which stores the text. Or, if the operator configures a Groq key and enables page reading, the server fetches a post's media file into memory when you ask for a deep read (or when a video's caption is too thin to understand and automatic transcription is on, inside an analysis you started), sends the **audio of that post** to Groq to be transcribed, keeps the text and discards the media. That audio is public content from the post, but its transcription is a request to a third-party service, which receives it and is subject to its own terms. Without a key, nothing is sent anywhere for transcription.

## AI

AI is optional and invoked by an explicit user action. The chosen scope can be individual saves, a complete filtered set, or the entire non-archived library. Whole-library processing includes matching items beyond the currently loaded gallery page. There is no automatic hosted-model fallback in the application: a provider is used only if the operator configured it.

- **Ollama (the default provider).** The server sends each matched item's bounded text evidence, your notes and your collection names to the Ollama origin the operator configured. This is what the application has always done.
- **A hosted provider (Google Gemini), only if the operator sets `LA_AI_PROVIDER=gemini` and a key.** Text then **leaves your server and goes to Google**. By default that text is only what comes from the post: its title (unless you wrote it), creator, caption, image alternative text, and any transcript. Your notes, your own text and your collection names are not sent unless the operator also sets `LA_AI_SHARE_PRIVATE_CONTEXT=true`. Google's own terms and retention apply to what it receives. A key alone never turns this on. Several saves can be sent in one request.
- **Transcription** is a separate third-party step, described above.

The folder suggestion is matched to your collections on your server when only post text is sent, so hosted providers never see your collection names by default.

Cancelling work prevents queued jobs and cancelled results from updating the library. A request already sent to the model service can continue computing there until it finishes; cancellation cannot retract text that the service has already received. Retrying failed or cancelled work uses current item evidence and sends it to the configured model service again.

If your configured model service forwards requests elsewhere, that behavior belongs to the model service's configuration. To keep processing local, use a downloaded local model and an endpoint on hardware or a private network you control.

The application keeps validated final suggestions and their review state. It does not store a model's reasoning trace. A suggestion is not a verified fact about a post or the person who saved it. Each suggestion records what it rested on (caption, transcript of the audio, title) and says that the pictures and video were not seen, because a text model cannot see them.

## Shared cache (optional, off by default)

If the operator sets `LA_PUBLIC_CACHE=true`, results derived from a public post can be reused for everyone who saves the same post, so it is read, transcribed and analysed once. The cache is a separate file from any library and from backups.

It holds only: the public details the **server itself** read from the post's page, a transcript the server made from the post's own audio, and an analysis (title, summary, topics, category) made from the post's public text. It cannot hold your notes, tags, collections, favourites, progress, account names, or who saved the post: each kind of entry has a fixed list of allowed fields, and when the cache is on the analysis never receives private text. An analysis is only given to someone whose copy of the post's public text is identical, which also stops one person's made-up text from changing what another sees. Entries expire after 30 days by default.

What remains: anyone who can read the cache file can see which public posts have been analysed on that deployment. Protect it like the library. With the cache on, your notes no longer influence suggestions, because they are not sent to the model.

## Usage counters

The application counts, locally, what each step used (model calls, tokens, audio seconds, bytes read, cache hits), per save and per job, in your library. A deployment that sells these steps can attach its own meter. The counters do not contain text. They are included in backups and visible at `/api/enrichment/usage`.

## Export, backup, and deletion

Portable exports contain library records and annotations. Backups also contain local assets. Both can reveal private interests or source links: share them deliberately and avoid adding them to a public repository.

Deleting an item in Little Archive changes the local library, not the original platform save. Copies already present in an exported file or old backup remain until you remove those files. Revoking a token prevents future requests with that credential but does not erase data previously imported with it.

## If someone else hosts your library

A hosted service runs this software in its [hosted mode](hosted-mode.md). The statements above about what the application sends and stores still describe the software, but who controls it changes:

- **The operator is not you.** Your library sits in a database file on the operator's server. It is separated from other accounts, not encrypted from the operator, who can read it and include it in their own backups.
- **Sign-in goes through an identity provider.** You sign in with the operator's Supabase project, which holds your email address and credentials under the operator's and Supabase's terms. The Little Archive server receives a signed token containing your account id on each request; it does not store your email address or password.
- **AI, if offered, uses the operator's model service.** Text you queue for suggestions is sent to the model endpoint the operator configured, not to hardware you control. You cannot change that endpoint.
- **The browser extension and the bundled web interface are not offered** by a hosted server.
- **Deleting your account** removes your library and thumbnails from that server. It keeps two small records under a hash of your account id, with none of your content: the time of deletion for 30 days, so older sign-ins stop working, and the current month's usage count until the month ends. It does not remove the sign-in account at the identity provider, the operator's earlier backups, files you exported, or text already sent to a model service. Ask the operator how they handle those.

Export and backup work the same way, and a backup from a hosted account can be restored into a self-hosted instance.

## Demo and issue reports

The bundled demo content is synthetic. Use it for screenshots and bug reports. Do not attach your full account export, database, private thumbnails, cookies, or `.env` to a public issue.
