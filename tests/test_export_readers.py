"""The readers for Instagram and TikTok data exports: every variant, localisation, and what makes an archive unsafe.

The fixtures in tests/fixtures/exports are synthetic and were built from published descriptions of the formats. None is a real
export. Which variants rest on fixtures from an open-source project (Instagram JSON, current layout, English and French) and which
on documentation alone (Instagram HTML, the older collections layout, every TikTok variant) is stated in docs/importing.md."""
import io
import json
from pathlib import Path
import stat
import tempfile
import unittest
import warnings
import zipfile

from server.exports import ExportError, ExportLimits, classify_member, read_export, repair_text
from server.importers import parse_import
from server.storage import normalize_url

FIXTURES = Path(__file__).parent / "fixtures" / "exports"
ROOT = "instagram-example_user-2026-11-10-AbCdEf"


def fixture(name: str) -> bytes:
    return (FIXTURES / name).read_bytes()


def make_zip(members: dict, *, compress=zipfile.ZIP_DEFLATED) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compress) as archive:
        for name, body in members.items():
            archive.writestr(name, body)
    return buffer.getvalue()


def instagram_zip(posts="instagram_saved_posts_current_en.json", collections="instagram_saved_collections_current_en.json", extra=None) -> bytes:
    members = {f"{ROOT}/your_instagram_activity/saved/saved_posts.json": fixture(posts)}
    if collections:
        members[f"{ROOT}/your_instagram_activity/saved/saved_collections.json"] = fixture(collections)
    members[f"{ROOT}/your_instagram_activity/messages/inbox/someone_123/message_1.json"] = b'{"messages":[{"content":"PRIVATE-DM-MARKER"}]}'
    members[f"{ROOT}/your_instagram_activity/media/posts/202411/photo.jpg"] = b"\xff\xd8\xff synthetic"
    members[f"{ROOT}/personal_information/personal_information/personal_information.json"] = b'{"bio":"PRIVATE-PROFILE-MARKER"}'
    members.update(extra or {})
    return make_zip(members)


class Reader:
    """Write bytes to a file the way an upload is staged, then read them."""

    def __init__(self, test):
        self.dir = tempfile.TemporaryDirectory()
        test.addCleanup(self.dir.cleanup)

    def read(self, data: bytes, filename="export.zip", platform="auto", limits=ExportLimits()):
        path = Path(self.dir.name) / "staged.bin"
        path.write_bytes(data)
        return read_export(path, filename, platform, limits)


class TextRepairTests(unittest.TestCase):
    def test_bytes_written_as_characters_are_put_back_and_good_text_is_left_alone(self):
        self.assertEqual(repair_text("faÃ§on cafÃ©"), "façon café")
        self.assertEqual(repair_text("Ø§Ù\u0084Ù\u0084Ø¨Ù\u0086Ø©"), "اللبنة")
        self.assertEqual(repair_text("Café"), "Café", "text that was already right is not touched")
        self.assertEqual(repair_text("plain ascii"), "plain ascii")
        self.assertEqual(repair_text("日本語"), "日本語")
        self.assertEqual(repair_text("Ã"), "Ã", "a lone character that cannot be decoded stays as it is")


