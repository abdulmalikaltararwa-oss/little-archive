"""Places: where coordinates may come from, extraction (schema.org data, text rules, a stubbed provider), edits that win,
the opt-in geocoder's usage-policy behaviour, the library-wide list for a map, hosted gating and isolation.
No network and no real geocoder: the geocoder talks to a mock transport and a fake clock."""
import json
import unittest

import httpx

from server.enrich import places as places_module
from server.enrich.features import FeatureSettings
from server.enrich.places import Geocoder, coordinates_from_url, coordinates_in_text
from support_features import Hosted, SelfHosted, StubProvider, page_html

TEXT = """Best coffee in Vienna
📍 Café Central, Herrengasse 14, Vienna
☕ Best coffee ever
📍 Naschmarkt https://www.google.com/maps/place/Naschmarkt/@48.1986,16.3629,17z
Location: Prater 48.2166, 16.3959
Coordinates: 48.2104, 16.3655
#vienna"""
URL_GEOCODER = "https://nominatim.example.org"


class CoordinateTests(unittest.TestCase):
    def test_only_explicit_coordinates_are_read(self):
        self.assertEqual(coordinates_in_text("at 48.2104, 16.3655 today")[0]["lat"], 48.2104)
        south_west = coordinates_in_text("41.0123° S, 72.5678° W")[0]
        self.assertEqual((south_west["lat"], south_west["lon"]), (-41.0123, -72.5678))
        for text in ("It cost 12.50, then 3.99 more", "version 1.2.3, build 4.5.6", "0.000, 0.000", "95.1234, 20.1234", "48.2, 16.4"):
            with self.subTest(text=text):
                self.assertEqual(coordinates_in_text(text), [], "prices, versions, null island, out-of-range and low-precision pairs are not coordinates")

    def test_map_links_carry_coordinates_and_a_name_only_when_they_say_so(self):
        google = coordinates_from_url("https://www.google.com/maps/place/Caf%C3%A9+Central/@48.2104,16.3655,17z/data=!3m1")
        self.assertEqual((google["lat"], google["lon"], google["name"]), (48.2104, 16.3655, "Café Central"))
        self.assertEqual(coordinates_from_url("https://www.google.com/maps?q=48.2104,16.3655")["lat"], 48.2104)
        self.assertEqual(coordinates_from_url("https://maps.apple.com/?ll=48.2104,16.3655&q=Naschmarkt")["name"], "Naschmarkt")
        self.assertEqual(coordinates_from_url("https://www.openstreetmap.org/#map=17/48.2104/16.3655")["lon"], 16.3655)
        self.assertIsNone(coordinates_from_url("https://maps.app.goo.gl/AbCdEf"), "a short link cannot be read without a request")
        self.assertIsNone(coordinates_from_url("https://example.com/maps/@48.2104,16.3655"))


class SettingsTests(unittest.TestCase):
    def test_the_geocoder_is_off_unless_the_operator_turns_it_on_properly(self):
        self.assertFalse(FeatureSettings.from_env({}).geocoding_enabled)
        on = FeatureSettings.from_env({"LA_GEOCODER_URL": URL_GEOCODER + "/", "LA_GEOCODER_CONTACT": "ops@example.org"})
        self.assertEqual((on.geocoding_enabled, on.geocoder_url, on.geocoder_min_interval), (True, URL_GEOCODER, 1.1))
        self.assertNotIn("ops@example.org", repr(on), "the contact is not echoed into logs")
        for values in ({"LA_GEOCODER_URL": URL_GEOCODER}, {"LA_GEOCODER_CONTACT": "ops@example.org"}, {"LA_GEOCODER_URL": "http://nominatim.example.org", "LA_GEOCODER_CONTACT": "ops@example.org"},
                       {"LA_GEOCODER_URL": URL_GEOCODER + "?key=1", "LA_GEOCODER_CONTACT": "ops@example.org"}, {"LA_GEOCODER_URL": "https://user:pw@nominatim.example.org", "LA_GEOCODER_CONTACT": "ops@example.org"},
                       {"LA_GEOCODER_URL": URL_GEOCODER, "LA_GEOCODER_CONTACT": "ops@example.org", "LA_GEOCODER_MIN_INTERVAL_SECONDS": "0.2"},
                       {"LA_GEOCODER_URL": URL_GEOCODER, "LA_GEOCODER_CONTACT": "ops@example.org", "LA_GEOCODER_CACHE_DAYS": "0"}):
            with self.subTest(values=values):
                with self.assertRaises(ValueError):
                    FeatureSettings.from_env(values)
        self.assertTrue(FeatureSettings.from_env({"LA_GEOCODER_URL": "http://127.0.0.1:8080", "LA_GEOCODER_CONTACT": "ops@example.org"}).geocoding_enabled, "a local geocoder may use plain HTTP")


