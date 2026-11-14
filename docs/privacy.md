# Privacy and data flow

Little Archive is self-hosted by default. The repository does not operate a central account service or an application analytics endpoint. Your configured instance is the destination for your library data.

This page describes a self-hosted instance, where you are both the owner and the operator. The same software can also be run by someone else as a hosted service for many accounts; the last section says what is different there.

## Data stored by your instance

The database can contain saved URLs, source-account labels, creator labels, available captions or alternative text, original collection names and memberships, local tags, notes, favorites, progress, AI suggestions, and import history. Local thumbnail files are stored separately and referenced by the database.

Authentication data is stored separately from exported content. Treat the entire data directory as sensitive even when session or token values are hashed. A device token for a phone or other native app gives full access to the library, like the owner password; revoke it when you stop using that device. Revocation is an API call today (`DELETE /api/auth/devices/{id}`); the bundled settings page does not list devices yet. The application does not independently encrypt its SQLite database. Use storage and backup protection appropriate for your machine or server.

## Browser extension

You explicitly choose a source view and configure the receiving instance. The extension can read supported visible saved-content data in that view and retain a bounded pending queue locally until the server acknowledges it. It does not request your social-platform password or export the platform's session cookies.

An import token is a credential for your Little Archive instance. Verify the instance URL before entering it. Revoke the token from settings when you remove the extension or no longer trust a device.

## Remote previews

Remote previews are off initially. If enabled, your browser may request stored preview URLs from third-party media hosts. Those requests disclose network information such as your IP address to the receiving host and are subject to the browser's network policies. A remote URL may also contain an expiring access parameter.

The server does not use saved URLs as arbitrary fetch instructions. A local thumbnail upload provides an alternative to loading a remote preview. Opening the original post is also an explicit online action in your browser.

## AI

AI is optional and invoked by an explicit user action. The chosen scope can be individual saves, a complete filtered set, or the entire non-archived library. The server sends each matched item's bounded text evidence and collection labels to the Ollama origin configured by the operator. Whole-library processing includes matching items beyond the currently loaded gallery page. There is no automatic hosted-model fallback in the application.

Cancelling work prevents queued jobs and cancelled results from updating the library. A request already sent to the model service can continue computing there until it finishes; cancellation cannot retract text that the service has already received. Retrying failed or cancelled work uses current item evidence and sends it to the configured model service again.

If your configured model service forwards requests elsewhere, that behavior belongs to the model service's configuration. To keep processing local, use a downloaded local model and an endpoint on hardware or a private network you control.

The application keeps validated final suggestions and their review state. It does not store a model's reasoning trace. A suggestion is not a verified fact about a post or the person who saved it.

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
