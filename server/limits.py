"""Hosted mode: rate limits, concurrency caps and the early checks that run before a request body is read.

Everything here is in this process's memory. That is correct for the one worker process this server is run with (see
docs/hosted-mode.md); with more than one process or more than one machine each would keep its own counts, so the limits
become per process and a shared store (or the reverse proxy) is needed. Nothing here persists across a restart.

Four things, none of which a client can switch off or choose:

* a per-address request budget, applied to every request before anything else is done with it;
* a per-account request budget, with a heavier price for the routes that cost the most (exports, imports, thumbnail
  decoding, page reading, AI queueing), applied once the account is known;
* a cap on how many expensive requests one account, and the service as a whole, runs at the same moment;
* a budget of failed sign-in attempts per address. An expired token is not a failure (a phone refreshes it); a
  forged, malformed or wrong-audience one is.

`Refusal` is the one error type for "no, and here is what to tell the person": it answers with the usual
`{"detail": ...}` plus a machine-readable `code` (and, for a cap, a `limit` object), so an app can show a clear message.
"""
from __future__ import annotations

import asyncio
from collections import OrderedDict
import ipaddress
import re
from threading import Lock
import time

from fastapi import HTTPException
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool


class Refusal(HTTPException):
    """A refusal with a stable `code` and optional extra fields, answered as `{"detail", "code", **extra}`."""

    def __init__(self, status_code, detail, code, headers=None, **extra):
        super().__init__(status_code, detail, headers=headers)
        self.code, self.extra = code, extra

    def body(self):
        return {"detail": self.detail, "code": self.code, **self.extra}


def refusal_response(exc):
    body = exc.body() if isinstance(exc, Refusal) else {"detail": exc.detail}
    return JSONResponse(body, status_code=exc.status_code, headers=exc.headers)


def retry_after(seconds):
    return {"Retry-After": str(max(1, int(seconds + 0.999)))}


class Buckets:
    """Token buckets by key: `per_minute` tokens a minute, up to `burst` at once. Memory is bounded."""

    def __init__(self, per_minute, burst=None, max_keys=50_000, clock=time.monotonic):
        self.rate, self.burst = per_minute / 60.0, float(burst if burst is not None else per_minute)
        self.max_keys, self.clock = max_keys, clock
        self._state, self._lock = OrderedDict(), Lock()

    def take(self, key, cost=1):
        """0.0 when the request may go ahead; otherwise the seconds until it could."""
        if self.rate <= 0:
            return 0.0
        now = self.clock()
        with self._lock:
            tokens, stamp = self._state.pop(key, (self.burst, now))
            tokens = min(self.burst, tokens + (now - stamp) * self.rate)
            allowed = tokens >= min(cost, self.burst)
            if allowed:
                tokens -= min(cost, self.burst)
            self._state[key] = (tokens, now)  # most recently used goes last
            while len(self._state) > self.max_keys:
                self._state.popitem(last=False)  # the least recently seen key has the oldest (and so fullest) bucket
            return 0.0 if allowed else (min(cost, self.burst) - tokens) / self.rate

    def spend(self, key, cost=1):
        """Take a token for something that already happened (a failure). Returns the wait once none are left, else 0.0."""
        if self.rate <= 0:
            return 0.0
        now = self.clock()
        with self._lock:
            tokens, stamp = self._state.pop(key, (self.burst, now))
            tokens = min(self.burst, tokens + (now - stamp) * self.rate) - cost
            self._state[key] = (max(tokens, -self.burst), now)
            while len(self._state) > self.max_keys:
                self._state.popitem(last=False)
            return 0.0 if tokens >= 0 else -tokens / self.rate


class Gates:
    """How many expensive requests run at once: per account, and for the service as a whole."""

    def __init__(self, per_account, overall):
        self.per_account, self.overall = per_account, overall
        self._by_account, self._total, self._lock = {}, 0, Lock()

    def enter(self, account):
        """A function that gives the place back, or the reason it could not be had: 'account' or 'service'."""
        with self._lock:
            if self._by_account.get(account, 0) >= self.per_account:
                return None, "account"
            if self._total >= self.overall:
                return None, "service"
            self._by_account[account] = self._by_account.get(account, 0) + 1
            self._total += 1
        done = []

        def leave():
            if done:
                return
            done.append(True)
            with self._lock:
                self._total -= 1
                self._by_account[account] -= 1
                if not self._by_account[account]:
                    del self._by_account[account]
        return leave, None

    def counts(self):
        with self._lock:
            return self._total, dict(self._by_account)


def client_address(scope, trusted_hops=0):
    """The address a request came from: the socket's peer, or with `trusted_hops` reverse proxies in front, the address the
    first of them saw. X-Forwarded-For is believed only that many entries from the right (what the proxies appended), never
    from the left (what the client wrote). A value that is not an address falls back to the socket's peer.
    """
    peer = (scope.get("client") or ("unknown", 0))[0]
    if trusted_hops > 0:
        values = [value.decode("latin-1") for name, value in scope.get("headers", []) if name == b"x-forwarded-for"]
        chain = [part.strip() for value in values for part in value.split(",") if part.strip()]
        if len(chain) >= trusted_hops:
            candidate = chain[-trusted_hops]
            try:
                return str(ipaddress.ip_address(candidate))
            except ValueError:
                pass
    return str(peer)


