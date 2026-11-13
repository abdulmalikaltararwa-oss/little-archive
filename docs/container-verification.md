# Packaged container verification

The [container harness](../scripts/container_smoke.py) exercises a built Little Archive image with real HTTP requests and the image's restore CLI. It is a release gate for packaging and recovery. Merely adding the harness or building an image does not mean the gate has passed; retain the result for the exact candidate commit and image ID.

## Observed candidate result

Both container jobs passed on 2026-11-13 in [Release validation run 43484644844](https://github.com/abdulmalikaltararwa-oss/little-archive/actions/runs/43484644844), for candidate [`505b93b0e07ceeb801ca62e9bb5ae2bd3cac5a6d`](https://github.com/abdulmalikaltararwa-oss/little-archive/commit/505b93b0e07ceeb801ca62e9bb5ae2bd3cac5a6d). Each report records **7 lifecycle checks passed and cleanup passed**, with application version `0.1.0`.

| Image platform | Native runner / observed runtime | Evidence |
| --- | --- | --- |
| `linux/amd64` | `ubuntu-24.04` / `x86_64` | [Job 132089743921](https://github.com/abdulmalikaltararwa-oss/little-archive/actions/runs/43484644844/job/132089743921), [retained JSON](evidence/505b93b0/container-amd64.json) |
| `linux/arm64` | `ubuntu-24.04-arm` / `aarch64` | [Job 132089743561](https://github.com/abdulmalikaltararwa-oss/little-archive/actions/runs/43484644844/job/132089743561), [retained JSON](evidence/505b93b0/container-arm64.json) |

The inspected image IDs were `sha256:3513cce68b8cff79b84249bcab1c14b3c9f5ab3372de77609a42fcafcee62d6b` for AMD64 and `sha256:a768bd9047ce2c9b2fa7174b17297e98251dd99fbadc0b6ddc7bfeb3708dbedb` for ARM64. These identify the actual tested builds; the reusable `little-archive:ci-*` tags do not establish image identity.

The job logs show the strict runtime probe passing on both the original and restored containers: UID/GID `10001`, effective capabilities `0`, `NoNewPrivs` `1`, and read-only `/app` filesystem. Docker configuration checks also required read-only root, all capabilities dropped, no-new-privileges, and `/tmp` tmpfs. Actual owner authentication, content/asset persistence, backup integrity/authentication exclusion, offline restore, and fresh-credential enforcement then passed.

The reports retain full image IDs and platforms. They do **not** contain a source-commit field: their association with this candidate is established by the workflow/artifact metadata, checkout logs, and Buildx revision metadata. The [provenance index](evidence/505b93b0/README.md) records those job/artifact associations and retained-file hashes rather than inferring a commit from a mutable image tag.

The same workflow also passed the separate [Compose lifecycle gate](upgrade-verification.md#observed-candidate-result): 8 checks plus cleanup for actual old-to-candidate image replacement, retained-data removal, and previous-image rollback into a separate volume. Its source refs, runtime image IDs, and packaged-source fingerprints are recorded independently of these same-version container recovery reports.

The [earlier `6fb4c1db` reports](evidence/6fb4c1db/README.md) remain historical evidence for their own builds. The two current reports above record new image executions for `505b93b0`; no earlier pass is assumed to apply to the changed candidate.

## What the harness checks

| Area | Check |
| --- | --- |
| Runtime | The image starts with a read-only root filesystem, all capabilities dropped, `no-new-privileges`, and a writable `/tmp` tmpfs. The process runs as a non-root user; its effective capabilities and architecture are checked inside the container. |
| Owner access | A new random password creates an authenticated owner session. An anonymous client cannot read the library or its local image. |
| Records | Create and edit an item, favorite it, set its progress, search a Unicode note, create local and empty collections, and import synthetic Instagram/TikTok-shaped records from a file. Repeat import must not create duplicates. No platform URL is fetched. |
| Images | Upload an original synthetic PNG and retrieve its stored bytes through the authenticated API. |
| Backup | Download the actual backup endpoint; verify the ZIP, manifest, hashes, SQLite integrity, local image inclusion, and removal of session, token, and owner-password material. |
| Restart | Restart the container and compare records, annotations, collections, image bytes, owner session, and instance identity. |
| Recovery | Stop the original container; run the packaged offline restore CLI against a second fresh volume; start the restored library under a different password. Compare content, empty collections, and image bytes. |
| Credential boundaries | The old password, owner cookie, and import token must fail against the restored instance. Its instance ID must change, its token list must start empty, and an interrupted import must be cancelled. A newly issued token must work. |
| Cleanup | Remove only the containers and volumes created by this run, after checking their unique ownership label. The supplied image is retained. |

## Run on a Docker-enabled machine

Requirements: Python 3.10 or newer on the host, a running Docker Engine or Docker Desktop in Linux-container mode, and a checked-out candidate commit. The application image itself uses its own packaged Python. No host application dependencies are needed for the harness.

Build with a dedicated test tag, then verify it:

```sh
docker build --tag little-archive:verification .
python3 scripts/container_smoke.py --image little-archive:verification --report work/container-verification.json
```

Choose an unused image tag and a new report filename for each retained candidate. The report refuses to overwrite an existing file so an earlier result cannot silently become the current one. Exit status `0` means all checks and cleanup passed. A failure exits nonzero and prints bounded diagnostics with the generated credentials redacted.

The harness creates unique `little-archive-check-...` containers and volumes, publishes random loopback ports, and uses synthetic data. It does not read `.env`, use the operator's Compose project, mount a private library, or stop existing application containers. It does not push or delete the image supplied with `--image`. A daemon outage or host shutdown can prevent cleanup; inspect the `io.little-archive.verification` label before manually removing a leftover test resource. Never use a volume-prune command as part of this check.

## Verify Linux ARM64

On an Apple Silicon Mac with Docker Desktop, build and run the native Linux ARM64 image:

```sh
docker build --platform linux/arm64 --tag little-archive:verification-arm64 .
python3 scripts/container_smoke.py --image little-archive:verification-arm64 --platform linux/arm64 --startup-timeout 180 --report work/container-verification-arm64.json
```

The passing candidate above ran ARM64 on a native ARM64 Linux runner. QEMU on an x86 runner remains useful for optional cross-build checks, but does not replace native ARM runtime acceptance. An earlier QEMU attempt built the ARM64 image and started the server, then failed a runtime-hardening probe. That is historical failed evidence; the current native pass used the unchanged strict assertions.

A native Linux ARM64 pass still does not establish that a physical Mac, Docker Desktop installation, browser, filesystem sharing, or sleep/resume path has been tested. Record a separate Docker Desktop acceptance result before claiming that installation path was tested on a Mac.

## CI job configuration

Use one architecture per native runner so each image can be loaded into that runner's ordinary local Docker image store and its kernel hardening can be checked directly. The [Release validation workflow](../.github/workflows/release-validation.yml) includes both architectures, runs on relevant source pushes to `main`, and can also be dispatched manually. The [Checks workflow](../.github/workflows/checks.yml) covers routine regressions and the original startup smoke check. The following is the equivalent focused container job recipe.

```yaml
container:
  runs-on: ${{ matrix.runner }}
  timeout-minutes: 25
  permissions:
    contents: read
  strategy:
    fail-fast: false
    matrix:
      include:
        - arch: amd64
          runner: ubuntu-24.04
        - arch: arm64
          runner: ubuntu-24.04-arm
  steps:
    - uses: actions/checkout@v7
      with:
        persist-credentials: false
    - uses: actions/setup-python@v7
      with:
        python-version: '3.12'
    - uses: docker/setup-buildx-action@v4
    - name: Build and load the candidate image
      uses: docker/build-push-action@v7
      with:
        context: .
        platforms: linux/${{ matrix.arch }}
        load: true
        push: false
        tags: little-archive:ci-${{ matrix.arch }}
    - name: Verify hardened runtime and recovery
      run: python scripts/container_smoke.py --image little-archive:ci-${{ matrix.arch }} --platform linux/${{ matrix.arch }} --startup-timeout 180 --report work/container-verification-${{ matrix.arch }}.json
```

The action major versions were checked against their official repositories: [Buildx v4](https://github.com/docker/setup-buildx-action) and [build-push v7](https://github.com/docker/build-push-action). GitHub documents its [hosted runner labels and architectures](https://docs.github.com/en/actions/reference/runners/github-hosted-runners). The job builds locally and requires no registry credentials or image-publishing permission.

For an additional cross-build experiment, the official [QEMU v4 action](https://github.com/docker/setup-qemu-action) can register ARM64 emulation before Buildx on an x86 runner. Docker's [multi-platform Actions guide](https://docs.docker.com/build/ci/github-actions/multi-platform/) explains that path and the default runner image-store limitation. Keep its result separate from the native runtime gate.

## Limits

These checks use actual packaged code, HTTP, SQLite, local assets, and restore. They use a tiny synthetic library, so they do not measure large-library throughput or long-running disk pressure. They are separate from the passing browser, synthetic-source MV3, real-model, and Compose upgrade/removal checks in the [verification matrix](verification.md). Live social-page capture, the browser's native extension permission prompt, and the physical-Mac Docker Desktop/operator flow remain pending direct [release gates](release-gates.md).
