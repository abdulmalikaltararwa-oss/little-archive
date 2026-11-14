"""Recipe cards: parsing, extraction from schema.org data, rules and a stubbed provider, edits that win, scaling,
listing, hosted gating and isolation, the migration and a backup round trip. Synthetic data only; no network, no real model."""
import io
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
import zipfile

from fastapi.testclient import TestClient

from server.app import create_app
from server.backups import create_backup, restore_backup
from server.config import Config
from server.enrich.features import FEATURES_SCHEMA, FEATURES_SCHEMA_VERSION, ensure_features_schema
from server.enrich.recipe import parse_duration_text, parse_ingredient, parse_servings, scale_recipe
from server.enrich.schema import ENRICH_SCHEMA
from server.security import hash_password
from server.storage import SCHEMA, Store
from support_features import Hosted, MODES, PASSWORD, SelfHosted, StubProvider, page_html

CAPTION = """Garlic butter noodles
Serves 2

Ingredients:
- 200 g spaghetti
- 3 cloves garlic, minced
- 2 tbsp butter
- a pinch of chilli flakes
- Parmesan, to serve

Method:
1. Boil the spaghetti for 9 minutes in salted water.
2. Melt the butter and cook the garlic for 1 minute.
3. Toss the spaghetti with the garlic butter and chilli flakes.

#pasta #easyrecipes"""
LOOSE_CAPTION = "Midnight noodles. Boil 200 g spaghetti for 9 minutes in salted water. Melt 2 tbsp butter and cook 3 cloves garlic for 1 minute. Toss it all together with a pinch of chilli flakes."


def ai_answer(**changes):
    answer = {
        "is_recipe": True, "title": "Midnight noodles", "servings_quote": "", "time_quotes": [],
        "ingredients": [{"quote": "200 g spaghetti", "group": ""}, {"quote": "2 tbsp butter", "group": ""}, {"quote": "3 cloves garlic", "group": ""},
                        {"quote": "a pinch of chilli flakes", "group": ""}],
        "steps": [{"text": "Boil the spaghetti for 9 minutes in salted water.", "quote": "Boil 200 g spaghetti for 9 minutes in salted water."},
                  {"text": "Melt the butter and cook the garlic for 1 minute.", "quote": "Melt 2 tbsp butter and cook 3 cloves garlic for 1 minute."}],
    }
    answer.update(changes)
    return answer


class ParsingTests(unittest.TestCase):
    def test_an_ingredient_line_gives_only_what_it_says(self):
        cases = {
            "2 cups all-purpose flour, sifted": (2.0, None, "cup", "all-purpose flour", "sifted"),
            "1 1/2 tsp baking powder": (1.5, None, "tsp", "baking powder", None),
            "1½ cups milk": (1.5, None, "cup", "milk", None),
            "200g butter (softened)": (200.0, None, "g", "butter", "softened"),
            "2-3 cloves garlic, minced": (2.0, 3.0, "clove", "garlic", "minced"),
            "a pinch of salt": (1.0, None, "pinch", "salt", None),
            "1 can (14 oz) diced tomatoes": (1.0, None, "can", "diced tomatoes", "14 oz"),
            "Salt and pepper, to taste": (None, None, None, "Salt and pepper", "to taste"),
            "a little olive oil": (None, None, None, "olive oil", "a little"),
            "half an onion": (0.5, None, None, "onion", None),
            "two large eggs": (2.0, None, None, "large eggs", None),
            "٢ كوب طحين": (2.0, None, "cup", "طحين", None),
            "Olive oil": (None, None, None, "Olive oil", None),
        }
        for line, (quantity, high, unit, name, note) in cases.items():
            with self.subTest(line=line):
                got = parse_ingredient(line)
                self.assertEqual((got["quantity"], got["quantity_max"], got["unit"], got["name"], got["note"]), (quantity, high, unit, name, note))
        self.assertTrue(parse_ingredient("1 tbsp sugar (optional)")["optional"])
        self.assertFalse(parse_ingredient("Salt, to taste")["scalable"])

    def test_durations_take_the_shorter_end_and_never_guess(self):
        self.assertEqual(parse_duration_text("Simmer for 10-12 minutes until thick"), 600)
        self.assertEqual(parse_duration_text("Bake 1 hour 30 minutes"), 5400)
        self.assertEqual(parse_duration_text("Rest for half an hour"), 1800)
        self.assertEqual(parse_duration_text("Cook for 45 seconds"), 45)
        self.assertIsNone(parse_duration_text("Cook for a few minutes"))
        self.assertIsNone(parse_duration_text("Stir well"))

    def test_servings(self):
        self.assertEqual(parse_servings("Serves 4-6")[0], 4)
        self.assertEqual(parse_servings("makes 12 cookies")[0], 12)
        self.assertEqual(parse_servings("4 servings")[0], 4)
        self.assertEqual(parse_servings("No count here")[0], None)


