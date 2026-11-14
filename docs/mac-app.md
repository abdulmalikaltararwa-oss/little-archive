# Little Archive for Mac (development build)

`Little Archive.app` is the server and the web interface in one double-clickable Mac app. It needs no Docker, no terminal and no Python on the Mac that runs it. This is a development build, not a release: nothing here has been signed with a Developer ID or notarized, no download is published, and it has been built and run on one Mac (see [what was verified](#what-was-verified-and-what-was-not)).

It implements the packaging proof and backend lifecycle described in section E of the [v1 plan](v1-product-plan.md). The plan's other Mac items (pairing exchange, start at login, model setup wizard, backup assistant, signing and notarization) are not part of it.

## Build it

You need a Mac with the Xcode command line tools (`xcode-select --install`), Python 3.12 (for example `brew install python@3.12`), and network access the first time so pip can install the pinned build tools. From a checkout:

```sh
python3 scripts/build_mac_app.py --python /path/to/python3.12
```

Add `--no-archives` to skip the `.zip` and `.dmg`, or `--clean` to start from a fresh build environment. The script uses only the standard library, creates its own environment in `.mac-build/` from [`packaging/mac/requirements-build.txt`](../packaging/mac/requirements-build.txt), and writes to `dist-mac/`. Both folders are ignored by Git and Docker. The server's own `requirements.txt` does not list the build tools, and the app bundles the versions in `requirements-lock.txt`.

| Output in `dist-mac/` | What it is |
| --- | --- |
| `Little Archive.app` | The app, ad-hoc signed |
| `Little-Archive-<version>-macos-<arch>.zip` and `.dmg` | The same app packaged for sharing |
| `SHA256SUMS`, `build-info.json` | Checksums, versions, source revision and whether the tree had local changes |

The app is built for the CPU of the Mac that builds it: `arm64` on Apple Silicon, `x86_64` on an Intel Mac. There is no universal build. The icon is rendered from [`web/icon.svg`](../web/icon.svg) during the build.

The approach is PyInstaller (one-folder mode) around a small launcher in [`packaging/mac/little_archive_mac/`](../packaging/mac/little_archive_mac). PyInstaller was chosen because it handles this dependency set (FastAPI, pydantic, Pillow) with maintained hooks, produces an ordinary `.app`, and could be checked end to end on the build machine. py2app and briefcase were not tried. The launcher keeps its decisions (library folder, port, one-server-per-library, first-run password) in a module with no macOS imports, which is unit tested; a thin AppKit layer draws the menu and the welcome window.

## What happens when you open it

1. It takes a lock on the library folder. If another copy already serves that library, it opens that copy in your browser and exits. It never starts a second server on the same library.
2. On the first run it creates the library folder with owner-only permissions and a private `config.env` containing a randomly generated owner password. This reuses the server's own setup code (`server.bootstrap`), so the file has the same format and protections as `python -m server.cli setup --apply`. The password is never written to the log.
3. It starts the server on `127.0.0.1` only, on port 8787 if that is free, otherwise on another free port that it remembers for next time.
4. On first run, a welcome window shows the password with a **Copy Password and Open** button. The window returns on later launches until you have clicked one of its buttons once.
5. It opens the library in your default browser at the exact address the server expects (`http://localhost:<port>`), where you sign in with that password.

I chose the **default browser** over an embedded window. The library already works in the browser, its file import, backup download and password-manager sign-in then behave exactly as they do in the other install paths, and the Chrome extension is paired through the same browser and address. An embedded web view would have to re-implement downloads and uploads and would add a second place for bugs. The cost is that closing the browser tab does not quit the app.

The app stays in the Dock while the server runs. Clicking its Dock icon (not tested), or **Open Little Archive in Browser**, opens the library again. **Quit** (Cmd-Q, the Dock menu, or log out) stops the server, closes the port, removes the running-instance marker and folds the database's write-ahead log into `library.sqlite3`. There is no background service or launch agent: after a restart, open the app again.

The menu also has **Show Sign-in Password…** (shows the password from `config.env` again) and **Show Library Folder in Finder**.

If the default port is busy, the library moves to another port and keeps it. Open it from the app so the address matches. Use that address (shown in the browser) when you pair the Chrome extension.

## Where your data lives

| Location | Contents |
| --- | --- |
| `~/Library/Application Support/Little Archive/library.sqlite3` | The library database. While the app runs, `-wal` and `-shm` files sit beside it. |
| `…/Little Archive/assets/` | Uploaded thumbnails |
| `…/Little Archive/config.env` | Owner password and optional model settings (`LA_OLLAMA_URL`, `LA_OLLAMA_MODEL`), mode `0600` |
| `…/Little Archive/launcher.json` | The remembered port and whether the welcome window was clicked through |
| `…/Little Archive/.instance.lock`, `.instance.json` | One-server-per-library lock and the running copy's address (the marker exists only while running) |
| `~/Library/Logs/Little Archive/little-archive.log` | Startup and shutdown messages, rotated at about 0.5 MB. It does not contain the password. |

Nothing is stored inside the app, so replacing or deleting the app does not touch the library. `config.env` holds the password in clear text, as `.env` does for the Docker and native installs; keep the folder private and out of backups you share. The folder is `0700`. Downloading a backup from Settings produces the same archive as the other install paths, without the password or sessions.

An existing Docker or native library is not migrated automatically. Copying one in has not been tried.

## Opening an unsigned app (Gatekeeper)

This build has only an ad-hoc signature: it is not signed with a Developer ID and not notarized by Apple. `spctl --assess` rejects it. An app built on your own Mac is not quarantined and opens normally. An app you **download** (the `.zip` or `.dmg`) is quarantined, and macOS will refuse the first double-click with a message that Apple could not verify it. Based on Apple's documented behavior, not observed in this work:

- macOS 15 and later: try to open it once, then open **System Settings → Privacy & Security**, scroll to the Security section and choose **Open Anyway** for Little Archive, then confirm.
- macOS 14 and earlier: Control-click the app, choose **Open**, then **Open** again.

Only do this for a build you trust. Removing that friction needs an Apple Developer Program membership (a paid account) to obtain a Developer ID certificate, sign the nested executables with the Hardened Runtime, notarize and staple the result, as the v1 plan describes. That has not been done and cannot be done without such an account. The bundle identifier `io.github.abdulmalikaltararwa-oss.little-archive` is provisional.

## Command-line tools from the app

The same operator commands as `python -m server.cli` run with the bundled Python:

```sh
APP="/Applications/Little Archive.app/Contents/MacOS/Little Archive"
CONFIG="$HOME/Library/Application Support/Little Archive/config.env"
"$APP" --cli doctor --json --env-file "$CONFIG"
```

To reset the owner password, quit the app first, then run `"$APP" --cli reset-password --env-file "$CONFIG"` and type the new password twice. Then delete the `LA_ADMIN_PASSWORD=` line from `config.env`, so **Show Sign-in Password…** does not display the old one. `restore` works the same way and always writes to a new folder. A restored library has no owner password: to open it in the app, put it at `~/Library/Application Support/Little Archive` (with the app quit and the previous folder moved aside) and add a `config.env` containing `LA_ADMIN_PASSWORD=` followed by a new password of at least 12 characters, with mode `0600`. See [backup and restore](backup-restore.md).

## Updating and uninstalling

To update, quit the app and replace it with the newer build. The library stays where it is. Download a backup first; do not run an older build against a library a newer one has migrated.

To uninstall, quit the app and drag `Little Archive.app` to the Trash. That removes the app only. To also delete your library, which cannot be undone, remove `~/Library/Application Support/Little Archive`; remove `~/Library/Logs/Little Archive` for the log. The app installs no launch agent, helper or system service. The Chrome extension is separate: revoke its import token in the app's settings, then remove it in `chrome://extensions`.

## Limits

- Not signed with a Developer ID, not notarized; first open of a downloaded copy needs the steps above.
- One architecture per build; a build on an Intel Mac has not been made.
- The minimum macOS recorded in the app (11.0) is computed from the bundled binaries' deployment targets. It has not been tested on any macOS older than the one used here.
- One library, in a fixed folder. No library chooser, no start at login, no menu bar item, no automatic updates, no guided restore or migration, no in-app password change.
- Model (Ollama) settings can be put in `config.env`, but guided model setup is not provided and the app path has not been tried with a model.
- Pairing the Chrome extension still uses an import token created in settings.
- Third-party license notices for the bundled Python packages are not collected into the app; only this project's `LICENSE` is.
- No CI job builds the app, and the build is not reproducible byte for byte.
- The app adds no analytics, update check or other network call. The server's own network behavior is unchanged: it listens on loopback and contacts a model endpoint only if one is configured.

## What was verified, and what was not

Built on an Apple Silicon Mac running macOS 26.5.1 with Python 3.12.16 and PyInstaller 6.22.3, using temporary home folders so no real library was involved.

Run against the built app and observed:

- A fresh home folder opened through Launch Services (`open`) created `~/Library/Application Support/Little Archive` with the database, `assets`, `config.env` and `launcher.json`, folder mode `0700`, `config.env` mode `0600`; no database was written inside the app bundle.
- `/api/health` answered on port 8787. The only listening socket was `127.0.0.1:8787`, and the running process held no other network connection.
- Sign-in with the generated password worked. Through the bundled app: add a link, upload a thumbnail (bundled Pillow), search, download a backup (valid ZIP with manifest), serve the web interface's static files.
- The password was not found in the log, and not in `doctor` output.
- A Quit request from outside (the AppleScript quit event, the path the Dock's Quit uses) ended the process in about 0.1 s, with and without the welcome window open. The port closed, the running-instance marker was removed, and the write-ahead log was empty. After a restart the same password, port and data were present. SIGTERM also stopped it cleanly while a window was open.
- Running the executable a second time while the app was running exited at once with status 0 and left one process and one listener; `open -a` on the running app also did not start another process.
- With port 8787 occupied by another program, the app used a different port, sign-in worked at that origin, and the same port was reused on the next start.
- A library whose `config.env` held a too-short password showed an explanation window, started no server, and after the file was fixed it started and showed the welcome window.
- The bundled `--cli doctor` found Python 3.12 and the dependencies; the bundled `--cli reset-password` changed the password through a pseudo-terminal (new password worked, old one was refused).
- The `.zip` and `.dmg` were extracted/mounted; their app copies pass `codesign --verify --deep --strict`, the checksums match, and the extracted copy runs. Every bundled binary refers only to system libraries or to files inside the bundle. The built app is 43 MiB on disk; the `.zip` is 23 MiB and the `.dmg` 25 MiB.

Covered by the automated tests (`tests/test_mac_launcher.py`, run without building the app): library location, owner-only permissions, port choice including wildcard and occupied ports, the one-server-per-library lock (including release when the holder dies), state-file tampering, loopback-only health probing, first-run password creation without output or log exposure, ignoring inherited `LA_*` variables, startup failure messages, restart persistence, the write-ahead-log fold on quit, and restoring a backup into the app's folder.

Not verified: the welcome window's buttons (they could not be clicked without UI-automation permission), clipboard copy through those buttons (the copy routine was checked only on a private pasteboard), **Open Anyway** and Control-click **Open** on a quarantined download, a clean Mac without developer tools, Intel Macs and other macOS versions, log out, restart or sleep with the app running, Dock-icon reopen, VoiceOver and keyboard use of the welcome window, behavior with a real library of thousands of items, and the app with a model configured. One unexplained observation: in one run right after a rebuild, two processes matched the app's path for a moment; it did not recur in the many launches that followed, and the cause is unknown. Also unexplained: in one failure-window run the window closed by itself after a few seconds, which was probably keyboard input from the person at the machine, since the window takes focus and Quit is its default button.
