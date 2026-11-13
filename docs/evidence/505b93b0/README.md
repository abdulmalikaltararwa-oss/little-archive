# Foundation verification evidence: 505b93b0

All 12 jobs in [Release validation run 43484644844](https://github.com/abdulmalikaltararwa-oss/little-archive/actions/runs/43484644844) passed on 2026-11-13 for commit [`505b93b0e07ceeb801ca62e9bb5ae2bd3cac5a6d`](https://github.com/abdulmalikaltararwa-oss/little-archive/commit/505b93b0e07ceeb801ca62e9bb5ae2bd3cac5a6d). This directory retains six credential-free installation, recovery, and lifecycle reports copied unchanged from that run's artifacts.

| Retained report | Workflow job | Original artifact ID | Passed checks |
| --- | --- | --- | --- |
| [container-amd64.json](container-amd64.json) | [Container (amd64)](https://github.com/abdulmalikaltararwa-oss/little-archive/actions/runs/43484644844/job/132089743921) | `14066522356` | 7 + cleanup |
| [container-arm64.json](container-arm64.json) | [Container (arm64)](https://github.com/abdulmalikaltararwa-oss/little-archive/actions/runs/43484644844/job/132089743561) | `14067525948` | 7 + cleanup |
| [native-ubuntu-24.04.json](native-ubuntu-24.04.json) | [Native install (ubuntu-24.04)](https://github.com/abdulmalikaltararwa-oss/little-archive/actions/runs/43484644844/job/132089743681) | `14067465947` | 8 + cleanup |
| [native-macos-arm64.json](native-macos-arm64.json) | [Native install (macos-15)](https://github.com/abdulmalikaltararwa-oss/little-archive/actions/runs/43484644844/job/132089743821) | `14066937673` | 8 + cleanup |
| [native-macos-intel.json](native-macos-intel.json) | [Native install (macos-15-intel)](https://github.com/abdulmalikaltararwa-oss/little-archive/actions/runs/43484644844/job/132089743880) | `14067376866` | 8 + cleanup |
| [upgrade.json](upgrade.json) | [Upgrade, rollback, and retained-data removal](https://github.com/abdulmalikaltararwa-oss/little-archive/actions/runs/43484644844/job/132089743786) | `14066638041` | 8 + cleanup |

The [machine-readable provenance index](provenance.json) records all 12 workflow jobs, exact source revision, artifact identities, runner labels, report hashes, and relevant image identities. The hashes cover the retained JSON bytes, not their enclosing downloaded ZIPs. All three native jobs also passed 16 contributor-workspace and 18 operator-setup tests; these are separate from the eight native lifecycle checks.

Native reports identify the exact commit and a clean source worktree. The two ordinary container reports contain image IDs and platforms, but no source-commit field; their source association was checked against workflow/artifact metadata, checkout logs, and Buildx revision metadata. The upgrade report directly identifies both revisions, actual image identities, and differing packaged-source fingerprints. A mutable image tag or the shared internal version `0.1.0` was not used as proof of source identity.

Reports were reviewed for credentials and private content before publication. They retain synthetic counts, runtime/source/image identifiers, check results, resource fingerprints, and cleanup status. They contain no generated passwords, cookies, CSRF values, import tokens, private posts, environment-file contents, database bytes, or backup bytes. Original CI artifacts have finite retention; these exact reports remain with the repository.

The [verification matrix](../../verification.md) records the browser, actual extension ZIP, model, and regression results and the initial failures corrected before this run. Earlier [6fb4c1db evidence](../6fb4c1db/README.md) remains historical. Live Instagram/TikTok capture, the normal Chrome optional-host consent flow, a signed Mac bundle, physical-Mac operator acceptance, and the broader [v1 plan](../../v1-product-plan.md) remain distinct requirements. This evidence does not announce a stable release or establish classification quality.