class ScalingTests(unittest.TestCase):
    """The maths in docs/understanding.md: one linear factor, exact arithmetic, clean promotions inside one system only."""

    def doc(self, *lines, servings=4):
        return {"servings": servings, "ingredients": [parse_ingredient(line) for line in lines]}

    def scaled(self, line, target, servings=4):
        return scale_recipe(self.doc(line, servings=servings), servings=target)["ingredients"][0]

    def test_a_factor_of_one_and_a_half(self):
        got = self.scaled("2 cups flour", 6)
        self.assertEqual((got["quantity"], got["unit"], got["display"]), (3.0, "cup", "3 cups flour"))
        self.assertEqual(self.scaled("250 g sugar", 6)["display"], "375 g sugar")

    def test_units_move_only_within_one_dimension_and_system(self):
        self.assertEqual(self.scaled("500 ml stock", 12)["display"], "1½ l stock")           # ml -> l
        self.assertEqual(self.scaled("250 g flour", 16)["display"], "1 kg flour")             # g -> kg
        self.assertEqual(self.scaled("1 tsp salt", 12)["display"], "1 tbsp salt")             # 3 tsp -> 1 tbsp
        self.assertEqual(self.scaled("2 tbsp oil", 32)["display"], "1 cup oil")               # 16 tbsp -> 1 cup
        self.assertEqual(self.scaled("12 oz pasta", 12)["display"], "2¼ lb pasta")            # 36 oz -> 2 1/4 lb
        self.assertEqual(self.scaled("1 tbsp oil", 1)["display"], "¾ tsp oil")                # 1/4 tbsp -> 3/4 tsp
        # never between systems, and never between weight and volume (that would need a density)
        self.assertEqual(self.scaled("8 oz cheese", 6)["unit"], "oz")                          # 12 oz does not read cleanly as pounds
        self.assertEqual(self.scaled("2 cups flour", 40)["unit"], "cup")
        self.assertNotIn(self.scaled("100 g butter", 8)["unit"], {"cup", "tbsp", "oz", "lb", "ml", "l"})

    def test_rounding_is_for_a_cook_and_says_when_it_moved_the_amount(self):
        third = self.scaled("1/3 cup milk", 1)
        self.assertEqual(third["display"], "1⅓ tbsp milk")                                     # 1/12 cup, in spoons
        self.assertAlmostEqual(third["exact"], 4 / 3, places=3)
        egg = self.scaled("3 eggs", 1)                                                        # 0.75 egg cannot be cooked
        self.assertEqual((egg["quantity"], egg["approximate"], egg["warnings"]), (1.0, True, ["rounded"]))
        self.assertEqual(self.scaled("3 eggs", 6)["warnings"], ["fractional_count"])           # 4.5 eggs is exact but flagged
        sugar = self.scaled("250 g sugar", 1)
        self.assertEqual((sugar["exact"], sugar["quantity"], sugar["display"]), (62.5, 63.0, "63 g sugar"))   # half rounds up, not to even; the exact amount stays

    def test_what_has_no_amount_is_left_alone(self):
        got = self.scaled("Salt, to taste", 12)
        self.assertFalse(got["scaled"])
        self.assertEqual(got["display"], "Salt, to taste")

    def test_ranges_scale_both_ends(self):
        self.assertEqual(self.scaled("2-3 cloves garlic", 8)["display"], "4–6 cloves garlic")

    def test_refusals_are_machine_readable(self):
        for call, code in ((lambda: scale_recipe({"servings": None, "ingredients": []}, servings=2), "servings_unknown"),
                           (lambda: scale_recipe({"servings": 4, "ingredients": []}, servings=0), "invalid_servings"),
                           (lambda: scale_recipe({"servings": 4, "ingredients": []}, servings=4000), "scale_out_of_range")):
            with self.assertRaises(Exception) as caught:
                call()
            self.assertEqual(caught.exception.code, code)
        self.assertEqual(scale_recipe({"servings": None, "ingredients": [parse_ingredient("2 cups flour")]}, factor=2)["ingredients"][0]["quantity"], 4.0)

    def test_the_stored_recipe_is_never_changed_by_scaling(self):
        doc = self.doc("2 cups flour")
        before = json.dumps(doc, sort_keys=True)
        scale_recipe(doc, servings=8)
        self.assertEqual(json.dumps(doc, sort_keys=True), before)


