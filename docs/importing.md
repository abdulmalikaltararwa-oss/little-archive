# Imports, source collections, and coverage

An import adds observations to your library. It does not edit or unsave anything on the original platform.

## Two collection types

**Source collections** preserve names and memberships observed in an import. **Local collections** are folders you organize inside Little Archive. An AI suggestion cannot alter a source collection. One item can belong to several collections without becoming several library cards.

## File formats

| Format | Supported shape | Notes |
| --- | --- | --- |
| Little Archive JSON | `format: "little-archive"`, `version: 1`, `items`, optional collection definitions | Preserves portable notes, tags, favorites, progress, and collection kinds. Standalone definitions preserve empty collections and colors. Local asset bytes belong in a backup. |
| Generic JSON | Array of URLs/records, a single URL record, or `{items:[...]}` | Records need `url`, `link`, or `href`. No arbitrary recursive URL harvesting. |
| Instagram JSON | Recognized saved-media/post sections and `string_map_data["Saved on"]` or `string_list_data` records | Export layouts vary. Unrecognized sections fail visibly rather than importing unrelated account data. |
| TikTok JSON | Explicit Favorite/Favourite Videos sections and known favorite-video list fields | Watch history, likes, and messages are not treated as favorites. |
| TikTok TXT | Explicit Favorite Videos section or dedicated favorite-video text file | Reads date/link pairs only from that scope. |
| CSV/TSV | Header row with `url`, `link`, or `href` | Optional title, notes, tags, collections, favorite, and status columns. UTF-8 required. |
| Netscape bookmark HTML | Browser bookmark export with the standard document marker | Folder names become local collections; same-name folder ambiguity may need review. |
| ZIP | Recognized saved/favorite/bookmark files inside an archive | No extraction to disk. Unrelated files are ignored. |
| Official Instagram or TikTok data export | The whole export ZIP or one file from it | Use the [guided backlog import](#guided-backlog-import): it previews before saving and runs as a job. The older single-file importer above also reads the current Instagram saved-posts layout and TikTok `tiktokv.com` links. |

The application's file-import endpoint accepts uploads up to 16 MiB and 20,000 item records. Portable exports may contain up to 5,000 collection definitions. Additional limits apply to selected uncompressed ZIP data, member counts, nesting, and compression ratios. Oversized files should be split into supported saved-data files. Nested or encrypted ZIPs, unsafe paths, and symbolic links are rejected.

Portable source-collection definitions must include their original `platform`, `source_account`, and stable `source_key` when available. Missing scope is reported instead of inventing an empty collection under another account. For a portable JSON bundled with unrelated formats in the same ZIP, import the JSON separately to restore standalone collection definitions and annotations consistently.

Portable JSON also preserves whether a title or summary was deliberately edited. Its boolean `manual_title` and `manual_summary` fields keep an intentionally blank summary protected from later suggestions. These flags are accepted only in the Little Archive format; older exports remain importable with the previous text-based inference.

For CSV, `tags` can be a semicolon-separated string or a JSON array. `collections` can be a JSON array of objects with `name`, `kind`, and optional `source_key`; JSON is preferable when exact membership structure matters. A semicolon-separated collection string creates local collections.

### Minimal generic JSON

```json
{
  "items": [
    {
      "url": "https://example.com/a-guide",
      "title": "A useful guide",
      "notes": "Try the second exercise",
      "tags": ["learning"],
      "collections": [{"name": "Weekend ideas", "kind": "local"}]
    }
  ]
}
```

## Guided backlog import

For a large backlog, the best source is the file each platform will send you: Instagram's "Download your information" and TikTok's "Download your data". The guided import takes that file as the platform gave it (the ZIP, or one file from inside it), shows you what it found **before anything is saved**, and then imports it as a job you can leave and come back to. The step-by-step instructions for requesting the file are served as data by `GET /api/imports/guides` so an interface can draw them; the contract for every route is in [API_CONTRACT.md](../API_CONTRACT.md#guided-backlog-import).

### What each export is read as

| Export | Read as | Basis |
| --- | --- | --- |
| Instagram JSON, current layout (`saved_posts.json`: entries with `label_values`) | Saved posts with link, caption, creator (`@username`) and save date | Synthetic fixtures built from a public open-source project's fixtures, which it documents as real exports with the values replaced (English and French). |
| Instagram `saved_collections.json`, current layout | Collections and the posts in each | Same basis. A post that only a collection mentions is still imported, marked `in_collections_only`, with no save date. |
| Instagram JSON, older layout (`saved_saved_media` with `string_map_data`) | Saved posts with creator and save date; no captions | Community documentation of the layout. The link is found whatever the label says, so a localized "Saved on" works. Older collections files are **not** read, and the preview says so. |
| Instagram HTML (`saved_posts.html`) | Post links and, where a date sits beside one in a format the importer knows, the save date | **Documentation only.** Never checked against a real export. Collections and creators are not read from HTML. |
| TikTok JSON (`user_data_tiktok.json`: `Activity > Favorite Videos > FavoriteVideoList`, each `{Date, Link}`) | Favorite videos with save date | **Documentation and community descriptions only.** No real export was available. Likes, watch history, shares, favorite sounds, hashtags and effects are recognised and counted in the preview but never imported. |
| TikTok TXT (a "Favorite Videos" heading, then `Date:` and `Link:` lines) | The same | **Documentation only**, as above. |

None of the six was checked against a real account's export, and the services change their layouts without notice. The first real export may need a reader change; the preview exists so that is visible before anything is saved.

**Languages.** The reader finds a post by its link and a collection by the list of posts it holds, not by label text. Captions, creators and collection names are read from labels in English and French (taken from the published fixtures) and in Spanish, German, Italian, Portuguese, Dutch and Arabic (best guesses from general knowledge of those languages, **not** checked against any export sample). In any other language the links and dates are still read, collection names fall back to the first value in the entry, and the preview warns that captions and creators are missing. Instagram writes non-ASCII text as UTF-8 bytes shown as separate characters; the reader repairs that, and leaves text that is already right alone.

**TikTok links.** TikTok's export links look like `https://www.tiktokv.com/share/video/<id>/`. They are now recognised as TikTok saves whose identity is the video id, so the same video saved from a `tiktok.com/@user/video/<id>` link or this one is one save. Before this change those links were dropped by the TXT reader and filed as plain web links elsewhere. The export has no creator, caption or cover, and no collection names (TikTok flattens collections into one list), so those arrive later if the save is read.

### The steps

1. `POST /api/imports/archives` declares the file (`platform`, `filename`, `size_bytes`, optional `sha256` and `source_account`) and returns the piece size. The file is sent as numbered pieces (`PUT .../chunks/{n}`) of at most that size; any piece can be sent again, `GET` lists what has arrived, and a dropped connection resumes. The piece size is chosen so every request fits a hosted service's request limit.
2. `POST .../finish` joins the pieces, checks the checksum if one was given, reads the file **without extracting anything** and returns the **preview**: the platform and format; each file read; counts (entries seen, distinct saves, new, already in the library under this account, in the library under another account, duplicates inside the file, unreadable, only in a collection); the collections found with how many saves each holds and whether the collection already exists; sections recognised but not imported; how many files were ignored; the date range; the first five saves; the entries that could not be read and why; and warnings. Nothing has been saved.
3. `POST .../commit` with the preview's `digest` starts the job. The digest ties the confirmation to what was shown; a different one is refused.
4. The job saves in batches of 100 with the same merge every other import uses: it adds a save or refreshes what the source says, never overwrites a title, summary, notes or tags you wrote, and never removes anything. Each batch and the job's cursor are one transaction, so a crash or restart repeats nothing and loses nothing. `GET .../{id}` reports `state` (`uploading`, `previewed`, `importing`, `completed`, `failed`, `cancelled`, `rejected`) and `progress` (`total`, `processed`, `created`, `updated`, `skipped`, `percent`).
5. A job interrupted by a restart continues the next time anyone asks about it (the status route, the list, or `commit` again); the server does not start work on its own at boot. A `failed` job keeps its cursor and `commit` continues it. `DELETE` cancels, removes the staged file, and keeps what was already saved. The run appears in `GET /api/imports` like any other.

**Source account.** Saves are keyed by platform, source account and the platform's own id. The default account is `default`, the same the single-file importer uses, so saves already imported that way are recognised. Give `source_account` (your handle) if you want these kept apart, for example from saves the extension collected under your handle; the preview's `in_library_other_account` count shows when that would make a second copy.

### Limits and safety

An archive is never extracted to disk. Archive paths are checked (a parent-directory, absolute, drive-letter or backslash path, a symbolic link, a password-protected saved-data file, or the same saved-data file twice refuses the whole archive); only files named like saved content are opened (found by content when none is, never under folders named for messages, comments, history and the like); reads are bounded by the bytes actually read, not by what the archive claims; a saved-data file over 1 MiB that is compressed more than 300 to 1 is refused unread; nested ZIPs are counted and ignored; and the unrelated rest of an export is counted, never opened. Limits: the whole file `LA_IMPORT_MAX_ARCHIVE_MB` (512 MiB self-hosted, 64 MiB hosted by default), 200,000 archive members, 96 MiB for any one saved-data file (48 hosted), 256 MiB read in total (96 hosted), and 100,000 saves (50,000 hosted). A TikTok JSON that is larger than that (a very long watch history) should be requested again in the TXT format or with only the activity data. Self-hosted allows three imports in progress, hosted one. An import left alone for three days is cleared when the next one starts. Staged files live in the library's own directory (`imports/`), outside backups, and are removed when the import finishes, is cancelled or is rejected; deleting a hosted account removes them with the rest.

**Not verified:** a real export of either platform; the HTML and TikTok readers (documentation only); the older Instagram collections layout (not read); a live hosted deployment (the 64 MiB staged-file allowance is not counted against an account's storage quota); and an import across a server restart in a deployed process (a simulated crash and a fresh job engine over the same library are tested, not an actual process restart).

## Extension workflow

The initial adapter scans the saved/favorite/collection **view you have selected**. Supply the intended source-account label and exact collection name, then begin the scan. To preserve several collections, scan their views separately using the corresponding names.

The extension collects supported links and visible text, sends bounded batches, and keeps unacknowledged batches for retry. It does not export platform credentials or call guessed private endpoints. A login challenge, unsupported layout, or changed page context should interrupt the operation rather than be reported as an empty library.

The browser must remain available for collection. Closing the popup is different from closing the source tab or browser; consult the displayed run state before resuming. Platform pages change, and adapter support remains experimental until validated for a particular layout.

## What a result means

- **Partial:** some accessible records were collected, but the scan did not establish traversal completion.
- **Enumeration exhausted:** the supported scan reached its observed stopping condition. This is not proof of a complete historical account archive.
- **Applied/replayed:** the server committed a batch, or recognized an identical previously committed batch. Replay should not create duplicates.

The application reports created, updated, and skipped records plus warnings. It does not remove old items or memberships because a later scan fails to see them.

## Evidence limits

A title, caption, thumbnail alternative text, and a complete video transcript are different kinds of evidence. This release supports text evidence and optional text classification. It does not transcribe speech, inspect entire videos, or recover unavailable content.

Preview URLs can expire. A link-only item is still a valid record. You may upload an image you are entitled to use as a local thumbnail; enabling remote previews is a separate setting that causes browser requests to the original image hosts.
