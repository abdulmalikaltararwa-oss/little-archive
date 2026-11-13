# Contributing to Little Archive

Thanks for helping make saved content easier to use. Small, focused changes are welcome.

## Before changing code

Read `API_CONTRACT.md` and `docs/architecture.md`. Keep source facts, user annotations, and AI suggestions separate. Never add personal platform exports or credentials to a fixture.

For an adapter change, include a minimal synthetic or sanitized fixture showing the supported page structure. State what the adapter can establish and what remains unknown. Do not claim complete coverage from a scroll timeout alone.

## Run checks

```sh
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python -m unittest discover -s tests -v
node --test extension/tests/*.test.mjs
```

Run the app locally and check the affected interaction. For visual changes, include a screenshot with synthetic content, and check keyboard navigation and a narrow viewport. For a parser or security boundary, add a focused regression test that demonstrates the failure being fixed.

## Pull requests

Explain the problem, the resulting behavior, and how you verified it. Call out a database migration, new network destination, new extension permission, or change to export compatibility. Avoid unrelated refactors in the same pull request.

Keep dependencies small and necessary. The browser UI and extension intentionally work without a build system. Do not add analytics, remotely loaded scripts, external fonts, or silent hosted-model fallback.

## Sensitive reports

Follow `SECURITY.md` for vulnerabilities. Do not publish private saved content, screenshots of another person's account, passwords, tokens, or session information in an issue.

## Licensing

Contributions are accepted under this repository's MIT license. Contribute only code and assets you have permission to contribute; retain required third-party notices.
