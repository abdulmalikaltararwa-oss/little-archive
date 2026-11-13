# Gates for the first stable 1.0 release

**The full automated acceptance matrix passed for candidate `7d24aa81cf8a5940397bd61985ef71a578962d76`; direct platform and operator acceptance is still incomplete. No stable release has been published.** The internal version remains `0.1.0` while the required checks below are completed.

The recorded result is [Release validation run 43395263266](https://github.com/abdulmalikaltararwa-oss/little-archive/actions/runs/43395263266), completed successfully on 2026-11-13 with all 11 jobs passing. The [verification record](verification.md) explains each suite's scope, and the [retained report index](evidence/7d24aa81/README.md) ties installation/recovery evidence to the exact candidate. A passing automated run does not substitute for the live-account and browser-permission checks below.

Before tagging or announcing `1.0.0`, record the command or procedure, environment, date, result, and evidence link for every required gate. Earlier results remain history; later runtime changes need fresh verification of their affected scope. Fix a failed gate and repeat it without weakening the acceptance assertion.

## Automated gates

| Gate | Required evidence | Recorded candidate result |
| --- | --- | --- |
| Python and JavaScript regressions | All suites pass with failure output available in CI. | **Passed:** 78 Python tests; 35 extension, 17 web, and 3 browser-infrastructure Node tests. [Regression job](https://github.com/abdulmalikaltararwa-oss/little-archive/actions/runs/43395263266/job/131784529212). |
| Hardened Linux AMD64 container | Packaged image passes real authenticated operations, restart, and offline recovery with read-only root, non-root user, capability drop, and no-new-privileges. | **Passed:** all 7 lifecycle checks and cleanup. [AMD64 job](https://github.com/abdulmalikaltararwa-oss/little-archive/actions/runs/43395263266/job/131784528885), [report](evidence/7d24aa81/container-amd64.json). |
| Native Linux ARM64 container | Build/load `linux/arm64` on a native ARM64 runner and pass the same strict harness. | **Passed:** all 7 checks and cleanup on `ubuntu-24.04-arm`, with `aarch64` runtime and hardening verified. [ARM64 job](https://github.com/abdulmalikaltararwa-oss/little-archive/actions/runs/43395263266/job/131784528815), [report](evidence/7d24aa81/container-arm64.json). This supersedes the earlier failed emulation attempt for native-runtime acceptance. |
| Native Linux and macOS install/recovery | Fresh Python 3.12 environments pass setup, real CLI/HTTP operations, restart, reset-password, and restore on Linux, Apple Silicon macOS, and Intel macOS. | **Passed:** 3 jobs, each with 7 checks and cleanup. [Native environment reports](native-verification.md#observed-candidate-result) identify the exact clean source and actual OS/runtime versions. Docker Desktop acceptance remains separate. |
| Authenticated browser flow | Actual backend and owner login; create/edit/search/filter/export; reload persistence; logout and rejected unauthorized operations. | **Passed:** 27 cases, 9 each in Chromium, Firefox, and WebKit. Includes 205-item organization beyond the first gallery page. [Scope and job links](verification.md#passing-candidate-matrix). |
| Packaged extension against controlled source pages | Actual MV3 package, popup, service worker, durable state, and server; source identity, collections, partial coverage, login/scope failures, repeated imports, and recovery. | **Passed:** 9 synthetic-source cases. [Extension job](https://github.com/abdulmalikaltararwa-oss/little-archive/actions/runs/43395263266/job/131784528491). Live platform layouts and the native permission bubble remain pending below. |
| Optional model integration | Actual configured model completes structured suggestions and the review flow while preserving annotations; queue selection, deduplication, cancellation/retry, and stale results are exercised in their appropriate suites. | **Passed for the recorded model:** `ollama/ollama:0.40.16`, `qwen3:0.6b`; worker smoke reported 2 real inferences, plus 1 separate real-model UI case. Queue cancellation/retry and late-result behavior passed regressions. [Model job](https://github.com/abdulmalikaltararwa-oss/little-archive/actions/runs/43395263266/job/131784528856). |
| Portable data and complete recovery | Preserve items, source/local memberships, empty collections, colors, annotation intent, and local assets; invalidate old credentials on full restore. | **Passed in regression and all 5 installation/recovery jobs.** Portable JSON retains intentional blank-summary protection. ZIP recovery includes local assets and fresh authentication; JSON remains a record export, not an asset backup. [Retained evidence](evidence/7d24aa81/README.md). |
| Candidate source packaging | Demo build/source checks succeed; required docs/license exist; synthetic fixtures and release contents are reviewable. | **Passed for this development candidate:** demo build and 17-file release-source check. A stable version tag/package has not been created; final version alignment remains part of the release decision. |

The [Release validation workflow](../.github/workflows/release-validation.yml) runs automatically on relevant source pushes to `main` and can also be dispatched manually. The [container guide](container-verification.md) and [native guide](native-verification.md) give reproducible commands. To repeat the model smoke, first run an Ollama service with the selected model pulled; the script creates only temporary synthetic application data:

```sh
.venv/bin/python scripts/ollama_smoke.py --url http://127.0.0.1:11434 --model qwen3:0.6b --timeout 360
```

Record the actual model and environment. One successful small text model does not establish every model's runtime, quality, or resource use. The separate [real-model browser case](../tests/e2e/ai/local-model.spec.mjs) checks the interface with a real service; core browser runs leave model inference disabled.

## Required direct platform acceptance — pending

The [Mac setup and final live acceptance guide](mac-acceptance.md) gives the operator procedure for the candidate, private instance, Chrome permission prompt, source views, and restart/recovery entry points.

Each platform needs a deliberate check in an account the tester is authorized to use. Use a small known source view and a fresh test library. Keep private post text, account names, tokens, and exports out of public fixtures, screenshots, and issues. Publish only counts, field-level outcomes, sanitized errors, and synthetic reproductions.

1. **Establish the expected view.** For Instagram, choose a known Saved collection; for TikTok, choose a known Favorites or collection view. Keep a private expected inventory and exact collection name. Record browser/extension versions, source layout/locale, and view type. Each platform needs its own completed result.
2. **Pair the real extension and exercise permission consent.** Load the candidate extension, create an import-only token, and use the native browser prompt to grant the specific server-host permission. The CI profile's exact-loopback-host pregrant does not satisfy this step. Grant source access through the real toolbar action, enter the correct source-account label, and confirm that the token cannot browse owner endpoints.
3. **Import the selected view.** Start the actual extension capture, keep the source tab available, scroll as required, and observe its completion/coverage result. Compare imported unique URLs and source memberships with the known inventory. Titles, available captions or image alternatives, dates, and preview references must reflect observed source information.
4. **Check evidence and limits.** Missing captions or images must yield honest limited-evidence records. A loaded grid, repeated scroll position, timeout, login wall, or selector failure must not be described as a complete historical account inventory.
5. **Repeat and interrupt.** Reimport the view, interrupt and resume, and repeat an acknowledged batch where practical. Check duplicates, omissions, and coverage. Add local notes/tags before refresh and verify they survive. Preserve original collection names and source memberships separately from local organization.
6. **Check revocation and failure.** Revoke the token, verify a clear stop/error, then reconnect with a fresh token. Exercise an unavailable source page or changed layout and verify that existing library records are not deleted.
7. **Record acceptance.** Compare expected and actual counts and representative fields. A platform is accepted only after capture, transmission, server ingestion, and the resulting library have been observed together. State any remaining adapter restrictions in the release scope.

Current direct evidence is limited to read-only Instagram Saved-grid inspection, including post identifiers, image alternative text, and creator-qualified post/Reel paths. The available TikTok session was signed out, and the local browser connection later stalled. **Neither platform has a recorded completed live capture-to-server acceptance result.** The synthetic MV3 suite passed; it does not complete these checks or establish all-collection discovery.

## Installation and operator acceptance

| Environment or operation | Recorded status and remaining check |
| --- | --- |
| Apple Silicon Mac with Docker Desktop | **Pending direct operator acceptance.** Start Docker Desktop, perform the documented clean install, sign in, create/import a synthetic record, restart, and recover into a separate instance. Confirm Linux ARM64 and record macOS/Docker Desktop versions. Native Linux ARM64 and native macOS Python CI both passed, but neither ran this Docker Desktop flow. |
| Native Python setup | **Automated gate passed** on Linux, macOS ARM, and macOS Intel. Generated configuration, startup, authentication, content, assets, restart, password reset, and fresh-destination recovery were observed. A signed native app bundle, launch-at-login service, and desktop sleep/resume are outside the implemented install path. |
| Update and rollback | **Pending operator rehearsal.** Use an isolated library and retained backup, preserve Compose project/volume identity, verify content and credentials after replacement, and rehearse rollback to a separate restored destination. Restart and recovery automation is supporting evidence, not a version-upgrade rehearsal. |
| Password recovery | **Automated native flow passed** on all 3 host targets: old password/session/token invalidated, new password accepted, configuration and library preserved. The documented Docker/operator procedure still belongs in the direct installation rehearsal. |
| Removal | **Pending operator rehearsal.** Follow the documented stop/remove procedure and verify that the default path retains the library volume. Deliberate data erasure is a separate opt-in action. Harness cleanup removes only its own labelled resources. |
| User interface | **Automated browser checks passed** for the recorded editing, navigation, narrow viewport, keyboard search, appearance, and error flows. Keep any untested assistive-technology or platform-specific behavior explicit; these cases are not a comprehensive accessibility audit. |

## Release decision and announcement

Complete the pending direct gates and attach their evidence to [verification.md](verification.md). Resolve required failures and state the supported import scope before creating a stable tag. Then align version metadata, changelog, install instructions, and generated packages, and rerun the required acceptance/packaging checks on the final release commit.

Only after those gates pass should the maintainer create `1.0.0`, publish its release notes, and use the conditional [launch copy](launch-kit.md). The [public synthetic demo](https://abdulmalikaltararwa-oss.github.io/little-archive/) has its own [successful Pages deployment](https://github.com/abdulmalikaltararwa-oss/little-archive/actions/runs/43388893222); it is not an authenticated hosted account service or evidence that direct source-platform acceptance is complete.
