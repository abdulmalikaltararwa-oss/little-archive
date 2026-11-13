# Gates for the first stable 1.0 release

**The project is in development toward 1.0. No stable release has been published.** The current internal version remains `0.1.0` while verification continues. A public source repository and a working synthetic demo do not establish that a stable product release is ready.

Before tagging or announcing `1.0.0`, record a passing result for every required gate below against the candidate commit. Record the command or procedure, environment, date, result, and evidence link. A previously passing run on an earlier commit is useful history; it does not automatically cover later code changes. Fix a failed gate and repeat the affected check rather than relabeling an incomplete result.

## Automated gates

| Gate | Required evidence | Current recorded scope |
| --- | --- | --- |
| Python and JavaScript regression checks | All suites pass on the candidate commit, with failure output available in CI. | An earlier commit passed 67 Python tests and 33 Node tests; see the [verification record](verification.md). Candidate rerun required after code changes. |
| Hardened Linux AMD64 container | Build the packaged image and pass `scripts/container_smoke.py` with read-only filesystem, non-root user, capability drop, real authenticated operations, restart, and recovery. | The earlier CI health smoke passed. The new full harness requires its own execution evidence. |
| Linux ARM64 container | Build and load `linux/arm64` on a native ARM64 Linux runner; run the same full harness and record image/platform plus runtime-hardening fields. | The initial QEMU build started the server but failed a runtime-hardening assertion. Native execution evidence is required; an emulated cross-build is supplementary. |
| Native Linux and macOS install/recovery | Install locked requirements into a fresh Python 3.12 environment and pass `scripts/native_smoke.py` on Linux, Apple Silicon macOS, and Intel macOS. Retain actual host/architecture/version reports. | A local Linux development run passed; see [native verification](native-verification.md). Candidate CI results on each target are still required. This does not replace Docker Desktop acceptance. |
| Authenticated browser flow | Use the actual backend and owner login in a browser; verify create/edit/search/filter/export, reload persistence, logout, and rejected unauthenticated access. | Synthetic-adapter browser checks are recorded. They do not satisfy this real-backend gate. |
| Optional model integration | Run `scripts/ollama_smoke.py` against an actual configured Ollama model. Record model name and completion, preserved annotations, review, acceptance, stale-result rejection, and dismissal. Verify whole-library/filter queue scope beyond gallery pagination, cancellation, and retry through automated/API and browser checks. | Mock/protocol checks are recorded. A real model result and the queue-control acceptance results must be recorded separately. |
| Portable and complete recovery | Automated roundtrip tests plus the packaged restore gate preserve items, source/local memberships, empty collections, colors, annotations, and local assets while invalidating old credentials. | API tests cover these behaviors. Packaged restore evidence is required before the stable release. |
| Release packaging | Source/package check passes; required docs and license exist; no private data or credentials are included; version identifiers and release notes agree. | Recheck the final candidate after all fixes. Do not increment the public release version before the functional gates are complete. |

The [manual Release validation workflow](../.github/workflows/release-validation.yml) supplies regression, Chromium/Firefox/WebKit browser, packaged-extension fixture, AMD64/ARM64 container, native Linux/macOS, and real-model jobs. Its existence is not a passing result. The [container guide](container-verification.md) and [native guide](native-verification.md) contain exact local commands. The model service must already be running with a model pulled before the model check; the script creates only temporary synthetic application data:

```sh
.venv/bin/python scripts/ollama_smoke.py --url http://127.0.0.1:11434 --model qwen3:0.6b --timeout 240
```

Substitute the model you intend to support and record it. One working model does not establish that every model or machine will meet the same runtime or quality level.

## Real-account import acceptance

These are deliberate checks in an account the tester is authorized to use. Use a small known source view and a fresh test library. Keep private post text, account names, tokens, and exports out of public fixtures, screenshots, and issues. Record public evidence as counts, field-level outcomes, sanitized errors, and synthetic reproductions.

1. **Establish the expected view.** For Instagram, choose a known Saved collection; for TikTok, choose a known Favorites or collection view. Record a private expected inventory and the exact collection name. Record browser/extension versions, source layout/locale, and the tested view type. Each platform needs its own completed result.
2. **Pair the real extension.** Load the candidate extension, create an import-only token in the candidate server, grant the required source and server permissions, and enter the correct source-account label. Verify that the token cannot browse the private library through owner endpoints.
3. **Import the selected view.** Start the actual extension capture. Keep the source tab available, scroll the view as its flow requires, and observe the completion/coverage result. Compare the imported unique URLs and source memberships with the known inventory. Titles, available captions or image alternatives, dates, and preview references must reflect what was actually present.
4. **Check evidence and limitations.** A missing caption or image must produce an honest link-only or limited-evidence record, not invented content. A loaded grid, repeated scroll position, timeout, login wall, or selector failure must not be described as a complete historical account inventory.
5. **Repeat and interrupt.** Reimport the same view, interrupt and resume an import, and repeat an acknowledged batch where practical. Check for duplicates, omissions, and misleading coverage. Add local notes/tags before a refresh and confirm they survive. Confirm original collection names and memberships remain separate from local organization.
6. **Check revocation and failure.** Revoke the token while testing, verify the extension stops with a clear error, and reconnect with a fresh token. Exercise an unavailable source page or changed layout and verify existing library records are not deleted.
7. **Record acceptance.** Compare expected and actual counts and a representative set of fields. Keep any remaining adapter limitations in the release scope. A platform is not accepted until the actual capture, transmission, server ingestion, and resulting library have been observed together.

A read-only inspection of one loaded Instagram grid found 21 post anchors with image alternative text and no `figcaption` elements. This helps choose selectors for that observed layout. It does **not** satisfy live extension-capture acceptance, all-collection discovery, or a TikTok test.

## Installation and operator acceptance

| Environment or operation | Required check |
| --- | --- |
| Apple Silicon Mac | Start Docker Desktop, run the documented clean install, sign in, create/import a synthetic record, restart, and recover a backup into a separate instance. Confirm the image is Linux ARM64. Record macOS and Docker Desktop versions. A QEMU CI pass is separate evidence. |
| Native Python setup | Run the [native gate](native-verification.md) from a clean Python environment on each target OS; inspect its generated-configuration, login, persistence, restart, restore, and password-reset results. Check the actual browser workflow separately. |
| Update | Use a retained backup and a candidate update in an isolated library. Preserve the existing Compose project/volume identity. Verify content and credentials after replacement, and rehearse rollback using a separate restored destination. |
| Password recovery | Stop the server, run the documented local password-reset flow, restart, and check the old password, sessions, and extension tokens are invalid. |
| Removal | Follow the documented stop/remove procedure; verify the default path retains the library volume. Treat deliberate data erasure as a separate opt-in action. |
| User interface | Check keyboard navigation, focus visibility, dialog focus/escape behavior, narrow viewport, light/dark themes, helpful empty/error states, and realistic scrolling with the candidate backend. Record any unresolved blocker. |

## Release decision and announcement

Record links or retained reports for the accepted candidate in [verification.md](verification.md). Resolve required failures and document the supported import scope before creating a stable tag. Then align version metadata, changelog, install instructions, and any generated packages; rerun packaging checks on the final release commit.

Only after the gates pass should the maintainer create `1.0.0`, publish its release notes, and use the conditional [launch copy](launch-kit.md). The [public synthetic demo](https://abdulmalikaltararwa-oss.github.io/little-archive/) is already available and has a separate [successful Pages deployment](https://github.com/abdulmalikaltararwa-oss/little-archive/actions/runs/43388893222); it is not an authenticated hosted account service or proof that the stable-release gates have passed.
