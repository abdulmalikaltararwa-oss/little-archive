# Compose upgrade, retained-data removal, and rollback verification

The [upgrade harness](../scripts/upgrade_smoke.py) exercises a real Docker Compose lifecycle between two distinct application revisions. It complements the [container](container-verification.md) and [native](native-verification.md) recovery harnesses, which establish restart and recovery behavior within one revision.

The recorded upgrade path starts at published source commit `85d50bf51504d047ab95fd48992d2e8589318616` and replaces it with candidate `52adf28a5ac1f9a2baecf89442deb8e59577197c`. Both revisions report application version `0.1.0`, so a successful health response or version string alone cannot prove an upgrade. This harness requires different full Git source refs, different inspected image IDs, and different fingerprints of the packaged `server` and `web` files. It also checks the actual running container image before accepting each phase.

## Observed candidate result

**All 8 lifecycle checks and cleanup passed on 2026-11-13** in [job 131791895491](https://github.com/abdulmalikaltararwa-oss/little-archive/actions/runs/43397490019/job/131791895491), part of the successful 12-job [Release validation run 43397490019](https://github.com/abdulmalikaltararwa-oss/little-archive/actions/runs/43397490019). The real execution used Linux AMD64 on `ubuntu-24.04`, Docker Engine `28.0.4`, and Docker Compose `2.38.2`. The [retained lifecycle report](evidence/52adf28a/upgrade.json) and [provenance index](evidence/52adf28a/README.md) identify both source revisions and the exact builds.

| Build | Full source revision | Inspected image ID |
| --- | --- | --- |
| Previous | `85d50bf51504d047ab95fd48992d2e8589318616` | `sha256:380ec91b2b032d37d6d337ee27c50da8c244aaa682e9de9f86be0825d7381152` |
| Candidate | `52adf28a5ac1f9a2baecf89442deb8e59577197c` | `sha256:88d146a9bcfa7bc784afd344e077ceeede40a6077b0027622e0edab075c49c71` |

The packaged `server`/`web` source fingerprints also differ: previous `3d2b026b88b2a03db41b583aac4007560aa986d32d325dad30f459dbce7eb7a7`, candidate `de090c35a9f015f8debe3311f950f873085d8aa8f40622a007047943eca89b80`. The same source-project volume name and hashed actual mount source remained unchanged through replacement and `compose down`/startup. Five runtime probes passed with UID/GID `10001`, zero effective capabilities, no-new-privileges, read-only root, and `x86_64` architecture.

The report confirms that the old owner cookie and CSRF token and the import token worked before any fresh login. Records, edit flags, source/local memberships, empty collections, colors, and thumbnail bytes survived. The rollback used the earlier backup and previous image on a separate volume with fresh authentication, excluded the candidate-only sentinel, and left the upgraded original container and data unchanged. This closes the update/rollback and retain-data removal gates for this revision pair and Linux environment. The physical Mac operator, native Chrome permission, and live-account checks remain separate.

## What is exercised

| Phase | Required behavior |
| --- | --- |
| Identify both builds | Require both local images, matching `org.opencontainers.image.revision` labels, distinct full source refs/image IDs, and the same supported Linux architecture. Record Docker Engine and Compose versions. |
| Start the previous revision | Use an owned, randomly named Compose project, private generated configuration, loopback port, and Compose-managed named volume. Require the actual image ID, non-root user, read-only root, zero effective capabilities, no-new-privileges, and `/tmp` tmpfs. |
| Seed and back up | Through real HTTP, create annotated synthetic records, source and local memberships on the same item, an empty colored collection, a local PNG, owner session, and import-only token. Preserve a deliberately empty summary's edit flag. Download and verify a complete pre-update backup with no reusable authentication material. |
| Replace the image | Prepare both images before stopping the old service. Run Compose `stop archive`, select the candidate image in the same configuration, then run `up -d --no-build archive` in the same project. Require a new container, the candidate image ID and different packaged-source fingerprint, the same actual named-volume mount, and unchanged private environment-file bytes. |
| Preserve access and data | Before any new login, use the original cookie and CSRF token for an authenticated empty PATCH, and use the original import token to check unchanged instance identity. Compare records, timestamps, annotations, source/local/empty collections, colors, database edit flags, and exact thumbnail bytes. Then verify a fresh login with the original password. |
| Write after replacement | Create a candidate-only sentinel record and download a new valid backup. This distinguishes the updated library from the earlier snapshot used for rollback. |
| Remove while retaining data | Execute the documented `docker compose down` without `-v` or `--volumes`. Require the service container and owned network to be gone and the exact named volume to remain. Start the same project again; require original authentication, data, image bytes, and candidate-only sentinel to survive. |
| Roll back separately | Stream the pre-update backup to the **previous image's** offline CLI in a fresh labelled volume, restoring into the nonexistent `/data/restored` destination. Start a different Compose project with the previous image and a new password. Require the original pre-update snapshot and assets, without the post-update sentinel. |
| Require fresh recovery credentials | Reject the old password, session, and import token in the recovered instance. Require an empty token list, a new owner session and token, and a fresh instance identity. |
| Preserve the upgraded original | While the rollback instance runs independently, verify that the original still runs the candidate image in the same container and volume, retains its original authentication, and contains its unchanged updated data and candidate-only sentinel. |
| Clean up | Remove only the containers, volumes, and networks carrying this run's unique ownership label. Keep the supplied images. Report every check and cleanup outcome without credentials. |

The old portable JSON export lacks two edit-intent fields added later. The harness excludes only those two fields from the cross-version JSON comparison and separately compares their actual `manual_title` and `manual_summary` database values. It does not discard timestamps, collection metadata, or annotations to make a comparison pass.

## Prepare and run

Requirements: Python 3.10 or newer, a running Docker Engine or Docker Desktop in Linux-container mode, the Docker Compose plugin, and a clean checkout of the candidate. The host needs no application Python packages. Use a native supported Linux image architecture on the Docker engine. Do not use a real library or existing Compose project for this check.

Build both images with full source-revision labels. The following uses the required baseline and the checked-out candidate; inspect `git status --short` first and use a clean candidate checkout. Choose unused test tags if the example tags already identify an image you need to retain.

```sh
LA_UPGRADE_PREVIOUS_REF=85d50bf51504d047ab95fd48992d2e8589318616
LA_UPGRADE_CANDIDATE_REF="$(git rev-parse HEAD)"
LA_UPGRADE_BASELINE_DIR="$(mktemp -d)"
git archive "$LA_UPGRADE_PREVIOUS_REF" | tar -x -C "$LA_UPGRADE_BASELINE_DIR"
docker build --label "org.opencontainers.image.revision=$LA_UPGRADE_PREVIOUS_REF" --tag little-archive:upgrade-previous "$LA_UPGRADE_BASELINE_DIR"
docker build --label "org.opencontainers.image.revision=$LA_UPGRADE_CANDIDATE_REF" --tag little-archive:upgrade-candidate .
python3 scripts/upgrade_smoke.py \
  --previous-image little-archive:upgrade-previous \
  --candidate-image little-archive:upgrade-candidate \
  --previous-ref "$LA_UPGRADE_PREVIOUS_REF" \
  --candidate-ref "$LA_UPGRADE_CANDIDATE_REF" \
  --report work/upgrade-verification.json
```

If the historical commit is not in the local repository, fetch the repository's history before the `git archive` step. The baseline directory contains only archived source and can be removed after inspection; the harness's private configuration and runtime resources use separate temporary locations. The script never builds, pushes, or removes the two supplied images.

Use `--platform linux/amd64` or `--platform linux/arm64` to require an explicit platform. The two images must agree even when that flag is omitted. `--startup-timeout` defaults to 90 seconds and accepts 15–600 seconds per application startup. Docker commands and HTTP requests also have bounded timeouts. Choose a new report filename on another run; existing reports are never overwritten.

The [Release validation workflow](../.github/workflows/release-validation.yml) prepares the previous source with `git archive`, builds and loads each image with its exact revision label, then runs this harness on an isolated runner. The image tags may be reused by that disposable runner; the report and runtime assertions use the inspected image IDs and packaged-source fingerprints.

## Isolation, failure, and evidence

The harness creates unique `little-archive-upgrade-...` Compose projects with explicit configuration paths, generated owner credentials, and random loopback ports. It never reads a checkout's `.env`, selects an existing project, mounts an operator's library, or uses a global Docker prune operation. Source credentials are retained privately to prove continuity; recovery uses separate fresh credentials. Neither the passwords nor cookies, CSRF values, tokens, private environment contents, database, or backups are written into the report.

The source volume is Compose-managed so the retain-data `down` check exercises ordinary named-volume behavior. The rollback volume is separately created and mounted as an external volume in its own recovery project, matching the documented [separate recovery procedure](backup-restore.md). A rollback never starts the older application against the updated library's writable volume.

On failure, the script returns nonzero, writes a failed report when requested, and prints bounded container diagnostics with generated secrets redacted. Its `finally` cleanup checks ownership labels before removing each resource. A Docker daemon failure can prevent cleanup; retain the failed report and inspect ownership labels before handling any remaining test resources. Do not substitute a broad volume/network prune.

A successful report contains the source refs, OCI labels, image IDs/platforms, packaged-source fingerprints, application version probes, Compose project and volume identities, hashed actual mount sources, runtime-hardening probes, pre-update backup fingerprint, check outcomes, and cleanup result. A stable tag is not implied by the file's existence: require `status: passed`, all lifecycle checks passed, and `cleanup.status: passed`, tied to the intended candidate.

## Scope

This is a real CLI-based image replacement, retain-data removal, and separate rollback rehearsal with a small synthetic library. It does not simulate a future incompatible schema migration or establish an arbitrary downgrade path. Future releases must test their intended previous-version pair and migration behavior.

Linux CI can establish these Compose lifecycle operations. It does not complete physical-Mac Docker Desktop GUI/operator acceptance, native browser extension permission consent, or live Instagram/TikTok capture. Those remaining checks stay in [Mac setup and final live acceptance](mac-acceptance.md) and the [release gates](release-gates.md).
