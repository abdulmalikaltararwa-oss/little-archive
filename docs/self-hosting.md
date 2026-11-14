# Self-hosting

Little Archive runs one private owner library per instance. Its web interface (a React app, built from `ui/`) and its API are served together. SQLite and local thumbnails persist in the configured data directory.

The interface is built once into static files, and the server only serves them. **Docker users need nothing extra**: the image builds the interface itself and ships only the built files. A native Python install builds it with Node, as described [below](#build-the-web-interface-native-installs).

The repository is in development toward 1.0. Use the [release gates](release-gates.md) and [verification record](verification.md) to distinguish completed checks from pending acceptance before choosing a build for your library.

## Docker

Install Docker Engine with the Compose plugin on Linux, or Docker Desktop on a Mac, and start its engine. Python 3 is needed for the configuration helper; the server's Python dependencies live inside the image. Check the local prerequisites:

```sh
docker version
docker compose version
python3 --version
```

### Run the published image

A development image is published for `linux/amd64` and `linux/arm64` at `ghcr.io/abdulmalikaltararwa-oss/little-archive`. It needs no checkout and no Python on the host. Each build passes the container smoke check on both architectures before it is published.

1. Save [`compose.image.yaml`](../compose.image.yaml) as `compose.yaml` in an empty folder.
2. Beside it, create `.env` containing `LA_ADMIN_PASSWORD=` followed by a unique password of at least 12 characters. Restrict the file to your own account.
3. Start it:

```sh
docker compose up -d
```

Open `http://localhost:8787` and sign in with that password. Update with `docker compose pull && docker compose up -d`; download a backup first.

The `edge` tag follows the main branch and is development software: it can change without notice, and no stable release has been published. Each build also has an immutable `sha-` tag for pinning. `latest` and version tags will exist only once a stable release is tagged. The hardening, volume, port, and origin notes below apply to this file as well.

### Build from a checkout

From a clean checkout of the version you intend to run:

```sh
python3 scripts/setup.py
docker compose up -d --build
```

Open `http://localhost:8787`. Keep the generated owner password private. Check service output with `docker compose logs` if startup fails. Do not paste unredacted environment files or credentials into public issues.

The image is built in two stages: a Node 24 stage runs `npm ci && npm run build` in `ui/`, and the final Python image copies only the built files (to `/app/webui`). It contains no Node, no npm packages, and no interface source. The build needs network access to the npm registry; run it on the machine that has it.

The setup helper creates `.env` with owner-only permissions and refuses to overwrite an existing file. Retain that configuration with the checkout. The default container runs as a non-root user, has a read-only root filesystem, drops Linux capabilities, and stores the library in the named `archive-data` volume mounted at `/data`. Its `/tmp` is temporary. In Compose, `LA_DATA_DIR` is explicitly `/data`; changing the native `LA_DATA_DIR=./data` line in `.env` does not move the Docker volume.

The default host binding is loopback. Keep the same checkout directory and Compose project name during updates: the project name determines the named-volume identity. If you move the checkout or choose another project name, deliberately attach the existing volume or restore a backup; an empty new project is a separate library.

Check operation without exposing configuration values:

```sh
docker compose ps
docker compose logs --tail=100 archive
```

If port 8787 is already used, change both the host-side port in `compose.yaml` and the browser-facing port in `LA_PUBLIC_URL`, then recreate the service. Open exactly the configured origin; mixing `localhost` and `127.0.0.1` can fail state-changing origin checks. Do not publish an unredacted `docker compose config` dump, which can include the owner password.

Apple Silicon uses Linux ARM64 images inside Docker Desktop. The [container verification guide](container-verification.md) gives native ARM64 and emulated CI checks. An ARM64 CI result and a physical Mac installation are separate entries in the release evidence.

## Native Python

Use Python 3.12, the packaged and CI runtime. Verify other Python versions separately before relying on them.

```sh
python3.12 -m venv .venv
.venv/bin/pip install -r requirements.txt
(cd ui && npm ci && npm run build)    # Node 22 or newer; see the next section
python3 scripts/setup.py
.venv/bin/python -m server.cli serve
```

### Build the web interface (native installs)

The server does not render the interface; it serves files built from `ui/`. From a checkout, with Node 22 or newer (the project's CI and Docker image use Node 24):

```sh
cd ui
npm ci            # installs exactly what package-lock.json names
npm run build     # type check, lint, then the production build into ui/dist
```

The server looks for a build in this order and uses the first folder that has an `index.html`:

1. `webui/` beside `server/`. This is where the Docker image and the Mac app put the build they were made with.
2. `ui/dist/` in a checkout, which is what the commands above make.

If there is no build, the server still starts and the API (the phone app and the browser extension only need it) works, but every page answers with one line saying to run `npm ci && npm run build` in `ui/`, and the same sentence is logged at startup. Restart the server after building. A rebuild of an existing build is picked up for the page without a restart, but restart anyway after an upgrade so the server and the files agree. Hosted mode (`LA_MODE=hosted`) serves no interface at all and is not affected.

Rebuild after every update of the checkout. The build is plain static files: nothing in `ui/` runs on the server, and `node_modules` can be deleted afterwards.

### Map tiles for Places

The Places screen draws a paper map and, only if a tile server is named, real map tiles. Nothing is requested from a tile server by default: a tile request tells that server the viewer's address and roughly where on Earth they are looking.

Name a tile server for everyone who uses this instance when you build the interface (the values are fixed into the build, not read at run time):

```sh
cd ui
VITE_LA_TILE_URL='https://tiles.example.org/{z}/{x}/{y}.png' \
VITE_LA_TILE_ATTRIBUTION='Map data © your tile provider' \
npm run build
```

The address must contain `{z}`, `{x}` and `{y}` (`{s}` and `{r}` are accepted). The attribution is shown on the map whenever tiles are, so use the wording your provider requires. An owner can also choose a server per browser from the Places screen; that choice is kept in that browser only and takes precedence over the build's. With Docker, add the two values to the `.env` beside `compose.yaml` and rebuild (`docker compose up -d --build`); `compose.yaml` passes them to the interface build. They are fixed into the image, so the published image (`compose.image.yaml`) names no tile server and cannot be given one; each owner can still choose a tile server for their own browser from the Places screen. An address that does not pass the checks above is ignored rather than half-used.

Two things about how the server is configured affect which tile servers work:

- **Tiles must be `https:`.** The page's policy allows images from `'self'`, `data:` and `https:` only (`img-src 'self' data: https:`), so a tile server on plain `http://` is blocked by the browser. The only exception is the interface's own check, which accepts `http://` for a tile server on this machine (`localhost`), but the policy still blocks it from the page. Put a local tile server behind HTTPS.
- **Some public tile servers refuse requests with no referrer.** The server sends `Referrer-Policy: no-referrer`, so the browser sends no `Referer` header with a tile request, and some public servers (the OpenStreetMap Foundation's among them, for heavy or unidentified use) ask that applications identify themselves and may return an error instead of a tile. This was not tested against any external tile server. If the map stays blank, check the browser's network panel for refused tile requests, and use a provider whose terms suit an application with no referrer, or your own tile server.

The CLI loads `.env` without requiring a separate dotenv package; variables already present in the process environment take precedence. The important settings are listed below; the Docker setup uses the same application configuration.

Run the commands from the same project directory so `.env` and a relative `LA_DATA_DIR` resolve consistently. The default native server binds to loopback and stores its library in `./data`. Keep the terminal process running; stop it with Ctrl-C before offline maintenance. Native setup does not install a macOS menu-bar application, a background launch agent, or automatic operating-system startup.

For an isolated setup-and-recovery rehearsal, use the [native verification harness](native-verification.md). It copies the candidate into a temporary directory, generates separate credentials, exercises the real CLI, and cleans up its own servers and data.

## Configuration

| Variable | Purpose |
| --- | --- |
| `LA_ADMIN_PASSWORD` | Initial owner password. Keep it out of Git and process command-line arguments. |
| `LA_PUBLIC_URL` | Exact browser-facing origin, such as `http://localhost:8787` or `https://archive.example.com`. No path suffix. |
| `LA_DATA_DIR` | Persistent directory for the database and local assets. |
| `LA_OLLAMA_URL` | Optional operator-controlled Ollama origin. Set together with the model name. |
| `LA_OLLAMA_MODEL` | Name of a model available in that Ollama instance. |
| `LA_DEVICE_TOKEN_IDLE_DAYS` | Days without use after which a phone's device token stops working (default `180`; `0` turns it off). Tokens from before this limit existed keep working until they have been idle that long counted from the upgrade. |
| `LA_DEVICE_TOKEN_MAX_DAYS` | Optional hard lifetime for every device token, counted from when it was made (default `0`, none). A single device can be given one when it is paired (`expires_in_days`). |

The optional understanding layer (reading public pages, transcripts, a hosted model provider, the shared cache) has its own settings, all off by default. They are listed in [Understanding saves](understanding.md#settings).

The initial password initializes the owner record. Use the local CLI's `reset-password` command when deliberately changing an existing owner's password; consult `python -m server.cli reset-password --help` for the supported invocation. Changing an environment file is not a substitute for verifying the existing account's password state.

## Password recovery

For Docker, stop the running server and use an interactive one-off container with the same project volume:

```sh
docker compose stop archive
docker compose run --rm --no-deps archive python -m server.cli reset-password
docker compose up -d archive
```

The CLI prompts for the new password twice. For a native installation, stop the server and run `.venv/bin/python -m server.cli reset-password` from the configured project directory, then start it again. Do not pass the password in command-line arguments.

Reset revokes existing owner sessions and extension tokens. Sign in with the new password and create a replacement import token for each browser. Update the private configuration's initial-password value for future fresh instances; an existing library's password hash changes only through the reset operation. Keep the same data directory or Compose project during this procedure.

## Browser-facing origin

An HTTP public URL is accepted only for a loopback instance. Use HTTPS for a network-facing deployment. The public URL controls application origin checks and secure-cookie behavior; it must match the address people actually open.

## Reverse proxy

Terminate HTTPS at a reverse proxy you administer and forward to the application's internal port. Preserve the original host and configure proxy trust deliberately. Do not expose the upstream container port publicly as an alternate unauthenticated or plain-HTTP route.

The page (`/`, and the same page at `/share`) carries a fresh value in its `Content-Security-Policy` header and in the page itself on every response, which is what lets the interface use styles without the policy allowing every inline style (`style-src 'self' 'nonce-…'`). So: do not cache those pages, do not add a second `Content-Security-Policy` header of your own that is stricter about styles than the application's, and do not rewrite the page. Files under `/assets/` have hashed names and are served with a one-year `immutable` cache lifetime; everything else is revalidated.

Set `LA_PUBLIC_URL=https://archive.example.com`, use your own DNS and certificate configuration, and test login, a state-changing action, a file import, and the extension connection through the public address. A working health endpoint alone does not verify the full deployment.

Native apps sign in with a device token sent as `Authorization: Bearer`. The application therefore treats any bearer value in that header as a presented credential and answers `401` if it is not a valid device token, even when a browser session cookie is present. If your proxy adds its own `Authorization: Bearer` header (some single-sign-on proxies can), configure it not to forward that header to the application. Basic authentication at the proxy is unaffected.

For a personal installation, a private network or VPN is a reasonable additional access boundary. The application itself still requires owner authentication.

## Optional Ollama

Install and operate Ollama separately, download the chosen model through that service, and configure its origin and model name in Little Archive. Both values are server configuration; imported posts cannot choose an inference destination.

If both services run natively on the same machine, an origin such as `http://127.0.0.1:11434` may be appropriate. Inside a Docker container, `127.0.0.1` refers to that container, not the host. Use a configured private service name or host gateway that works in your deployment. Do not solve connectivity by exposing an unauthenticated model port to the Internet.

The classifier sends available title/caption/alternative text/notes and collection labels to that endpoint. If you configure a remote model host, that host receives this data. For local processing, keep the endpoint and its model service under your control and disable cloud-model fallback.

Model selection is your choice. Start with a small text model and test representative items before a large batch. Generated suggestions are always reviewed before acceptance. The application does not install or download a model automatically.

You can queue selected saves, a complete filtered inventory, or the entire non-archived library. Filtering is resolved on the server, so a whole-library request is not limited to the cards currently loaded in the gallery. One durable worker processes the queue. Its activity history separates queued, running, completed, failed, and cancelled jobs, with counts across the full history.

Use cancellation to stop queued/running work from updating items. An inference request already in progress may keep running in the model service, but its result is discarded after cancellation. Retry a failed or cancelled job after fixing the model connection or revising the item; retry uses current evidence. Identical evidence already queued, running, or completed is not sent for duplicate inference. Changing the configured model or endpoint changes the evidence fingerprint used for this check.

Cancelling or retrying a job does not accept its suggestions. Review completed output on the saved item. Editing its evidence makes an earlier suggestion stale, and accepting that stale result is rejected until new suggestions are generated. The synthetic public demo does not run these model operations.

## Updates

Download a backup and rehearse recovery into a separate destination before an update you cannot easily repeat. Retain the old application version, private configuration, and backup. Review the changelog and any migration notes; select a verified tag or commit rather than assuming the development branch is a stable release.

For native Python, stop the server before changing the checkout or dependencies. Docker users can leave the existing container running while preparing its replacement image. Check for local source changes with `git status --short`; preserve your edits before changing revisions. Fetch the target without overwriting the checkout, then switch to the reviewed reference (replace the literal placeholder):

```sh
git fetch --tags origin
git switch --detach VERIFIED_TAG_OR_COMMIT
```

For Docker, keep the existing project and volume. Build the replacement image before stopping the working service:

```sh
docker compose build archive
docker compose stop archive
docker compose up -d --no-build archive
docker compose ps
```

The image build does not open the live SQLite volume. After replacement, verify login, total and collection counts, a note, Unicode search, a local thumbnail, and a new backup. Keep the previous backup until the updated instance is confirmed usable.

For native Python, stop the server **before switching the checkout or replacing dependencies**, install the selected revision's requirements into the virtual environment, rebuild the interface, then restart:

```sh
.venv/bin/pip install -r requirements.txt
(cd ui && npm ci && npm run build)
.venv/bin/python -m server.cli serve
```

Do not downgrade an application against a database that a later version may have migrated. Roll back by running the previous compatible version with a separately restored pre-update backup, checking it, and then switching access to that instance. The [recovery guide](backup-restore.md) preserves the original library while doing this.

Do not run two application versions against the same writable SQLite directory during an upgrade. SQLite storage should be on a local filesystem with appropriate locking, not a live shared/network database directory.

## Stop or uninstall

To stop and remove the Docker service while retaining the library volume:

```sh
docker compose down
```

Run this from the original checkout with the same Compose project name. Keep the private configuration and record the project/volume identity before deleting the checkout. Starting the same project again with `docker compose up -d` reuses its retained volume.

Deleting the library is a separate, irreversible choice. After verifying an independent backup, `docker compose down --volumes` removes this project's named library volume. Do not use global Docker volume-prune commands. Removing a container or source checkout alone is not equivalent to securely erasing its stored library or backups.

For native Python, stop the server, then retain or deliberately remove the configured data directory, private configuration, virtual environment, and checkout as separate choices. The application has no installer-created system service to remove. Remove the unpacked browser extension through Chrome's extension settings; revoke its import token first if the instance will keep running.
