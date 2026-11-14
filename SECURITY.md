# Security

Little Archive is in development toward its first stable release. Treat your library, backups, owner password, device tokens, and extension tokens as private data. A public source-code repository does not make a running instance safe to leave unauthenticated.

## Deployment boundary

- Use the default loopback binding for a local-only instance.
- For a remote instance, use HTTPS, set the exact `LA_PUBLIC_URL`, and restrict network access to the people who should reach it.
- Use a strong owner password and keep `.env` outside source control.
- Run the service as a non-root user and persist its data directory on storage you control.
- Keep the application, Python dependencies, browser, and container runtime updated.
- Expose the application endpoint only. Do not expose the SQLite directory or an unauthenticated model service to the Internet.

## Application boundaries

The application uses an authenticated owner session for browsing and management. State-changing web requests require CSRF protection. Extension tokens are separate, revocable, import-scoped credentials; they are not owner sessions.

A native app cannot use the cookie flow, so the owner password can be exchanged for a device token. A device token is a bearer credential with the owner's full access: anyone holding it can read, change, export, and back up the library until it is revoked. It is stored only as a hash, in `devices.sqlite3` beside the library and never in a backup, is listed and revocable from the API, does not expire by itself, and is revoked by an offline password reset. The exchange shares the sign-in attempt limit. A request that presents a bearer token is never authenticated by a cookie instead, and CSRF and Origin checks apply to cookie requests only. The server sends no CORS headers for these routes. If a reverse proxy in front of the instance adds its own `Authorization: Bearer` header, strip it there: the application would treat it as a presented credential and refuse the request.

Imported text is rendered as text, and the classifier has no tools. File parsers are bounded, reject unsafe ZIP members, and do not request URLs. Uploaded images are restricted to validated raster formats. The backend does not use a saved URL as a general-purpose fetch instruction.

The extension stores its configuration locally, restricts access to trusted extension contexts, and requests source/server access when needed. It does not export Instagram or TikTok cookies. Tokens are transmitted to the configured instance, so check that URL before pairing.

## What is not promised

This release has not received an independent security audit. By default it is a single-owner application. The opt-in [hosted mode](docs/hosted-mode.md) keeps one library per account and verifies an identity provider's tokens, but it has been exercised only by this repository's tests: it has not been audited, load-tested, or run against a live identity provider, and it is not a hardened multi-tenant SaaS platform. In hosted mode the operator can read every account's library. The application does not encrypt its SQLite database independently. Use appropriate disk and backup protection for your environment. Local code execution under the same OS user is outside the app's isolation boundary.

## Reporting a vulnerability

If the repository's **Security → Report a vulnerability** option is available, use it for a private advisory. If that option is unavailable, open an issue asking the maintainer for a private reporting channel **without disclosing the exploit, private data, or credentials**. Do not assume that an ordinary GitHub issue is private.

Include the affected release, a minimal synthetic reproduction, impact, and any proposed fix. Report accidental exposure of a real credential by revoking it first.