class InstagramJsonTests(unittest.TestCase):
    def setUp(self):
        self.reader = Reader(self)

    def test_the_current_layout_gives_saves_creators_captions_dates_and_collections(self):
        read = self.reader.read(instagram_zip(), platform="instagram")
        self.assertEqual((read.platform, read.format, read.entries, len(read.records), read.duplicates), ("instagram", "json", 10, 6, 1))
        by_code = {r["url"].rstrip("/").rsplit("/", 1)[1]: r for r in read.records}
        self.assertEqual(set(by_code), {"SYNTHaaa001", "SYNTHaaa002", "SYNTHaaa003", "SYNTHaaa005", "SYNTHaaa006", "SYNTHaaa007"})
        first = by_code["SYNTHaaa001"]
        self.assertEqual((first["url"], first["creator"], first["caption"], first["saved_at"]), ("https://www.instagram.com/p/SYNTHaaa001/", "@example_baker", "Café style lemon pancakes #breakfast", 1731000300))
        self.assertEqual(by_code["SYNTHaaa002"]["url"], "https://www.instagram.com/p/SYNTHaaa002/", "a reel link is stored under its post identity")
        self.assertEqual(by_code["SYNTHaaa003"]["caption"], "وصفة لبنة منزلية بالزعتر")
        self.assertNotIn("creator", by_code["SYNTHaaa005"], "no owner in the entry, so none is invented")
        self.assertEqual(sorted((c["name"], c["count"]) for c in read.collections), [("Recipes", 3), ("Travel", 2)])
        self.assertEqual(sorted(c["name"] for c in by_code["SYNTHaaa001"]["collections"]), ["Recipes"])
        self.assertTrue(by_code["SYNTHaaa006"]["collection_only"] and by_code["SYNTHaaa007"]["collection_only"], "a save that only a collection mentions is still a save, and is marked")
        self.assertNotIn("saved_at", by_code["SYNTHaaa006"], "a collection's own time is not when a post was saved")
        reasons = sorted(u["reason"] for u in read.unreadable)
        self.assertEqual((read.unreadable_total, reasons), (3, ["collection_without_name", "no_post_link", "not_a_post_or_reel_link"]))
        self.assertEqual((read.ignored_files, read.nested_archives, read.collections_read), (3, 0, True))
        self.assertEqual([f["role"] for f in read.files], ["posts", "collections"])

    def test_the_french_export_reads_the_same_whatever_its_labels_say(self):
        read = self.reader.read(instagram_zip("instagram_saved_posts_current_fr.json", "instagram_saved_collections_current_fr.json"), platform="instagram")
        self.assertEqual((len(read.records), read.duplicates, read.unreadable_total), (6, 1, 3))
        first = next(r for r in read.records if r["url"].endswith("SYNTHaaa001/"))
        self.assertEqual((first["caption"], first["creator"]), ("Pancakes au citron façon café #petitdejeuner", "@example_baker"), "the byte-as-character corruption is repaired")
        self.assertEqual(sorted((c["name"], c["count"]) for c in read.collections), [("Recettes", 3), ("Voyages", 2)])
        self.assertEqual(read.warnings, [])

    def test_an_unknown_language_still_gives_links_dates_and_collections_and_says_what_is_missing(self):
        read = self.reader.read(instagram_zip("instagram_saved_posts_current_unknown_language.json", "instagram_saved_collections_current_unknown_language.json"), platform="instagram")
        self.assertEqual((len(read.records), read.duplicates), (6, 1))
        first = next(r for r in read.records if r["url"].endswith("SYNTHaaa001/"))
        self.assertNotIn("caption", first, "a caption is only read from a label the importer knows")
        self.assertEqual(first["saved_at"], 1731000300)
        self.assertEqual(sorted(c["name"] for c in read.collections), ["レシピ", "旅行"], "a collection name is the first value in the entry when no label is known")
        self.assertTrue(any("language this importer does not know" in w for w in read.warnings))

    def test_the_older_layout_is_read_whatever_the_label_language(self):
        read = self.reader.read(instagram_zip("instagram_saved_posts_older.json", None), platform="instagram")
        self.assertEqual((read.entries, len(read.records), read.duplicates, read.unreadable_total), (5, 3, 1, 1))
        by_code = {r["url"].rstrip("/").rsplit("/", 1)[1]: r for r in read.records}
        self.assertEqual((by_code["SYNTHold001"]["creator"], by_code["SYNTHold001"]["saved_at"]), ("@example_baker", 1600000300))
        self.assertIn("SYNTHold003", by_code, "an entry whose label is in French is read by its link")
        self.assertEqual(read.collections, [])

    def test_the_html_version_gives_links_and_the_dates_it_can_and_says_it_is_partial(self):
        read = self.reader.read(make_zip({f"{ROOT}/your_instagram_activity/saved/saved_posts.html": fixture("instagram_saved_posts.html")}), platform="instagram")
        self.assertEqual((read.format, len(read.records), read.duplicates, read.collections_read), ("html", 3, 1, False))
        by_code = {r["url"].rstrip("/").rsplit("/", 1)[1]: r for r in read.records}
        self.assertEqual(by_code["SYNThtm001"]["saved_at"], 1730991840, "Nov 07, 2024, 3:04 pm, read as UTC")
        self.assertEqual(by_code["SYNThtm002"]["saved_at"], 1730892000, "Nov 06, 2024, 11:20 am")
        self.assertNotIn("saved_at", by_code["SYNThtm003"], "a date in a format the importer does not know is left empty, not guessed")
        self.assertTrue(all("creator" not in r and "caption" not in r for r in read.records))
        self.assertTrue(any("HTML version" in w for w in read.warnings))

    def test_a_file_chosen_directly_works_without_an_archive(self):
        read = self.reader.read(fixture("instagram_saved_posts_current_en.json"), filename="saved_posts.json", platform="instagram")
        self.assertEqual((read.format, len(read.records), read.collections), ("json", 4, []))
        self.assertTrue(any("No collections file" in w for w in read.warnings))

    def test_an_unrecognised_file_name_is_found_by_its_content_but_never_inside_private_folders(self):
        data = make_zip({f"{ROOT}/saved_things_export.json": fixture("instagram_saved_posts_current_en.json")})
        self.assertEqual(len(self.reader.read(data, platform="instagram").records), 4)
        hidden = make_zip({f"{ROOT}/your_instagram_activity/messages/inbox/a/saved_things.json": fixture("instagram_saved_posts_current_en.json")})
        with self.assertRaises(ExportError) as caught:
            self.reader.read(hidden)
        self.assertEqual(caught.exception.code, "no_saved_data")

    def test_a_non_post_link_is_unreadable_not_imported(self):
        body = json.dumps([{"timestamp": 1, "label_values": [{"label": "URL", "value": "https://www.instagram.com/example_user/", "href": "https://www.instagram.com/example_user/"}]},
                           {"timestamp": 2, "label_values": [{"label": "URL", "value": "https://www.instagram.com/p/SYNTHzzz001/", "href": "https://www.instagram.com/p/SYNTHzzz001/"}]}]).encode()
        read = self.reader.read(make_zip({"saved_posts.json": body}), platform="instagram")
        self.assertEqual((len(read.records), read.unreadable_total), (1, 1))


