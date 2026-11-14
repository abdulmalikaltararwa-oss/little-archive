"""Hosted mode: one library directory per verified account, and nothing shared.

    <LA_DATA_DIR>/accounts.sqlite3          service bookkeeping, no library content
    <LA_DATA_DIR>/users/<account uuid>/     library.sqlite3, assets/, .backup-work/

The account id is the only input that selects a library. It is checked against
the canonical UUID shape before it becomes a single path component, so every
existing query runs unchanged inside the caller's own database.
"""
from collections import OrderedDict
from contextlib import contextmanager
import hashlib
import os
from pathlib import Path
import re
import secrets
import shutil
import sqlite3
from threading import Event, RLock, Thread
import time
from weakref import WeakValueDictionary

from .identity import valid_user_id
from .storage import LibraryClosed, Store


ACCOUNT_SCHEMA = """
CREATE TABLE IF NOT EXISTS deleted_accounts(user_hash TEXT PRIMARY KEY, deleted_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS pending_jobs(user_id TEXT PRIMARY KEY);
"""
TOMBSTONE_DAYS = 30
DELETING = ".deleting-"


class AccountDeleted(LibraryClosed):
    """The presented token was issued before its account was deleted."""


def account_hash(user_id):
    return hashlib.sha256(user_id.encode()).hexdigest()


def has_queued(c):
    return c.execute("SELECT 1 FROM ai_jobs WHERE status='queued' LIMIT 1").fetchone() is not None


def release_orphans(store):
    """Remove stored images that no item refers to, so they cannot use up an account's quota."""
    with store.lock:
        with store.transaction() as c:
            kept = {row[0] for row in c.execute("SELECT DISTINCT asset_hash FROM items WHERE asset_hash IS NOT NULL")}
        for entry in list(os.scandir(store.assets)):
            if entry.is_file(follow_symlinks=False) and re.fullmatch(r"[0-9a-f]{64}\.png", entry.name) and entry.name[:64] not in kept:
                os.unlink(entry.path)
        store.asset_bytes = None


def understanding_environment(config):
    """The settings every account's understanding service is built from.

    The optional cache of public-post results is one file for the whole service, never a
    file inside each account's directory, so it is not mistaken for account data.
    A transcript is made only when an account asks for a closer read, which is metered;
    the automatic thin-caption rule would spend transcription without that check.
    """
    from .enrich.settings import EnrichSettings
    values = {} if getattr(config, "testing", False) else dict(os.environ)
    values["LA_TRANSCRIBE_AUTO"] = "false"
    settings = EnrichSettings.from_env(values, config).validate()
    if settings.cache_enabled and not settings.cache_path:
        values["LA_PUBLIC_CACHE_PATH"] = str(Path(config.data_dir).resolve() / "public-posts.sqlite3")
    return values


