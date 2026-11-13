# Install the Little Archive companion extension

This package connects Chrome to a Little Archive server that you run. It contains the extension only; install the application from the [source repository](https://github.com/abdulmalikaltararwa-oss/little-archive) first. The [Mac guide](https://github.com/abdulmalikaltararwa-oss/little-archive/blob/main/docs/mac-acceptance.md) covers both parts.

## Pair with your private library

1. Unzip the extension package into a folder you will keep. Chrome loads it from that folder.
2. Open your running Little Archive instance and sign in. In **Settings & connections**, create an import token.
3. In Chrome, open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select the folder containing `manifest.json`.
4. Open the Little Archive toolbar extension. Enter your server origin, such as `http://localhost:8787`, paste the import token, and choose **Connect server**. Grant Chrome access to that server when prompted. Remote servers require HTTPS.
5. Open an Instagram Saved view or your TikTok Favorites/collection view. Confirm the account label and exact original collection name, then choose **Import this view**.
6. Keep the source tab available. Check the reported coverage and resulting library. Use **Pause** and **Resume** for interruptions.

The token is import-only. The extension does not ask for platform passwords or extract session cookies. Revoke the token in application settings when disconnecting this browser.

## Update without abandoning pending work

1. Pause capture and keep the existing Chrome profile and extension installed.
2. Replace the runtime files in the **same folder already registered with Chrome** with the new package's files. Keep that folder's location unchanged.
3. In `chrome://extensions`, click **Reload** on the same Little Archive entry.
4. Reopen its popup, inspect the retained scan, then use **Retry uploads** or reopen the original source view and **Resume**.

Do not use **Remove**, clear extension storage, or use **Load unpacked** on a different extracted folder while a scan is pending. Unpacked extension identity can change with its directory; a separate identity cannot access the old extension's stored queue. Chrome documents [extension identity](https://developer.chrome.com/docs/extensions/reference/manifest/key) and [unpacked-directory behavior](https://developer.chrome.com/docs/extensions/mv2/architecture-overview#referring-to-files). This package does not add or change a manifest key as an upgrade workaround.

## Import scope

Each run scans one selected view. Scan All posts/Favorites for the broad inventory, then scan original collections separately to preserve their memberships. Repeated observations are deduplicated, and local notes and tags survive refreshes.

The importer collects rendered links and available caption/alternative text. It does not discover every collection automatically or analyze the full video. A partial scan remains partial; inspect its result before assuming complete coverage. The current version still requires live-account acceptance before the first stable release.

For recovery, limits, permissions, and development instructions, see the [full extension guide](https://github.com/abdulmalikaltararwa-oss/little-archive/blob/main/extension/README.md). The source repository includes the tests and [API contract](https://github.com/abdulmalikaltararwa-oss/little-archive/blob/main/API_CONTRACT.md).

The code is MIT licensed. The standalone package includes the repository's complete `LICENSE` notice.