class TikTokTests(unittest.TestCase):
    def setUp(self):
        self.reader = Reader(self)

    def check(self, read):
        self.assertEqual((read.platform, read.entries, len(read.records), read.duplicates), ("tiktok", 6 if read.format == "json" else 4, 3 if read.format == "json" else 2, 1))
        ids = [r["url"] for r in read.records]
        self.assertEqual(ids[0], "https://www.tiktokv.com/share/video/7400000000000000001/")
        self.assertEqual(read.records[0]["saved_at"], "2024-03-05 18:30:12")
        self.assertEqual(read.collections, [], "TikTok's export has no collection names")
        self.assertFalse(read.collections_read)

    def test_json_favorites_only_and_what_else_was_there_is_counted_not_read(self):
        read = self.reader.read(make_zip({"user_data_tiktok.json": fixture("tiktok_user_data.json")}), platform="tiktok")
        self.check(read)
        self.assertEqual({r["url"].rstrip("/").rsplit("/", 1)[1] for r in read.records}, {"7400000000000000001", "7400000000000000002", "7400000000000000003"})
        self.assertEqual(sorted(u["reason"] for u in read.unreadable), ["no_video_link", "not_a_video_link"])
        ignored = {s["name"]: s["count"] for s in read.ignored_sections}
        self.assertEqual(ignored, {"Likes": 3, "Watch history": 4, "Favorite hashtags": 1, "Favorite sounds": 1, "Favorite effects": 0})
        self.assertEqual(read.sections, [{"name": "Favorite Videos", "count": 5}], "entries with a link in the section that was read")

    def test_text_favorites_only(self):
        read = self.reader.read(make_zip({"user_data.txt": fixture("tiktok_user_data.txt")}), platform="tiktok")
        self.check(read)
        self.assertEqual(read.unreadable_total, 1)
        self.assertNotIn("7400000000000000099", json.dumps(read.records), "a liked video is not a favorite")
        self.assertNotIn("PRIVATE-PROFILE-MARKER", json.dumps(read.records))

    def test_a_file_named_for_favorite_videos_needs_no_heading(self):
        text = b"Date: 2024-03-05 18:30:12\nLink: https://www.tiktokv.com/share/video/7400000000000000010/\n"
        read = self.reader.read(text, filename="Favorite Videos.txt", platform="tiktok")
        self.assertEqual([r["url"] for r in read.records], ["https://www.tiktokv.com/share/video/7400000000000000010/"])

    def test_the_link_form_tiktok_uses_has_an_identity_of_its_own(self):
        self.assertEqual(normalize_url("https://www.tiktokv.com/share/video/7400000000000000001/")[:2], ("tiktok", "7400000000000000001"))
        self.assertEqual(normalize_url("https://www.tiktokv.com/share/video/7400000000000000001")[2], "https://www.tiktokv.com/share/video/7400000000000000001/")
        self.assertEqual(normalize_url("https://www.tiktok.com/@example_creator/video/7400000000000000003")[:2], ("tiktok", "7400000000000000003"))
        with self.assertRaises(ValueError):
            normalize_url("https://www.tiktokv.com/share/tag/7400000000000007777/")

    def test_the_older_direct_importer_reads_the_same_text_and_the_current_instagram_layout(self):
        parsed = parse_import(fixture("tiktok_user_data.txt"), "user_data.txt")
        self.assertEqual(sorted({r["url"] for r in parsed["items"]}), ["https://www.tiktokv.com/share/video/7400000000000000001/", "https://www.tiktokv.com/share/video/7400000000000000002/"])
        direct = parse_import(fixture("instagram_saved_posts_current_en.json"), "saved_posts.json")
        self.assertEqual(len(direct["items"]), 6, "every entry that carries a post-like link is offered; the importer applies identity afterwards")
        self.assertEqual(direct["items"][0]["creator"], "@example_baker")


