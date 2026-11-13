# Development verification toward 1.0

**All 12 jobs passed on 2026-11-13** for the first v1 foundation batch at candidate [`505b93b0e07ceeb801ca62e9bb5ae2bd3cac5a6d`](https://github.com/abdulmalikaltararwa-oss/little-archive/commit/505b93b0e07ceeb801ca62e9bb5ae2bd3cac5a6d) in [Release validation run 43484644844](https://github.com/abdulmalikaltararwa-oss/little-archive/actions/runs/43484644844). The confirmed results below cover browsing continuity and focus, isolated contributor setup, redacted operator diagnostics, extension protocol compatibility, and the existing installation/recovery paths. The six credential-free installation/recovery reports are retained with their [provenance index](evidence/505b93b0/README.md).

The internal application version remains `0.1.0`, and no stable release has been published. This batch implements foundations within the [22-item v1 plan](v1-product-plan.md); it does not complete that plan or the remaining [release acceptance gates](release-gates.md).

## Candidate results

Every current row refers to the exact candidate and workflow above. Test cases, model inferences, and lifecycle checks are separate units. Repeating a test module on another operating system adds platform evidence, not new unique tests.

| Area | Observed result | Scope and evidence |
| --- | --- | --- |
| Python regressions | **117 tests passed.** | [Regression job](https://github.com/abdulmalikaltararwa-oss/little-archive/actions/runs/43484644844/job/132089743122). Parser, classifier, authenticated API, storage, import/recovery, contributor-workspace, and operator-setup regressions use synthetic data. |
| JavaScript regressions | **65 tests passed: 44 extension + 21 web.** | A separate **3-test browser-harness infrastructure suite also passed**. These counts do not include browser scenarios. |
| Authenticated web application | **39 cases passed: 13 each in Chromium, Firefox, and WebKit.** | [Chromium job 132089743896](https://github.com/abdulmalikaltararwa-oss/little-archive/actions/runs/43484644844/job/132089743896), [Firefox job 132089743638](https://github.com/abdulmalikaltararwa-oss/little-archive/actions/runs/43484644844/job/132089743638), and [WebKit job 132089743672](https://github.com/abdulmalikaltararwa-oss/little-archive/actions/runs/43484644844/job/132089743672). Real server, authentication, SQLite, and controlled synthetic records. |
| Packaged Chrome extension | **11 cases passed.** | [Extension job 132089743690](https://github.com/abdulmalikaltararwa-oss/little-archive/actions/runs/43484644844/job/132089743690) builds the distributable ZIP, extracts it, and loads that extension into Chromium. It exercises synthetic source views against the real application server. |
| Real model integration | **9 integration checks passed, including 2 real inferences; 1 separate real-model browser case passed.** | [Model job 132089743800](https://github.com/abdulmalikaltararwa-oss/little-archive/actions/runs/43484644844/job/132089743800), using `ollama/ollama:0.40.16` and `qwen3:0.6b`. The smoke checks include the new read-only model inventory probe. The probe itself performs no inference. |
| Hardened Linux containers | **AMD64 and native ARM64 passed, each with 7 lifecycle checks plus cleanup.** | Non-root execution, reduced privileges, read-only application filesystem, authentication, persistence, backup, and fresh-volume recovery. [AMD64 report](evidence/505b93b0/container-amd64.json), [ARM64 report](evidence/505b93b0/container-arm64.json), and [provenance](evidence/505b93b0/README.md). |
| Native Ubuntu installation | **8 lifecycle checks plus cleanup passed; 16 contributor and 18 operator tests also passed.** | [Ubuntu job](https://github.com/abdulmalikaltararwa-oss/little-archive/actions/runs/43484644844/job/132089743681). Fresh Python 3.12 environment, real CLI processes and HTTP requests. The two focused modules repeat cases already counted in the Python regression total. |
| Native Apple Silicon Mac installation | **8 lifecycle checks plus cleanup passed; 16 contributor and 18 operator tests also passed.** | [macos-15 job](https://github.com/abdulmalikaltararwa-oss/little-archive/actions/runs/43484644844/job/132089743821), [retained report](evidence/505b93b0/native-macos-arm64.json). macOS 15.8.2, ARM64, Python 3.12.10. |
| Native Intel Mac installation | **8 lifecycle checks plus cleanup passed; 16 contributor and 18 operator tests also passed.** | [macos-15-intel job](https://github.com/abdulmalikaltararwa-oss/little-archive/actions/runs/43484644844/job/132089743880), [retained report](evidence/505b93b0/native-macos-intel.json). macOS 15.7.9, x86_64, Python 3.12.10. |
| Compose update, rollback, and retained-data removal | **8 lifecycle checks plus cleanup passed.** | Previous source `85d50bf51504d047ab95fd48992d2e8589318616` is replaced by the current candidate on the same project/volume; `compose down` retains data; the pre-update backup is restored with the previous image into a separate fresh volume. [Lifecycle job](https://github.com/abdulmalikaltararwa-oss/little-archive/actions/runs/43484644844/job/132089743786) and [retained report](evidence/505b93b0/upgrade.json). |
| Source and demo packaging | **Source checks and demo build passed.** | The regression job verified 17 required source files and the extension runtime dependency closure. The extension browser job built and exercised the runtime-only ZIP. |
| Public synthetic demo | **Pages deployment succeeded.** | [Pages run 43484644801](https://github.com/abdulmalikaltararwa-oss/little-archive/actions/runs/43484644801). Deployment success is separate from authenticated application acceptance and does not establish live source-account importing. |

The [provenance index](evidence/505b93b0/provenance.json) binds the six retained report files to the exact run, job and artifact IDs, source revision, runtime images where applicable, and SHA-256 hashes. Documentation added after the tested candidate does not extend these results to arbitrary later runtime changes.

## What changed and what the checks establish

The foundation work preserves loaded gallery pages and useful focus during ordinary edits and favorites, and keeps closed narrow-screen navigation out of keyboard navigation and the accessibility tree. The authenticated browser suite retains its existing library, import/export, backup, and organization scenarios and adds regressions for these browsing behaviors. WebKit-engine coverage is not a claim that a normal Safari installation or VoiceOver interaction has been accepted on a physical Mac.

Contributor startup now uses an owned, ignored synthetic workspace on loopback by default. It does not load a personal `.env` or inherited `LA_*` deployment settings. Tests cover isolation, private credential handling, idempotent setup/seeding, real HTTP restart persistence, redacted inspection, and bounded cleanup. Operator tests cover configuration preview/creation and read-only diagnostics. These commands do not install a Mac application bundle, dependencies, a model runtime, or browser extensions. See [contributor setup](../CONTRIBUTING.md) and [operator setup](operator-setup.md).

The extension suite now tests the built/extracted distribution ZIP, including protocol compatibility and preservation of pending payloads. It exercises the actual popup, service worker, durable storage, and server integration, but source pages are controlled fixtures. The harness pregrants the exact test-server host; Chrome's native optional-host permission consent remains a direct acceptance check. See the [extension test boundary](../extension/tests/e2e/README.md).

The model job checks a real configured Ollama service and structured suggestions, with a separate browser review flow. An inventory response confirms availability information, not inference quality or local processing. One small text model's successful inferences do not establish categorization quality for a representative personal library, unseen video understanding, or other models' performance.

## Failures found before this candidate

The first foundation attempt, [run 43482024709](https://github.com/abdulmalikaltararwa-oss/little-archive/actions/runs/43482024709) at candidate `9bee770`, caught actual browser focus defects and a Mac-only test path assertion. The focus implementation was corrected while retaining the browser assertions. The Mac assertion compared a temporary `/var` path with the correctly canonicalized `/private/var` path; the expected isolated-workspace path now uses `.resolve()`. This was a test expectation correction, not a change that allows a production data directory. The corrected candidate passed the unchanged browser assertions in all three engines and the contributor/operator modules on both Mac architectures.

## Remaining direct and product acceptance

| Area | Unchanged limit |
| --- | --- |
| Live Instagram and TikTok imports | A full real-account extension capture, transmission, server ingestion, and comparison against an identified source inventory still require direct acceptance. Synthetic fixtures and read-only DOM inspection do not prove that end-to-end result or account-wide completeness. |
| Native Chrome permission consent | Normal installation, optional-host permission consent, and the resulting connection must be exercised in the real browser. The automated host pregrant does not close this gate. |
| Physical Mac operator journey | CI macOS and native Linux ARM64 container results are separate from a person's downloaded install, Docker Desktop GUI/filesystem interaction, and accessibility/operator acceptance on a physical Mac. |
| Signed Mac bundle | A signed/notarized consumer application and its normal installation/update journey remain proposed delivery work, not an artifact supplied by these source/Compose checks. |
| Broader v1 scope | Guided account-wide inventory, reconciliation, category/model quality, public distribution, newcomer contribution, and other remaining items in the 22-item plan require their own implementation and evidence. Passing this foundation batch does not complete them. |

Use [Mac setup and live acceptance](mac-acceptance.md), the [release gates](release-gates.md), and the [v1 plan](v1-product-plan.md) to record these outcomes against an identified candidate. No result here is an independent security audit or a claim that every installation, browser, source layout, model, or library size has been tested.

## Reproduction and historical evidence

Follow [CONTRIBUTING.md](../CONTRIBUTING.md) for isolated source setup, [browser testing](../tests/e2e/README.md) and [extension testing](../extension/tests/e2e/README.md) for their harnesses, and the [container](container-verification.md), [native](native-verification.md), and [upgrade](upgrade-verification.md) guides for installation and recovery checks. The [Release validation workflow](../.github/workflows/release-validation.yml) defines the current matrix. Each guide identifies the current candidate and its retained reports, with earlier evidence preserved separately.

The earlier full automated baseline, [`6fb4c1dbd6caa2127910ed8ccc5d305a9ed150f6`](https://github.com/abdulmalikaltararwa-oss/little-archive/actions/runs/43398600381), passed all 12 jobs: 78 Python tests; 35 extension and 17 web tests plus 3 infrastructure tests; 27 core browser cases; 9 extension cases; real-model checks; and six installation/recovery/lifecycle jobs. Its [retained reports and provenance](evidence/6fb4c1db/README.md) remain historical evidence. The current foundation candidate was verified independently, including both Mac architectures.

The [public demo](https://abdulmalikaltararwa-oss.github.io/little-archive/) contains synthetic records only, with edits held in temporary page memory. The current successful Pages deployment is linked in the matrix above. It remains an interface preview, separate from an owner's private authenticated library.
