# Privacy and data flow

Little Archive is self-hosted. The repository does not operate a central account service or an application analytics endpoint. Your configured instance is the destination for your library data.

## Data stored by your instance

The database can contain saved URLs, source-account labels, creator labels, available captions or alternative text, original collection names and memberships, local tags, notes, favorites, progress, AI suggestions, and import history. Local thumbnail files are stored separately and referenced by the database.

Authentication data is stored separately from exported content. Treat the entire data directory as sensitive even when session or token values are hashed. The application does not independently encrypt its SQLite database. Use storage and backup protection appropriate for your machine or server.

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

## Demo and issue reports

The bundled demo content is synthetic. Use it for screenshots and bug reports. Do not attach your full account export, database, private thumbnails, cookies, or `.env` to a public issue.