class PlatformDetectionTests(unittest.TestCase):
    def setUp(self):
        self.reader = Reader(self)

    def test_names(self):
        self.assertEqual(classify_member("a/b/saved_posts.json"), ("instagram", "posts"))
        self.assertEqual(classify_member("a/saved_collections.html"), ("instagram", "collections"))
        self.assertEqual(classify_member("user_data_tiktok.json"), ("tiktok", "favorites"))
        self.assertEqual(classify_member("Activity/Favorite Videos.txt"), ("tiktok", "favorites"))
        for name in ("messages/inbox/x/message_1.json", "followers_1.json", "liked_posts.json", "Like List.txt", "saved_posts.json.bak"):
            self.assertIsNone(classify_member(name), name)

    def test_the_wrong_platform_and_an_ambiguous_archive_are_explained(self):
        with self.assertRaises(ExportError) as caught:
            self.reader.read(instagram_zip(), platform="tiktok")
        self.assertEqual((caught.exception.code, "Instagram" in caught.exception.message), ("wrong_platform", True))
        both = make_zip({"saved_posts.json": fixture("instagram_saved_posts_current_en.json"), "user_data_tiktok.json": fixture("tiktok_user_data.json")})
        with self.assertRaises(ExportError) as caught:
            self.reader.read(both, platform="auto")
        self.assertEqual(caught.exception.code, "ambiguous_platform")
        self.assertEqual(self.reader.read(both, platform="tiktok").platform, "tiktok")
        self.assertEqual(self.reader.read(instagram_zip(), platform="auto").platform, "instagram")

    def test_nothing_to_import_says_so(self):
        for data, name in ((make_zip({"readme.txt": b"nothing here"}), "export.zip"), (b'{"hello": "world"}', "export.json")):
            with self.subTest(name):
                with self.assertRaises(ExportError) as caught:
                    self.reader.read(data, filename=name)
                self.assertEqual(caught.exception.code, "no_saved_data")


