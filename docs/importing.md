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
