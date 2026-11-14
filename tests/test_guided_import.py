"""Guided backlog import through the real routes, in both server modes: resumable upload, a preview before anything is saved, a job that
survives interruption and restart, progress, cancellation, and isolation between accounts. Synthetic exports only; no network."""
from dataclasses import replace
import hashlib
import json
import sqlite3
import threading
import time
import unittest

from server.guided_import import GuidedImports
from support_features import Hosted, SelfHosted
from test_export_readers import ROOT, fixture, instagram_zip, make_zip

IG = "https://www.instagram.com"


def wait_for(check, timeout=20.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        value = check()
        if value:
            return value
        time.sleep(0.02)
    raise AssertionError("timed out waiting")


def tiktok_zip():
    return make_zip({"Data/user_data_tiktok.json": fixture("tiktok_user_data.json")})


def big_instagram_zip(count=5200, duplicates=100):
    entries = []
    for n in range(count + duplicates):
        code = f"SYNTH{n % count:06d}"
        entries.append({"timestamp": 1731000000 - n, "media": [], "label_values": [
            {"label": "URL", "value": f"{IG}/p/{code}/", "href": f"{IG}/p/{code}/"}, {"label": "Caption", "value": f"Synthetic caption {n % count} about pasta"}, {"label": "Title", "value": ""},
            {"dict": [], "title": "Hashtags"}, {"dict": [{"dict": [{"label": "URL", "value": ""}, {"label": "Name", "value": "Ex"}, {"label": "Username", "value": f"user{n % 50}"}], "title": ""}], "title": "Owner"},
            {"dict": [], "title": "Brand partner"}], "fbid": str(n)})
    members = [{"dict": [{"label": "URL", "value": f"{IG}/p/SYNTH{n:06d}/", "href": f"{IG}/p/SYNTH{n:06d}/"}], "title": ""} for n in range(0, 600)]
    collections = [{"timestamp": 1731100000, "media": [], "label_values": [{"label": "Name", "value": "Big collection"}, {"label": "Type", "value": "Collection"}, {"dict": members, "title": "Media"}], "fbid": "1"}]
    return make_zip({f"{ROOT}/your_instagram_activity/saved/saved_posts.json": json.dumps(entries), f"{ROOT}/your_instagram_activity/saved/saved_collections.json": json.dumps(collections)})


class GuidedScenarios:
    harness = None

    def setUp(self):
        self.h = self.harness()
        self.addCleanup(self.h.close)
        self.a = self.h.account()
        self.guided.background = False      # tests drive the job themselves unless one says otherwise

    @property
    def guided(self):
        return self.a.service.guided

    def upload(self, data, name="export.zip", platform="auto", chunk=None, account=None, send=True, **extra):
        account = account or self.a
        guided = account.service.guided
        if chunk:
            guided.limits = replace(guided.limits, chunk_bytes=chunk)
        job = account.ok("POST", "/api/imports/archives", json={"platform": platform, "filename": name, "size_bytes": len(data), **extra})
        if send:
            size = job["upload"]["chunk_size"]
            for index in range(job["upload"]["chunks_total"]):
                account.ok("PUT", f"/api/imports/archives/{job['id']}/chunks/{index}", content=data[index * size:(index + 1) * size])
        return job

    def previewed(self, data, **kwargs):
        job = self.upload(data, **kwargs)
        return self.a.ok("POST", f"/api/imports/archives/{job['id']}/finish")

    def go(self, view, account=None):
        account = account or self.a
        committed = account.ok("POST", f"/api/imports/archives/{view['id']}/commit", json={"digest": view["preview"]["digest"]})
        account.service.guided.drain()
        return committed, account.ok("GET", f"/api/imports/archives/{view['id']}")

    def items(self, account=None, **params):
        return (account or self.a).ok("GET", "/api/items", params={"limit": 200, **params})

    def staged(self, job_id, account=None):
        return (account or self.a).library.root / "imports" / job_id

    # -- the guide
    def test_the_guides_describe_each_platform_as_data(self):
        guide = self.a.ok("GET", "/api/imports/guides")
        self.assertEqual([p["id"] for p in guide["platforms"]], ["instagram", "tiktok"])
        for platform in guide["platforms"]:
            with self.subTest(platform=platform["id"]):
                self.assertTrue(platform["steps"] and all({"id", "title", "detail"} <= set(s) for s in platform["steps"]))
                self.assertEqual(len({s["id"] for s in platform["steps"]}), len(platform["steps"]))
                self.assertEqual(platform["steps"][-1]["id"], "upload")
                self.assertTrue(platform["expect"] and platform["caveats"] and platform["formats"])
                self.assertEqual({f["id"] for f in platform["formats"]}, {"json", "html"} if platform["id"] == "instagram" else {"json", "txt"})
                self.assertEqual(platform["verified"]["real_export_tested"], False)
                self.assertTrue(platform["verified"]["unverified"])
                self.assertEqual(platform["upload"]["chunk_bytes"], self.guided.limits.chunk_bytes)
                self.assertTrue(platform["upload"]["keep_zipped"])
        self.assertEqual(guide["platforms"][0]["choose"]["format"], "JSON")
        self.assertEqual(self.a.call("GET", "/api/imports/guides", headers={"Authorization": "Bearer nope"}).status_code, 401)
        features = self.a.ok("GET", "/api/features")["guided_import"]
        self.assertEqual((features["available"], features["locked"], features["platforms"], features["chunk_bytes"]), (True, False, ["instagram", "tiktok"], self.guided.limits.chunk_bytes))

    # -- the whole flow
    def test_a_preview_comes_before_anything_is_saved_and_the_import_then_runs_as_a_job(self):
        data = instagram_zip()
        piece = -(-len(data) // 8)
        total = -(-len(data) // piece)
        job = self.upload(data, platform="instagram", chunk=piece, sha256=hashlib.sha256(data).hexdigest(), send=False)
        self.assertEqual((job["state"], job["upload"]["chunk_size"], job["upload"]["chunks_total"], job["upload"]["received"]), ("uploading", piece, total, []))
        for index in (0, 1, 2):
            self.a.ok("PUT", f"/api/imports/archives/{job['id']}/chunks/{index}", content=data[index * piece:(index + 1) * piece])
        partial = self.a.ok("GET", f"/api/imports/archives/{job['id']}")
        self.assertEqual((partial["upload"]["received"], partial["upload"]["received_count"], partial["upload"]["complete"], partial["preview"]), ([[0, 2]], 3, False, None))
        early = self.a.call("POST", f"/api/imports/archives/{job['id']}/finish")
        self.assertEqual((early.status_code, early.json()["code"]), (409, "upload_incomplete"))
        self.assertEqual(early.json()["missing"], [[3, total - 1]])
        self.assertEqual(self.a.call("GET", f"/api/imports/archives/{job['id']}/preview").json()["code"], "no_preview")
        for index in range(3, total):
            self.a.ok("PUT", f"/api/imports/archives/{job['id']}/chunks/{index}", content=data[index * piece:(index + 1) * piece])
        before = self.items()["total"]
        view = self.a.ok("POST", f"/api/imports/archives/{job['id']}/finish")
        self.assertEqual((view["state"], self.items()["total"], before), ("previewed", 0, 0), "nothing was saved by a preview")
        preview = view["preview"]
        self.assertEqual((preview["platform"], preview["format"], preview["source_account"]), ("instagram", "json", "default"))
        self.assertEqual(preview["totals"], {"entries": 10, "saves": 6, "new": 6, "already_in_library": 0, "in_library_other_account": 0, "duplicates_in_archive": 1, "unreadable": 3, "in_collections_only": 2})
        self.assertEqual([(c["name"], c["count"], c["exists"]) for c in preview["collections"]], [("Recipes", 3, False), ("Travel", 2, False)])
        self.assertEqual(sorted(u["reason"] for u in preview["unreadable"]), ["collection_without_name", "no_post_link", "not_a_post_or_reel_link"])
        self.assertEqual((preview["ignored"], preview["date_range"]["first"] < preview["date_range"]["last"], len(preview["sample"])), ({"sections": [], "files": 3, "nested_archives": 0}, True, 5))
        self.assertEqual({f["path"].rsplit("/", 1)[1]: f["entries"] for f in preview["files"]}, {"saved_posts.json": 7, "saved_collections.json": 3})
        self.assertEqual(self.a.ok("GET", f"/api/imports/archives/{job['id']}/preview")["preview"], preview)
        self.assertNotIn("PRIVATE", json.dumps(view), "files that are not saved content are never read, so nothing in them can appear")
        # confirming a different preview is refused; so is starting without confirming
        for body in ({"digest": "0" * 64}, {}, None):
            refused = self.a.call("POST", f"/api/imports/archives/{job['id']}/commit", **({"json": body} if body is not None else {}))
            self.assertEqual((refused.status_code, refused.json()["code"]), (409, "digest_mismatch"))
        committed = self.a.ok("POST", f"/api/imports/archives/{job['id']}/commit", json={"digest": preview["digest"]})
        self.assertEqual((committed["state"], committed["progress"]["processed"], committed["progress"]["total"], committed["run_id"] is not None), ("importing", 0, 6, True))
        self.guided.drain()
        done = self.a.ok("GET", f"/api/imports/archives/{job['id']}")
        self.assertEqual((done["state"], done["progress"], done["error"]), ("completed", {"total": 6, "processed": 6, "created": 6, "updated": 0, "skipped": 0, "percent": 100}, None))
        self.assertFalse(self.staged(job["id"]).exists(), "the staged copy is removed once the import is finished")
        # what is now in the library
        listing = self.items()
        self.assertEqual(listing["total"], 6)
        by_code = {i["url"].rstrip("/").rsplit("/", 1)[1]: i for i in listing["items"]}
        pancakes = by_code["SYNTHaaa001"]
        self.assertEqual((pancakes["platform"], pancakes["creator"], pancakes["caption"], pancakes["source_account"], pancakes["saved_at"]), ("instagram", "@example_baker", "Café style lemon pancakes #breakfast", "default", "2024-11-07T17:25:00+00:00"))
        self.assertEqual([c["name"] for c in pancakes["collections"]], ["Recipes"])
        self.assertEqual({c["name"]: c["kind"] for i in listing["items"] for c in i["collections"]}, {"Recipes": "source", "Travel": "source"})
        counts = {c["name"]: c["count"] for c in self.a.ok("GET", "/api/collections")["collections"]}
        self.assertEqual((counts["Recipes"], counts["Travel"]), (3, 2))
        run = self.a.ok("GET", "/api/imports")["imports"][0]
        self.assertEqual((run["id"], run["source"], run["status"], run["created"], run["scopes"]), (done["run_id"], "instagram", "completed", 6, ["export.zip"]))

    def test_importing_the_same_file_again_changes_nothing_and_the_preview_says_so(self):
        first = self.previewed(instagram_zip(), platform="instagram")
        self.go(first)
        edited = next(i for i in self.items()["items"] if i["url"].endswith("SYNTHaaa001/"))
        self.a.ok("PATCH", f"/api/items/{edited['id']}", json={"title": "My own title", "notes": "keep me", "tags": ["mine"]})
        again = self.previewed(instagram_zip(), platform="instagram")
        totals = again["preview"]["totals"]
        self.assertEqual((totals["saves"], totals["new"], totals["already_in_library"]), (6, 0, 6))
        self.assertTrue(all(c["exists"] for c in again["preview"]["collections"]))
        _, done = self.go(again)
        self.assertEqual((done["state"], done["progress"]["created"], done["progress"]["updated"]), ("completed", 0, 6))
        kept = self.a.ok("GET", f"/api/items/{edited['id']}")
        self.assertEqual((kept["title"], kept["notes"], kept["tags"]), ("My own title", "keep me", ["mine"]), "an import never overwrites what the owner wrote")
        self.assertEqual((self.items()["total"], len(self.a.ok("GET", "/api/collections")["collections"])), (6, 2))

    def test_saves_already_in_the_library_are_counted_by_account(self):
        mine = self.a.add_item(f"{IG}/p/SYNTHaaa002/", title="Saved by hand")      # the file importer's account, "default"
        view = self.previewed(instagram_zip(), platform="instagram", source_account="example_user")
        self.assertEqual((view["preview"]["totals"]["already_in_library"], view["preview"]["totals"]["in_library_other_account"], view["preview"]["totals"]["new"]), (0, 1, 6))
        self.a.ok("DELETE", f"/api/imports/archives/{view['id']}")
        same = self.previewed(instagram_zip(), platform="instagram")
        self.assertEqual((same["preview"]["totals"]["already_in_library"], same["preview"]["totals"]["new"]), (1, 5))
        self.go(same)
        self.assertEqual(self.a.ok("GET", f"/api/items/{mine}")["title"], "Saved by hand")

    def test_every_documented_variant_goes_through_the_same_flow(self):
        variants = {
            "french": (instagram_zip("instagram_saved_posts_current_fr.json", "instagram_saved_collections_current_fr.json"), "instagram", 6, ["Recettes", "Voyages"]),
            "older": (instagram_zip("instagram_saved_posts_older.json", None), "instagram", 3, []),
            "html": (make_zip({f"{ROOT}/your_instagram_activity/saved/saved_posts.html": fixture("instagram_saved_posts.html")}), "instagram", 3, []),
            "tiktok json": (tiktok_zip(), "tiktok", 3, []),
            "tiktok txt": (make_zip({"user_data.txt": fixture("tiktok_user_data.txt")}), "tiktok", 2, []),
        }
        for label, (data, platform, saves, collections) in variants.items():
            with self.subTest(label):
                h = self.harness()
                self.addCleanup(h.close)
                account = h.account()
                account.service.guided.background = False
                view = self.upload(data, platform="auto", account=account)
                view = account.ok("POST", f"/api/imports/archives/{view['id']}/finish")
                self.assertEqual((view["preview"]["platform"], view["preview"]["totals"]["saves"], {c["name"] for c in view["preview"]["collections"]}), (platform, saves, set(collections)))
                _, done = self.go(view, account)
                self.assertEqual((done["state"], done["progress"]["created"]), ("completed", saves))
                self.assertEqual(self.items(account=account)["total"], saves)
                self.assertTrue(all(i["platform"] == platform for i in self.items(account=account)["items"]))

    def test_tiktok_favorites_become_tiktok_saves_and_nothing_else_is_imported(self):
        view = self.previewed(tiktok_zip(), platform="tiktok")
        preview = view["preview"]
        self.assertEqual((preview["totals"]["saves"], preview["totals"]["duplicates_in_archive"], preview["totals"]["unreadable"], preview["collections"], preview["collections_read"]), (3, 1, 2, [], False))
        self.assertEqual({s["name"]: s["count"] for s in preview["ignored"]["sections"]}, {"Likes": 3, "Watch history": 4, "Favorite hashtags": 1, "Favorite sounds": 1, "Favorite effects": 0})
        self.assertNotIn("PRIVATE", json.dumps(view))
        self.go(view)
        items = self.items()["items"]
        self.assertEqual({(i["platform"], i["url"]) for i in items}, {("tiktok", "https://www.tiktokv.com/share/video/7400000000000000001/"), ("tiktok", "https://www.tiktokv.com/share/video/7400000000000000002/"),
                                                                       ("tiktok", "https://www.tiktok.com/@example_creator/video/7400000000000000003")})
        self.assertEqual(sorted(i["saved_at"][:10] for i in items), ["2024-03-05", "2024-03-06", "2024-03-08"])
        self.assertEqual(self.items(platform="instagram")["total"], 0)

    def test_a_single_file_chosen_directly_works(self):
        view = self.previewed(fixture("instagram_saved_posts_current_en.json"), name="saved_posts.json", platform="instagram")
        self.assertEqual((view["preview"]["format"], view["preview"]["totals"]["saves"], view["preview"]["files"][0]["path"]), ("json", 4, "saved_posts.json"))
        self.go(view)
        self.assertEqual(self.items()["total"], 4)

    # -- the upload
    def test_pieces_are_checked_and_can_be_sent_again(self):
        data = instagram_zip()
        piece = len(data) // 4 + 1
        job = self.upload(data, chunk=piece, send=False)
        url = f"/api/imports/archives/{job['id']}/chunks/"
        total = job["upload"]["chunks_total"]
        self.assertEqual(total, 4)
        self.assertEqual(self.a.ok("PUT", url + "0", content=data[:piece])["received_count"], 1)
        self.assertEqual(self.a.ok("PUT", url + "0", content=data[:piece])["received_count"], 1, "sending a piece again is harmless")
        for body, index, code in ((b"x" * 10, 0, "bad_chunk_size"), (data[:piece], total, "bad_chunk_index"), (data[:piece], total - 1, "bad_chunk_size"), (b"", 1, "bad_chunk_size"),
                                  (data[:piece], -1, "bad_chunk_index")):
            got = self.a.call("PUT", url + str(index), content=body)
            self.assertEqual((got.status_code, got.json()["code"]), (422, code), (index, len(body)))
        bad = self.a.call("PUT", url + "1", content=data[piece:2 * piece], headers={"X-Chunk-SHA256": "0" * 64})
        self.assertEqual((bad.status_code, bad.json()["code"]), (422, "chunk_checksum_mismatch"))
        good = self.a.ok("PUT", url + "1", content=data[piece:2 * piece], headers={"X-Chunk-SHA256": hashlib.sha256(data[piece:2 * piece]).hexdigest()})
        self.assertEqual(good["received"], [[0, 1]])
        self.a.ok("PUT", url + "3", content=data[3 * piece:])
        self.assertEqual(self.a.ok("GET", f"/api/imports/archives/{job['id']}")["upload"]["received"], [[0, 1], [3, 3]], "what has arrived is listed, so an upload can resume")
        self.a.ok("DELETE", f"/api/imports/archives/{job['id']}")
        late = self.a.call("PUT", url + "2", content=data[2 * piece:3 * piece])
        self.assertEqual((late.status_code, late.json()["code"]), (409, "not_uploading"))

    def test_a_file_that_does_not_match_what_was_announced_is_rejected_and_cleared(self):
        data = instagram_zip()
        job = self.upload(data, sha256="a" * 64)
        refused = self.a.call("POST", f"/api/imports/archives/{job['id']}/finish")
        self.assertEqual((refused.status_code, refused.json()["code"]), (422, "checksum_mismatch"))
        view = self.a.ok("GET", f"/api/imports/archives/{job['id']}")
        self.assertEqual((view["state"], "damaged" in view["error"], self.staged(job["id"]).exists()), ("rejected", True, False))

    def test_exports_that_cannot_be_used_are_rejected_with_a_reason_and_leave_no_trace(self):
        cases = {
            "not a zip": (b"definitely not a zip", "export.zip", "instagram", "not_a_zip"),
            "the wrong platform": (instagram_zip(), "export.zip", "tiktok", "wrong_platform"),
            "nothing saved inside": (make_zip({"readme.txt": b"hello"}), "export.zip", "instagram", "no_saved_data"),
            "an unsafe path": (make_zip({"../evil/saved_posts.json": fixture("instagram_saved_posts_current_en.json")}), "export.zip", "instagram", "unsafe_archive"),
            "a file of text": (b'{"hello": 1}', "notes.json", "auto", "no_saved_data"),
        }
        for label, (data, name, platform, code) in cases.items():
            with self.subTest(label):
                job = self.upload(data, name=name, platform=platform)
                refused = self.a.call("POST", f"/api/imports/archives/{job['id']}/finish")
                self.assertEqual((refused.status_code, refused.json()["code"]), (422, code))
                view = self.a.ok("GET", f"/api/imports/archives/{job['id']}")
                self.assertEqual((view["state"], bool(view["error"]), view["preview"]), ("rejected", True, None))
                self.assertFalse(self.staged(job["id"]).exists())
                self.assertEqual(self.a.call("POST", f"/api/imports/archives/{job['id']}/commit", json={"digest": "x" * 64}).status_code, 409)
        self.assertEqual(self.items()["total"], 0)

    def test_limits_on_size_and_on_how_many_imports_run_at_once(self):
        too_big = self.a.call("POST", "/api/imports/archives", json={"filename": "x.zip", "size_bytes": self.guided.limits.max_archive_bytes + 1})
        self.assertEqual((too_big.status_code, too_big.json()["code"], too_big.json()["max_bytes"]), (413, "file_too_large", self.guided.limits.max_archive_bytes))
        self.assertEqual(self.a.call("POST", "/api/imports/archives", json={"filename": "x.zip", "size_bytes": 0}).status_code, 422)
        self.assertEqual(self.a.call("POST", "/api/imports/archives", json={"filename": "x.zip", "size_bytes": 10, "platform": "myspace"}).status_code, 422)
        self.assertEqual(self.a.call("POST", "/api/imports/archives", json={"filename": "x.zip", "size_bytes": 10, "sha256": "zz"}).status_code, 422)
        first = [self.a.ok("POST", "/api/imports/archives", json={"filename": f"x{n}.zip", "size_bytes": 10})["id"] for n in range(self.guided.limits.max_active)]
        full = self.a.call("POST", "/api/imports/archives", json={"filename": "y.zip", "size_bytes": 10})
        self.assertEqual((full.status_code, full.json()["code"]), (409, "import_in_progress"))
        self.a.ok("DELETE", f"/api/imports/archives/{first[0]}")
        self.assertEqual(self.a.call("POST", "/api/imports/archives", json={"filename": "y.zip", "size_bytes": 10}).status_code, 200)
        self.assertEqual(len(self.a.ok("GET", "/api/imports/archives")["imports"]), self.guided.limits.max_active + 1)

    def test_an_abandoned_import_is_cleared_when_the_next_one_starts(self):
        data = instagram_zip()
        job = self.upload(data, chunk=1000, send=False)
        self.a.ok("PUT", f"/api/imports/archives/{job['id']}/chunks/0", content=data[:1000])
        self.assertTrue(self.staged(job["id"]).exists())
        with self.a.library.transaction() as c:
            c.execute("UPDATE guided_imports SET updated_at='2020-01-01T00:00:00+00:00'")
        self.a.ok("POST", "/api/imports/archives", json={"filename": "next.zip", "size_bytes": 10})
        self.assertEqual((self.a.ok("GET", f"/api/imports/archives/{job['id']}")["state"], self.staged(job["id"]).exists()), ("cancelled", False))

    # -- the job
    def test_a_job_that_stops_part_way_continues_from_where_it_stopped(self):
        self.guided.limits = replace(self.guided.limits, batch_size=2)
        view = self.previewed(instagram_zip(), platform="instagram")
        seen = []

        def stop_after_two_batches(job_id, cursor):
            seen.append(cursor)
            if cursor == 4:
                raise RuntimeError("synthetic failure after a committed batch")

        self.guided.on_batch = stop_after_two_batches
        _, failed = self.go(view)
        self.assertEqual((failed["state"], failed["progress"]["processed"], failed["progress"]["created"], failed["resumable"]), ("failed", 4, 4, True))
        self.assertIn("continue from where it stopped", failed["error"])
        self.assertEqual(self.items()["total"], 4, "what was committed stays")
        self.guided.on_batch = lambda job_id, cursor: seen.append(cursor)
        resumed = self.a.ok("POST", f"/api/imports/archives/{view['id']}/commit", json={})
        self.assertEqual((resumed["state"], resumed["progress"]["processed"]), ("importing", 4), "resuming needs no new confirmation")
        self.guided.drain()
        done = self.a.ok("GET", f"/api/imports/archives/{view['id']}")
        self.assertEqual((done["state"], done["progress"]["processed"], done["progress"]["created"], done["progress"]["skipped"]), ("completed", 6, 6, 0))
        self.assertEqual((seen, self.items()["total"]), ([2, 4, 6], 6), "no batch was repeated and no save was doubled")
        self.assertEqual(len([r for r in self.a.ok("GET", "/api/imports")["imports"] if r["source"] == "instagram"]), 1, "one run in the history, not two")

    def test_a_process_that_dies_mid_job_resumes_from_its_cursor(self):
        self.guided.limits = replace(self.guided.limits, batch_size=2)
        view = self.previewed(instagram_zip(), platform="instagram")
        self.a.ok("POST", f"/api/imports/archives/{view['id']}/commit", json={"digest": view["preview"]["digest"]})

        def die(job_id, cursor):
            if cursor == 2:
                raise KeyboardInterrupt          # not caught by the job: the process is gone

        self.guided.on_batch = die
        with self.assertRaises(KeyboardInterrupt):
            self.guided.drain()
        crashed = self.a.ok("GET", f"/api/imports/archives/{view['id']}")
        self.assertEqual((crashed["state"], crashed["progress"]["processed"]), ("importing", 2))
        # a new process: a fresh job engine over the same library, started by someone looking at the job
        fresh = GuidedImports(self.a.library, replace(self.guided.limits, batch_size=2), background=True)
        self.a.service.guided = fresh
        self.assertEqual(self.a.ok("GET", f"/api/imports/archives/{view['id']}")["state"], "importing")
        done = wait_for(lambda: (v := self.a.ok("GET", f"/api/imports/archives/{view['id']}"))["state"] == "completed" and v)
        self.assertEqual((done["progress"]["processed"], done["progress"]["created"], self.items()["total"]), (6, 6, 6))

    def test_progress_can_be_watched_while_the_job_runs_in_the_background(self):
        self.guided.limits = replace(self.guided.limits, batch_size=2)
        self.guided.background = True
        view = self.previewed(instagram_zip(), platform="instagram")
        gate, reached = threading.Event(), threading.Event()

        def pause(job_id, cursor):
            if cursor == 2:
                reached.set()
                gate.wait(10)

        self.guided.on_batch = pause
        self.a.ok("POST", f"/api/imports/archives/{view['id']}/commit", json={"digest": view["preview"]["digest"]})
        self.assertTrue(reached.wait(10))
        midway = self.a.ok("GET", f"/api/imports/archives/{view['id']}")
        self.assertEqual((midway["state"], midway["progress"]["processed"], midway["progress"]["total"], midway["progress"]["percent"]), ("importing", 2, 6, 33))
        self.assertEqual(self.items()["total"], 2, "what is done is already in the library")
        gate.set()
        done = wait_for(lambda: (v := self.a.ok("GET", f"/api/imports/archives/{view['id']}"))["state"] == "completed" and v)
        self.assertEqual((done["progress"]["percent"], done["progress"]["created"]), (100, 6))

    def test_cancelling_stops_the_job_and_keeps_what_was_saved(self):
        self.guided.limits = replace(self.guided.limits, batch_size=2)
        view = self.previewed(instagram_zip(), platform="instagram")
        self.guided.on_batch = lambda job_id, cursor: self.a.ok("DELETE", f"/api/imports/archives/{job_id}") if cursor == 2 else None
        self.go(view)
        cancelled = self.a.ok("GET", f"/api/imports/archives/{view['id']}")
        self.assertEqual((cancelled["state"], cancelled["progress"]["processed"], cancelled["progress"]["created"], "Saves already imported were kept" in cancelled["error"]), ("cancelled", 2, 2, True))
        self.assertEqual((self.items()["total"], self.staged(view["id"]).exists()), (2, False))
        self.assertEqual(self.a.ok("GET", "/api/imports")["imports"][0]["status"], "cancelled")
        self.assertEqual(self.a.ok("DELETE", f"/api/imports/archives/{view['id']}")["state"], "cancelled", "cancelling again changes nothing")
        self.assertEqual(self.a.call("POST", f"/api/imports/archives/{view['id']}/commit", json={"digest": view["preview"]["digest"]}).status_code, 409)

    def test_a_full_library_stops_the_job_cleanly_and_it_can_continue(self):
        self.guided.limits = replace(self.guided.limits, batch_size=2)
        view = self.previewed(instagram_zip(), platform="instagram")

        def full(job_id, cursor):
            if cursor == 2:
                error = sqlite3.OperationalError("database or disk is full")
                error.sqlite_errorcode = sqlite3.SQLITE_FULL
                raise error

        self.guided.on_batch = full
        _, failed = self.go(view)
        self.assertEqual((failed["state"], failed["progress"]["processed"], "storage limit" in failed["error"]), ("failed", 2, True))
        self.guided.on_batch = None
        self.a.ok("POST", f"/api/imports/archives/{view['id']}/commit", json={})
        self.guided.drain()
        self.assertEqual(self.a.ok("GET", f"/api/imports/archives/{view['id']}")["progress"]["created"], 6)

    def test_an_export_of_five_thousand_saves(self):
        data = big_instagram_zip()
        view = self.previewed(data, platform="instagram", chunk=64 * 1024)
        totals = view["preview"]["totals"]
        self.assertEqual((totals["entries"], totals["saves"], totals["new"], totals["duplicates_in_archive"], totals["unreadable"]), (5300 + 1, 5200, 5200, 100, 0))
        self.assertEqual([(c["name"], c["count"]) for c in view["preview"]["collections"]], [("Big collection", 600)])
        cursors = []
        self.guided.on_batch = lambda job_id, cursor: cursors.append(cursor)
        started = time.time()
        _, done = self.go(view)
        self.assertEqual((done["state"], done["progress"]["processed"], done["progress"]["created"], done["progress"]["percent"]), ("completed", 5200, 5200, 100))
        self.assertEqual((len(cursors), cursors[:3], cursors[-1]), (52, [100, 200, 300], 5200), "progress was reported after every batch of 100")
        self.assertLess(time.time() - started, 120)
        self.assertEqual(self.items(limit=1)["total"], 5200)
        self.assertEqual({c["name"]: c["count"] for c in self.a.ok("GET", "/api/collections")["collections"]}["Big collection"], 600)
        self.assertEqual(self.a.ok("GET", "/api/items", params={"q": "synthetic caption 4999 pasta"})["total"], 1, "what was imported is searchable")


class SelfHostedGuidedTests(GuidedScenarios, unittest.TestCase):
    harness = SelfHosted

    def test_the_limits_for_a_single_owner(self):
        limits = self.guided.limits
        self.assertEqual((limits.max_archive_bytes, limits.chunk_bytes, limits.max_active), (512 * 1024 * 1024, 1024 * 1024, 3))

    def test_routes_need_the_owner(self):
        for method, path in (("GET", "/api/imports/guides"), ("GET", "/api/imports/archives"), ("POST", "/api/imports/archives"), ("GET", "/api/imports/archives/x"),
                             ("PUT", "/api/imports/archives/x/chunks/0"), ("POST", "/api/imports/archives/x/finish"), ("GET", "/api/imports/archives/x/preview"),
                             ("POST", "/api/imports/archives/x/commit"), ("DELETE", "/api/imports/archives/x")):
            with self.subTest(route=method + " " + path):
                self.assertEqual(self.h.client.request(method, path, json={}).status_code, 401)


class HostedGuidedTests(GuidedScenarios, unittest.TestCase):
    harness = Hosted

    def test_a_hosted_account_stages_one_import_at_a_time_in_pieces_that_fit_the_request_limit(self):
        limits = self.guided.limits
        self.assertEqual((limits.max_active, limits.max_archive_bytes, limits.chunk_bytes), (1, 64 * 1024 * 1024, 256 * 1024))
        small = Hosted(hosted_max_json_kb=64)
        self.addCleanup(small.close)
        account = small.account()
        self.assertEqual(account.service.guided.limits.chunk_bytes, 64 * 1024 - 8192)
        data = big_instagram_zip(count=12000, duplicates=0)
        self.assertGreater(len(data), account.service.guided.limits.chunk_bytes, "the export needs more than one piece")
        view = self.upload(data, platform="instagram", account=account)
        view = account.ok("POST", f"/api/imports/archives/{view['id']}/finish")
        self.assertEqual(view["preview"]["totals"]["saves"], 12000)

    def test_it_is_part_of_the_product_not_of_the_unlock(self):
        locked = self.h.account(unlocked=False)
        locked.service.guided.background = False
        view = self.upload(instagram_zip(), platform="instagram", account=locked)
        view = locked.ok("POST", f"/api/imports/archives/{view['id']}/finish")
        _, done = self.go(view, locked)
        self.assertEqual((done["state"], done["progress"]["created"]), ("completed", 6))
        self.assertFalse(locked.ok("GET", "/api/features")["unlocked"])

    def test_an_account_cannot_see_or_touch_anothers_import(self):
        b = self.h.account()
        b.service.guided.background = False
        data = instagram_zip()
        mine = self.previewed(data, platform="instagram", chunk=50000)
        theirs = self.upload(tiktok_zip(), platform="tiktok", account=b, send=False)
        for method, path, kwargs in (("GET", f"/api/imports/archives/{mine['id']}", {}), ("GET", f"/api/imports/archives/{mine['id']}/preview", {}),
                                     ("PUT", f"/api/imports/archives/{mine['id']}/chunks/0", {"content": b"x"}), ("POST", f"/api/imports/archives/{mine['id']}/finish", {}),
                                     ("POST", f"/api/imports/archives/{mine['id']}/commit", {"json": {"digest": mine["preview"]["digest"]}}), ("DELETE", f"/api/imports/archives/{mine['id']}", {})):
            with self.subTest(route=method + " " + path):
                got = b.call(method, path, **kwargs)
                self.assertEqual((got.status_code, got.json()["code"]), (404, "import_not_found"))
                self.assertNotIn(mine["preview"]["digest"], got.text)
        self.assertEqual([j["id"] for j in b.ok("GET", "/api/imports/archives")["imports"]], [theirs["id"]])
        self.assertEqual(self.a.ok("GET", f"/api/imports/archives/{mine['id']}")["state"], "previewed", "nothing B did reached this job")
        self.go(mine)
        self.assertEqual((self.items()["total"], self.items(account=b)["total"]), (6, 0), "A's import landed only in A's library")
        self.assertEqual(self.staged(theirs["id"], b).parent.parent, b.library.root)
        self.assertNotEqual(b.library.root, self.a.library.root)

    def test_deleting_an_account_removes_its_staged_export(self):
        data = instagram_zip()
        job = self.upload(data, chunk=1000, send=False)
        self.a.ok("PUT", f"/api/imports/archives/{job['id']}/chunks/0", content=data[:1000])
        staged = self.staged(job["id"])
        self.assertTrue(staged.exists())
        self.a.ok("POST", "/api/account/delete", json={"confirm": "DELETE"})
        self.assertFalse(staged.exists())
        self.assertFalse(staged.parent.parent.exists(), "the account's whole directory is gone")


if __name__ == "__main__":
    unittest.main()