class FakeGeocoderWorld:
    """A mock geocoder, a clock that only moves when the code sleeps, and a record of every request."""

    def __init__(self, answers=None, status=200):
        self.requests, self.slept, self.now, self.status = [], [], [1000.0], status
        self.answers = answers if answers is not None else {}
        places_module._NEXT_REQUEST.clear()

    def handler(self, request):
        self.requests.append(request)
        if self.status != 200:
            return httpx.Response(self.status, text="busy")
        query = request.url.params["q"]
        hit = self.answers.get(query)
        return httpx.Response(200, json=[hit] if hit else [])

    def sleep(self, seconds):
        self.slept.append(seconds)
        self.now[0] += seconds

    def geocoder(self, url=URL_GEOCODER):
        settings = FeatureSettings.from_env({"LA_GEOCODER_URL": url, "LA_GEOCODER_CONTACT": "ops@example.org"})
        return Geocoder(settings, client=httpx.Client(transport=httpx.MockTransport(self.handler)), clock=lambda: self.now[0], sleep=self.sleep)


BAKERY = {"lat": "51.5007", "lon": "-0.1246", "display_name": "Harbour Bakery, 12 Quay Street, Portville, Examplia", "osm_type": "node", "osm_id": 42, "category": "shop", "type": "bakery", "addresstype": "shop"}
PORTVILLE = {"lat": "51.5", "lon": "-0.12", "display_name": "Portville, Examplia", "osm_type": "relation", "osm_id": 7, "category": "boundary", "type": "administrative", "addresstype": "city"}


