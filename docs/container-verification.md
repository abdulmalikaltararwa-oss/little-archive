# Packaged container verification

The [container harness](../scripts/container_smoke.py) exercises a built Little Archive image with real HTTP requests and the image's restore CLI. It is a release gate for packaging and recovery. Merely adding the harness or building an image does not mean the gate has passed; retain the result for the exact candidate commit and image ID.

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

On an x86 Linux runner, register ARM64 QEMU emulation before building or running the ARM64 image. An emulated pass establishes Linux ARM64 packaging and runtime behavior under QEMU. It does not establish that a physical Mac, Docker Desktop installation, browser, filesystem sharing, or sleep/resume path has been tested. Record a separate Mac acceptance result before claiming a tested Mac installation.

## CI job configuration

Use one architecture per job so each image can be loaded into the runner's ordinary local Docker image store. The [manual Release validation workflow](../.github/workflows/release-validation.yml) includes both architectures; the [Checks workflow](../.github/workflows/checks.yml) covers routine regressions and the original startup smoke check. The following is the equivalent focused container job recipe.

```yaml
container:
  runs-on: ubuntu-latest
  timeout-minutes: 35
  permissions:
    contents: read
  strategy:
    fail-fast: false
    matrix:
      arch: [amd64, arm64]
  steps:
    - uses: actions/checkout@v7
      with:
        persist-credentials: false
    - uses: actions/setup-python@v7
      with:
        python-version: '3.12'
    - name: Register ARM64 emulation
      if: matrix.arch == 'arm64'
      uses: docker/setup-qemu-action@v4
      with:
        platforms: arm64
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

The Docker action major versions above were checked against their official repositories: [QEMU v4](https://github.com/docker/setup-qemu-action), [Buildx v4](https://github.com/docker/setup-buildx-action), and [build-push v7](https://github.com/docker/build-push-action). Docker's [multi-platform Actions guide](https://docs.docker.com/build/ci/github-actions/multi-platform/) documents emulation and the default runner image-store limitation. QEMU registration precedes Buildx, as documented by the QEMU action. The job builds locally and requires no registry credentials or image-publishing permission.

## Limits

These checks use actual packaged code, HTTP, SQLite, local assets, and restore. They use a tiny synthetic library, so they do not measure large-library throughput, long-running disk pressure, real social-page capture, model quality, or browser usability. Run the other [release gates](release-gates.md) as well, and keep their evidence separate.
