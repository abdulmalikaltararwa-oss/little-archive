# Backup, export, and restore

## Export versus backup

A **portable JSON export** is useful for inspecting records, moving them to another tool, or reimporting content. It includes known source collections, local organization, and annotations. It does not include the bytes of local thumbnails.

A **backup ZIP** contains a consistent SQLite snapshot, referenced local assets, and a verification manifest. Use a backup when you want to recover the instance's library and local images together. Authentication records and reusable credentials are excluded from the downloadable backup.

CSV is useful for spreadsheets but flattens relationships. Netscape bookmark HTML is useful for moving links into another bookmark tool. Neither format is the preferred complete-library recovery format.

## Create a backup

Sign in and use the backup download action. Store the file somewhere separate from the server's primary data directory. A backup on the same failing disk is not an independent recovery copy.

The server snapshots SQLite and includes the local assets referenced by the snapshot. It should fail visibly if an asset recorded as present is missing or invalid. A link-only record with no local thumbnail is valid and does not constitute a missing backup asset.

Backups are staged in the private `LA_DATA_DIR/.backup-work/` directory on the library's disk. Allow free space for a database snapshot plus the compressed archive. Temporary files are removed after a completed download or a handled failure. A process crash can leave a staging directory; remove it only after confirming no backup is running.

## Restore safely with native Python

Restore is an offline administrative operation, not a public HTTP endpoint. Stop the application before restoring into a data directory. Use the provided CLI restore command with a separate destination, verify the result, and keep the original directory until the restored library is confirmed usable.

For a downloaded file, the restore command is:

```sh
.venv/bin/python -m server.cli restore little-archive-backup-YYYYMMDD.zip --destination ./restored-data
```

The destination must be new and nonexistent. Replace the example filename with the actual downloaded backup. Use the CLI's `--help` for the options in your installed release. A restored library gets a fresh instance identity and needs fresh owner authentication configuration and newly created extension tokens; do not expect old credentials to be revived by a content backup. Set `LA_DATA_DIR` to the restored directory and a new `LA_ADMIN_PASSWORD` before starting it.

After restore, confirm record and collection counts, inspect notes and progress on a few items, open local thumbnails, and test a small export. Do not immediately overwrite your only previous backup with a new unverified one.

## Restore a Docker installation into a separate instance

A Docker volume's mount point already exists, while the restore CLI requires a nonexistent destination. Restore to a new subdirectory, `/data/restored`, inside a **fresh named volume**. The following procedure uses a separate Compose project on `http://localhost:8788`, leaving the original project and volume intact. Stop the original server before taking over its production address; the two instances below use different volumes and ports.

Use a checkout compatible with the backup's schema. Choose the actual absolute backup filename, then create a unique recovery workspace outside the source checkout:

```sh
LA_BACKUP_FILE="/absolute/path/to/little-archive-backup-YYYYMMDD.zip"
LA_RECOVERY_NAME="little-archive-recovery-$(python3 -c 'import secrets; print(secrets.token_hex(6))')"
LA_RECOVERY_DIR="$HOME/LittleArchiveRecovery/$LA_RECOVERY_NAME"
LA_RECOVERY_VOLUME="$LA_RECOVERY_NAME-data"
LA_RECOVERY_IMAGE="$LA_RECOVERY_NAME:local"
mkdir -p "$LA_RECOVERY_DIR"
chmod 700 "$LA_RECOVERY_DIR"
docker build --tag "$LA_RECOVERY_IMAGE" .
docker volume create "$LA_RECOVERY_VOLUME"
```

The next command streams the backup through standard input to an offline, non-root container. It stages the ZIP on the new volume, where large backups are not limited by the container's `/tmp` tmpfs. This also avoids host-file ownership differences between Linux and Docker Desktop. The packaged CLI verifies checksums, schema, database integrity, and referenced images before committing the new directory:

Allow enough disk space for the staged ZIP and its expanded library. The current restore CLI rejects archives or combined expanded members larger than 4 GiB; do not assume a larger backup can be restored by this version.

