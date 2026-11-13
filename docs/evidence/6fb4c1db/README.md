# Deployment and lifecycle evidence: 6fb4c1db

All 12 jobs in [Release validation run 43398600381](https://github.com/abdulmalikaltararwa-oss/little-archive/actions/runs/43398600381) passed on 2026-11-13 for commit [`6fb4c1dbd6caa2127910ed8ccc5d305a9ed150f6`](https://github.com/abdulmalikaltararwa-oss/little-archive/commit/6fb4c1dbd6caa2127910ed8ccc5d305a9ed150f6). This directory retains six credential-free JSON reports: five native/container installation and recovery jobs with seven checks each, plus one real Compose update/rollback/retained-data removal job with eight checks. Every report records successful cleanup.

## Report provenance

| Retained report | Workflow job | Original artifact ID | Passed checks |
| --- | --- | --- | --- |
| [container-amd64.json](container-amd64.json) | [Container (amd64)](https://github.com/abdulmalikaltararwa-oss/little-archive/actions/runs/43398600381/job/131795523149) | `14023986556` | 7 + cleanup |
| [container-arm64.json](container-arm64.json) | [Container (arm64)](https://github.com/abdulmalikaltararwa-oss/little-archive/actions/runs/43398600381/job/131795523426) | `14023468431` | 7 + cleanup |
| [native-ubuntu-24.04.json](native-ubuntu-24.04.json) | [Native install (ubuntu-24.04)](https://github.com/abdulmalikaltararwa-oss/little-archive/actions/runs/43398600381/job/131795523250) | `14023339885` | 7 + cleanup |
| [native-macos-arm64.json](native-macos-arm64.json) | [Native install (macos-15)](https://github.com/abdulmalikaltararwa-oss/little-archive/actions/runs/43398600381/job/131795523185) | `14024032043` | 7 + cleanup |
| [native-macos-intel.json](native-macos-intel.json) | [Native install (macos-15-intel)](https://github.com/abdulmalikaltararwa-oss/little-archive/actions/runs/43398600381/job/131795523192) | `14024390573` | 7 + cleanup |
| [upgrade.json](upgrade.json) | [Upgrade, rollback, and retained-data removal](https://github.com/abdulmalikaltararwa-oss/little-archive/actions/runs/43398600381/job/131795523089) | `14023514334` | 8 + cleanup |

The [machine-readable provenance index](provenance.json) records all 12 workflow jobs and their result/URL, the full candidate SHA, each retained report's original artifact name/ID, runner label, SHA-256, and image identities where relevant. Hashes identify the retained JSON files, not the downloaded artifact ZIPs. The reports were copied unchanged from the downloaded JSON files. Documentation added later describes this exact tested candidate, not arbitrary later runtime revisions.

## Source and image association

Native reports identify `source_commit: 6fb4c1dbd6caa2127910ed8ccc5d305a9ed150f6`, `source_worktree_modified: false`, and the same copied-source SHA-256: `03cffe6cadbd5c042a7b5bc127a2341c9dbf8c15a4500787fb34c4c65a207d34`.

**The two standard container reports do not contain a source-commit field.** Their association with this candidate was checked against workflow/artifact `head_sha`, job checkout logs, and Buildx revision metadata. The reports identify the exact local image IDs and `linux/amd64` or `linux/arm64` platform. A mutable image tag is not used as proof of source identity. Original and restored runtime probes passed non-root UID/GID 10001, zero effective capabilities, NoNewPrivs 1, read-only root, and the correct architecture.

The [lifecycle report](upgrade.json) directly records previous ref `85d50bf51504d047ab95fd48992d2e8589318616` and candidate ref `6fb4c1dbd6caa2127910ed8ccc5d305a9ed150f6`, matching OCI labels, distinct inspected image IDs, and distinct packaged-source fingerprints. The same project/volume/mount source survived real image replacement and `compose down`/startup. Rollback used the previous image and the pre-update backup in a separate fresh volume; the updated original remained unchanged. Docker Engine was `28.0.4` and Compose was `2.38.2` on Linux AMD64. Both application revisions reported internal version `0.1.0`, so version-string equality was not used to infer that a replacement occurred.

## Credential review and retention

The reports contain synthetic test counts, runtime versions, source/image/resource identifiers, source and backup fingerprints, check outcomes, and cleanup status. They contain no generated password, cookie, CSRF value, import token, private environment contents, private export, database, or backup bytes. Report structure and string values were checked before these copies were added. Original GitHub artifacts have finite retention; these report files and provenance remain with the repository. The [52adf28a evidence](../52adf28a/README.md) is retained as history; this directory records the later packaging candidate independently.

The recorded Linux Compose update, rollback, and retain-data removal gates are complete for this revision pair. Native macOS Python and both Linux container architectures also passed independently. Live Instagram/TikTok capture, Chrome's native optional-host permission prompt, and physical-Mac Docker Desktop/operator acceptance remain separate direct checks. See [the verification matrix](../../verification.md), [the lifecycle record](../../upgrade-verification.md), [Mac acceptance](../../mac-acceptance.md), and [release gates](../../release-gates.md). No stable release is implied by this evidence directory.