class LibraryManager:
    def __init__(self, config, clock=time.time):
        self.config, self.clock = config, clock
        self.root = Path(config.data_dir)
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        if (self.root / "library.sqlite3").exists() or (self.root / "library.sqlite3").is_symlink():
            raise ValueError("LA_DATA_DIR already holds a single-owner library. Use a separate data directory for hosted mode.")
        self.users = self.root / "users"
        self.users.mkdir(exist_ok=True, mode=0o700)
        self.accounts_path = self.root / "accounts.sqlite3"
        self.max_open = config.hosted_open_libraries
        self.quota = config.hosted_storage_quota_mb * 1024 * 1024
        self.on_delete = []
        self.prepare = None  # called once with each library as it is opened, before anyone else can use it
        self._lock = RLock()            # the open-library cache
        self._accounts_lock = RLock()   # accounts.sqlite3 and the two maps below
        # Bounded strong references, plus a weak map so a library that is still
        # in use by a request or job is never opened a second time.
        self._recent, self._live, self._deleting = OrderedDict(), WeakValueDictionary(), set()
        with self._accounts() as c:
            c.executescript(ACCOUNT_SCHEMA)
            c.execute("DELETE FROM deleted_accounts WHERE deleted_at<?", (int(self.clock()) - TOMBSTONE_DAYS * 86400,))
            self._deleted = {row[0]: row[1] for row in c.execute("SELECT user_hash,deleted_at FROM deleted_accounts")}
            self._pending = OrderedDict((row[0], None) for row in c.execute("SELECT user_id FROM pending_jobs ORDER BY rowid"))
        try:
            self.accounts_path.chmod(0o600)
        except OSError:
            pass

    def resume_deletions(self):
        """Finish deletions that a crash or an error interrupted. Call once `on_delete` is set up.

        A detached directory is named after its account, so every remaining step
        (the deletion record, bookkeeping, the files) can be completed from it.
        """
        for leftover in sorted(self.users.glob(DELETING + "*")):
            user_id = leftover.name[len(DELETING):len(DELETING) + 36]
            try:
                valid_user_id(user_id)
            except ValueError:
                continue
            if leftover.is_dir() and not leftover.is_symlink():
                self._finish_deletion(user_id, leftover)

    @contextmanager
    def _accounts(self):
        with self._accounts_lock:
            conn = sqlite3.connect(self.accounts_path, timeout=15)
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA busy_timeout=15000")
            conn.execute("PRAGMA secure_delete=ON")  # a forgotten account leaves no row remnants
            try:
                with conn:
                    yield conn
            finally:
                conn.close()

    def _path(self, user_id):
        path = self.users / valid_user_id(user_id)
        if path.parent != self.users or path.is_symlink():
            raise ValueError("Account storage must be a plain directory inside the users folder.")
        return path

    def open(self, user_id, create=True, issued_at=None):
        """The caller's library, created empty on first use (background work never creates one).

        `issued_at` is the caller's token time. It is checked here, under the same
        lock a deletion holds, so no request can slip between a deletion and its record.
        """
        path = self._path(user_id)
        with self._lock:
            if user_id in self._deleting or not (create or (path / "library.sqlite3").is_file()):
                raise LibraryClosed("This library was deleted.")
            if issued_at is not None and self.revoked(user_id, issued_at):
                raise AccountDeleted("This account was deleted.")
            store = self._recent.get(user_id) or self._live.get(user_id)
            if store is None or store.closed:
                store = Store(self.config, root=path, tenant=user_id, quota_bytes=self.quota)
                if self.prepare is not None:
                    self.prepare(store)
                self._live[user_id] = store
            self._recent[user_id] = store
            self._recent.move_to_end(user_id)
            while len(self._recent) > self.max_open:
                self._recent.popitem(last=False)
            return store

    def revoked(self, user_id, issued_at, margin=10):
        """True for a token issued before its account was deleted (plus clock margin)."""
        with self._accounts_lock:
            deleted_at = self._deleted.get(account_hash(user_id))
        return deleted_at is not None and issued_at <= deleted_at + margin

    def delete(self, user_id):
        """Permanently remove one account's library, assets and bookkeeping."""
        path = self._path(user_id)
        with self._lock:
            if user_id in self._deleting:
                raise LibraryClosed("This library is already being deleted.")
            self._deleting.add(user_id)
            store = self._recent.pop(user_id, None) or self._live.get(user_id)
            self._live.pop(user_id, None)
        try:
            if store is not None:
                # Waits for any transaction in flight, then refuses all later ones.
                with store.lock:
                    store.closed = True
            if path.is_symlink():
                raise ValueError("Account storage must be a plain directory inside the users folder.")
            detached = None
            if path.exists():
                # One atomic step makes the library unreachable. Everything after it
                # can fail or be interrupted and is completed by `resume_deletions`.
                detached = self.users / f"{DELETING}{user_id}-{secrets.token_hex(8)}"
                os.rename(path, detached)
            self._finish_deletion(user_id, detached, replace_record=True)
            for earlier in self.users.glob(f"{DELETING}{user_id}-*"):
                if earlier.is_dir() and not earlier.is_symlink():
                    shutil.rmtree(earlier)
        finally:
            with self._lock:
                self._deleting.discard(user_id)

    def _finish_deletion(self, user_id, detached, replace_record=False):
        """Record the deletion, drop bookkeeping, remove files: each step is tried even if another fails."""
        failures = []
        try:
            moment = int(self.clock())
            with self._accounts() as c:
                # A token issued before this moment can never recreate the library.
                c.execute("INSERT INTO deleted_accounts VALUES(?,?) ON CONFLICT(user_hash) DO " + ("UPDATE SET deleted_at=excluded.deleted_at" if replace_record else "NOTHING"), (account_hash(user_id), moment))
                c.execute("DELETE FROM pending_jobs WHERE user_id=?", (user_id,))
                c.execute("DELETE FROM deleted_accounts WHERE deleted_at<?", (moment - TOMBSTONE_DAYS * 86400,))
                self._deleted = {row[0]: row[1] for row in c.execute("SELECT user_hash,deleted_at FROM deleted_accounts")}
                self._pending.pop(user_id, None)
        except Exception as error:
            failures.append(error)
        for forget in self.on_delete:
            try:
                forget(user_id)
            except Exception as error:
                failures.append(error)
        if detached is not None:
            try:
                # The content goes regardless. The emptied directory stays as a marker
                # while any other step is unfinished, so the next start retries it.
                for entry in list(detached.iterdir()):
                    if entry.is_dir() and not entry.is_symlink():
                        shutil.rmtree(entry)
                    else:
                        entry.unlink()
                if not failures:
                    detached.rmdir()
            except OSError as error:
                failures.append(error)
        if failures:
            raise failures[0]

    # Background work. A library is "pending" while it may hold queued jobs. The
    # set is durable so queued work resumes after a restart without scanning
    # every account. Lock order is always library lock, then the accounts lock.

    def mark_pending(self, store):
        with self._accounts_lock:
            if store.tenant not in self._pending:
                self._pending[store.tenant] = None
                with self._accounts() as c:
                    c.execute("INSERT OR IGNORE INTO pending_jobs VALUES(?)", (store.tenant,))

    def _drained(self, user_id):
        with self._accounts_lock:
            if self._pending.pop(user_id, "absent") != "absent":
                with self._accounts() as c:
                    c.execute("DELETE FROM pending_jobs WHERE user_id=?", (user_id,))

    def set_aside(self, store):
        """Stop offering a library whose job failed unexpectedly, until work is queued in it again."""
        if store is not None and store.tenant is not None:
            try:
                self._drained(store.tenant)
            except sqlite3.Error:
                with self._accounts_lock:
                    self._pending.pop(store.tenant, None)

    def next_pending(self, has_work):
        """Round-robin: the next library where `has_work(connection)` is true, else None.

        A library that is busy with its own request is skipped for this pass, so
        one account's long import never holds up another account's queued work.
        """
        with self._accounts_lock:
            candidates = list(self._pending)
        for user_id in candidates:
            with self._accounts_lock:
                if user_id not in self._pending:
                    continue
                self._pending.move_to_end(user_id)
            try:
                store = self.open(user_id, create=False)
                if not store.lock.acquire(blocking=False):
                    continue
                try:
                    with store.transaction() as c:
                        if has_work(c):
                            return store
                    self._drained(user_id)
                finally:
                    store.lock.release()
            except (LibraryClosed, ValueError, OSError, sqlite3.Error):
                self._drained(user_id)
        return None