```sh
docker run --rm --interactive --network none \
  --read-only --cap-drop ALL --security-opt no-new-privileges:true \
  --tmpfs /tmp:size=512m,mode=1777 \
  --volume "$LA_RECOVERY_VOLUME:/data" \
  "$LA_RECOVERY_IMAGE" python -c '
from pathlib import Path
import shutil, subprocess, sys
source = Path("/data/.restore-input.zip")
try:
    with source.open("xb") as target:
        source.chmod(0o600)
        shutil.copyfileobj(sys.stdin.buffer, target)
    subprocess.run([sys.executable, "-m", "server.cli", "restore", str(source), "--destination", "/data/restored"], check=True)
finally:
    source.unlink(missing_ok=True)
' < "$LA_BACKUP_FILE"
```

Continue only after this exits successfully. A failed restore must be investigated before starting the recovered server; never retry by deleting the original library. The CLI refuses an existing `/data/restored` directory, so it cannot overwrite an earlier successful recovery.

Generate a fresh owner password in a private recovery configuration:

```sh
python3 - "$LA_RECOVERY_DIR/.env" "$LA_RECOVERY_IMAGE" "$LA_RECOVERY_VOLUME" <<'PY'
import os, secrets, sys
descriptor = os.open(sys.argv[1], os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(descriptor, "w") as target:
    target.write("LA_RECOVERY_IMAGE=" + sys.argv[2] + "\n")
    target.write("LA_RECOVERY_VOLUME=" + sys.argv[3] + "\n")
    target.write("LA_RECOVERY_PASSWORD=" + secrets.token_urlsafe(30) + "\n")
print("Created private recovery configuration. Open it locally to copy the new owner password.")
PY
```

Save this separate recovery Compose file:

```sh
cat > "$LA_RECOVERY_DIR/compose.yaml" <<'YAML'
services:
  archive:
    image: ${LA_RECOVERY_IMAGE:?Missing recovery image}
    restart: unless-stopped
    ports:
      - "127.0.0.1:8788:8787"
    environment:
      LA_ADMIN_PASSWORD: ${LA_RECOVERY_PASSWORD:?Missing fresh recovery password}
      LA_PUBLIC_URL: http://localhost:8788
      LA_DATA_DIR: /data/restored
      LA_OLLAMA_URL: ""
      LA_OLLAMA_MODEL: ""
    volumes:
      - recovered-library:/data
    read_only: true
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    tmpfs:
      - /tmp:size=512m,mode=1777
volumes:
  recovered-library:
    external: true
    name: ${LA_RECOVERY_VOLUME:?Missing recovery volume}
YAML
docker compose --env-file "$LA_RECOVERY_DIR/.env" -f "$LA_RECOVERY_DIR/compose.yaml" -p "$LA_RECOVERY_NAME" up -d
```

Open `http://localhost:8788` and sign in with the new password from the recovery configuration. If the port is occupied, change both the published port and `LA_PUBLIC_URL` consistently before starting. The old owner password, browser sessions, and extension tokens should fail; issue fresh tokens only after checking the recovered library. Confirm annotations, source and local collections (including empty ones), item counts, thumbnail bytes, and a new export.

Keep the recovery configuration and volume identity together. To stop this separate recovery instance while retaining its volume:

```sh
docker compose --env-file "$LA_RECOVERY_DIR/.env" -f "$LA_RECOVERY_DIR/compose.yaml" -p "$LA_RECOVERY_NAME" down
```

Its volume is declared external, so Compose does not own its lifecycle. Delete it only when you deliberately choose to discard that recovery copy. Keep the original library and backup until the restored instance is confirmed usable and the intended access address has been switched deliberately.

The [container verification harness](container-verification.md) automates the same fresh-volume, packaged-CLI, fresh-credential recovery boundary using only synthetic data. A passing synthetic test is useful release evidence; periodically rehearse recovery of your own backup privately as well.

## Privacy

A backup can expose saved links, interests, notes, and local images. Protect it as private data. The archive is not automatically encrypted. Do not upload it to a public issue or commit it to Git.