class RecipeScenarios:
    harness = None

    def setUp(self):
        self.h = self.harness()
        self.addCleanup(self.h.close)
        self.a = self.h.account()

    def extract(self, iid, **body):
        return self.a.ok("POST", f"/api/items/{iid}/recipe/extract", json=body)

    def test_a_save_with_no_recipe_says_so(self):
        iid = self.a.add_item(caption="A walk by the harbour.")
        got = self.a.ok("GET", f"/api/items/{iid}/recipe")
        self.assertEqual((got["status"], got["recipe"], got["edited"]), ("none", None, False))
        self.assertEqual(got["available"], {"jsonld": False, "rules": True, "ai": False})

    def test_schema_org_data_is_preferred_and_needs_no_model(self):
        provider = self.a.use(StubProvider([]))
        iid = self.a.add_item("https://example.com/lemon-ricotta-pancakes", title="Pancakes")
        self.a.ok("POST", f"/api/items/{iid}/page", json={"html": page_html("recipe_jsonld.html")})
        self.assertTrue(self.a.ok("GET", f"/api/items/{iid}/recipe")["available"]["jsonld"])
        got = self.extract(iid)
        recipe = got["recipe"]
        self.assertEqual((got["status"], got["extraction_result"]["method"], recipe["provenance"]["method"], recipe["confidence"]), ("extracted", "jsonld", "jsonld", "high"))
        self.assertEqual(provider.calls, [], "structured data is read, not sent to a model")
        self.assertIn("No AI was used", recipe["provenance"]["evidence_note"])
        self.assertEqual((recipe["title"], recipe["servings"], recipe["time"]["total_seconds"], recipe["time"]["prep_seconds"], recipe["time"]["cook_seconds"]), ("Lemon Ricotta Pancakes", 4.0, 1500, 600, 900))
        names = [(i["quantity"], i["unit"], i["name"]) for i in recipe["ingredients"]]
        self.assertEqual(names[0], (1.0, "cup", "ricotta cheese"))
        self.assertEqual(names[1], (0.75, "cup", "all-purpose flour"))
        self.assertEqual(names[5], (1.0, "pinch", "salt"))
        self.assertEqual([s["section"] for s in recipe["steps"]], ["Batter", "Batter", "Cook", "Cook"])
        cook = recipe["steps"][2]
        self.assertEqual(cook["timer_seconds"], 120, "the shorter end of '2-3 minutes'")
        self.assertEqual(recipe["steps"][3]["timer_seconds"], 300)
        self.assertEqual({recipe["ingredients"][i]["name"] for i in recipe["steps"][0]["ingredient_refs"]}, {"ricotta cheese", "large eggs", "sugar"})

    def test_rules_read_a_structured_caption_without_a_model(self):
        iid = self.a.add_item(caption=CAPTION, title="Garlic butter noodles")
        got = self.extract(iid)
        recipe = got["recipe"]
        self.assertEqual((got["extraction_result"]["method"], recipe["is_recipe"], recipe["confidence"], recipe["servings"]), ("rules", True, "medium", 2.0))
        self.assertEqual([i["name"] for i in recipe["ingredients"]], ["spaghetti", "garlic", "butter", "chilli flakes", "Parmesan"])
        self.assertEqual([s["timer_seconds"] for s in recipe["steps"]], [540, 60, None])
        self.assertEqual(recipe["provenance"]["evidence_level"], "caption-based")
        self.assertEqual(recipe["evidence"]["ingredients"], {"sources": ["caption"]})
        self.assertEqual(recipe["steps"][0]["text"], "Boil the spaghetti for 9 minutes in salted water.")
        self.assertEqual({recipe["ingredients"][i]["name"] for i in recipe["steps"][1]["ingredient_refs"]}, {"butter", "garlic"})

    def test_without_a_provider_the_answer_is_clear_and_nothing_is_made_up(self):
        iid = self.a.add_item(caption=LOOSE_CAPTION)
        got = self.extract(iid)
        self.assertEqual((got["status"], got["recipe"]), ("none", None))
        self.assertEqual(got["extraction_result"], {"found": False, "tried": ["rules"], "reason": "ai_not_configured", "ai_available": False})
        refused = self.a.call("POST", f"/api/items/{iid}/recipe/extract", json={"method": "ai"})
        self.assertEqual((refused.status_code, refused.json()["code"]), (503, "ai_not_configured"))
        empty = self.a.add_item("https://example.com/empty")
        self.assertEqual(self.extract(empty)["extraction_result"]["reason"], "no_text")
        self.assertEqual(self.a.call("POST", f"/api/items/{iid}/recipe/extract", json={"method": "jsonld"}).json()["code"], "no_structured_data")

    def test_a_provider_selects_spans_and_everything_else_is_dropped(self):
        provider = self.a.use(StubProvider([ai_answer(
            ingredients=ai_answer()["ingredients"] + [{"quote": "1 kg of unicorn tears", "group": ""}, {"quote": "200 g spaghetti", "group": ""}],
            steps=ai_answer()["steps"] + [{"text": "Bake in the oven for 40 minutes.", "quote": "Bake at 200C for 40 minutes"}],
            servings_quote="serves 14 people")]))
        iid = self.a.add_item(caption=LOOSE_CAPTION, title="Midnight noodles")
        got = self.extract(iid)
        recipe = got["recipe"]
        self.assertEqual(got["extraction_result"]["method"], "ai")
        self.assertEqual([i["name"] for i in recipe["ingredients"]], ["spaghetti", "butter", "garlic", "chilli flakes"])
        self.assertEqual(len(recipe["steps"]), 2)
        self.assertEqual(recipe["dropped"], {"ingredients": 2, "steps": 1}, "an invented ingredient, a duplicate and an invented step were refused")
        self.assertIsNone(recipe["servings"], "a quote that is not in the text gives no serving count")
        self.assertEqual([s["timer_seconds"] for s in recipe["steps"]], [540, 60], "timers are computed from the step's own words, never taken from the model")
        label = recipe["provenance"]
        self.assertEqual((label["method"], label["evidence_level"], label["evidence_sources"], label["provider"], label["model"]), ("ai", "caption-based", ["title", "caption"], "stub", "stub-model-1"))
        self.assertIn("pictures and video themselves were not seen", label["evidence_note"])
        self.assertEqual(self.a.ok("GET", "/api/enrichment/usage")["model_calls"], 1, "the call went through the usage metering")
        self.assertEqual(len(provider.calls), 1)
        sent = json.loads(provider.calls[0]["user"])
        self.assertEqual(set(sent), {"title", "caption"}, "only the post's own text was sent")
        self.assertNotIn("https://", provider.calls[0]["user"])

    def test_a_provider_that_finds_no_recipe_leaves_none_and_is_not_asked_again(self):
        provider = self.a.use(StubProvider([ai_answer(is_recipe=False, title="", ingredients=[], steps=[])]))
        iid = self.a.add_item(caption="Just a lovely evening at the beach with friends and good music.")
        got = self.extract(iid)
        self.assertEqual((got["status"], got["recipe"]["is_recipe"], got["recipe"]["reason"]), ("not_a_recipe", False, "not_a_recipe"))
        self.assertEqual(self.a.ok("GET", "/api/recipes")["total"], 0)
        again = self.extract(iid)
        self.assertTrue(again["unchanged"])
        self.assertEqual(len(provider.calls), 1, "the same text is not sent twice")

    def test_a_model_that_claims_a_recipe_without_checkable_content_is_not_believed(self):
        self.a.use(StubProvider([ai_answer(ingredients=[{"quote": "1 kg of unicorn tears", "group": ""}], steps=[{"text": "Whisk the rainbow gently", "quote": "Whisk the rainbow"}])]))
        iid = self.a.add_item(caption=LOOSE_CAPTION)
        recipe = self.extract(iid)["recipe"]
        self.assertEqual((recipe["is_recipe"], recipe["reason"], recipe["ingredients"], recipe["steps"]), (False, "too_little_verifiable_content", [], []))

    def test_a_broken_provider_answer_changes_nothing(self):
        provider = self.a.use(StubProvider([{"is_recipe": "yes"}]))
        iid = self.a.add_item(caption=LOOSE_CAPTION)
        refused = self.a.call("POST", f"/api/items/{iid}/recipe/extract", json={})
        self.assertEqual((refused.status_code, refused.json()["code"]), (502, "ai_invalid"))
        self.assertEqual(self.a.ok("GET", f"/api/items/{iid}/recipe")["status"], "none")
        self.assertEqual(len(provider.calls), 1)

    def test_the_owners_edit_wins_over_every_later_extraction(self):
        provider = self.a.use(StubProvider([ai_answer(), ai_answer(ingredients=ai_answer()["ingredients"][:2])]))
        iid = self.a.add_item(caption=LOOSE_CAPTION, title="Midnight noodles")
        first = self.extract(iid)["recipe"]
        edit = {"title": "My noodles", "servings": 2, "servings_text": "2 bowls", "time": {"total_seconds": 900},
                "ingredients": [{"quantity": 200, "unit": "grams", "name": "spaghetti"}, {"quantity": 2, "unit": "tbsp", "name": "butter", "note": "salted"}, {"name": "chilli flakes"}],
                "steps": [{"text": "Boil the spaghetti for 9 minutes."}, {"text": "Toss with butter and chilli flakes.", "timer_seconds": 30}, {"text": "Leave it for 20 minutes but do not time it.", "no_timer": True}]}
        saved = self.a.ok("PUT", f"/api/items/{iid}/recipe", json=edit)
        self.assertEqual((saved["status"], saved["edited"], saved["recipe"]["title"], saved["recipe"]["provenance"]["method"]), ("edited", True, "My noodles", "user"))
        self.assertEqual(saved["recipe"]["ingredients"][0]["unit"], "g", "a spelled-out unit is read as the unit it names")
        self.assertEqual([s["timer_seconds"] for s in saved["recipe"]["steps"]], [540, 30, None])
        self.assertEqual(saved["extracted"]["title"], first["title"], "the extraction is kept beside the edit, untouched")
        again = self.extract(iid, force=True)
        self.assertEqual((again["recipe"]["title"], again["edited"]), ("My noodles", True), "a new extraction never overwrites an edit")
        self.assertEqual((len(first["ingredients"]), len(again["extracted"]["ingredients"])), (4, 2), "but it is recorded, so the owner can look at it")
        reverted = self.a.ok("DELETE", f"/api/items/{iid}/recipe/edits")
        self.assertEqual((reverted["edited"], len(reverted["recipe"]["ingredients"]), reverted["status"]), (False, 2, "extracted"))
        self.assertEqual(len(provider.calls), 2)

    def test_what_a_get_returned_can_be_sent_back_after_editing(self):
        iid = self.a.add_item(caption=CAPTION, title="Garlic butter noodles")
        recipe = self.extract(iid)["recipe"]
        recipe["title"] = "Garlic butter noodles, my way"
        recipe["ingredients"][0]["quantity"] = 250
        saved = self.a.ok("PUT", f"/api/items/{iid}/recipe", json=recipe)
        self.assertEqual((saved["status"], saved["recipe"]["title"], saved["recipe"]["ingredients"][0]["quantity"]), ("edited", "Garlic butter noodles, my way", 250.0))
        self.assertEqual(saved["recipe"]["provenance"]["method"], "user", "the server, not the client, says who wrote it")
        self.assertEqual(saved["recipe"]["steps"][0]["timer_seconds"], 540)
        scaled = self.a.ok("GET", f"/api/items/{iid}/recipe", params={"servings": 4})["scaled"]
        self.assertEqual(self.a.call("PUT", f"/api/items/{iid}/recipe", json={**recipe, "titel": "typo"}).status_code, 422, "a misspelt field is refused, not dropped")
        self.assertEqual(self.a.call("PUT", f"/api/items/{iid}/recipe", json={"ingredients": [{"name": "salt", "qty": 2}]}).status_code, 422)
        self.assertEqual(scaled["ingredients"][0]["quantity"], 500.0)

    def test_an_owner_can_write_a_recipe_by_hand_and_mark_a_save_not_a_recipe(self):
        iid = self.a.add_item(caption="No recipe text at all.")
        saved = self.a.ok("PUT", f"/api/items/{iid}/recipe", json={"title": "Toast", "ingredients": [{"quantity": 2, "unit": "slice", "name": "bread"}], "steps": [{"text": "Toast it."}]})
        self.assertEqual((saved["status"], saved["recipe"]["confidence"]), ("edited", "high"))
        self.assertEqual(self.a.ok("GET", "/api/recipes")["total"], 1)
        self.a.ok("PUT", f"/api/items/{iid}/recipe", json={"is_recipe": False})
        self.assertEqual((self.a.ok("GET", f"/api/items/{iid}/recipe")["status"], self.a.ok("GET", "/api/recipes")["total"]), ("not_a_recipe", 0))
        self.a.ok("DELETE", f"/api/items/{iid}/recipe/edits")
        self.assertEqual(self.a.ok("GET", f"/api/items/{iid}/recipe")["status"], "none", "with no extraction and no edit nothing remains")

    def test_invalid_edits_are_refused_not_stored(self):
        iid = self.a.add_item(caption="x")
        for body in ({"ingredients": [{"name": ""}]}, {"ingredients": [{"name": "salt", "quantity": -1}]}, {"steps": [{"text": ""}]}, {"servings": 0}, {"unknown": 1},
                     {"ingredients": [{"name": "salt", "quantity": 2, "quantity_max": 1}]}):
            with self.subTest(body=body):
                self.assertIn(self.a.call("PUT", f"/api/items/{iid}/recipe", json=body).status_code, {422})
        self.assertEqual(self.a.ok("GET", f"/api/items/{iid}/recipe")["status"], "none")

    def test_scaling_through_the_api(self):
        iid = self.a.add_item(caption=CAPTION, title="Garlic butter noodles")
        self.extract(iid)
        scaled = self.a.ok("GET", f"/api/items/{iid}/recipe", params={"servings": 6})["scaled"]
        self.assertEqual((scaled["base_servings"], scaled["target_servings"], scaled["factor"]), (2.0, 6.0, "3"))
        self.assertEqual(scaled["ingredients"][0]["display"], "600 g spaghetti")
        self.assertEqual(scaled["ingredients"][3]["display"], "3 pinches chilli flakes")
        self.assertEqual(scaled["ingredients"][4]["display"], "Parmesan, to serve", "an ingredient with no amount is left as written")
        self.assertEqual(self.a.ok("GET", f"/api/items/{iid}/recipe", params={"factor": 0.5})["scaled"]["ingredients"][0]["quantity"], 100.0)
        stored = self.a.ok("GET", f"/api/items/{iid}/recipe")["recipe"]
        self.assertEqual(stored["ingredients"][0]["quantity"], 200.0, "reading a scaled view changes nothing stored")
        self.assertEqual(self.a.call("GET", f"/api/items/{iid}/recipe", params={"servings": 2, "factor": 2}).status_code, 422)
        self.assertEqual(self.a.call("GET", f"/api/items/{iid}/recipe", params={"servings": 0}).status_code, 422)
        no_servings = self.a.add_item(caption="Ingredients:\n2 eggs\n1 cup milk\nMethod:\nWhisk them together well.\nCook gently.")
        self.extract(no_servings)
        refused = self.a.call("GET", f"/api/items/{no_servings}/recipe", params={"servings": 4})
        self.assertEqual((refused.status_code, refused.json()["code"]), (409, "servings_unknown"))
        missing = self.a.add_item("https://example.com/none")
        self.assertEqual(self.a.call("GET", f"/api/items/{missing}/recipe", params={"servings": 4}).json()["code"], "no_recipe")

    def test_listing_recipes(self):
        ids = [self.a.add_item(f"https://example.com/r{n}", title=f"Dish {n}", caption=CAPTION) for n in range(3)]
        for iid in ids:
            self.extract(iid)
        other = self.a.add_item("https://example.com/not", caption="no recipe")
        listed = self.a.ok("GET", "/api/recipes")
        self.assertEqual((listed["total"], len(listed["recipes"])), (3, 3))
        row = listed["recipes"][0]
        self.assertEqual((row["ingredient_count"], row["step_count"], row["servings"], row["method"], row["edited"]), (5, 3, 2.0, "rules", False))
        self.assertNotIn(other, [r["item_id"] for r in listed["recipes"]])
        self.assertEqual(len(self.a.ok("GET", "/api/recipes", params={"limit": 2})["recipes"]), 2)
        self.assertEqual(len(self.a.ok("GET", "/api/recipes", params={"limit": 2, "offset": 2})["recipes"]), 1)
        self.a.ok("PATCH", f"/api/items/{ids[0]}", json={"status": "archived"})
        self.assertEqual(self.a.ok("GET", "/api/recipes")["total"], 2)
        self.assertEqual(self.a.ok("GET", "/api/recipes", params={"include_archived": True})["total"], 3)

    def test_deleting_a_save_deletes_its_recipe(self):
        iid = self.a.add_item(caption=CAPTION)
        self.extract(iid)
        self.a.ok("DELETE", f"/api/items/{iid}")
        with self.a.library.transaction() as c:
            self.assertEqual(c.execute("SELECT count(*) FROM item_recipe").fetchone()[0], 0)
        self.assertEqual(self.a.call("GET", f"/api/items/{iid}/recipe").status_code, 404)
        self.assertEqual(self.a.call("PUT", f"/api/items/{iid}/recipe", json={"title": "x"}).status_code, 404)

    def test_a_backup_carries_recipes_and_restores(self):
        iid = self.a.add_item(caption=CAPTION, title="Garlic butter noodles")
        self.extract(iid)
        self.a.ok("PUT", f"/api/items/{iid}/recipe", json={"title": "Kept edit", "ingredients": [{"name": "salt"}]})
        raw = self.a.call("GET", "/api/backup").content
        archive = Path(self.h.root) / "backup.zip"
        archive.write_bytes(raw)
        restore_backup(archive, Path(self.h.root) / "restored")
        with sqlite3.connect(Path(self.h.root) / "restored" / "library.sqlite3") as db:
            row = db.execute("SELECT json_extract(override,'$.title'),json_extract(extracted,'$.title'),is_recipe FROM item_recipe").fetchone()
        self.assertEqual(row, ("Kept edit", "Garlic butter noodles", 1))


