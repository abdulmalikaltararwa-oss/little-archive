# Installation and recovery evidence: 7d24aa81

These five credential-free reports were downloaded from the successful [Release validation run 43395263266](https://github.com/abdulmalikaltararwa-oss/little-archive/actions/runs/43395263266) for commit [`7d24aa81cf8a5940397bd61985ef71a578962d76`](https://github.com/abdulmalikaltararwa-oss/little-archive/commit/7d24aa81cf8a5940397bd61985ef71a578962d76) on 2026-11-13. All five jobs passed, and every report records seven checks passed plus successful cleanup. The full run had 11 successful jobs; the other suites and remaining acceptance limits are described in [the verification record](../../verification.md).

## Report provenance

| Retained report | Workflow job | Original artifact ID |
| --- | --- | --- |
| [container-amd64.json](container-amd64.json) | [Container (amd64)](https://github.com/abdulmalikaltararwa-oss/little-archive/actions/runs/43395263266/job/131784528885) | `14022532098` |
| [container-arm64.json](container-arm64.json) | [Container (arm64)](https://github.com/abdulmalikaltararwa-oss/little-archive/actions/runs/43395263266/job/131784528815) | `14022104723` |
| [native-ubuntu-24.04.json](native-ubuntu-24.04.json) | [Native install (ubuntu-24.04)](https://github.com/abdulmalikaltararwa-oss/little-archive/actions/runs/43395263266/job/131784528874) | `14023015565` |
| [native-macos-arm64.json](native-macos-arm64.json) | [Native install (macos-15)](https://github.com/abdulmalikaltararwa-oss/little-archive/actions/runs/43395263266/job/131784528860) | `14021853771` |
| [native-macos-intel.json](native-macos-intel.json) | [Native install (macos-15-intel)](https://github.com/abdulmalikaltararwa-oss/little-archive/actions/runs/43395263266/job/131784528936) | `14023075430` |

The [machine-readable provenance index](provenance.json) records the workflow, full candidate SHA, job IDs/URLs, runner labels, original artifact names/IDs, retained report SHA-256 hashes, and container image IDs. Hashes identify the retained JSON files; they are not hashes of the original artifact ZIP containers. The report files were copied unchanged from the downloaded JSON reports. These files were added to documentation after the workflow completed and describe the stated candidate, not arbitrary later application revisions.

## Source association

Native reports contain `source_commit: 7d24aa81cf8a5940397bd61985ef71a578962d76`, `source_worktree_modified: false`, and copied-source SHA-256 `03cffe6cadbd5c042a7b5bc127a2341c9dbf8c15a4500787fb34c4c65a207d34`. All three native reports share that application-source fingerprint.

**Container reports do not include a source-commit field.** Their revision association was checked against the workflow run and artifact `head_sha`, each job's checkout log, and the Buildx `vcs:revision`/workflow metadata, all identifying `7d24aa81cf8a5940397bd61985ef71a578962d76`. Each report identifies its exact local image ID and `linux/amd64` or `linux/arm64` platform. The source association is not inferred from the mutable `little-archive:ci-*` tag. Both original and restored container runtime probes in the job logs passed with UID/GID 10001, effective capabilities 0, NoNewPrivs 1, read-only root, and the expected architecture.

## Scope and retention

The reports contain synthetic test counts, runtime versions, public source/image identifiers, check outcomes, and cleanup status. They contain no generated owner password, session cookie, CSRF value, import token, private export, database, or backup. Original GitHub artifacts have finite retention; these report copies and their provenance remain with the source documentation.

The evidence establishes automated native/container installation and recovery. It does not establish live Instagram/TikTok capture, native optional-host permission consent, a physical-Mac Docker Desktop installation, or operator update/removal acceptance. Use [Mac setup and final live acceptance](../../mac-acceptance.md) and [the release gates](../../release-gates.md) for those remaining checks. No stable release is implied by this evidence directory.
