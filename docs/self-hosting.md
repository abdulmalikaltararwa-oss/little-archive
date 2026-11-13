# Self-hosting

Little Archive runs one private owner library per instance. Its web UI and API are served together. SQLite and local thumbnails persist in the configured data directory.

## Docker

From a clean checkout:

```sh
python3 scripts/setup.py
docker compose up -d --build
```

Open `http://localhost:8787`. Keep the generated owner password private. Check service output with `docker compose logs` if startup fails. Do not paste unredacted environment files or credentials into public issues.

The default host binding is loopback. Docker volumes or bind mounts must be retained when replacing the container. Do not run a command that removes your data volume unless you intend to delete the library and have a verified backup.

## Native Python

Requirements: Python 3.12 or newer.

```sh
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
python3 scripts/setup.py
.venv/bin/python -m server.cli serve
```

The CLI loads `.env` without requiring a separate dotenv package; variables already present in the process environment take precedence. The important settings are listed below; the Docker setup uses the same application configuration.

## Configuration

| Variable | Purpose |
| --- | --- |
| `LA_ADMIN_PASSWORD` | Initial owner password. Keep it out of Git and process command-line arguments. |
| `LA_PUBLIC_URL` | Exact browser-facing origin, such as `http://localhost:8787` or `https://archive.example.com`. No path suffix. |
| `LA_DATA_DIR` | Persistent directory for the database and local assets. |
| `LA_OLLAMA_URL` | Optional operator-controlled Ollama origin. Set together with the model name. |
| `LA_OLLAMA_MODEL` | Name of a model available in that Ollama instance. |

The initial password initializes the owner record. Use the local CLI's `reset-password` command when deliberately changing an existing owner's password; consult `python -m server.cli reset-password --help` for the supported invocation. Changing an environment file is not a substitute for verifying the existing account's password state.

An HTTP public URL is accepted only for a loopback instance. Use HTTPS for a network-facing deployment. The public URL controls application origin checks and secure-cookie behavior; it must match the address people actually open.

## Reverse proxy

Terminate HTTPS at a reverse proxy you administer and forward to the application's internal port. Preserve the original host and configure proxy trust deliberately. Do not expose the upstream container port publicly as an alternate unauthenticated or plain-HTTP route.

Set `LA_PUBLIC_URL=https://archive.example.com`, use your own DNS and certificate configuration, and test login, a state-changing action, a file import, and the extension connection through the public address. A working health endpoint alone does not verify the full deployment.

For a personal installation, a private network or VPN is a reasonable additional access boundary. The application itself still requires owner authentication.

## Optional Ollama

Install and operate Ollama separately, download the chosen model through that service, and configure its origin and model name in Little Archive. Both values are server configuration; imported posts cannot choose an inference destination.

If both services run natively on the same machine, an origin such as `http://127.0.0.1:11434` may be appropriate. Inside a Docker container, `127.0.0.1` refers to that container, not the host. Use a configured private service name or host gateway that works in your deployment. Do not solve connectivity by exposing an unauthenticated model port to the Internet.

The classifier sends available title/caption/alternative text/notes and collection labels to that endpoint. If you configure a remote model host, that host receives this data. For local processing, keep the endpoint and its model service under your control and disable cloud-model fallback.

Model selection is your choice. Start with a small text model and test representative items before a large batch. Generated suggestions are always reviewed before acceptance. The application does not install or download a model automatically.

## Updates

1. Download and verify a backup.
2. Review the changelog and any migration notes.
3. Stop the old application process, update the checkout, and rebuild/restart.
4. Verify login, item counts, search, and a representative preview.
5. Keep the backup until the updated instance is confirmed usable.

Do not run two application versions against the same writable SQLite directory during an upgrade. SQLite storage should be on a local filesystem with appropriate locking, not a live shared/network database directory.
