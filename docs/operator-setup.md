# Setup and diagnostics for people and local assistants

These commands are implemented for the source/native installation. They provide
predictable configuration and diagnosis; a packaged Mac installer, guided model
download, and independently verified coding-assistant installation remain later
deliverables in the [v1 plan](v1-product-plan.md).

## Prepare the runtime

Use a reviewed source revision and Python 3.12. From that checkout:

```sh
python3.12 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

The selected environment must contain the application's locked dependencies.
These commands do not require a social account, an AI service, or a model. Keep
the checkout and private configuration on storage you control.

## Preview and create private configuration

```sh
.venv/bin/python -m server.cli setup --dry-run --json
.venv/bin/python -m server.cli setup --apply --json
```

`setup` without `--apply` is a preview. It describes creating `.env` with a random
owner password, a loopback public origin, `./data`, and AI disabled. Preview does
not create directories, configuration, or a database. Apply writes a complete
private file before making it the active configuration, refuses an existing
destination, and never overwrites an existing library. The filesystem must
support hard links for this atomic creation step.

Repeat setup returns `unchanged` if a regular configuration already exists. New
setup options do not edit that file. It has not been validated merely because it
was retained; run doctor next. The older `scripts/setup.py` helper remains
available and returns an error on repeat creation. Neither helper prints the
generated owner password.

Options for a fresh configuration are `--config`, `--data-dir`, and
`--public-url`. Relative data paths resolve from the command's working directory,
including when the configuration file is elsewhere. Use an absolute data path
when working across directories. Fresh setup refuses a selected data directory
that already contains a library database; use its existing configuration or the
documented recovery flow instead.

If setup uses `--config PATH`, pass that same file to subsequent commands with
`doctor --env-file PATH`, `serve --env-file PATH`, and, when needed, the documented
`reset-password --env-file PATH` recovery operation. The examples below assume
the default `.env` configuration and default public origin.

Open the private configuration locally in a text editor to retrieve the owner
password. Do not paste that file or password into an assistant conversation.
There is deliberately no password flag or secret value in setup's JSON output.
Keep configuration outside `web/` and source control.

## Diagnose before starting

```sh
.venv/bin/python -m server.cli doctor --json
```

Doctor inspects Python/dependencies, configuration precedence, data-location
access, free space, the presence of a SQLite file header, and whether initial
owner access is configured. Environment values take precedence over the file;
the report identifies the source of each setting without printing its value.
Dependency checks confirm installed package metadata and report versions; they
do not compare all packages with the dependency lock, verify transitive packages,
or replace a successful application start using the locked requirements.

Doctor does not open the database through SQLite or initialize the application's
store. It does not migrate schemas, checkpoint WAL files, requeue jobs, reset
credentials, create a library, or modify configuration. Its header check is not
a database integrity test, schema check, or proof that sign-in succeeds.

No network request is made unless a specific probe is requested:

```sh
.venv/bin/python -m server.cli doctor --check-port --port 8787 --json
.venv/bin/python -m server.cli doctor --check-ai --json
```

The port probe connects only to loopback. An accepting socket may belong to an
already running Little Archive or another application. The result does not
identify or stop that service, and an unused socket is not a reservation.

The AI probe uses the configured Ollama endpoint for bounded version and model
inventory requests. It never downloads a model, starts inference, changes a
runtime, or follows a redirect. It distinguishes missing models, timeouts,
unsupported responses, and known remote-model metadata. `model_available` means
the model was listed; it does not mean structured generation or category quality
was tested. A local endpoint alone does not establish local inference.

Run the probe in the backend's environment. Inside a container, `localhost`
addresses that container. On a remote self-hosted server, it addresses that
server, not the computer displaying the browser. Configure the intended private
runtime route rather than exposing an unauthenticated model port.

Use `--env-file PATH` with doctor or serve to select a different configuration.
The reader accepts a bounded regular UTF-8 dotenv file, keeps the first repeated
key, and performs no shell expansion. It refuses symlink/nonregular files.

## Structured contract

| Command | Format | Important fields | Exit status |
| --- | --- | --- | --- |
| `setup --json` | `little-archive-setup`, schema 1 | `status`, `code`, `summary`, `next_action`, `applied` | 0 for planned/created/unchanged; 1 for blocked; 2 for invalid command usage |
| `doctor --json` | `little-archive-diagnostics`, schema 1 | `status`, `exit_code`, `read_only`, `network_checks_requested`, `checks` | 1 if a check failed; 0 for OK or attention/warnings; 2 for invalid command usage |

Each diagnostic check has `id`, `status`, `code`, `summary`, and optional
`next_action`/bounded `details`. Check states are `passed`, `warning`, `failed`,
or `skipped`. Warnings do not silently become a readiness guarantee. Read the
codes and next actions instead of matching prose or assuming exit 0 verifies
every possible problem. Future incompatible result changes require a new schema
version; clients should tolerate additional checks and fields within schema 1.

Common actionable codes include:

| Code | Meaning / next step |
| --- | --- |
| `configuration_exists` | The existing file was retained; run diagnostics using it. |
| `existing_library` | Fresh configuration cannot safely adopt this library; use its prior configuration/recovery. |
| `configuration_invalid` | Correct the selected origin, data location, or paired model settings. |
| `owner_password_missing` | Configure initial owner access before starting a fresh library. |
| `database_header_unrecognized` | Preserve the existing file and use the recovery guide. |
| `ai_disabled` | No model is required for core library use. |
| `ai_not_probed` | Settings are present; no connection check has run. |
| `model_missing` | The runtime responded but did not list the selected model. |
| `model_service_timeout` | Check runtime availability from the backend. |
| `model_available` | Inventory lookup succeeded; inference and processing location remain unverified. |
| `remote_model_selected` | Metadata indicates remote processing; review the selected runtime/model. |

Reports omit raw configuration, passwords, tokens, URLs, model names, file
paths, private post text, and raw provider errors. They include application and
dependency versions, fixed reason codes, counts, and resource numbers. A user
can inspect a diagnostic report before sharing it.

## Start and verify the application

After resolving blocking diagnostics:

```sh
.venv/bin/python -m server.cli serve
```

Open `http://localhost:8787`, sign in with the locally retrieved password, and
try an invented link or the explicitly loaded synthetic demo. These commands
assume default setup options. For a different direct loopback origin, pass its
port to `serve --port` and `doctor --check-port --port`, then open the exact
configured origin. The server port is not inferred from `LA_PUBLIC_URL`;
`localhost` and `127.0.0.1` are different origins for authenticated requests.

Keep the process running while using the app. For Docker or a reverse proxy,
continue with the separate [self-hosting guide](self-hosting.md), where the
public origin and backend listening port can differ. This command does not
install a service.

For development, use [the isolated contributor workspace](../CONTRIBUTING.md)
instead of a personal library. Its read-only check is:

```sh
.venv/bin/python scripts/dev.py --check --json
```

That command inspects the development workspace's separate JSON configuration;
do not pass its JSON file to the production dotenv reader.

## A request for a local coding assistant

> Use Little Archive's AGENTS.md and operator setup guide to prepare a source
> installation. Preserve existing configuration and data. Run the setup preview
> and read-only diagnostics, use synthetic data for verification, and report the
> local URL and any remaining owner steps. Keep credentials in local interfaces.
> Configure optional classification AI only when requested.

This assumes the local assistant and its own reasoning model already work. That
model is independent from optional categorization AI. The direct command path is
covered by tests; broad compatibility with arbitrary coding assistants and a
complete GUI installer are not claimed.