class SelfHostedRecipeTests(RecipeScenarios, unittest.TestCase):
    harness = SelfHosted

    def test_the_owner_is_never_gated(self):
        features = self.a.ok("GET", "/api/features")
        self.assertEqual((features["unlocked"], features["recipes"]["locked"], features["places"]["locked"], features["ask"]["locked"]), (True, False, False, False))


class HostedRecipeTests(RecipeScenarios, unittest.TestCase):
    harness = Hosted

    def test_locked_until_the_account_has_the_unlock(self):
        locked = self.h.account(unlocked=False)
        iid = locked.add_item(caption=CAPTION)
        for method, path, body in (("GET", f"/api/items/{iid}/recipe", None), ("PUT", f"/api/items/{iid}/recipe", {"title": "x"}), ("POST", f"/api/items/{iid}/recipe/extract", {}),
                                   ("DELETE", f"/api/items/{iid}/recipe/edits", None), ("GET", "/api/recipes", None)):
            with self.subTest(route=method + " " + path):
                got = locked.call(method, path, json=body) if body is not None else locked.call(method, path)
                self.assertEqual(got.status_code, 402)
                self.assertEqual(got.json(), {"detail": "This comes with the full unlock.", "code": "unlock_required", "feature": "recipes"})
        self.assertFalse(locked.ok("GET", "/api/features")["unlocked"])
        self.assertTrue(locked.ok("GET", "/api/features")["recipes"]["locked"])
        with locked.library.transaction() as c:
            self.assertEqual(c.execute("SELECT count(*) FROM item_recipe").fetchone()[0], 0, "a refused request stores nothing")
        self.h.unlock(locked)
        self.assertEqual(locked.call("POST", f"/api/items/{iid}/recipe/extract", json={}).status_code, 200)

    def test_an_account_cannot_read_change_or_list_anothers_recipes(self):
        b = self.h.account()
        mine = self.a.add_item("https://example.com/mine", caption=CAPTION, title="private-marker-a")
        self.extract(mine)
        self.a.ok("PUT", f"/api/items/{mine}/recipe", json={"title": "private-marker-a edit", "ingredients": [{"name": "secret spice"}]})
        theirs = b.add_item("https://example.com/theirs", caption=CAPTION)
        b.ok("POST", f"/api/items/{theirs}/recipe/extract", json={})
        for method, path, body in (("GET", f"/api/items/{mine}/recipe", None), ("PUT", f"/api/items/{mine}/recipe", {"title": "hijack"}), ("POST", f"/api/items/{mine}/recipe/extract", {}),
                                   ("DELETE", f"/api/items/{mine}/recipe/edits", None)):
            with self.subTest(route=method + " " + path):
                got = b.call(method, path, json=body) if body is not None else b.call(method, path)
                self.assertEqual(got.status_code, 404)
                self.assertNotIn("private-marker-a", got.text)
        listed = b.ok("GET", "/api/recipes")
        self.assertEqual([r["item_id"] for r in listed["recipes"]], [theirs])
        self.assertNotIn("private-marker-a", json.dumps(listed))
        self.assertEqual(self.a.ok("GET", f"/api/items/{mine}/recipe")["recipe"]["title"], "private-marker-a edit", "nothing the other account did reached this library")
        self.assertIn(theirs, [r["item_id"] for r in b.ok("GET", "/api/recipes")["recipes"]])

    def test_model_use_is_metered_in_the_callers_own_ledger(self):
        b = self.h.account()
        self.a.use(StubProvider([ai_answer()]))
        b.use(StubProvider([]))
        iid = self.a.add_item(caption=LOOSE_CAPTION)
        self.extract(iid)
        self.assertEqual(self.a.ok("GET", "/api/enrichment/usage")["model_calls"], 1)
        self.assertEqual(b.ok("GET", "/api/enrichment/usage")["model_calls"], 0)


