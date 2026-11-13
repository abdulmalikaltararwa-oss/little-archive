# Mac setup and final live acceptance

All 12 jobs in [Release validation run 43398600381](https://github.com/abdulmalikaltararwa-oss/little-archive/actions/runs/43398600381) passed for commit `6fb4c1dbd6caa2127910ed8ccc5d305a9ed150f6`. The matrix includes native Apple Silicon and Intel Mac installation/recovery, authenticated browser flows, real local-model inference, the packaged Chrome extension against synthetic source pages, and a real Compose update/rollback/retained-data removal rehearsal. The [verification record](verification.md) and [six retained reports](evidence/6fb4c1db/README.md) contain the exact scope and provenance.

The remaining check connects the actual source accounts, Chrome's permissions, and a private instance on the operator's Mac. A synthetic fixture cannot establish that a currently logged-in platform exposes the same saved-content layout.

## 1. Start a private instance

Have Docker Desktop running and Python 3 available. From Terminal, use a **new checkout**:

```sh
git clone https://github.com/abdulmalikaltararwa-oss/little-archive.git
cd little-archive
git switch --detach 6fb4c1dbd6caa2127910ed8ccc5d305a9ed150f6
python3 scripts/setup.py
docker compose up -d --build
open -a "Google Chrome" http://localhost:8787
```

The setup helper displays the initial owner password in Terminal and stores it in the private configuration. Sign in locally. Do not paste the password, configuration file, import token, or private saved-post export into a public issue or chat.

The default service is reachable only from the local machine. The database and local images persist in the Compose volume. Keep the checkout and Compose project identity consistent. For an existing installation, use the [update instructions](self-hosting.md#updates), not a new checkout with an unrelated empty volume.

If Docker is not the chosen installation method, the [native Python instructions](self-hosting.md#native-python) use the same application and were verified on both Mac architectures. Native Python requires Python 3.12 and a running server process; it does not install a signed macOS application bundle or background launch agent.

## 2. Pair the companion extension

1. In the app, open **Settings & connections** and create an import token.
2. In Chrome, open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select the checkout's `extension` directory.
3. Open the Little Archive toolbar extension. Set the instance to `http://localhost:8787`, paste the token there, and connect.
4. Review and grant Chrome's requested access to that local instance. Keep the token in the extension; it is import-only and can be revoked from app settings.

The actual Chrome permission prompt is part of this live check. The CI harness exercises the real extension after granting its loopback test-host permission through Chromium's test management interface; that does not test the operator's consent dialog.

## 3. Verify one known view on each platform

For **Instagram**, open a small Saved collection whose contents you can recognize. Confirm the account label and exact collection name in the extension, then start the import. Current numeric-ID collection paths and creator-qualified post links are supported. If the heading is unambiguous, its visible name is prefilled and remains editable.

For **TikTok**, sign in, open your **Favorites** tab or a known favorites collection, and start a separate import with its correct source-account label. A Posts or Liked view is outside this importer. Complete platform login or verification prompts yourself.

Keep each source tab available until its scan finishes or pauses. In Little Archive, compare the imported unique links and original collection membership with the known view. Check a few available text fields and their provenance. A caption and image alternative text are distinct evidence; missing text must remain missing.

Repeat a view once after adding a local note and topic to one imported item. The same post should keep its identity and your edits. Scan an overlapping original collection to confirm one library item can retain both original memberships. Use **All posts** or **Favorites** for the broad inventory, then scan individual collections separately to preserve their memberships.

The extension reports observed coverage. Repeated scrolling without an explicit source end marker is a partial scan, even when all currently loaded cards were imported. It does not discover every collection automatically, recover deleted posts, or prove an entire historical account inventory.

## 4. Check the Mac runtime and recovery entry points

Save a note, upload a small local preview, and download a backup through Settings. Restart the same Compose service:

```sh
docker compose restart archive
```

Reload the app and confirm the content and preview remain. The automated native and container suites already test full offline restore, new-instance identity, asset integrity, and invalidation of old credentials. The [Linux Compose lifecycle gate](upgrade-verification.md#observed-candidate-result) also passed actual old-to-current replacement, data retention after `compose down`, and previous-image restoration of a pre-update backup into a separate volume. These completed lifecycle checks are separate from observing Docker Desktop and the application on this physical Mac. Use [backup and restore](backup-restore.md) for the local recovery entry points; restore never overwrites the current library.

Record the Mac and Docker Desktop versions, architecture, browser version, tested view type, expected/imported unique counts, preserved memberships, repeat-import behavior, and any sanitized error. Keep account handles, captions, private URLs, credentials, and screenshots of personal records outside public evidence. Public reports can use counts and synthetic reproductions.

## Acceptance decision

The first stable release requires a completed live capture, transmission, ingestion, and resulting-library check for each supported source, plus the chosen Mac installation path. A failed layout or permission check is a reproducible release blocker to fix, not a reason to mark an incomplete inventory complete. After the remaining checks pass, align version metadata and release notes, run the final packaging check, and publish the stable tag.
