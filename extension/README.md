# Little Archive companion extension

An experimental, buildless Chrome Manifest V3 importer for the **current** Instagram Saved view or TikTok Favorites/collection view. It sends rendered post links and available text/preview URLs to a Little Archive instance you choose. It does not log in for you, read cookies or passwords, call private platform APIs, or alter source saves.

## Install

1. Run your Little Archive server and sign in to its web app.
2. In app Settings, create an **import token**. Keep the token private.
3. Open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select this `extension` directory. No package installation or build is required.
4. Open the extension, enter the server origin (for example `http://localhost:8787`), paste the token, and click **Connect server**. Chrome asks for access to that server host.
5. Open your Instagram **All posts** or a specific saved collection, or your own TikTok **Favorites** tab/collection. Open the extension again, verify the account handle, enter the exact collection name if prompted, and confirm the selected view.
6. Choose **Import this view**. Leave the source tab open. The small page badge shows progress and offers Pause; the popup shows processed and queued counts.

Remote servers require HTTPS. Plain HTTP is allowed only for `localhost` and `127.0.0.1`. Subpath installations are not supported by this release: enter an origin without `/api`, a path, credentials, query, or fragment. Chrome host permissions cover ports, but all extension requests are pinned to the configured origin and API path.

## Scope and coverage

- Import one view at a time. Scanning All posts/Favorites does **not** discover every original collection membership; scan each collection separately with its original name.
- Instagram supports account URLs shaped like `/ACCOUNT/saved/all-posts/`, `/ACCOUNT/saved/COLLECTION/`, and `/ACCOUNT/saved/DISPLAY-SLUG/NUMERIC-ID/`. The numeric collection ID remains the identity when its display slug changes. Audio is excluded.
- TikTok supports profile Favorites views and `/@ACCOUNT/collection/COLLECTION` paths. Select Favorites, not Posted or Liked. When selected-tab semantics are unavailable, the extension relies on your explicit view confirmation; it never claims to detect your signed-in account independently.
- Only rendered permalink cards are collected. Captions, thumbnails, and alternative text may be absent. Alternative text is labeled separately from captions. No claim of full-video understanding is made.
- After several scrolls without new cards, the scan is saved as **partial**. Only an explicit page-level end/empty marker can request `enumeration_exhausted`; the server keeps every zero-batch run partial, and an observed end still does not prove every historic save is exposed.
- Platform layouts change. These adapters are experimental and need live validation against each supported layout. Passing fixture/unit tests is not proof of universal platform support.
- The importer pauses for a detected login/verification prompt, changed page/account, or scan limit. Complete source prompts yourself; it does not bypass them.

## Resume and retries

The extension stores a bounded local outbox and a checkpoint in this Chrome profile. Records are acknowledged only after the server confirms a transaction. Retries use the same run, batch ID, and sequence, so a repeated upload does not create a second record. Queued batches retry while Chrome is running. Chrome cannot import while closed.

**Pause** stops collection and lets queued uploads finish. **Resume** requires reopening the original source account/view. **Finish partial scan** uploads queued work and records a partial result. **Retry uploads** retries a failed transfer after you repair the server/token connection.

**Forget this scan** intentionally removes this device's checkpoint and pending queue. Already processed server records remain, and an unfinished server import entry may remain. Use this when abandoning an unavailable or replaced server; normal interruptions should use Resume instead.

The outbox is capped at 4 MiB, total extension state at 8 MiB, and each batch at 50 observations/256 KiB. Collection stops before exceeding those limits. Individual sessions pause after 300 scrolls or 10 minutes; you may inspect the page and resume.

## Server compatibility and upgrades

The extension checks the server's versioned import capabilities before connecting, starting, resuming, uploading each batch, and completing a scan. Compatible servers use import protocol 1. The original `0.1.0` server without protocol metadata still works through a visible **legacy compatibility mode**; update it to enable explicit capability checks. Unknown or malformed declarations stop imports with repair guidance.

An incompatibility keeps pending batch bodies, IDs and sequences unchanged. Keep the same browser profile, restore compatible software, then use **Retry uploads**. Do not forget the scan or clear extension storage as an upgrade step. Existing original checkpoints remain supported; an unknown future checkpoint format is retained without being rewritten. See [the full compatibility policy](../docs/extension-protocol.md).

For an unpacked extension update, pause capture, replace the extension files in the **same folder already registered with Chrome**, then click **Reload** on that same entry in `chrome://extensions`. Reopen its popup and retry/resume. Do not remove the extension or load a different extracted folder while work is pending: a different extension identity has separate local storage. Keep both the browser profile and registered extension identity.

## Privacy and permissions

- `activeTab` and `scripting`: inspect only the source tab you invoke and show progress there.
- `storage`: retain connection settings, the import-only token, checkpoint, and unsent observations locally. `storage.sync` is never used. Access is restricted to trusted extension contexts; page scripts never receive the token.
- `alarms`: retry saved uploads and recover stale scan state while Chrome is running.
- Optional HTTPS/loopback host access: needed to reach a self-hosted server chosen at setup. The wildcard in the manifest declares possible destinations; setup requests only the chosen host. No all-site permission is requested at installation.
- No analytics, external scripts, arbitrary proxy endpoint, cookie access, or browsing-history permission.

Remote previews are metadata only. The app's separate remote-preview setting controls whether your browser contacts the original image host. Content, notes, and token material must not be included in public bug reports; use sanitized fixtures.

To disconnect, use the popup and revoke the corresponding import token in app Settings. Removing the extension clears its local data but does not revoke a server token automatically.

## Development

Run `node --test extension/tests/*.test.mjs` from the repository root, or `npm test` from this directory. No dependency installation is needed. The tests exercise URL validation, source scoping, batching and replay boundaries, DOM adapter decisions using synthetic fixtures, and mocked extension/server message handling. They do not automate sign-in or a live social account.

The server API contract is in `../API_CONTRACT.md`. Source adapters are in `adapters.js`; they read rendered DOM only. Treat source text as data, never as commands. Preserve existing safety boundaries when updating selectors.

Build the runtime-only downloadable ZIP from the repository root:

```sh
python3 scripts/package_extension.py --output work/little-archive-extension.zip
```

The builder validates manifest, JavaScript and HTML dependencies, including `protocol.js`, and includes `INSTALL.md` plus the full MIT license. The ZIP has `manifest.json` at its root. Tests, fixtures, dependencies and local data are excluded by an explicit file list. File order, timestamps and permissions are fixed for reproducible builds from the same source and Python/compression environment. New runtime resource mechanisms require a packaging review. `scripts/release_check.py` uses the same validation.
