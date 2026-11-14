"""The durable worker, driven by the provider interface instead of one fixed Ollama call.

It extends ``jobs.ClassificationWorker`` so queueing, cancelling, retrying and restart
recovery behave exactly as before, and replaces how a claimed job is run:

* queued jobs are claimed in groups the provider can take in one call (Gemini batches,
  Ollama takes one at a time);
* a job that needs a transcript first (an explicit "deep read", or the thin-caption rule
  with automatic transcription on) is handled one at a time: the transcript is stored, the
  job is re-keyed to the item's new evidence, then the item is analysed;
* the review flow is unchanged. A result is only written if the job is still active and
  the item's evidence still matches; the owner accepts or dismisses it.

Tenancy seam: this class reads ``self.store`` and ``self.service`` only. A deployment that
runs one library per user builds one worker per store through ``build_enrichment``.
"""
from __future__ import annotations

import hashlib
import logging
from uuid import uuid4

from ..jobs import ClassificationWorker
from ..storage import json_text, now
from .service import EnrichError
from .understanding import build_evidence
from .urls import classify_url

log = logging.getLogger("little_archive.enrich")
GENERIC_FAILURE = "Classification failed. Check the configured AI provider and try again."


class _Job:
    def __init__(self, row, item):
        self.id, self.item_id, self.hash, self.item = row["id"], row["item_id"], row["input_hash"], item
        self.special = False

    @property
    def deep(self) -> bool:
        return self.hash.startswith("deep:")


