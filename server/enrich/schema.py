"""Additive schema for the understanding layer. Separate from ``storage.SCHEMA`` on purpose.

``ensure_schema`` only ever creates tables that do not exist, so it is safe to call on
every start and for every Store a deployment creates. It never alters ``items`` or any
other existing table; the extra tables are ignorable by older code, and restore accepts
a backup with or without them (see ``backups.restore_backup``).
"""
from __future__ import annotations

ENRICH_SCHEMA_VERSION = "1"

ENRICH_SCHEMA = """
CREATE TABLE IF NOT EXISTS item_enrichment(
 item_id TEXT PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
 page TEXT NOT NULL DEFAULT '',
 page_source TEXT NOT NULL DEFAULT '',
 page_at TEXT,
 transcript_source TEXT NOT NULL DEFAULT '',
 transcript_language TEXT NOT NULL DEFAULT '',
 transcript_seconds REAL,
 transcript_at TEXT,
 deep_read_state TEXT NOT NULL DEFAULT '',
 deep_read_error TEXT NOT NULL DEFAULT '',
 updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS enrich_usage(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 at TEXT NOT NULL, kind TEXT NOT NULL, tier TEXT NOT NULL,
 provider TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '',
 item_id TEXT, job_id TEXT, items INTEGER NOT NULL DEFAULT 1,
 model_calls INTEGER NOT NULL DEFAULT 0, input_tokens INTEGER, output_tokens INTEGER,
 audio_seconds REAL NOT NULL DEFAULT 0, bytes_fetched INTEGER NOT NULL DEFAULT 0,
 deep_read INTEGER NOT NULL DEFAULT 0, cache_hit INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_enrich_usage_at ON enrich_usage(at);
"""


def ensure_schema(store) -> None:
    with store.transaction() as c:
        c.executescript(ENRICH_SCHEMA)
        c.execute("INSERT OR IGNORE INTO meta VALUES('enrich_schema_version',?)", (ENRICH_SCHEMA_VERSION,))
        # A deep read that was waiting when the process stopped, or whose job a restore
        # marked failed, must not look pending forever.
        c.execute(
            "UPDATE item_enrichment SET deep_read_state='failed', deep_read_error='This request was interrupted. Ask again to retry.' "
            "WHERE deep_read_state IN ('queued','running') AND item_id NOT IN (SELECT item_id FROM ai_jobs WHERE status IN ('queued','running'))"
        )