# Which routes cost what. Anything not listed costs one token and has no concurrency cap. A new feature route can be added
# here, or call `HostedLimits.admit` itself; it is covered by the per-address and per-account budgets either way.
ROUTE_CLASSES = (
    ("heavy", "GET", re.compile(r"/api/(?:export|backup)")),
    ("heavy", "POST", re.compile(r"/api/imports/file")),
    ("heavy", "POST", re.compile(r"/api/items/[^/]+/thumbnail")),
    ("fetch", "POST", re.compile(r"/api/items/[^/]+/page")),
    ("ai", "POST", re.compile(r"/api/ai/jobs(?:/[^/]+/retry)?")),
    ("ai", "POST", re.compile(r"/api/items/[^/]+/deep-read")),
)
COSTS = {"heavy": 10, "fetch": 5, "ai": 3}
FETCH_GATE = (2, 16)  # page reading by the server holds a worker for up to twenty seconds


def route_class(method, path):
    for name, verb, pattern in ROUTE_CLASSES:
        if method == verb and pattern.fullmatch(path):
            return name
    return None


class HostedLimits:
    def __init__(self, config, clock=time.monotonic):
        self.trusted_hops = config.hosted_trusted_proxy_hops
        self.by_address = Buckets(config.hosted_rate_address_per_minute, clock=clock)
        self.notifications = Buckets(60, clock=clock)  # unauthenticated store notifications, per address
        self.by_account = Buckets(config.hosted_rate_account_per_minute, clock=clock)
        # A failed sign-in costs one token of a bucket that holds this many and refills over ten minutes.
        self.failures = Buckets(config.hosted_rate_auth_failures / 10, burst=config.hosted_rate_auth_failures, clock=clock) if config.hosted_rate_auth_failures else Buckets(0)
        self.gates = {"heavy": Gates(config.hosted_heavy_per_account, config.hosted_heavy_overall), "fetch": Gates(*FETCH_GATE)}

    def address(self, address, notification=False):
        """Seconds to wait, or 0.0."""
        return (self.notifications if notification else self.by_address).take(address)

    def auth_failed(self, address):
        """Record a failed sign-in. Returns the seconds to wait once this address has used up its failures, else 0.0."""
        return self.failures.spend(address)

    def admit(self, method, path, account, releases):
        """Charge an account's budget for this request and, for an expensive route, take its place in the line.

        Raises `Refusal`. Each place taken is appended to `releases` as a function; the caller (the request guard) calls them
        when the response is finished, whatever happened.
        """
        kind = route_class(method, path)
        wait = self.by_account.take(account, COSTS.get(kind, 1))
        if wait:
            raise Refusal(429, "Too many requests from this account. Wait a moment and try again.", "rate_limited", headers=retry_after(wait), scope="account", retry_after=int(wait + 0.999))
        if kind in self.gates:
            leave, why = self.gates[kind].enter(account)
            if leave is None:
                if why == "account":
                    raise Refusal(429, "This account already has this kind of request running. Wait for it to finish, then try again.", "too_many_concurrent", headers=retry_after(2), scope="account", retry_after=2)
                raise Refusal(503, "The service is busy with this kind of request. Try again in a moment.", "server_busy", headers=retry_after(5), retry_after=5)
            releases.append(leave)


# What the guard puts in a request's ASGI scope, for the code that handles it.
CLIENT = "little_archive.client"
IDENTITY = "little_archive.identity"
RELEASES = "little_archive.releases"
# Routes whose caller is not a signed-in account: they must not be refused for want of a bearer token, and are judged by
# their own proof (a store's signature) instead.
NO_EARLY_AUTH = ("/api/auth/", "/api/extension/", "/api/health", "/api/discovery", "/api/purchases/apple/notifications", "/api/purchases/google/notifications")
BODY_METHODS = {"POST", "PUT", "PATCH"}


class HostedGuard:
    """Outermost application layer in hosted mode (inside host checking, around the body reader).

    1. A request over its address's budget is answered 429 before anything else.
    2. A request that carries a body is authenticated *before* the body is read, so nobody who is not signed in can make
       the server buffer megabytes. The result is kept in the scope for the routes, which do not verify it again.
    3. Whatever the routes take (a concurrency place) is given back when the response is finished.
    """

    def __init__(self, app, limits, authenticate):
        self.app, self.limits, self.authenticate = app, limits, authenticate

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        path, method = scope.get("path", ""), scope.get("method", "")
        address = client_address(scope, self.limits.trusted_hops)
        scope[CLIENT], scope[RELEASES] = address, []
        try:
            if path != "/api/health":
                wait = self.limits.address(address, notification=path.endswith("/notifications"))
                if wait:
                    return await refusal_response(Refusal(429, "Too many requests from this address. Wait a moment and try again.", "rate_limited", headers=retry_after(wait), scope="address", retry_after=int(wait + 0.999)))(scope, receive, send)
            if method in BODY_METHODS and path.startswith("/api/") and not path.startswith(NO_EARLY_AUTH):
                values = [value.decode("latin-1") for name, value in scope.get("headers", []) if name == b"authorization"]
                try:
                    scope[IDENTITY] = await run_in_threadpool(self.authenticate, values, address)
                except HTTPException as exc:
                    return await refusal_response(exc)(scope, receive, send)
            await self.app(scope, receive, send)
        finally:
            for release in scope[RELEASES]:
                release()


def body_deadline(seconds):
    """Used by the body reader: how long a client may take to deliver what it declared."""
    return time.monotonic() + seconds


async def read_with_timeout(receive, idle, deadline):
    """One message from `receive`, or asyncio.TimeoutError once the client has been quiet for `idle` seconds or is past `deadline`."""
    return await asyncio.wait_for(receive(), timeout=max(0.001, min(idle, deadline - time.monotonic())))