class PlaceScenarios:
    harness = None

    def setUp(self):
        self.h = self.harness()
        self.addCleanup(self.h.close)
        self.a = self.h.account()

    def extract(self, iid, account=None, **body):
        return (account or self.a).ok("POST", f"/api/items/{iid}/places/extract", json=body)

    def put(self, iid, places, account=None):
        return (account or self.a).ok("PUT", f"/api/items/{iid}/places", json={"places": places})

    def test_a_save_with_no_places_says_so(self):
        iid = self.a.add_item(caption="Lovely day.")
        got = self.a.ok("GET", f"/api/items/{iid}/places")
        self.assertEqual((got["status"], got["places"], got["edited"]), ("none", [], False))
        self.assertEqual(got["available"]["geocoding"], {"enabled": False, "attribution": None})

    def test_schema_org_places_come_with_the_coordinates_the_page_gives(self):
        iid = self.a.add_item("https://example.com/harbour-bakery", title="Bakery")
        self.a.ok("POST", f"/api/items/{iid}/page", json={"html": page_html("place_jsonld.html")})
        got = self.extract(iid)
        place = got["places"][0]
        self.assertEqual((place["name"], place["kind"], place["city"], place["country"], place["address"]), ("Harbour Bakery", "bakery", "Portville", "Examplia", "12 Quay Street, Portville"))
        self.assertEqual(place["coordinates"], {"lat": 51.5007, "lon": -0.1246, "source": "source", "detail": "jsonld", "provider": "", "precision": "point"})
        self.assertEqual((place["origin"], got["extraction"]["method"]), ("jsonld", "jsonld+rules"))

    def test_text_rules_find_pinned_places_and_tie_coordinates_only_to_their_own_line(self):
        iid = self.a.add_item(caption=TEXT)
        got = self.extract(iid)
        by_name = {p["name"]: p for p in got["places"]}
        self.assertEqual(set(by_name), {"Café Central", "Naschmarkt", "Prater"})
        cafe = by_name["Café Central"]
        self.assertEqual((cafe["kind"], cafe["address"], cafe["coordinates"], cafe["evidence"]["source"]), ("cafe", "Herrengasse 14, Vienna", None, "caption"))
        self.assertIn("Herrengasse 14", cafe["evidence"]["quote"])
        self.assertEqual(by_name["Naschmarkt"]["coordinates"]["detail"], "maps_link")
        self.assertEqual((by_name["Prater"]["coordinates"]["lat"], by_name["Prater"]["coordinates"]["source"]), (48.2166, "source"))
        self.assertEqual(got["extraction_result"]["unattached_coordinates"], 1, "a coordinate on a line of its own is not attached to any place")
        self.assertFalse(any(abs((p["coordinates"] or {"lat": 0})["lat"] - 48.2104) < 1e-6 for p in got["places"]))
        self.assertNotIn("Best coffee ever", by_name, "a coffee emoji is not a location pin")

    def test_no_provider_is_clear_and_nothing_is_invented(self):
        iid = self.a.add_item(caption="Went somewhere amazing for lunch with Sara.")
        got = self.extract(iid)
        self.assertEqual((got["places"], got["extraction_result"]["found"], got["extraction_result"]["reason"], got["extraction_result"]["ai_available"]), ([], False, "ai_not_configured", False))
        refused = self.a.call("POST", f"/api/items/{iid}/places/extract", json={"method": "ai"})
        self.assertEqual((refused.status_code, refused.json()["code"]), (503, "ai_not_configured"))
        self.assertEqual(self.extract(self.a.add_item("https://example.com/blank"))["extraction_result"]["reason"], "no_text")

    def test_a_provider_may_only_name_what_the_text_names(self):
        answer = {"places": [
            {"name": "Trattoria Da Enzo", "kind": "restaurant", "city": "Rome", "country": "Italy", "address": "", "quote": "Trattoria Da Enzo in Rome", "lat": 41.9, "lon": 12.5},
            {"name": "Colosseum", "kind": "landmark", "city": "Rome", "country": "Italy", "address": "", "quote": "Colosseum"},
            {"name": "example_cook", "kind": "other", "city": "", "country": "", "address": "", "quote": "example_cook"},
            {"name": "Piazza Navona", "kind": "attraction", "city": "", "country": "", "address": "", "quote": "walked past Piazza Navona"}]}
        provider = self.a.use(StubProvider([answer]))
        iid = self.a.add_item(caption="Best carbonara at Trattoria Da Enzo in Rome last week, then walked past Piazza Navona.", creator="@example_cook")
        got = self.extract(iid)
        names = {p["name"]: p for p in got["places"]}
        self.assertEqual(set(names), {"Trattoria Da Enzo", "Piazza Navona"}, "a place the text does not name and the creator's own account are dropped")
        enzo = names["Trattoria Da Enzo"]
        self.assertEqual((enzo["city"], enzo["country"], enzo["coordinates"], enzo["origin"]), ("Rome", None, None, "ai"))
        self.assertEqual(got["extraction_result"]["ai"], {"dropped": 2, "unstated_fields_cleared": 1}, "the country the text never states is cleared, and coordinates from a model are ignored")
        self.assertEqual(enzo["provenance"]["evidence_level"], "caption-based")
        self.assertEqual((enzo["provenance"]["provider"], enzo["provenance"]["model"]), ("stub", "stub-model-1"))
        self.assertEqual(self.a.ok("GET", "/api/enrichment/usage")["model_calls"], 1)
        self.assertEqual(len(provider.calls), 1)
        self.assertNotIn("example_cook", json.loads(provider.calls[0]["user"]).get("title", ""))

    def test_the_owners_edit_wins_and_labels_coordinates_as_theirs(self):
        self.a.use(StubProvider([{"places": []}] * 3))
        iid = self.a.add_item(caption=TEXT)
        self.extract(iid)
        saved = self.put(iid, [{"name": "Café Central", "kind": "cafe", "city": "Vienna", "country": "Austria", "coordinates": {"lat": 48.2104, "lon": 16.3655}}])
        place = saved["places"][0]
        self.assertEqual((saved["status"], saved["edited"], place["origin"], place["coordinates"]["source"]), ("edited", True, "user", "user"))
        self.assertEqual(len(saved["extracted"]), 3, "the extraction is kept beside the edit")
        again = self.extract(iid, force=True)
        self.assertEqual([p["name"] for p in again["places"]], ["Café Central"], "a new extraction never overwrites an edit")
        kept = self.put(iid, again["places"])      # what a GET returned can be sent back; computed fields are ignored and the label and id are kept
        self.assertEqual((kept["places"][0]["id"], kept["places"][0]["coordinates"]["source"], kept["places"][0]["origin"]), (place["id"], "user", "user"))
        reverted = self.a.ok("DELETE", f"/api/items/{iid}/places/edits")
        self.assertEqual((reverted["edited"], len(reverted["places"])), (False, 3))
        for bad in ({"name": "x", "coordinates": {"lat": 91, "lon": 0}}, {"name": "x", "coordinates": {"lat": 0, "lon": 181}}, {"name": "", "kind": "other"}, {"name": "x", "kind": "spaceport"}):
            with self.subTest(bad=bad):
                self.assertEqual(self.a.call("PUT", f"/api/items/{iid}/places", json={"places": [bad]}).status_code, 422)
        self.assertEqual(self.a.call("PUT", f"/api/items/{iid}/places", json={"places": [{"name": "x", "coordinates": {"lat": 0, "lon": 0}}]}).json()["code"], "invalid_place", "null island is not a place")
        self.assertEqual(self.a.call("PUT", f"/api/items/{iid}/places", json={"places": [{"name": "x", "colour": "red"}]}).status_code, 422, "a misspelt field is refused, not dropped")

    def test_without_a_geocoder_places_stay_without_coordinates(self):
        iid = self.a.add_item(caption="📍 Harbour Bakery\nGreat bread.")
        got = self.extract(iid, geocode=True)
        self.assertEqual(got["geocoding"], {"requested": True, "enabled": False, "reason": "geocoder_not_configured", "resolved": 0, "not_found": 0, "skipped": 0})
        self.assertIsNone(got["places"][0]["coordinates"])
        refused = self.a.call("POST", f"/api/items/{iid}/places/geocode", json={})
        self.assertEqual((refused.status_code, refused.json()["code"]), (503, "geocoder_not_configured"))

    def test_the_geocoder_is_used_only_when_asked_and_follows_its_usage_policy(self):
        world = FakeGeocoderWorld({"Harbour Bakery, 12 Quay Street, Portville, Examplia": BAKERY, "Portville, Examplia": PORTVILLE})
        self.a.service.geocoder = world.geocoder()
        iid = self.a.add_item("https://example.com/private-item-url", caption="Secret caption text that must never leave.")
        self.put(iid, [{"name": "Harbour Bakery", "kind": "bakery", "address": "12 Quay Street", "city": "Portville", "country": "Examplia"},
                       {"name": "Portville", "kind": "city", "country": "Examplia"}])
        self.extract(iid)   # asking for places alone never calls the geocoder
        self.assertEqual(world.requests, [])
        got = self.a.ok("POST", f"/api/items/{iid}/places/geocode", json={})
        self.assertEqual(got["geocoding"], {"requested": True, "enabled": True, "resolved": 2, "not_found": 0, "skipped": 0})
        bakery, city = got["places"]
        self.assertEqual((bakery["coordinates"]["lat"], bakery["coordinates"]["source"], bakery["coordinates"]["precision"]), (51.5007, "geocoder", "point"))
        self.assertEqual((city["coordinates"]["precision"], city["coordinates"]["provider"]), ("area", "nominatim.example.org"))
        self.assertIn("OpenStreetMap", bakery["coordinates"]["attribution"])
        self.assertEqual(bakery["coordinates"]["display_name"], "Harbour Bakery, 12 Quay Street, Portville, Examplia")
        first, second = world.requests
        self.assertEqual(dict(first.url.params), {"q": "Harbour Bakery, 12 Quay Street, Portville, Examplia", "format": "jsonv2", "limit": "1", "addressdetails": "0"},
                         "only the place's own name, address, city and country are sent")
        sent = " ".join(str(r.url) + str(dict(r.headers)) for r in world.requests)
        for private in ("Secret caption", "private-item-url", iid):
            self.assertNotIn(private, sent)
        self.assertRegex(first.headers["user-agent"], r"^LittleArchive/\S+ \(\+ops@example\.org\)$")
        self.assertEqual([round(s, 3) for s in world.slept], [1.1], "one request a second at most: the second waits out the interval")
        self.assertEqual((first.url.host, first.url.scheme), ("nominatim.example.org", "https"))
        # asking again is answered from the cache: no request, no waiting
        self.a.ok("DELETE", f"/api/items/{iid}/places/edits")
        self.put(iid, [{"name": "Harbour Bakery", "kind": "bakery", "address": "12 Quay Street", "city": "Portville", "country": "Examplia"}])
        self.a.ok("POST", f"/api/items/{iid}/places/geocode", json={})
        self.assertEqual(len(world.requests), 2)
        self.assertEqual([round(s, 3) for s in world.slept], [1.1])
        self.assertEqual(self.a.ok("GET", f"/api/items/{iid}/places")["places"][0]["coordinates"]["source"], "geocoder")

    def test_a_place_the_geocoder_does_not_know_is_remembered_and_stays_without_coordinates(self):
        world = FakeGeocoderWorld({})
        self.a.service.geocoder = world.geocoder()
        iid = self.a.add_item(caption="x")
        self.put(iid, [{"name": "Nowhere Specific Cafe", "kind": "cafe"}])
        got = self.a.ok("POST", f"/api/items/{iid}/places/geocode", json={})
        self.assertEqual((got["geocoding"]["resolved"], got["geocoding"]["not_found"], got["places"][0]["coordinates"]), (0, 1, None))
        self.a.ok("POST", f"/api/items/{iid}/places/geocode", json={})
        self.assertEqual(len(world.requests), 1, "a miss is cached too, so the geocoder is not asked again")

    def test_a_geocoder_that_is_busy_changes_nothing_and_is_not_cached(self):
        world = FakeGeocoderWorld(status=429)
        self.a.service.geocoder = world.geocoder()
        iid = self.a.add_item(caption="x")
        self.put(iid, [{"name": "Harbour Bakery", "kind": "bakery", "city": "Portville"}])
        refused = self.a.call("POST", f"/api/items/{iid}/places/geocode", json={})
        self.assertEqual((refused.status_code, refused.json()["code"], refused.json()["retryable"]), (502, "geocoder_failed", True))
        self.assertIsNone(self.a.ok("GET", f"/api/items/{iid}/places")["places"][0]["coordinates"])
        world.status = 200
        world.answers["Harbour Bakery, Portville"] = BAKERY
        self.assertEqual(self.a.ok("POST", f"/api/items/{iid}/places/geocode", json={})["geocoding"]["resolved"], 1, "an error is not cached as an answer")

    def test_extract_can_geocode_in_the_same_request_but_never_more_than_five_places(self):
        world = FakeGeocoderWorld({f"Spot {n}": {**BAKERY, "lat": str(10 + n), "lon": str(20 + n)} for n in range(8)})
        self.a.service.geocoder = world.geocoder()
        iid = self.a.add_item(caption="\n".join(f"📍 Spot {n}" for n in range(8)))
        got = self.extract(iid, geocode=True)
        self.assertEqual((len(got["places"]), got["geocoding"]["resolved"], got["geocoding"]["skipped"]), (8, 5, 3))
        self.assertEqual(sum(1 for p in got["places"] if p["coordinates"]), 5)
        self.assertEqual(len(world.requests), 5)

    def test_the_library_wide_list_for_a_map(self):
        spots = {"London": (51.5, -0.12, "city"), "Paris": (48.85, 2.35, "city"), "Tokyo": (35.68, 139.69, "city"), "Auckland": (-36.85, 174.76, "city"), "Fiji": (-17.7, 178.0, "country"),
                 "Honolulu": (21.3, -157.8, "city")}
        ids = {}
        for name, (lat, lon, kind) in spots.items():
            ids[name] = self.a.add_item(f"https://example.com/{name}", title=f"About {name}")
            self.put(ids[name], [{"name": name, "kind": kind, "coordinates": {"lat": lat, "lon": lon}}])
        nameless = self.a.add_item("https://example.com/nowhere")
        self.put(nameless, [{"name": "Somewhere Nice", "kind": "park"}])
        everything = self.a.ok("GET", "/api/places")
        self.assertEqual(everything["total"], 7)
        self.assertEqual(everything["places"][0]["item_id"] in ids.values(), True)
        europe = self.a.ok("GET", "/api/places", params={"bbox": "-10,35,30,60"})
        self.assertEqual(sorted(p["name"] for p in europe["places"]), ["London", "Paris"])
        self.assertEqual(europe["bbox"], [-10.0, 35.0, 30.0, 60.0])
        across = self.a.ok("GET", "/api/places", params={"bbox": "170,-50,-170,0"})
        self.assertEqual(sorted(p["name"] for p in across["places"]), ["Auckland", "Fiji"], "a box that crosses the antimeridian")
        self.assertEqual([p["name"] for p in self.a.ok("GET", "/api/places", params={"with_coordinates": "false"})["places"]], ["Somewhere Nice"])
        self.assertEqual(self.a.ok("GET", "/api/places", params={"kind": "country"})["total"], 1)
        self.assertEqual([p["name"] for p in self.a.ok("GET", "/api/places", params={"q": "tokyo"})["places"]], ["Tokyo"])
        row = europe["places"][0]
        self.assertEqual((row["item_title"], row["url"].startswith("https://example.com/"), row["item_id"] in ids.values()), (f"About {row['name']}", True, True))
        geo = self.a.ok("GET", "/api/places", params={"format": "geojson"})
        self.assertEqual((geo["type"], len(geo["features"])), ("FeatureCollection", 6), "places without coordinates are not on a map")
        london = next(f for f in geo["features"] if f["properties"]["name"] == "London")
        self.assertEqual((london["geometry"], london["properties"]["coordinate_source"]), ({"type": "Point", "coordinates": [-0.12, 51.5]}, "user"))
        self.assertEqual(len(self.a.ok("GET", "/api/places", params={"limit": 3})["places"]), 3)
        self.assertEqual(len(self.a.ok("GET", "/api/places", params={"limit": 3, "offset": 6})["places"]), 1)
        self.a.ok("PATCH", f"/api/items/{ids['London']}", json={"status": "archived"})
        self.assertEqual(self.a.ok("GET", "/api/places")["total"], 6)
        self.assertEqual(self.a.ok("GET", "/api/places", params={"include_archived": True})["total"], 7)
        for bad in ("1,2,3", "a,b,c,d", "0,10,10,5", "-200,0,10,10", "0,-95,10,10"):
            with self.subTest(bbox=bad):
                got = self.a.call("GET", "/api/places", params={"bbox": bad})
                self.assertEqual((got.status_code, got.json()["code"]), (422, "invalid_bbox"))
        self.assertEqual(self.a.call("GET", "/api/places", params={"kind": "spaceport"}).json()["code"], "invalid_kind")

    def test_deleting_a_save_deletes_its_places(self):
        iid = self.a.add_item(caption=TEXT)
        self.extract(iid)
        self.a.ok("DELETE", f"/api/items/{iid}")
        with self.a.library.transaction() as c:
            self.assertEqual(c.execute("SELECT count(*) FROM item_places").fetchone()[0], 0)
        self.assertEqual(self.a.ok("GET", "/api/places")["total"], 0)


