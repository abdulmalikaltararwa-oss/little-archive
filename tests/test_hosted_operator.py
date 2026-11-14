"""Operator commands in hosted mode: read-only diagnostics and the owner-password reset.

Synthetic configuration in temporary directories; no network and no library is opened.
"""
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from server import cli
from server.diagnostics import diagnose


SECRET = "synthetic-legacy-jwt-secret-of-at-least-32-bytes"


class HostedOperatorTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="little-archive-hosted-operator-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.data = self.root / "data"
        self.environment = {"LA_MODE": "hosted", "LA_SUPABASE_URL": "https://synthetic-project.supabase.test", "LA_SUPABASE_JWT_SECRET": SECRET,
                            "LA_DATA_DIR": str(self.data), "LA_PUBLIC_URL": "http://localhost:8787"}

    def report(self, **changes):
        guards = (patch("socket.create_connection", side_effect=AssertionError("Network was not requested")),
                  patch("httpx.Client", side_effect=AssertionError("Network was not requested")),
                  patch("server.identity.fetch_jwks", side_effect=AssertionError("Signing keys were not requested")),
                  patch("sqlite3.connect", side_effect=AssertionError("No database may be opened")))
        with guards[0], guards[1], guards[2], guards[3]:
            return diagnose(env_file=self.root / "absent.env", environment={**self.environment, **changes})

    @staticmethod
    def row(result, identifier):
        return next(row for row in result["checks"] if row["id"] == identifier)

    def test_doctor_describes_hosted_mode_without_network_secrets_or_side_effects(self):
        result = self.report()
        self.assertEqual(result["exit_code"], 0, result)
        self.assertEqual(self.row(result, "configuration")["code"], "configuration_valid")
        self.assertEqual(self.row(result, "configuration")["details"]["sources"]["LA_MODE"], "environment")
        self.assertEqual(self.row(result, "owner_access")["code"], "identity_provider_sign_in")
        self.assertEqual(self.row(result, "database")["code"], "per_account_libraries")
        for package in ("pyjwt", "cryptography"):
            self.assertEqual(self.row(result, "dependency_" + package)["code"], "dependency_installed")
        serialized = json.dumps(result)
        for private in (SECRET, str(self.root), "synthetic-project"):
            self.assertNotIn(private, serialized)
        self.assertFalse(self.data.exists(), "diagnostics must not create the data directory")

    def test_doctor_blocks_contradictory_hosted_settings(self):
        self.assertEqual(self.row(self.report(LA_ADMIN_PASSWORD="a-private-owner-password"), "configuration")["code"], "configuration_invalid")
        self.assertEqual(self.row(self.report(LA_SUPABASE_URL=""), "configuration")["code"], "configuration_invalid")
        self.data.mkdir()
        (self.data / "library.sqlite3").write_bytes(b"SQLite format 3\x00 synthetic single-owner library")
        result = self.report()
        self.assertEqual(self.row(result, "database")["code"], "single_owner_library_present")
        self.assertEqual(result["exit_code"], 1)

    def test_owner_password_reset_is_refused_before_prompting(self):
        errors = io.StringIO()
        with patch.dict(os.environ, self.environment), patch("getpass.getpass", side_effect=AssertionError("No password prompt in hosted mode")), patch("sys.stderr", errors):
            self.assertEqual(cli.main(["reset-password", "--env-file", str(self.root / "absent.env")]), 1)
        self.assertIn("no owner password", errors.getvalue())
        self.assertFalse(self.data.exists())


if __name__ == "__main__":
    unittest.main()
