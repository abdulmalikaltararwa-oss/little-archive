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

## Import scope

Each run scans one selected view. Scan All posts/Favorites for the broad inventory, then scan original collections separately to preserve their memberships. Repeated observations are deduplicated, and local notes and tags survive refreshes.

The importer collects rendered links and available caption/alternative text. It does not discover every collection automatically or analyze the full video. A partial scan remains partial; inspect its result before assuming complete coverage. The current version still requires live-account acceptance before the first stable release.

For recovery, limits, permissions, and development instructions, see the [full extension guide](https://github.com/abdulmalikaltararwa-oss/little-archive/blob/main/extension/README.md). The source repository includes the tests and [API contract](https://github.com/abdulmalikaltararwa-oss/little-archive/blob/main/API_CONTRACT.md).

The code is MIT licensed. The standalone package includes the repository's complete `LICENSE` notice.
