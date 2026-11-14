"""One durable classification worker per instance; the library remains usable without AI."""
import hashlib
import threading
from uuid import uuid4

from .storage import json_text, now


class ClassificationWorker:
    def __init__(self, store, config, libraries=None):
        # Tenant-awareness: a single-owner instance works on `store`. A hosted
        # instance passes `libraries` (server.tenancy.LibraryManager) instead and
        # every job is claimed from, and written back to, its own account's library.
        self.store, self.config, self.libraries, self.active = store, config, libraries, None
        self.stopping = threading.Event()
        self.wake = threading.Event()
        self.thread = None

    def fingerprint(self, item):
        # Hash the classifier's actual bounded input projection, not a second
        # hand-maintained subset. Creator and collection changes are evidence
        # changes too. Keep acceptance checks on this same helper.
        from .classifier import _evidence, SYSTEM_PROMPT, SCHEMA
        evidence, level = _evidence(item)
        data = {
            "evidence": evidence,
            "evidence_level": level,
            "model": self.config.ollama_model,
            "endpoint": self.config.ollama_url,
            "system_prompt": SYSTEM_PROMPT,
            "output_schema": SCHEMA,
            "prompt_version": 1,
        }
        return hashlib.sha256(json_text(data).encode()).hexdigest()

    @staticmethod
    def has_queued(c):
        return c.execute("SELECT 1 FROM ai_jobs WHERE status='queued' LIMIT 1").fetchone() is not None

    def enqueue(self, ids, store=None, charge=None):
        store = store or self.store
        count = 0
        with store.transaction() as c:
            for iid in dict.fromkeys(ids):
                item = store.get_item(iid, c)
                if not item:
                    raise ValueError("One of the selected items no longer exists.")
                digest = self.fingerprint(item)
                old = c.execute("SELECT id,status FROM ai_jobs WHERE item_id=? AND input_hash=?", (iid, digest)).fetchone()
                if old and old["status"] in {"queued", "running", "completed"}:
                    continue
                if old:
                    c.execute("UPDATE ai_jobs SET status='queued',error='',updated_at=? WHERE id=?", (now(), old["id"]))
                else:
                    c.execute("INSERT INTO ai_jobs(id,item_id,input_hash,created_at,updated_at) VALUES(?,?,?,?,?)", (str(uuid4()), iid, digest, now(), now()))
                count += 1
            if count and charge:
                charge(count)  # Raises to roll the whole request back when over an allowance.
            if count and self.libraries:
                self.libraries.mark_pending(store)
        self.wake.set()
        return count

    def start(self):
        if self.config.ollama_url and self.config.ollama_model:
            self.thread = threading.Thread(target=self.run, daemon=True, name="little-archive-classifier")
            self.thread.start()

    def stop(self):
        self.stopping.set()
        self.wake.set()
        if self.thread:
            self.thread.join(timeout=2)

    def run(self):
        while not self.stopping.is_set():
            try:
                self.work()
            except Exception:
                if not self.libraries:
                    raise  # Single-owner behaviour is unchanged.
                # Hosted: one library's failure (its account deleted mid-job, a full
                # disk) must not end every account's work.
                self.libraries.set_aside(self.active)
                self.stopping.wait(1)

    def work(self):
        from .classifier import classify_item
        while not self.stopping.is_set():
            self.active = None
            store = self.active = self.libraries.next_pending(self.has_queued) if self.libraries else self.store
            if store is None:
                self.wake.wait(timeout=2)
                self.wake.clear()
                continue
            with store.transaction() as c:
                row = c.execute("SELECT * FROM ai_jobs WHERE status='queued' ORDER BY created_at,id LIMIT 1").fetchone()
                if row:
                    job = dict(row)
                    c.execute("UPDATE ai_jobs SET status='running',updated_at=? WHERE id=?", (now(), job["id"]))
                    item = store.get_item(job["item_id"], c)
            if not row:
                self.wake.wait(timeout=2)
                self.wake.clear()
                continue
            try:
                if not item:
                    continue
                result = classify_item(item, self.config.ollama_url, self.config.ollama_model)
                result.update(created_at=now(), input_hash=job["input_hash"], evidence_snapshot=item.get("evidence", []))
                with store.transaction() as c:
                    # Cancellation is durable. A model request already in flight
                    # may finish, but must never revive a cancelled/requeued job.
                    active = c.execute("SELECT status FROM ai_jobs WHERE id=?", (job["id"],)).fetchone()
                    if not active or active["status"] != "running":
                        continue
                    current = store.get_item(item["id"], c)
                    if current and self.fingerprint(current) == job["input_hash"]:
                        dismissed = c.execute("SELECT ai_dismissed FROM items WHERE id=?", (item["id"],)).fetchone()[0]
                        if dismissed != job["input_hash"]:
                            c.execute("UPDATE items SET ai=?,needs_review=1,updated_at=? WHERE id=?", (json_text(result), now(), item["id"]))
                        c.execute("UPDATE ai_jobs SET status='completed',error='',updated_at=? WHERE id=?", (now(), job["id"]))
                    elif current:
                        c.execute("UPDATE ai_jobs SET status='failed',error='Item changed during classification. Queue it again.',updated_at=? WHERE id=?", (now(), job["id"]))
            except Exception:
                # Avoid returning model text, URLs, credentials, or stack traces to clients/logs.
                with store.transaction() as c:
                    c.execute("UPDATE ai_jobs SET status='failed',error='Classification failed. Check the configured local model and try again.',updated_at=? WHERE id=? AND status='running'", (now(), job["id"]))
