import io
import json
import stat
import unittest
import zipfile

from server.importers import ImportFormatError, parse_import


def blob(value):
    return json.dumps(value, ensure_ascii=False).encode()


def zipped(entries):
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as z:
        for name, data in entries:
            z.writestr(name, data)
    return output.getvalue()


class ImportTests(unittest.TestCase):
    def test_portable_preserves_annotations_and_source_membership(self):
        source = {"format": "little-archive", "version": 1, "items": [{
            "url": "https://www.instagram.com/p/EXAMPLE123/", "title": "مثال",
            "notes": "Remember this", "tags": ["design", "فن"], "favorite": True,
            "status": "done", "needs_review": False, "source_account": "demo",
            "collections": [{"id": "source-id", "name": "  Exact Spelling  ", "kind": "source"}, {"name": "Ideas", "kind": "local"}],
            "evidence": [{"kind": "thumbnail_alt", "text": "cover text"}],
        }]}
        result = parse_import(blob(source), "export.json")
        item = result["items"][0]
        self.assertTrue(result["portable"])
        self.assertEqual(item["collections"][0], {"name": "  Exact Spelling  ", "kind": "source", "source_key": "source-id"})
        self.assertEqual(item["notes"], "Remember this")
        self.assertTrue(item["favorite"])
        self.assertEqual(item["status"], "done")
        self.assertEqual(item["evidence"][0]["kind"], "thumbnail_alt")
        self.assertFalse(item["needs_review"])

    def test_portable_reference_collections_resolve(self):
        source = {"format": "little-archive", "version": 1, "collections": [{"id": "c1", "name": "Recipes", "kind": "source"}], "items": [{"url": "https://example.com/one", "collection_ids": ["c1"]}]}
        self.assertEqual(parse_import(blob(source), "a.json")["items"][0]["collections"][0]["name"], "Recipes")

    def test_only_portable_boolean_flags_preserve_edit_intent(self):
        record = {"url": "https://example.com/annotation", "summary": "", "manual_title": False, "manual_summary": True}
        source = {"format": "little-archive", "version": 1, "items": [record]}
        item = parse_import(blob(source), "export.json")["items"][0]
        self.assertIs(item["manual_title"], False)
        self.assertIs(item["manual_summary"], True)
        self.assertEqual(item["summary"], "")
        generic = parse_import(blob([record]), "links.json")["items"][0]
        self.assertNotIn("manual_title", generic)
        self.assertNotIn("manual_summary", generic)
        source["items"][0].update(manual_title="false", manual_summary=1)
        invalid = parse_import(blob(source), "export.json")["items"][0]
        self.assertNotIn("manual_title", invalid)
        self.assertNotIn("manual_summary", invalid)

    def test_portable_empty_collections_preserve_scope_and_color(self):
        source = {"format": "little-archive", "version": 1, "items": [], "collections": [
            {"id": "old-local-id", "name": "Empty ideas", "kind": "local", "color": "#d7A5ae", "platform": "ignored", "source_account": "ignored", "extra_secret": "do not retain"},
            {"id": "old-source-id", "name": " Exact source name ", "kind": "source", "source_key": "platform-scope-42", "platform": "instagram", "source_account": "example-account", "color": "#123456"},
        ]}
        parsed = parse_import(blob(source), "export.json")
        self.assertEqual(parsed["items"], [])
        self.assertTrue(parsed["portable"])
        self.assertEqual(len(parsed["collections"]), 2)
        local, original = parsed["collections"]
        self.assertEqual(local["name"], "Empty ideas")
        self.assertEqual(local["color"], "#d7A5ae")
        self.assertEqual((local["platform"], local["source_account"]), ("web", "local"))
        self.assertEqual(original, {"name": " Exact source name ", "kind": "source", "source_key": "platform-scope-42", "platform": "instagram", "source_account": "example-account", "color": "#123456"})
        self.assertNotIn("id", local)
        self.assertNotIn("extra_secret", local)

    def test_portable_collection_reference_uses_preserved_source_key(self):
        source = {"format": "little-archive", "version": 1, "items": [{"url": "https://www.instagram.com/p/EXAMPLE123/", "source_account": "example-account", "collection_ids": ["exported-id"]}], "collections": [{"id": "exported-id", "name": "Original", "kind": "source", "source_key": "source-key", "platform": "instagram", "source_account": "example-account", "color": "#010203"}]}
        result = parse_import(blob(source), "export.json")
        self.assertEqual(result["collections"][0]["source_key"], "source-key")
        self.assertEqual(result["items"][0]["collections"][0]["source_key"], "source-key")

    def test_portable_collection_validation_warns_and_fails_closed(self):
        source = {"format": "little-archive", "version": 1, "items": [], "collections": [
            {"id": {"bad": "type"}, "name": "Valid local", "kind": "local", "color": "url(javascript:bad)"},
            {"name": "Missing scope", "kind": "source"},
            {"name": "Bad scope", "kind": "source", "platform": "unknown", "source_account": "example"},
            {"name": "", "kind": "local"},
        ]}
        result = parse_import(blob(source), "export.json")
        self.assertEqual(len(result["collections"]), 1)
        self.assertEqual(result["collections"][0]["color"], "#6F8A72")
        self.assertTrue(result["warnings"])
        for bad in (None, {}, "bad"):
            with self.assertRaisesRegex(ImportFormatError, "array"):
                parse_import(blob({"format": "little-archive", "version": 1, "items": [], "collections": bad}), "export.json")

    def test_portable_zip_keeps_empty_collection_definitions(self):
        source = {"format": "little-archive", "version": 1, "items": [], "collections": [{"name": "Empty folder", "kind": "local", "color": "#010203"}]}
        parsed = parse_import(zipped([("little-archive-export.json", blob(source))]), "backup-of-export.zip")
        self.assertTrue(parsed["portable"])
        self.assertEqual(parsed["collections"][0]["name"], "Empty folder")

    def test_portable_collection_count_limit(self):
        source = {"format": "little-archive", "version": 1, "items": [], "collections": [{"name": "Folder", "kind": "local"}] * 5001}
        with self.assertRaisesRegex(ImportFormatError, "5,000"):
            parse_import(blob(source), "export.json")

    def test_long_source_key_matches_definition_and_membership(self):
        key = "s" * 450
        source = {"format": "little-archive", "version": 1, "items": [{"url": "https://www.instagram.com/p/EXAMPLE123/", "collection_ids": ["ref"]}], "collections": [{"id": "ref", "name": "Original", "kind": "source", "source_key": key, "platform": "instagram", "source_account": "example-account"}]}
        result = parse_import(blob(source), "export.json")
        self.assertEqual(result["collections"][0]["source_key"], key)
        self.assertEqual(result["items"][0]["collections"][0]["source_key"], key)

    def test_instagram_saved_on_only(self):
        source = {"saved_saved_media": [{"title": "example_creator", "string_map_data": {"Saved on": {"href": "https://www.instagram.com/reel/EXAMPLE123/", "timestamp": 1700000000}}}], "messages": [{"url": "https://example.com/private"}]}
        result = parse_import(blob(source), "saved_posts.json")
        self.assertEqual(len(result["items"]), 1)
        self.assertEqual(result["items"][0]["creator"], "example_creator")
        self.assertTrue(result["items"][0]["saved_at"].endswith("Z"))
        self.assertFalse(result["portable"])

    def test_tiktok_explicit_sections_ignore_watch_history(self):
        source = {"Activity": {"Favorite Videos": {"FavoriteVideoList": [{"Date": "2026-01-01", "Link": "https://www.tiktok.com/@example/video/123456"}]}, "Watch History": {"VideoList": [{"Link": "https://example.com/private"}]}}}
        items = parse_import(blob(source), "user_data_tiktok.json")["items"]
        self.assertEqual(len(items), 1)
        self.assertIn("tiktok.com", items[0]["url"])

    def test_unrelated_account_json_rejected(self):
        with self.assertRaises(ImportFormatError):
            parse_import(blob({"Direct Messages": [{"Link": "https://example.com/secret"}]}), "account.json")

    def test_csv_annotations_and_json_collections(self):
        import csv
        s = io.StringIO()
        w = csv.DictWriter(s, fieldnames=["url", "title", "notes", "favorite", "tags", "collections"])
        w.writeheader()
        w.writerow({"url": "https://example.com/one", "title": "Hello", "notes": "A, B", "favorite": "true", "tags": '["one","two"]', "collections": '[{"name":"Original","kind":"source","source_key":"s1"}]'})
        item = parse_import(s.getvalue().encode(), "export.csv")["items"][0]
        self.assertEqual(item["notes"], "A, B")
        self.assertEqual(item["tags"], ["one", "two"])
        self.assertTrue(item["favorite"])
        self.assertEqual(item["collections"][0]["kind"], "source")

    def test_unsafe_url_skipped(self):
        result = parse_import(blob([{"url": "javascript:alert(1)"}, {"url": "https://name:secret@example.com/"}, {"url": "https://example.com/safe"}]), "items.json")
        self.assertEqual(len(result["items"]), 1)
        self.assertTrue(result["warnings"])

    def test_bookmarks_nested_folder_memberships(self):
        html = b'<!DOCTYPE NETSCAPE-Bookmark-file-1><DL><DT><H3>Ideas</H3><DL><DT><H3>Design</H3><DL><DT><A HREF="https://example.com/a" ADD_DATE="1700000000">A &amp; B</A></DL></DL></DL>'
        item = parse_import(html, "bookmarks.html")["items"][0]
        self.assertEqual(item["title"], "A & B")
        self.assertEqual([c["name"] for c in item["collections"]], ["Ideas", "Design"])

    def test_arbitrary_html_rejected(self):
        with self.assertRaises(ImportFormatError):
            parse_import(b'<html><a href="https://example.com/a">A</a></html>', "page.html")

    def test_tiktok_text_section_does_not_leak_likes(self):
        text = b'Favorite Videos:\nDate: 2026-01-01\nLink: https://www.tiktok.com/@demo/video/123\n\nLike List:\nDate: 2026-01-02\nLink: https://www.tiktok.com/@demo/video/456\n'
        result = parse_import(text, "account.txt")
        self.assertEqual(len(result["items"]), 1)
        self.assertTrue(result["items"][0]["url"].endswith("123"))

    def test_tiktok_host_suffix_spoof_rejected(self):
        text = b'Date: 2026-01-01\nLink: https://eviltiktok.com/@demo/video/123\n'
        self.assertEqual(parse_import(text, "Favorite Videos.txt")["items"], [])

    def test_zip_only_selected_files(self):
        data = zipped([("saved/saved_posts.json", blob({"saved_saved_media": [{"url": "https://example.com/saved"}]})), ("messages/message_1.json", blob([{"url": "https://example.com/private"}]))])
        result = parse_import(data, "account.zip")
        self.assertEqual([i["url"] for i in result["items"]], ["https://example.com/saved"])

    def test_zip_known_tiktok_container(self):
        data = zipped([("user_data_tiktok.json", blob({"Favorite Videos": [{"Link": "https://www.tiktok.com/@demo/video/123"}]}))])
        self.assertEqual(len(parse_import(data, "account.zip")["items"]), 1)

    def test_zip_traversal_rejected(self):
        data = zipped([("../saved_posts.json", b"[]")])
        with self.assertRaisesRegex(ImportFormatError, "unsafe"):
            parse_import(data, "account.zip")

    def test_zip_symlink_rejected(self):
        out = io.BytesIO()
        with zipfile.ZipFile(out, "w") as z:
            info = zipfile.ZipInfo("saved_posts.json")
            info.create_system = 3
            info.external_attr = (stat.S_IFLNK | 0o777) << 16
            z.writestr(info, "/etc/passwd")
        with self.assertRaisesRegex(ImportFormatError, "symbolic"):
            parse_import(out.getvalue(), "account.zip")

    def test_zip_bomb_ratio_rejected(self):
        data = zipped([("saved_posts.json", b" " * (2 * 1024 * 1024))])
        with self.assertRaisesRegex(ImportFormatError, "compression"):
            parse_import(data, "account.zip")

    def test_nested_zip_rejected(self):
        with self.assertRaisesRegex(ImportFormatError, "Nested"):
            parse_import(zipped([("nested.zip", b"test")]), "account.zip")

    def test_empty_recognized_source_is_valid(self):
        self.assertEqual(parse_import(blob({"saved_saved_media": []}), "saved_posts.json")["items"], [])

    def test_wrong_export_version_rejected(self):
        with self.assertRaisesRegex(ImportFormatError, "version"):
            parse_import(blob({"format": "little-archive", "version": 2, "items": []}), "export.json")

    def test_input_and_nesting_bounds(self):
        with self.assertRaisesRegex(ImportFormatError, "16 MiB"):
            parse_import(b"a" * (16 * 1024 * 1024 + 1), "items.json")
        value = {}
        for _ in range(32):
            value = {"x": value}
        with self.assertRaisesRegex(ImportFormatError, "nesting"):
            parse_import(blob(value), "items.json")


if __name__ == "__main__":
    unittest.main()
