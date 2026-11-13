"""Original synthetic records for product exploration; no personal or scraped content."""
from datetime import datetime, timedelta, timezone


def demo_items():
    examples = [
        ("instagram", "A little corner of calm", "Design notes", ["interiors", "slow living"], "A fictional reading nook with warm wood, linen and a place for your current book.", "image"),
        ("tiktok", "The lemon pasta worth remembering", "Food & recipes", ["recipes", "weeknight"], "A synthetic recipe note: lemon, olive oil, pasta water and a generous shower of herbs.", "video"),
        ("web", "Make room for your next idea", "Things to learn", ["creativity", "writing"], "An example article about keeping a small, approachable notebook of ideas.", "article"),
        ("instagram", "Objects with a little soul", "Gift ideas", ["ceramics", "gifts"], "Fictional handmade ceramic objects and thoughtful little gifts.", "image"),
        ("tiktok", "A weekend, somewhere green", "Weekend plans", ["travel", "outdoors"], "An illustrative slow weekend itinerary: a walk, a picnic, a book and no particular rush.", "video"),
        ("instagram", "Good typography is a feeling", "Design notes", ["typography", "design"], "Synthetic design inspiration exploring expressive serif type and thoughtful spacing.", "image"),
        ("web", "A tiny system for big ideas", "Things to learn", ["productivity", "tools"], "A fictional guide to turning interesting saved links into small, achievable projects.", "article"),
        ("tiktok", "One bowl, endless possibilities", "Food & recipes", ["recipes", "seasonal"], "An example grain bowl with roasted vegetables and a bright, simple dressing.", "video"),
        ("instagram", "The art of the thoughtful gift", "Gift ideas", ["gifts", "handmade"], "An original demo idea for assembling a personal gift from a note and a small useful object.", "image"),
        ("web", "Designing a kinder internet", "Things to learn", ["design", "technology"], "A sample essay about software that gives people space to think and control of their data.", "article"),
        ("instagram", "A palette for a slower morning", "Design notes", ["color", "inspiration"], "An illustrative color study in sage, warm cream, terracotta and soft lilac.", "image"),
        ("tiktok", "Stretch, breathe, begin again", "Little discoveries", ["movement", "routine"], "A synthetic bookmark about a short movement break. This is demonstration content, not advice.", "video"),
        ("instagram", "Dinner with the windows open", "Food & recipes", ["gatherings", "recipes"], "An original demo scene of a simple shared dinner, a linen tablecloth and seasonal flowers.", "image"),
        ("web", "Your bookmarks deserve a home", "Little discoveries", ["open source", "tools"], "A demo link showing how a personal library can connect notes, collections and things to revisit.", "article"),
        ("tiktok", "Small adventures, close to home", "Weekend plans", ["travel", "local"], "A fictional collection of ideas for an unhurried afternoon exploring a nearby neighborhood.", "video"),
    ]
    records = []
    for i, (platform, title, collection, tags, caption, content_type) in enumerate(examples):
        if platform == "instagram":
            url = f"https://www.instagram.com/p/LA_DEMO_{i:03d}/"
        elif platform == "tiktok":
            url = f"https://www.tiktok.com/@little_archive_demo/video/{9000000000000000000 + i}"
        else:
            url = f"https://example.com/little-archive-demo/{i + 1}"
        records.append({
            "url": url, "source_account": "demo", "title": title, "creator": "Little Archive · demo",
            "caption": caption, "summary": caption, "content_type": content_type, "tags": tags,
            "notes": "Synthetic demo content. Source links are illustrative and may not resolve.",
            "favorite": i in {0, 3, 7, 11}, "status": "to_revisit" if i in {1, 4, 8} else "done" if i == 2 else "inbox",
            "needs_review": i in {5, 10},
            "saved_at": (datetime.now(timezone.utc) - timedelta(days=i * 3)).isoformat(),
            "collections": [{"name": collection, "kind": "local"}],
        })
    return records
