# Security

Little Archive is in development toward its first stable release. Treat your library, backups, owner password, and extension tokens as private data. A public source-code repository does not make a running instance safe to leave unauthenticated.

## Deployment boundary

- Use the default loopback binding for a local-only instance.
- For a remote instance, use HTTPS, set the exact `LA_PUBLIC_URL`, and restrict network access to the people who should reach it.
- Use a strong owner password and keep `.env` outside source control.
- Run the service as a non-root user and persist its data directory on storage you control.
- Keep the application, Python dependencies, browser, and container runtime updated.
- Expose the application endpoint only. Do not expose the SQLite directory or an unauthenticated model service to the Internet.

## Application boundaries

The application uses an authenticated owner session for browsing and management. State-changing web requests require CSRF protection. Extension tokens are separate, revocable, import-scoped credentials; they are not owner sessions.

Imported text is rendered as text, and the classifier has no tools. File parsers are bounded, reject unsafe ZIP members, and do not request URLs. Uploaded images are restricted to validated raster formats. By default the backend never requests a saved URL.

**Optional server-side page reading** (`LA_FETCH_ENABLED=true`, off by default) is the one feature that makes the server request an address derived from stored data, so it is the one to review. It is documented in [Understanding saves](docs/understanding.md#the-opt-in-server-fetcher). In short: owner session and CSRF are required to start a read; only http(s) on ports 80 and 443 is allowed; every address a name resolves to (and after every redirect) must be public, so loopback, private, link-local, cloud-metadata and IPv4-embedding IPv6 ranges, numeric host tricks and local-by-convention names are refused; the connection is pinned to the validated address with the original name as Host and TLS name, which defeats DNS rebinding; redirects, size, time and content types are limited; no cookies are sent; and error messages never include internal addresses or response bodies. It does not sign in, rotate proxies or imitate a browser. Text read from pages is untrusted: it is cleaned, length-bounded and rendered as text, and models receive it as data with no tools.

Hosted-provider API keys (`LA_GEMINI_API_KEY`, `LA_GROQ_API_KEY`) are read from the environment only. They are sent in request headers (never URLs), are excluded from every API response, log line, error message and object representation, and a hosted key never activates by itself: choosing the provider is a separate, explicit setting.

The extension stores its configuration locally, restricts access to trusted extension contexts, and requests source/server access when needed. It does not export Instagram or TikTok cookies. Tokens are transmitted to the configured instance, so check that URL before pairing.

## What is not promised

This release has not received an independent security audit. It is a single-owner application, not a hardened multi-tenant SaaS platform. It does not encrypt its SQLite database independently. Use appropriate disk and backup protection for your environment. Local code execution under the same OS user is outside the app's isolation boundary.

## Reporting a vulnerability

If the repository's **Security → Report a vulnerability** option is available, use it for a private advisory. If that option is unavailable, open an issue asking the maintainer for a private reporting channel **without disclosing the exploit, private data, or credentials**. Do not assume that an ordinary GitHub issue is private.

Include the affected release, a minimal synthetic reproduction, impact, and any proposed fix. Report accidental exposure of a real credential by revoking it first.