class UnderstandingWorker(ClassificationWorker):
    def __init__(self, store, config, service):
        super().__init__(store, config)
        self.service = service

    # -- configuration ------------------------------------------------------
    def enabled(self) -> bool:
        # Run when there is something to do: understanding, or transcribing for a deep read.
        return self.service.provider is not None or self.service.transcriber is not None

    def fingerprint(self, item):
        """Hash everything that could reach any provider for this item, plus the pipeline itself.

        Owner notes, evidence and collection names are all included (as they always were) so
        that any change to them offers a fresh suggestion, even when this deployment sends
        only public text to its provider; a changed pipeline invalidates stored suggestions.
        """
        analyzer = self.service.analyzer()
        evidence = build_evidence(item, mode="full", budget=analyzer.budget)
        return hashlib.sha256(json_text({"evidence": evidence.source, "evidence_level": evidence.level, "analysis": analyzer.material()}).encode()).hexdigest()

    def enqueue_deep(self, item_id) -> None:
        """Queue a closer read. Its key is unique so it cannot be mistaken for finished work."""
        with self.store.transaction() as c:
            if not self.store.get_item(item_id, c):
                raise ValueError("One of the selected items no longer exists.")
            c.execute("INSERT INTO ai_jobs(id,item_id,input_hash,created_at,updated_at) VALUES(?,?,?,?,?)", (str(uuid4()), item_id, "deep:" + uuid4().hex, now(), now()))
            self.service._upsert(c, item_id, deep_read_state="queued", deep_read_error="")
        self.wake.set()

    # -- the loop -----------------------------------------------------------------
    def run(self):
        while not self.stopping.is_set():
            if not self.step():
                self.wake.wait(timeout=2)
                self.wake.clear()

    def step(self) -> bool:
        """Claim and process one group of queued jobs; False when nothing was queued.

        A deployment with a library per account calls this from one shared thread,
        for each library with queued work in turn (``tenancy.AccountWorker``).
        """
        jobs = self._claim()
        if not jobs:
            return False
        try:
            self._process(jobs)
        except Exception:
            # Never return model text, URLs, credentials or stack traces to clients or logs.
            log.warning("A background understanding job failed unexpectedly.", exc_info=False)
            for job in jobs:
                self._fail(job, GENERIC_FAILURE)
        return True

    def _claim(self) -> list[_Job]:
        limit = self.service.batch_limit()
        claimed: list[_Job] = []
        with self.store.transaction() as c:
            rows = c.execute("SELECT * FROM ai_jobs WHERE status='queued' ORDER BY created_at,id LIMIT ?", (max(limit, 1),)).fetchall()
            for row in rows:
                item = self.store.get_item(row["item_id"], c)
                job = _Job(row, item)
                # A job that needs audio first is slow and is handled on its own.
                job.special = item is not None and (job.deep or self.service.wants_auto_transcript(item))
                if job.special and claimed:
                    break  # take it on the next pass
                c.execute("UPDATE ai_jobs SET status='running',updated_at=? WHERE id=?", (now(), job.id))
                claimed.append(job)
                if job.special:
                    break
        return claimed

    def _process(self, jobs: list[_Job]) -> None:
        plain = []
        for job in jobs:
            if job.item is None:
                self._fail(job, "This item no longer exists.")
            elif job.special:
                self._process_special(job)
            else:
                plain.append(job)
        if plain:
            self._analyze(plain)

    # -- jobs that need a transcript first ---------------------------------------------
    def _process_special(self, job: _Job) -> None:
        with self.store.transaction() as c:
            self.service._upsert(c, job.item_id, deep_read_state="running", deep_read_error="")
        try:
            item = self.service.transcribe_item(job.item, deep=job.deep)
        except EnrichError as exc:
            with self.store.transaction() as c:
                self.service._upsert(c, job.item_id, deep_read_state="failed", deep_read_error=exc.message[:500])
            if job.deep or not self.service.ai_ready():
                self._fail(job, exc.message)
                return
            item = self.store.get_item(job.item_id)  # an automatic attempt falls back to the text that exists
            if item is None:
                return
        except Exception:
            with self.store.transaction() as c:
                self.service._upsert(c, job.item_id, deep_read_state="failed", deep_read_error="The closer read could not be completed.")
            self._fail(job, GENERIC_FAILURE)
            return
        job = self._rekey(job, item)
        if job is None:
            return
        if not self.service.ai_ready():
            with self.store.transaction() as c:
                c.execute("UPDATE ai_jobs SET status='completed',error='',updated_at=? WHERE id=? AND status='running'", (now(), job.id))
            return
        self._analyze([job])

    def _rekey(self, job: _Job, item: dict):
        """Point the job at the evidence it will really analyse (the transcript changed it)."""
        new_hash = self.fingerprint(item)
        with self.store.transaction() as c:
            active = c.execute("SELECT status FROM ai_jobs WHERE id=?", (job.id,)).fetchone()
            if not active or active["status"] != "running":
                return None  # cancelled while the audio was being read
            other = c.execute("SELECT id,status FROM ai_jobs WHERE item_id=? AND input_hash=? AND id!=?", (job.item_id, new_hash, job.id)).fetchone()
            if other:
                # The same evidence already has a job (and so a result or a queued run); this one is redundant.
                if other["status"] in {"failed", "cancelled"}:
                    c.execute("UPDATE ai_jobs SET status='queued',error='',updated_at=? WHERE id=?", (now(), other["id"]))
                c.execute("UPDATE ai_jobs SET status='completed',error='',updated_at=? WHERE id=?", (now(), job.id))
                self.wake.set()
                return None
            c.execute("UPDATE ai_jobs SET input_hash=?,updated_at=? WHERE id=?", (new_hash, now(), job.id))
        job.hash, job.item = new_hash, item
        return job

    # -- analysis ---------------------------------------------------------------------------
    def _analyze(self, jobs: list[_Job]) -> None:
        analyzer = self.service.analyzer()
        local = self.service.local_collection_names()
        prepared, by_key = [], {}
        for job in jobs:
            try:
                cache_url = classify_url(job.item["url"]).canonical
            except ValueError:
                cache_url = None
            p = analyzer.prepare(job.id, job.item, manual_title=self.service.manual_title(job.item_id), local_collections=local, cache_url=cache_url)
            prepared.append(p)
            by_key[job.id] = job
        outcomes = analyzer.run(prepared, job_ids={j.id: j.id for j in jobs})
        for key, job in by_key.items():
            outcome = outcomes.get(key)
            if outcome is not None and outcome.result is not None:
                self._complete(job, outcome.result)
            else:
                self._fail(job, (outcome.error if outcome else None) or GENERIC_FAILURE)

    def _complete(self, job: _Job, result: dict) -> None:
        result = dict(result, created_at=now(), input_hash=job.hash, evidence_snapshot=job.item.get("evidence", []))
        with self.store.transaction() as c:
            # Cancellation is durable. A model request already in flight may finish, but must
            # never revive a cancelled or requeued job.
            active = c.execute("SELECT status FROM ai_jobs WHERE id=?", (job.id,)).fetchone()
            if not active or active["status"] != "running":
                return
            current = self.store.get_item(job.item_id, c)
            if current and self.fingerprint(current) == job.hash:
                dismissed = c.execute("SELECT ai_dismissed FROM items WHERE id=?", (job.item_id,)).fetchone()[0]
                if dismissed != job.hash:
                    c.execute("UPDATE items SET ai=?,needs_review=1,updated_at=? WHERE id=?", (json_text(result), now(), job.item_id))
                c.execute("UPDATE ai_jobs SET status='completed',error='',updated_at=? WHERE id=?", (now(), job.id))
                if job.deep:
                    self.service._upsert(c, job.item_id, deep_read_state="", deep_read_error="")
            elif current:
                c.execute("UPDATE ai_jobs SET status='failed',error='Item changed during classification. Queue it again.',updated_at=? WHERE id=?", (now(), job.id))

    def _fail(self, job: _Job, message: str) -> None:
        with self.store.transaction() as c:
            c.execute("UPDATE ai_jobs SET status='failed',error=?,updated_at=? WHERE id=? AND status='running'", (message[:500], now(), job.id))
