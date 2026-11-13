# Security

Little Archive is an early self-hosted application. Treat your library, backups, owner password, and extension tokens as private data. A public source-code repository does not make a running instance safe to leave unauthenticated.

## Deployment boundary

- Use the default loopback binding for a local-only instance.
- For a remote instance, use HTTPS, set the exact `LA_PUBLIC_URL`, and restrict network access to the people who should reach it.
- Use a strong owner password and keep `.env` outside source control.
- Run the service as a non-root user and persist its data directory on storage you control.
- Keep the application, Python dependencies, browser, and container runtime updated.
- Expose the application endpoint only. Do not expose the SQLite directory or an unauthenticated model service to the Internet.

## Application boundaries

The application uses an authenticated owner session for browsing and management. State-changing web requests require CSRF protection. Extension tokens are separate, revocable, import-scoped credentials; they are not owner sessions.

Imported text is rendered as text, and the classifier has no tools. File parsers are bounded, reject unsafe ZIP members, and do not request URLs. Uploaded images are restricted to validated raster formats. The backend does not use a saved URL as a general-purpose fetch instruction.

The extension stores its configuration locally, restricts access to trusted extension contexts, and requests source/server access when needed. It does not export Instagram or TikTok cookies. Tokens are transmitted to the configured instance, so check that URL before pairing.

## What is not promised

This release has not received an independent security audit. It is a single-owner application, not a hardened multi-tenant SaaS platform. It does not encrypt its SQLite database independently. Use appropriate disk and backup protection for your environment. Local code execution under the same OS user is outside the app's isolation boundary.

## Reporting a vulnerability

If the repository's **Security → Report a vulnerability** option is available, use it for a private advisory. If that option is unavailable, open an issue asking the maintainer for a private reporting channel **without disclosing the exploit, private data, or credentials**. Do not assume that an ordinary GitHub issue is private.

Include the affected release, a minimal synthetic reproduction, impact, and any proposed fix. Report accidental exposure of a real credential by revoking it first.
