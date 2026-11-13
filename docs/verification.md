# Development verification toward 1.0

**All 11 jobs in the full acceptance workflow passed on 2026-11-13** for candidate [`7d24aa81cf8a5940397bd61985ef71a578962d76`](https://github.com/abdulmalikaltararwa-oss/little-archive/commit/7d24aa81cf8a5940397bd61985ef71a578962d76). The result is [Release validation run 43395263266](https://github.com/abdulmalikaltararwa-oss/little-archive/actions/runs/43395263266). The five installation and recovery reports are retained with their [provenance index](evidence/7d24aa81/README.md).

The candidate's internal version is `0.1.0`; no stable release has been published. The automated results below do not complete the remaining live-account, browser permission-consent, and Mac operator acceptance checks in the [1.0 release gates](release-gates.md). This is a record of observed behavior, not an independent security audit or a claim that every platform, model, installation, or library size has been tested.

## Passing candidate matrix

Every row applies to the candidate and workflow run linked above. Test cases, model inferences, and harness checks are different units and are reported separately.

| Area | Observed result | Evidence and scope |
| --- | --- | --- |
| Python regression suite | **78 tests passed.** | [Regression job](https://github.com/abdulmalikaltararwa-oss/little-archive/actions/runs/43395263266/job/131784529212). Parser, classifier, authenticated API, storage, import integrity, queue, and recovery checks use isolated synthetic data. |
| JavaScript regression suites | **35 extension + 17 web + 3 browser-harness infrastructure tests passed.** | The same regression job records 52 extension/web tests and a separate 3-test infrastructure suite. These are distinct from the browser cases below. |
| Authenticated web application | **27 browser cases passed: 9 each in Chromium, Firefox, and WebKit.** | [Chromium](https://github.com/abdulmalikaltararwa-oss/little-archive/actions/runs/43395263266/job/131784528955), [Firefox](https://github.com/abdulmalikaltararwa-oss/little-archive/actions/runs/43395263266/job/131784528841), [WebKit](https://github.com/abdulmalikaltararwa-oss/little-archive/actions/runs/43395263266/job/131784528788). These browsers used the real application server, owner authentication, SQLite, and synthetic records. |
| Packaged Chrome extension | **9 cases passed using the actual Manifest V3 extension and server.** | [Extension job](https://github.com/abdulmalikaltararwa-oss/little-archive/actions/runs/43395263266/job/131784528491). Source pages are controlled synthetic fixtures, not live Instagram or TikTok accounts. The native optional-host permission bubble remains a manual acceptance check. |
| Real local model | **Worker smoke passed with 2 real inferences; 1 additional real-model browser case passed.** | [Model job](https://github.com/abdulmalikaltararwa-oss/little-archive/actions/runs/43395263266/job/131784528856), using `ollama/ollama:0.40.16` and `qwen3:0.6b` on a disposable CPU service. The separate browser case queued two synthetic records and checked review, acceptance, dismissal, persistence, and unchanged-input deduplication. |
| Packaged Linux containers | **AMD64 and native ARM64 jobs passed, each with 7 lifecycle checks plus cleanup.** | [Container evidence](container-verification.md#observed-candidate-result). Both architectures passed actual non-root, capability, privilege, read-only filesystem, authentication, persistence, backup, and fresh-volume restore assertions. |
| Native installation and recovery | **Ubuntu, Apple Silicon macOS, and Intel macOS jobs passed, each with 7 checks plus cleanup.** | [Native evidence](native-verification.md#observed-candidate-result). Each used a fresh Python 3.12 environment, a clean copy of the candidate application, real CLI processes, and real HTTP requests. |
| Source and demo packaging | **Demo build and release-source check passed.** | The regression job built the synthetic demo and passed the source check for 17 required files. This is a check of the development candidate; it is not a published stable-version package. |

## What the browser and extension results establish

The core browser cases cover owner sign-in and sign-out, session-cookie attributes, CSRF rejection, session revocation, editing and reload persistence, search and filters, topics, favorites, progress, collections, selected-item bulk operations, archive/restore/delete, JSON import/export, rejected invalid imports, local previews, authenticated backup downloads, narrow-screen navigation, keyboard search, and remembered appearance. The Organize case imported **205 synthetic saves**, displayed the first 60, and applied topics and a collection to all 205 matches. This establishes operation beyond the currently visible gallery page, not a large-library throughput benchmark. The test sources and setup are documented in [browser testing](../tests/e2e/README.md).

The extension cases exercise the real toolbar popup, source-tab injection, service worker, durable extension storage, import-only token, and server requests. They cover an Instagram image grid, incremental ordered batches, overlapping source collections, ambiguous collection headings, TikTok video/photo identity, a login prompt, rejection of a TikTok Posts view, pause/resume with scope protection, and recovery after a committed batch's response is lost and the browser restarts. The [extension test boundary](../extension/tests/e2e/README.md) is explicit: fixture pages replace the source services, and Chromium's settings API pregrants the exact loopback server host in the fresh test profile. The production permission-request flow is unchanged, but the browser's native consent bubble was not operated by this suite.

The real-model smoke confirms worker completion, structured suggestions, evidence provenance, review before changes, preservation of manual annotations, acceptance, stale-suggestion rejection, and dismissal. The AI browser case separately confirms these review actions through the interface. Whole-library/filter queue selection, repeated-request deduplication, cancellation, retry, and discarded late results have regression coverage; the real-model browser case is not a cancellation stress test. No video decoding or frame-by-frame understanding was tested or claimed, and one small text model does not establish the quality or speed of other models.

## Remaining direct acceptance

Follow [Mac setup and final live acceptance](mac-acceptance.md) to connect the chosen private installation, real browser permissions, and known source-account views. The following limits remain distinct from the passing automated matrix.

| Area | Current boundary |
| --- | --- |
| Live Instagram capture | Read-only inspection observed real Saved-grid post identifiers, image alternative text, and creator-qualified post/Reel paths. The candidate has automated coverage for those path shapes. A complete real-account extension capture, transmission, server ingestion, and comparison with a known source inventory has **not** been observed. |
| Live TikTok capture | The available TikTok session was signed out. The nine extension cases include synthetic TikTok source views, but no completed live-account capture-to-server result is recorded. |
| Native browser permission consent | Manually grant the extension's optional server-host permission in a normal installed browser and observe its response. The CI suite's exact-host pregrant does not complete this check. |
| Mac Docker Desktop | Native macOS Python and native Linux ARM64 containers passed independently. Docker Desktop installation, GUI startup, filesystem sharing, and the documented operator flow on a physical Mac remain unverified. |
| Operator lifecycle | The scripted native/container recovery checks passed. A human rehearsal of the documented update/rollback and retain-data removal procedures, and any claimed desktop sleep/resume behavior, remains a separate scope. |

The latest manual browser session did not complete these live checks: TikTok was signed out, and the local browser connection later stalled. A DOM inspection or synthetic fixture pass must not be promoted into a real-account import result. Record completed direct checks against an identified candidate before marking the relevant [release gate](release-gates.md) accepted.

## Reproduce the checks

After the development setup in the [README](../README.md), the local regression commands are:

```sh
.venv/bin/python -m unittest discover -s tests -v
node --test extension/tests/*.test.mjs
node --test web/*.test.mjs
npm run test:e2e:infra
python3 scripts/build_demo.py
python3 scripts/release_check.py
```

Use the [browser test guide](../tests/e2e/README.md) and [packaged-extension guide](../extension/tests/e2e/README.md) for browser/dependency setup. The [container guide](container-verification.md) and [native guide](native-verification.md) give the installation/recovery commands. Real inference requires a running, configured Ollama service with the selected model available.

The [Release validation workflow](../.github/workflows/release-validation.yml) runs the full matrix on relevant source pushes to `main` and can also be dispatched manually. The smaller [Checks workflow](../.github/workflows/checks.yml) remains a separate fast regression/startup check. Use the logs and retained evidence for the exact revision you are installing; later runtime changes need fresh acceptance results.

## Earlier development evidence

An earlier [Checks run 43388516184](https://github.com/abdulmalikaltararwa-oss/little-archive/actions/runs/43388516184) at `85d50bf51504d047ab95fd48992d2e8589318616` passed the then-current 67 Python and 33 Node tests plus a container health smoke. Those counts and the earlier absence of authenticated browser/real-model checks are historical, superseded by the current matrix above. An initial ARM64 emulation attempt later failed a hardening assertion; the current native ARM64 job passed the unchanged strict assertions.

The first [public synthetic demo](https://abdulmalikaltararwa-oss.github.io/little-archive/) deployment was [Pages run 43388893222](https://github.com/abdulmalikaltararwa-oss/little-archive/actions/runs/43388893222). Earlier manual demo checks covered search, notes, Done status, favorites, JSON export, dark theme, and reset using its in-memory adapter. Those observations are separate from the authenticated backend cases now recorded above.

## Current public demo

[Pages run 43394662571](https://github.com/abdulmalikaltararwa-oss/little-archive/actions/runs/43394662571) successfully deployed the demo from `c99c4bf04b458f680050e01a6949e9398103a34f`. Its UI/runtime files are unchanged through the accepted automated candidate `7d24aa81cf8a5940397bd61985ef71a578962d76`. The live URL was reloaded and its gallery, detail inspector, and **Organize library** dialog were checked; the dialog showed a scope of **15 synthetic saves**.

The current [gallery](assets/gallery-current.jpg), [Organize dialog](assets/organize-current.jpg), and [detail inspector](assets/detail-current.jpg) screenshots show synthetic records only. No private account content was imported into or published with the demo. Demo changes intentionally reset on reload; it remains a public interface preview, separate from a private authenticated instance.
