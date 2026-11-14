"""Device tokens that expire: idle time, an optional lifetime, and old files that must keep working.

The clock is replaced where the tokens read it (`server.devices.now`), so months pass in a test
without waiting. Everything is synthetic and stays in a temporary directory.
"""
from datetime import datetime, timedelta, timezone
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from server.app import create_app
from server.config import Config
from server.devices import DeviceTokens, PREFIX
from server.security import token_hash

PASSWORD = "device-expiry-password-2026"
START = datetime(2031, 1, 1, 10, 0, 0, tzinfo=timezone.utc)


def at(days=0, hours=0, minutes=0):
    return (START + timedelta(days=days, hours=hours, minutes=minutes)).isoformat(timespec="seconds")


class Clock:
    """Where `server.devices.now` is pointed. Move it with `.to(days=...)`."""

    def __init__(self):
        self.value = at()
        self.patch = patch("server.devices.now", side_effect=lambda: self.value)

    def to(self, **moment):
        self.value = at(**moment)

    def __enter__(self):
        self.patch.start()
        return self

    def __exit__(self, *exc):
        self.patch.stop()


class DeviceExpiryTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="little-archive-expiry-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.clock = Clock()
        self.clock.__enter__()
        self.addCleanup(self.clock.__exit__)

    def tokens(self, **settings):
        return DeviceTokens(self.root, **settings)

    def rows(self):
        with sqlite3.connect(self.root / "devices.sqlite3") as c:
            return c.execute("SELECT id FROM device_tokens").fetchall()

    def test_a_token_idle_for_the_limit_stops_working_and_its_row_is_removed(self):
        devices = self.tokens(idle_days=30)
        made = devices.create("Phone")
        self.assertEqual(made["expires_at"], at(days=30))
        self.clock.to(days=29, hours=23)
        self.assertEqual(devices.authenticate(made["token"])["id"], made["id"])
        self.clock.to(days=60)  # more than 30 days after the use above
        self.assertIsNone(devices.authenticate(made["token"]))
        self.assertEqual(self.rows(), [], "an expired token's hash is not kept")
        self.assertEqual(devices.list(), [])

    def test_use_moves_the_idle_deadline_so_a_device_in_use_stays_signed_in(self):
        devices = self.tokens(idle_days=30)
        made = devices.create("Phone")
        for week in range(1, 30):  # most of a year, one use every 20 days
            self.clock.to(days=week * 20)
            row = devices.authenticate(made["token"])
            self.assertIsNotNone(row, f"day {week * 20}")
            self.assertEqual(row["expires_at"], at(days=week * 20 + 30))
        self.assertEqual(devices.list()[0]["expires_at"], at(days=29 * 20 + 30))

    def test_a_lifetime_ends_a_token_however_often_it_is_used(self):
        devices = self.tokens(idle_days=30, max_days=45)
        made = devices.create("Phone")
        self.assertEqual(made["expires_at"], at(days=30))
        for day in (20, 40, 44):
            self.clock.to(days=day)
            self.assertIsNotNone(devices.authenticate(made["token"]), day)
        self.assertEqual(devices.list()[0]["expires_at"], at(days=45), "the earlier of the two limits is reported")
        self.clock.to(days=45, minutes=1)
        self.assertIsNone(devices.authenticate(made["token"]))

    def test_a_lifetime_chosen_when_pairing_applies_to_that_device_only(self):
        devices = self.tokens(idle_days=0)
        short, forever = devices.create("Guest tablet", expires_in_days=7), devices.create("Mine")
        self.assertEqual((short["expires_at"], forever["expires_at"]), (at(days=7), None))
        self.clock.to(days=8)
        self.assertIsNone(devices.authenticate(short["token"]))
        self.assertIsNotNone(devices.authenticate(forever["token"]))
        for bad in (0, -1, 3651, True, "7", 1.5):
            with self.assertRaises(ValueError, msg=repr(bad)):
                devices.create("x", expires_in_days=bad)

    def test_both_rules_off_is_the_old_behaviour(self):
        devices = self.tokens(idle_days=0, max_days=0)
        made = devices.create("Phone")
        self.assertIsNone(made["expires_at"])
        self.clock.to(days=3000)
        self.assertEqual(devices.authenticate(made["token"])["id"], made["id"])

    def test_an_expired_device_does_not_count_toward_the_twenty_device_limit(self):
        devices = self.tokens(idle_days=10)
        for number in range(20):
            devices.create(f"Device {number}")
        with self.assertRaisesRegex(ValueError, "20-device limit"):
            devices.create("One too many")
        self.clock.to(days=11)
        self.assertEqual(devices.create("Fresh")["name"], "Fresh")
        self.assertEqual([row["name"] for row in devices.list()], ["Fresh"])

    def legacy_file(self, last_used):
        """A devices file exactly as the release before this one wrote it: no expiry column, no policy table."""
        path = self.root / "devices.sqlite3"
        token = PREFIX + "legacy-token-synthetic-0123456789abcdefghij"
        with sqlite3.connect(path) as c:
            c.execute("CREATE TABLE device_tokens(id TEXT PRIMARY KEY, name TEXT NOT NULL, hash TEXT UNIQUE NOT NULL, created_at TEXT NOT NULL, last_used_at TEXT)")
            c.execute("INSERT INTO device_tokens VALUES('legacy-id','Old phone',?,?,?)", (token_hash(token), "2029-01-01T00:00:00+00:00", last_used))
        return token

    def test_tokens_from_an_earlier_release_keep_working_through_the_upgrade(self):
        # Last used two years before "now": under the new rule alone it would already be idle for far longer than the limit.
        token = self.legacy_file("2028-12-01T00:00:00+00:00")
        devices = self.tokens(idle_days=180)
        row = devices.authenticate(token)
        self.assertIsNotNone(row, "an upgrade must not sign anyone out")
        self.assertEqual(row["id"], "legacy-id")
        self.assertEqual(row["expires_at"], at(days=180), "the idle clock starts when the policy did")
        with sqlite3.connect(self.root / "devices.sqlite3") as c:
            self.assertIn("expires_at", {r[1] for r in c.execute("PRAGMA table_info(device_tokens)")})
            self.assertEqual(c.execute("SELECT value FROM device_policy WHERE key='policy_started_at'").fetchone()[0], at())
        # From there the ordinary rule applies, counted from the last use.
        self.clock.to(days=179)
        self.assertIsNotNone(devices.authenticate(token))
        self.clock.to(days=179 + 181)
        self.assertIsNone(devices.authenticate(token))

    def test_an_unused_legacy_token_is_listed_and_expires_from_the_upgrade_not_from_its_age(self):
        token = self.legacy_file(None)
        devices = self.tokens(idle_days=90)
        listed = devices.list()
        self.assertEqual([(row["name"], row["expires_at"]) for row in listed], [("Old phone", at(days=90))])
        self.clock.to(days=91)
        self.assertIsNone(devices.authenticate(token))

    def test_the_upgrade_is_repeatable_and_leaves_the_policy_start_alone(self):
        self.legacy_file("2030-12-25T00:00:00+00:00")
        devices = self.tokens(idle_days=90)
        devices.list()
        self.clock.to(days=5)
        devices.list()
        with sqlite3.connect(self.root / "devices.sqlite3") as c:
            self.assertEqual(c.execute("SELECT value FROM device_policy WHERE key='policy_started_at'").fetchone()[0], at())

    def test_settings_are_checked(self):
        for bad in (-1, 3651, True, "30", None):
            with self.assertRaises(ValueError, msg=repr(bad)):
                DeviceTokens(self.root, idle_days=bad)
            with self.assertRaises(ValueError, msg=repr(bad)):
                DeviceTokens(self.root, max_days=bad)
        self.assertEqual(DeviceTokens(self.root).idle_days, 180, "the default is a half year of not being used")
        for key in ("LA_DEVICE_TOKEN_IDLE_DAYS", "LA_DEVICE_TOKEN_MAX_DAYS"):
            for text in ("-1", "99999", "many"):
                with self.assertRaises(ValueError, msg=key + "=" + text):
                    Config.from_env({"LA_DATA_DIR": str(self.root), key: text}).validate()
        config = Config.from_env({"LA_DATA_DIR": str(self.root), "LA_DEVICE_TOKEN_IDLE_DAYS": "0", "LA_DEVICE_TOKEN_MAX_DAYS": "365"})
        config.validate()
        self.assertEqual((config.device_token_idle_days, config.device_token_max_days), (0, 365))
        self.assertEqual(Config.from_env({"LA_DATA_DIR": str(self.root)}).device_token_idle_days, 180)


class DeviceExpiryOverHttpTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="little-archive-expiry-http-")
        self.addCleanup(self.temporary.cleanup)
        self.clock = Clock()
        self.clock.__enter__()
        self.addCleanup(self.clock.__exit__)
        config = Config(data_dir=Path(self.temporary.name) / "data", admin_password=PASSWORD, public_url="http://testserver", testing=True,
                        device_token_idle_days=30)
        self.client = TestClient(create_app(config))
        self.client.__enter__()
        self.addCleanup(self.client.__exit__, None, None, None)

    def pair(self, **extra):
        return self.client.post("/api/auth/devices", json={"password": PASSWORD, "name": "Phone", **extra})

    def test_an_expired_token_is_a_plain_401_with_a_message_that_says_to_pair_again(self):
        made = self.pair().json()
        auth = {"Authorization": "Bearer " + made["token"]}
        self.assertEqual(self.client.get("/api/items", headers=auth).status_code, 200)
        self.clock.to(days=31)
        refused = self.client.get("/api/items", headers=auth)
        self.assertEqual(refused.status_code, 401)
        self.assertEqual(refused.headers["www-authenticate"], "Bearer")
        self.assertIn("expired", refused.json()["detail"])
        self.assertEqual(self.client.get("/api/auth/me", headers=auth).json(), {"authenticated": False, "version": "0.1.0"})
        self.assertEqual(self.pair().status_code, 200, "pairing again works")

    def test_pairing_reports_and_accepts_a_lifetime(self):
        made = self.pair(expires_in_days=3).json()
        self.assertEqual(made["expires_at"], at(days=3))
        auth = {"Authorization": "Bearer " + made["token"]}
        self.assertEqual(self.client.get("/api/auth/devices", headers=auth).json()["devices"][0]["expires_at"], at(days=3))
        self.clock.to(days=4)
        self.assertEqual(self.client.get("/api/items", headers=auth).status_code, 401)
        for bad in (0, 3651, "soon", -5):
            self.assertEqual(self.pair(expires_in_days=bad).status_code, 422, repr(bad))

    def test_the_default_idle_limit_is_half_a_year(self):
        with TemporaryDirectoryClient() as client:
            made = client.post("/api/auth/devices", json={"password": PASSWORD, "name": "Phone"}).json()
            self.assertEqual(made["expires_at"], at(days=180))


class TemporaryDirectoryClient:
    def __enter__(self):
        self.directory = tempfile.TemporaryDirectory(prefix="little-archive-expiry-default-")
        config = Config(data_dir=Path(self.directory.name) / "data", admin_password=PASSWORD, public_url="http://testserver", testing=True)
        self.client = TestClient(create_app(config))
        self.client.__enter__()
        return self.client

    def __exit__(self, *exc):
        self.client.__exit__(None, None, None)
        self.directory.cleanup()


if __name__ == "__main__":
    unittest.main()
