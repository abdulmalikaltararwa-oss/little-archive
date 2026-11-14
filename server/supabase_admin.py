"""Deleting a person's Supabase sign-in, with the project's secret key.

Account deletion removes the library from this server; App Store guideline 5.1.1(v) also requires that the person's account
itself be deleted, and an app holds only a user token, which cannot delete its own user. This is the one place the server uses
the project's secret key, and it uses it for one request: `DELETE /auth/v1/admin/users/{id}`.

The key comes from the environment only (`LA_SUPABASE_SERVICE_KEY`). It is never logged, never put in an error, never returned
by a route, never shown by `doctor`, and not part of this object's `repr`. The request goes to the configured project's own
origin, follows no redirects (a redirect would carry the key to another host) and ignores proxy environment variables.

Verified only against a stand-in server in this repository's tests; not against a live Supabase project. The request shape (the
endpoint, the `apikey` header for a `sb_secret_` key, `apikey` plus a bearer token for a legacy `service_role` JWT, and the
`should_soft_delete` flag) follows Supabase's published client libraries and API-key guide.
"""
from __future__ import annotations

import httpx

from .identity import valid_user_id


class AdminUnavailable(Exception):
    """The deletion could not be completed now. `reason` is a short code safe to store and show; `retryable` says whether trying later can help."""

    def __init__(self, reason, retryable=True):
        super().__init__(reason)
        self.reason, self.retryable = reason, retryable


class SupabaseAdmin:
    def __init__(self, base_url, key, *, transport=None, timeout=10.0):
        if not key:
            raise ValueError("A secret key is needed to delete sign-ins.")
        self._base = base_url.rstrip("/")
        self._key = key  # private: nothing reads it back out
        self._transport, self._timeout = transport, float(timeout)

    def __repr__(self):
        return f"SupabaseAdmin(base_url={self._base!r}, key=<hidden>)"

    __str__ = __repr__

    def _headers(self):
        # A new-style secret key (sb_secret_...) is not a JWT and goes in `apikey` only; the older service_role key is a JWT and
        # is sent the way Supabase's own libraries send it.
        headers = {"apikey": self._key, "Content-Type": "application/json", "Accept": "application/json"}
        if self._key.startswith("eyJ"):
            headers["Authorization"] = "Bearer " + self._key
        return headers

    def delete_user(self, user_id):
        """Delete the Supabase user, permanently. Returns when the user is gone (including: was already gone). Raises AdminUnavailable."""
        user_id = valid_user_id(user_id)
        timeout = httpx.Timeout(self._timeout, connect=min(5.0, self._timeout))
        try:
            with httpx.Client(transport=self._transport, timeout=timeout, follow_redirects=False, trust_env=False) as client:
                response = client.request("DELETE", f"{self._base}/auth/v1/admin/users/{user_id}", headers=self._headers(), json={"should_soft_delete": False})
        except httpx.TimeoutException:
            raise AdminUnavailable("timeout") from None
        except (httpx.HTTPError, OSError):
            raise AdminUnavailable("unreachable") from None
        status = response.status_code
        if status in (200, 204, 404):
            return  # gone: deleted now, or deleted before (deleting twice is not an error)
        if status in (401, 403):
            raise AdminUnavailable("key_refused")  # the key is wrong, rotated or lacks rights; an operator has to fix it
        if status == 429 or status >= 500:
            raise AdminUnavailable("service_unavailable")
        if 300 <= status < 400:
            raise AdminUnavailable("redirected")  # never followed
        raise AdminUnavailable("rejected")