class SafetyTests(unittest.TestCase):
    def setUp(self):
        self.reader = Reader(self)

    def refused(self, data, code, **kwargs):
        with self.assertRaises(ExportError) as caught:
            self.reader.read(data, **kwargs)
        self.assertEqual(caught.exception.code, code, caught.exception.message)
        self.assertNotIn("PRIVATE", caught.exception.message)

    def test_unsafe_paths_are_refused_outright(self):
        good = fixture("instagram_saved_posts_current_en.json")
        for name in ("../evil/saved_posts.json", "/etc/saved_posts.json", "a/../../saved_posts.json", "..\\evil\\saved_posts.json", "C:\\evil\\saved_posts.json"):
            with self.subTest(name):
                self.refused(make_zip({name: good}), "unsafe_archive")

    def test_a_symbolic_link_an_encrypted_file_and_a_repeated_name_are_refused(self):
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w") as archive:
            link = zipfile.ZipInfo("saved_posts.json")
            link.external_attr = (stat.S_IFLNK | 0o777) << 16
            archive.writestr(link, "/etc/passwd")
        self.refused(buffer.getvalue(), "unsafe_archive")
        raw = bytearray(make_zip({"saved_posts.json": b"[]"}))
        for signature, offset in ((b"PK\x03\x04", 6), (b"PK\x01\x02", 8)):      # the "encrypted" bit, in the local and central headers
            raw[raw.find(signature) + offset] |= 0x01
        self.assertEqual(zipfile.ZipFile(io.BytesIO(bytes(raw))).infolist()[0].flag_bits & 1, 1)
        self.refused(bytes(raw), "unsafe_archive")
        buffer = io.BytesIO()
        with warnings.catch_warnings(), zipfile.ZipFile(buffer, "w") as archive:
            warnings.simplefilter("ignore")
            archive.writestr("a/saved_posts.json", fixture("instagram_saved_posts_current_en.json"))
            archive.writestr("a/saved_posts.json", b"[]")
        self.refused(buffer.getvalue(), "unsafe_archive")

    def test_a_decompression_bomb_is_refused_before_it_is_read(self):
        bomb = make_zip({"saved_posts.json": b" " * (24 * 1024 * 1024)})
        self.assertLess(len(bomb), 100_000)
        self.refused(bomb, "unsafe_archive")

    def test_size_and_count_limits(self):
        data = instagram_zip()
        self.refused(data, "too_large", limits=ExportLimits(max_member_bytes=500))
        self.refused(data, "too_large", limits=ExportLimits(max_total_bytes=500))
        self.refused(data, "too_many_files", limits=ExportLimits(max_members=3))
        self.refused(data, "too_many_records", limits=ExportLimits(max_records=3))
        many = make_zip({f"f{n}.txt": b"x" for n in range(50)} | {"saved_posts.json": fixture("instagram_saved_posts_current_en.json")})
        self.refused(many, "too_many_files", limits=ExportLimits(max_members=10))

    def test_a_file_that_is_not_a_zip_or_is_damaged(self):
        self.refused(b"this is not a zip file at all", "not_a_zip", filename="export.zip")
        truncated = instagram_zip()[:-200]
        self.refused(truncated, "not_a_zip")
        bad_json = make_zip({"saved_posts.json": b"{ not json"})
        self.refused(bad_json, "unreadable")

    def test_files_that_are_not_saved_content_are_counted_never_opened(self):
        """A file whose stored bytes were damaged would fail its checksum if anything opened it. None of these is opened."""
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w", zipfile.ZIP_STORED) as archive:
            archive.writestr(f"{ROOT}/your_instagram_activity/saved/saved_posts.json", fixture("instagram_saved_posts_current_en.json"))
            archive.writestr(f"{ROOT}/your_instagram_activity/messages/inbox/a/message_1.json", b"PRIVATE-DM-MARKER-CORRUPT-ME-" * 20)
            archive.writestr(f"{ROOT}/your_instagram_activity/comments/post_comments_1.json", b"PRIVATE-COMMENT-MARKER-CORRUPT-ME-" * 20)
            archive.writestr(f"{ROOT}/parts/part_2.zip", b"PK nested")
        raw = bytearray(buffer.getvalue())
        for marker in (b"PRIVATE-DM-MARKER", b"PRIVATE-COMMENT-MARKER"):
            at = raw.find(marker)
            raw[at] ^= 0x20     # damages the stored bytes, so reading the file would raise a checksum error
        with self.assertRaises(zipfile.BadZipFile):
            with zipfile.ZipFile(io.BytesIO(bytes(raw))) as check:
                check.read(f"{ROOT}/your_instagram_activity/messages/inbox/a/message_1.json")
        read = self.reader.read(bytes(raw), platform="instagram")
        self.assertEqual((len(read.records), read.ignored_files, read.nested_archives), (4, 2, 1))

    def test_a_damaged_saved_data_file_is_reported_not_trusted(self):
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w", zipfile.ZIP_STORED) as archive:
            archive.writestr("a/saved_posts.json", fixture("instagram_saved_posts_current_en.json"))
            archive.writestr("a/saved_collections.json", fixture("instagram_saved_collections_current_en.json"))
        raw = bytearray(buffer.getvalue())
        raw[raw.find(b"Recipes")] ^= 0x20
        read = self.reader.read(bytes(raw), platform="instagram")
        self.assertEqual(len(read.records), 4, "the intact file was still read")
        self.assertEqual([f["error"] is None for f in read.files], [True, False])
        self.assertTrue(any("could not be read" in w for w in read.warnings))


if __name__ == "__main__":
    unittest.main()
