"""Opt-in, SSRF-safe reading of public pages. Off unless the operator enables it.

What is enforced on every request and every redirect hop:

* http(s) only, ports 80 and 443 only, no credentials in the URL;
* the host is resolved here, every returned address must be public (loopback, private,
  link-local, shared, reserved, multicast, cloud-metadata and IPv6 forms that embed an
  IPv4 address are refused), and a single mixed answer is refused as a whole;
* the connection is then made to the validated IP address with the original host as
  ``Host`` and TLS server name, so a second DNS answer cannot redirect it (rebinding);
* limits on redirects, bytes and total time; a small content-type allowlist per call;
* no cookies are sent, none are kept, and no environment proxy settings are used.

The User-Agent says what this is. There is no proxy rotation, no spoofed crawler
identity and no login. A site that refuses the request simply yields an error.
"""
from __future__ import annotations

from dataclasses import dataclass
import ipaddress
import re
import socket
import time
from urllib.parse import urljoin, urlsplit

import httpx

from .. import __version__

ALLOWED_PORTS = {80, 443}
REDIRECT_CODES = {301, 302, 303, 307, 308}
HTML_TYPES = frozenset({"text/html", "application/xhtml+xml"})
JSON_TYPES = frozenset({"application/json", "text/json", "application/jrd+json"})
IMAGE_TYPES = frozenset({"image/jpeg", "image/png", "image/webp"})
MEDIA_TYPES = frozenset({"video/mp4", "video/webm", "video/quicktime", "audio/mpeg", "audio/mp4", "audio/webm", "audio/ogg", "audio/wav", "audio/x-m4a", "audio/flac"})

_BLOCKED_NETWORKS = [ipaddress.ip_network(n) for n in (
    "0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12", "192.0.0.0/24",
    "192.0.2.0/24", "192.88.99.0/24", "192.168.0.0/16", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24",
    "224.0.0.0/4", "240.0.0.0/4",
    "::/128", "::1/128", "::/96", "64:ff9b:1::/48", "100::/64", "2001:db8::/32", "2001:10::/28", "fc00::/7", "fe80::/10", "fec0::/10", "ff00::/8",
)]
_NAT64 = ipaddress.ip_network("64:ff9b::/96")
_BLOCKED_NAMES = {"localhost", "metadata", "metadata.google.internal"}
_BLOCKED_SUFFIXES = (".localhost", ".local", ".internal", ".localdomain", ".home.arpa", ".lan", ".intranet", ".corp", ".private")
_LABEL = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?")
# The numeric forms inet_aton accepts: 2130706433, 0x7f.1, 0177.0.0.1, 127.1
_NUMERIC_HOST = re.compile(r"(?:0x[0-9a-f]+|[0-9]+)(?:\.(?:0x[0-9a-f]+|[0-9]+)){0,3}")