class MigrationTests(unittest.TestCase):
    """A library written before these features upgrades in place, keeps everything and is safe to open again."""

    def build_old_library(self, root):
        data = Path(root) / "data"
        data.mkdir(mode=0o700)
        with sqlite3.connect(data / "library.sqlite3") as db:
            db.executescript(SCHEMA + ENRICH_SCHEMA)
            db.execute("INSERT INTO meta VALUES('schema_version','1')")
            db.execute("INSERT INTO meta VALUES('enrich_schema_version','1')")
            db.execute("INSERT INTO meta VALUES('instance_id','old-instance')")
            db.execute("INSERT INTO items(id,platform,source_account,source_key,url,title,caption,created_at,updated_at,last_seen_at) VALUES('old-1','web','default','k','https://example.com/old','Old save','Old caption','2025-01-01T00:00:00+00:00','2025-01-01T00:00:00+00:00','2025-01-01T00:00:00+00:00')")
            db.execute("INSERT INTO meta VALUES('password_hash','x')")
        return data

    def test_an_existing_library_gains_the_tables_without_losing_anything(self):
        with tempfile.TemporaryDirectory() as root:
            data = self.build_old_library(root)
            with sqlite3.connect(data / "library.sqlite3") as db:
                before = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            self.assertNotIn("item_recipe", before)
            self.assertNotIn("features_schema_version", {r[0] for r in sqlite3.connect(data / "library.sqlite3").execute("SELECT key FROM meta")})
            store = Store(Config(data_dir=data, admin_password=PASSWORD, testing=True))
            ensure_features_schema(store)
            with store.transaction() as c:
                tables = {r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table'")}
                self.assertTrue({"item_recipe", "item_places", "geocode_cache", "guided_imports"} <= tables)
                self.assertEqual(c.execute("SELECT value FROM meta WHERE key='features_schema_version'").fetchone()[0], str(FEATURES_SCHEMA_VERSION))
                self.assertEqual(c.execute("SELECT title,caption FROM items WHERE id='old-1'").fetchone()[:], ("Old save", "Old caption"))
                self.assertEqual(c.execute("SELECT value FROM meta WHERE key='instance_id'").fetchone()[0], "old-instance")
            ensure_features_schema(store)   # again: nothing changes, nothing fails
            with store.transaction() as c:
                self.assertEqual(c.execute("SELECT count(*) FROM items").fetchone()[0], 1)

    def test_the_old_library_opens_through_the_application_and_serves_the_new_routes(self):
        with tempfile.TemporaryDirectory() as root:
            data = self.build_old_library(root)
            with sqlite3.connect(data / "library.sqlite3") as db:
                db.execute("UPDATE meta SET value=? WHERE key='password_hash'", (hash_password(PASSWORD),))
            from unittest.mock import patch
            with patch("server.jobs.ClassificationWorker.start"):
                app = create_app(Config(data_dir=data, admin_password=PASSWORD, public_url="http://testserver", testing=True))
                with TestClient(app) as client:
                    token = client.post("/api/auth/devices", json={"password": PASSWORD, "name": "t"}).json()["token"]
                    headers = {"Authorization": "Bearer " + token}
                    self.assertEqual(client.get("/api/items/old-1/recipe", headers=headers).json()["status"], "none")
                    self.assertEqual(client.get("/api/items/old-1", headers=headers).json()["title"], "Old save")
                    self.assertEqual(client.get("/api/places", headers=headers).json()["total"], 0)

    def test_a_library_from_a_newer_release_is_not_opened_by_an_older_schema_reader(self):
        with tempfile.TemporaryDirectory() as root:
            data = self.build_old_library(root)
            store = Store(Config(data_dir=data, admin_password=PASSWORD, testing=True))
            ensure_features_schema(store)
            store.set_meta("features_schema_version", str(FEATURES_SCHEMA_VERSION + 1))
            with self.assertRaises(ValueError):
                ensure_features_schema(store)

    def test_a_backup_made_before_these_tables_still_restores_and_one_with_them_does_too(self):
        with tempfile.TemporaryDirectory() as root:
            data = self.build_old_library(root)
            old = Path(root) / "old.zip"
            from server.backups import file_digest
            with sqlite3.connect(data / "library.sqlite3") as src, sqlite3.connect(Path(root) / "old.sqlite3") as dest:
                src.backup(dest)
                dest.execute("DELETE FROM meta WHERE key='password_hash'")
            manifest = {"format": "little-archive-backup", "version": 1, "schema_version": 1, "created_at": "2025-01-02T00:00:00+00:00", "items": 1,
                        "files": {"library.sqlite3": {"sha256": file_digest(Path(root) / "old.sqlite3"), "size": (Path(root) / "old.sqlite3").stat().st_size}}}
            with zipfile.ZipFile(old, "w") as z:
                z.write(Path(root) / "old.sqlite3", "library.sqlite3")
                z.writestr("manifest.json", json.dumps(manifest))
            restore_backup(old, Path(root) / "restored-old")
            with sqlite3.connect(Path(root) / "restored-old" / "library.sqlite3") as db:
                self.assertEqual(db.execute("SELECT title FROM items").fetchone()[0], "Old save")
            with sqlite3.connect(":memory:") as reference:
                reference.executescript(SCHEMA + ENRICH_SCHEMA + FEATURES_SCHEMA)
                self.assertTrue(reference.execute("SELECT 1 FROM sqlite_master WHERE name='item_recipe'").fetchone())


if __name__ == "__main__":
    unittest.main()