class SelfHostedPlaceTests(PlaceScenarios, unittest.TestCase):
    harness = SelfHosted


class HostedPlaceTests(PlaceScenarios, unittest.TestCase):
    harness = Hosted

    def test_locked_until_the_account_has_the_unlock(self):
        locked = self.h.account(unlocked=False)
        iid = locked.add_item(caption=TEXT)
        for method, path, body in (("GET", f"/api/items/{iid}/places", None), ("PUT", f"/api/items/{iid}/places", {"places": []}), ("POST", f"/api/items/{iid}/places/extract", {}),
                                   ("POST", f"/api/items/{iid}/places/geocode", {}), ("DELETE", f"/api/items/{iid}/places/edits", None), ("GET", "/api/places", None)):
            with self.subTest(route=method + " " + path):
                got = locked.call(method, path, json=body) if body is not None else locked.call(method, path)
                self.assertEqual((got.status_code, got.json()["code"], got.json()["feature"]), (402, "unlock_required", "places"))
        with locked.library.transaction() as c:
            self.assertEqual(c.execute("SELECT count(*) FROM item_places").fetchone()[0], 0)
        self.h.unlock(locked)
        self.assertEqual(locked.call("GET", "/api/places").status_code, 200)

    def test_accounts_never_see_each_others_places_and_do_not_share_a_geocoder_cache(self):
        b = self.h.account()
        world = FakeGeocoderWorld({"Harbour Bakery": BAKERY})
        self.a.service.geocoder = world.geocoder()
        b.service.geocoder = world.geocoder()
        mine = self.a.add_item("https://example.com/a", caption="x", title="private-marker-a")
        self.put(mine, [{"name": "Harbour Bakery", "kind": "bakery", "note": "private-marker-a"}])
        self.a.ok("POST", f"/api/items/{mine}/places/geocode", json={})
        theirs = b.add_item("https://example.com/b", caption="x")
        self.put(theirs, [{"name": "Harbour Bakery", "kind": "bakery"}], account=b)
        self.assertEqual(len(b.ok("GET", "/api/places")["places"]), 1)
        self.assertNotIn("private-marker-a", json.dumps(b.ok("GET", "/api/places")))
        self.assertIsNone(b.ok("GET", f"/api/items/{theirs}/places")["places"][0]["coordinates"], "another account's lookup is not applied to this library")
        for method, path, body in (("GET", f"/api/items/{mine}/places", None), ("PUT", f"/api/items/{mine}/places", {"places": []}), ("POST", f"/api/items/{mine}/places/extract", {}),
                                   ("POST", f"/api/items/{mine}/places/geocode", {}), ("DELETE", f"/api/items/{mine}/places/edits", None)):
            with self.subTest(route=method + " " + path):
                got = b.call(method, path, json=body) if body is not None else b.call(method, path)
                self.assertEqual(got.status_code, 404)
        b.ok("POST", f"/api/items/{theirs}/places/geocode", json={})
        self.assertEqual(len(world.requests), 2, "each library has its own cache, so a query one account made is not answered for another")
        self.assertEqual([round(s, 3) for s in world.slept], [1.1], "but the one-request-a-second limit is shared by every account")
        self.assertEqual(self.a.ok("GET", f"/api/items/{mine}/places")["places"][0]["note"], "private-marker-a")


if __name__ == "__main__":
    unittest.main()