class FetchError(Exception):
    """A refused or failed read. ``message`` is safe to show to the owner."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code, self.message = code, message


def is_public_ip(ip) -> bool:
    """True only for globally routable unicast addresses, looking through embedded IPv4."""
    if isinstance(ip, ipaddress.IPv6Address):
        if ip.ipv4_mapped is not None:
            return is_public_ip(ip.ipv4_mapped)
        if ip.sixtofour is not None:
            return is_public_ip(ip.sixtofour)
        if ip.teredo is not None:
            return all(is_public_ip(part) for part in ip.teredo)
        if ip in _NAT64:
            return is_public_ip(ipaddress.IPv4Address(int(ip) & 0xFFFFFFFF))
    if any(ip in network for network in _BLOCKED_NETWORKS):
        return False
    return bool(ip.is_global) and not (ip.is_multicast or ip.is_reserved or ip.is_unspecified or ip.is_loopback or ip.is_link_local)


def system_resolver(host: str, port: int) -> list[str]:
    try:
        infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except (socket.gaierror, UnicodeError, OSError) as exc:
        raise FetchError("dns_failed", "That address could not be looked up.") from exc
    return list(dict.fromkeys(info[4][0].split("%")[0] for info in infos))


def _host_kind(host: str):
    """Return an ip_address for a canonical IP literal, else the cleaned DNS name. Raises FetchError."""
    host = host.strip().rstrip(".").lower()
    if not host or len(host) > 253:
        raise FetchError("invalid_url", "That is not a valid address.")
    try:
        return ipaddress.ip_address(host)
    except ValueError:
        pass
    # Decimal, octal, hex and short forms (2130706433, 0x7f.1, 127.1) are read as IPv4 by
    # many resolvers. Refuse anything that looks numeric without being a canonical literal.
    if _NUMERIC_HOST.fullmatch(host):
        raise FetchError("blocked_destination", "That address is not allowed for server-side reading.")
    try:
        host = host.encode("idna").decode("ascii")
    except UnicodeError as exc:
        raise FetchError("invalid_url", "That is not a valid address.") from exc
    labels = host.split(".")
    if len(labels) < 2 or not all(_LABEL.fullmatch(label) for label in labels):
        raise FetchError("blocked_destination", "That address is not allowed for server-side reading.")
    if host in _BLOCKED_NAMES or host.endswith(_BLOCKED_SUFFIXES):
        raise FetchError("blocked_destination", "That address is not allowed for server-side reading.")
    return host


@dataclass(frozen=True)
class FetchResult:
    url: str
    status: int
    content_type: str
    body: bytes
    redirects: int


class SafeFetcher:
    def __init__(self, *, resolver=None, transport=None, user_agent=None, timeout=10.0, total_timeout=20.0,
                 max_bytes=2 * 1024 * 1024, max_redirects=4, clock=time.monotonic):
        self.resolver = resolver or system_resolver
        self.transport = transport
        self.user_agent = user_agent or default_user_agent()
        self.timeout, self.total_timeout = float(timeout), float(total_timeout)
        self.max_bytes, self.max_redirects, self.clock = int(max_bytes), int(max_redirects), clock

    # -- public helpers -------------------------------------------------
    def fetch_html(self, url):
        return self.fetch(url, accept="text/html,application/xhtml+xml;q=0.9", allowed_types=HTML_TYPES)

    def fetch_json(self, url):
        return self.fetch(url, accept="application/json", allowed_types=JSON_TYPES, max_bytes=256 * 1024)

    def fetch_image(self, url, max_bytes=8 * 1024 * 1024):
        return self.fetch(url, accept="image/jpeg,image/png,image/webp", allowed_types=IMAGE_TYPES, max_bytes=max_bytes)

    def fetch_media(self, url, max_bytes):
        return self.fetch(url, accept="video/mp4,video/webm,audio/*", allowed_types=MEDIA_TYPES, max_bytes=max_bytes)

    # -- core -------------------------------------------------------------
    def _destination(self, url: str):
        if not isinstance(url, str) or len(url) > 4096 or any(ord(c) <= 32 or ord(c) == 127 for c in url):
            raise FetchError("invalid_url", "That is not a valid address.")
        try:
            parts = urlsplit(url)
            port = parts.port
        except ValueError as exc:
            raise FetchError("invalid_url", "That is not a valid address.") from exc
        if parts.scheme not in {"http", "https"} or not parts.hostname or parts.username is not None or parts.password is not None:
            raise FetchError("invalid_url", "Only http and https addresses without credentials can be read.")
        port = port or (443 if parts.scheme == "https" else 80)
        if port not in ALLOWED_PORTS:
            raise FetchError("blocked_destination", "That address is not allowed for server-side reading.")
        target = _host_kind(parts.hostname)
        if isinstance(target, (ipaddress.IPv4Address, ipaddress.IPv6Address)):
            addresses, host = [target], str(target)
        else:
            host = target
            addresses = []
            try:
                raw = self.resolver(host, port)
            except FetchError:
                raise
            except Exception as exc:  # an injected or system resolver failing is a failed lookup
                raise FetchError("dns_failed", "That address could not be looked up.") from exc
            for value in list(raw or [])[:16]:
                try:
                    addresses.append(ipaddress.ip_address(str(value).split("%")[0]))
                except ValueError as exc:
                    raise FetchError("blocked_destination", "That address is not allowed for server-side reading.") from exc
            if not addresses:
                raise FetchError("dns_failed", "That address could not be looked up.")
        # Every answer must be public: a name that also points inside the network is refused.
        if not all(is_public_ip(a) for a in addresses):
            raise FetchError("blocked_destination", "That address is not allowed for server-side reading.")
        return parts, host, port, list(dict.fromkeys(addresses))

    def fetch(self, url, *, accept, allowed_types, max_bytes=None) -> FetchResult:
        limit = int(max_bytes or self.max_bytes)
        deadline = self.clock() + self.total_timeout
        timeout = httpx.Timeout(connect=min(5.0, self.timeout), read=self.timeout, write=self.timeout, pool=self.timeout)
        client = httpx.Client(transport=self.transport, timeout=timeout, follow_redirects=False, trust_env=False,
                              limits=httpx.Limits(max_connections=2, max_keepalive_connections=0))
        try:
            current, redirects = url, 0
            while True:
                parts, host, port, addresses = self._destination(current)
                outcome, failure = None, None
                for address in addresses[:2]:
                    try:
                        outcome = self._request(client, parts, host, port, address, accept, allowed_types, limit, deadline)
                        break
                    except _ConnectFailed as exc:
                        failure = exc
                if outcome is None:
                    raise FetchError("connect_failed", "The site could not be reached.") from failure
                client.cookies.clear()
                if isinstance(outcome, _Redirect):
                    redirects += 1
                    if redirects > self.max_redirects:
                        raise FetchError("too_many_redirects", "The address redirected too many times.")
                    target = urljoin(current, outcome.location)
                    if parts.scheme == "https" and urlsplit(target).scheme == "http":
                        raise FetchError("redirect_downgrade", "The address redirected from https to http.")
                    current = target
                    continue
                return FetchResult(current, outcome.status, outcome.content_type, outcome.body, redirects)
        finally:
            client.close()

    def _request(self, client, parts, host, port, address, accept, allowed_types, limit, deadline):
        literal = f"[{address}]" if address.version == 6 else str(address)
        path = (parts.path or "/") + (("?" + parts.query) if parts.query else "")
        default_port = 443 if parts.scheme == "https" else 80
        headers = {"Host": host if port == default_port else f"{host}:{port}", "User-Agent": self.user_agent, "Accept": accept, "Accept-Encoding": "identity"}
        extensions = {"sni_hostname": host} if parts.scheme == "https" else {}
        try:
            with client.stream("GET", f"{parts.scheme}://{literal}:{port}{path}", headers=headers, extensions=extensions) as response:
                if response.status_code in REDIRECT_CODES:
                    location = response.headers.get("location", "")
                    if not location or len(location) > 4096:
                        raise FetchError("http_status", "The site sent an unusable redirect.")
                    return _Redirect(location)
                if response.status_code != 200:
                    raise FetchError("http_status", f"The site answered with status {response.status_code}.")
                content_type = response.headers.get("content-type", "")
                if content_type.split(";")[0].strip().lower() not in allowed_types:
                    raise FetchError("unsupported_content_type", "The site returned a kind of file that is not read.")
                declared = response.headers.get("content-length", "")
                if declared.isdigit() and int(declared) > limit:
                    raise FetchError("too_large", "The page is larger than the size limit.")
                chunks, total = [], 0
                for chunk in response.iter_bytes():
                    total += len(chunk)
                    if total > limit:
                        raise FetchError("too_large", "The page is larger than the size limit.")
                    if self.clock() > deadline:
                        raise FetchError("timeout", "The site was too slow to answer.")
                    chunks.append(chunk)
                return _Response(response.status_code, content_type, b"".join(chunks))
        except (httpx.ConnectError, httpx.ConnectTimeout) as exc:
            raise _ConnectFailed() from exc
        except httpx.TimeoutException as exc:
            raise FetchError("timeout", "The site was too slow to answer.") from exc
        except (httpx.HTTPError, httpx.InvalidURL, OSError) as exc:
            raise FetchError("request_failed", "The site could not be read.") from exc


@dataclass(frozen=True)
class _Redirect:
    location: str


@dataclass(frozen=True)
class _Response:
    status: int
    content_type: str
    body: bytes


class _ConnectFailed(Exception):
    pass


def default_user_agent(contact: str = "") -> str:
    contact = re.sub(r"[^\x21-\x7e]", "", contact or "")[:200]
    suffix = f"; +{contact}" if contact else ""
    return f"LittleArchive/{__version__} (self-hosted link reader; reads public page details for its owner{suffix})"
