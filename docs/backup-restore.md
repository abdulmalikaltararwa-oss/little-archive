# Backup, export, and restore

## Export versus backup

A **portable JSON export** is useful for inspecting records, moving them to another tool, or reimporting content. It includes known source collections, local organization, and annotations. It does not include the bytes of local thumbnails.

A **backup ZIP** contains a consistent SQLite snapshot, referenced local assets, and a verification manifest. Use a backup when you want to recover the instance's library and local images together. Authentication records and reusable credentials are excluded from the downloadable backup.

CSV is useful for spreadsheets but flattens relationships. Netscape bookmark HTML is useful for moving links into another bookmark tool. Neither format is the preferred complete-library recovery format.

## Create a backup

Sign in and use the backup download action. Store the file somewhere separate from the server's primary data directory. A backup on the same failing disk is not an independent recovery copy.

The server snapshots SQLite and includes the local assets referenced by the snapshot. It should fail visibly if an asset recorded as present is missing or invalid. A link-only record with no local thumbnail is valid and does not constitute a missing backup asset.

Backups are staged in the private `LA_DATA_DIR/.backup-work/` directory on the library's disk. Allow free space for a database snapshot plus the compressed archive. Temporary files are removed after a completed download or a handled failure. A process crash can leave a staging directory; remove it only after confirming no backup is running.

## Restore safely

Restore is an offline administrative operation, not a public HTTP endpoint. Stop the application before restoring into a data directory. Use the provided CLI restore command with a separate destination, verify the result, and keep the original directory until the restored library is confirmed usable.

For a downloaded file, the restore command is:

```sh
python -m server.cli restore little-archive-backup-YYYYMMDD.zip --destination ./restored-data
```

The destination must be new and nonexistent. Replace the example filename with the actual downloaded backup. Use the CLI's `--help` for the options in your installed release. A restored library gets a fresh instance identity and needs fresh owner authentication configuration and newly created extension tokens; do not expect old credentials to be revived by a content backup. Set `LA_DATA_DIR` to the restored directory and a new `LA_ADMIN_PASSWORD` before starting it.

After restore, confirm record and collection counts, inspect notes and progress on a few items, open local thumbnails, and test a small export. Do not immediately overwrite your only previous backup with a new unverified one.

## Privacy

A backup can expose saved links, interests, notes, and local images. Protect it as private data. The archive is not automatically encrypted. Do not upload it to a public issue or commit it to Git.
