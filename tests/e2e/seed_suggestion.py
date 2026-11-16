"""Give one save in the isolated test library a stored suggestion, as a finished classification job leaves one.

The browser suite runs with AI switched off, so nothing in it can produce a suggestion, and the review queue's
Accept and Keep would never meet the real routes. This writes one into the temporary library that run.mjs made
(and only there: it refuses any other data directory), with the fingerprint the server itself computes for the
save, so that /ai/accept takes it. With "stale" it writes a fingerprint that no longer matches, which is what a
save edited after its suggestion looks like: the server then refuses to accept it.

    python seed_suggestion.py <item id> '<suggestion as JSON>' [stale]
"""
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))


def main(item_id, suggestion, stale=False):
    data_dir = os.environ.get("LA_E2E_DATA_DIR", "")
    if not data_dir or os.environ.get("LA_DATA_DIR") != data_dir:
        raise SystemExit("seed_suggestion: only the isolated test library may be written to.")
    from server.app import create_app

    # The app is built, never started: no worker runs and no port is opened. It is only asked for its fingerprint.
    store = create_app().state.store
    with store.transaction() as c:
        item = store.get_item(item_id, c)
        if not item:
            raise SystemExit("seed_suggestion: no such save.")
        fingerprint = "stale" if stale else store.enrichment.worker.fingerprint(item)
        ai = {"needs_review": True, "provider": "e2e", "model": "seeded", **suggestion, "input_hash": fingerprint}
        c.execute("UPDATE items SET ai=?,needs_review=1 WHERE id=?", (json.dumps(ai), item_id))
    print(json.dumps({"seeded": item_id}))


if __name__ == "__main__":
    main(sys.argv[1], json.loads(sys.argv[2]), stale=len(sys.argv) > 3 and sys.argv[3] == "stale")