class AccountWorker:
    """Hosted mode: one thread serves every account's queue, one group of jobs per account in turn.

    Each account library has its own understanding service and worker object (built by
    ``enrich.build_enrichment``); this class only decides whose turn it is and keeps one
    account's failure from stopping the rest.
    """

    def __init__(self, libraries):
        self.libraries, self.stopping, self.wake, self.thread, self.backoff = libraries, Event(), Event(), None, 1

    def adopt(self, store, service, charge_deep_read=None):
        """Attach an account library's understanding service and route its queueing through here."""
        store.enrichment = service
        worker = service.worker
        worker.wake = self.wake
        enqueue, enqueue_deep = worker.enqueue, worker.enqueue_deep

        def queue(ids):
            with store.lock:
                count = enqueue(ids)
                if count:
                    self.libraries.mark_pending(store)
                return count

        def queue_deep(item_id):
            with store.lock:
                if charge_deep_read is not None:
                    charge_deep_read(store.tenant)  # raises when the account has no allowance left
                enqueue_deep(item_id)
                self.libraries.mark_pending(store)

        worker.enqueue, worker.enqueue_deep = queue, queue_deep

    def start(self):
        self.thread = Thread(target=self.run, daemon=True, name="little-archive-accounts")
        self.thread.start()

    def stop(self):
        self.stopping.set()
        self.wake.set()
        if self.thread:
            self.thread.join(timeout=2)

    def run(self):
        while not self.stopping.is_set():
            if not self.step():
                self.wake.wait(timeout=2)
                self.wake.clear()

    def step(self) -> bool:
        """Do one group of jobs for the next account with queued work; False when there is none."""
        store = None
        try:
            store = self.libraries.next_pending(has_queued)
            if store is None:
                return False
            store.enrichment.worker.step()
        except Exception:
            # One library's failure (its account deleted mid-job, a full disk) must
            # not end every account's work. It is set aside until work is queued again.
            self.libraries.set_aside(store)
            self.stopping.wait(self.backoff)
        return True
