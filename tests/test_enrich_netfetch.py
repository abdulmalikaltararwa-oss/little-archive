"""The opt-in page fetcher must never reach a non-public address, however it is reached.

No network is used: DNS is an injected resolver and HTTP is an injected transport that
records exactly which address each request was sent to.
"""
import ipaddress
import unittest

import httpx

from server import __version__
from server.enrich.netfetch import FetchError, SafeFetcher, default_user_agent, is_public_ip

PUBLIC = "93.184.216.34"
PUBLIC_B = "8.8.4.4"


class Net:
    """Fake DNS plus fake web. ``dns`` maps host to the addresses it resolves to."""

    def __init__(self, dns=None, handler=None):
        self.dns = dns or {}
        self.queries, self.requests = [], []
        self.handler = handler or (lambda request: httpx.Response(200, headers={"content-type": "text/html"}, content=b"<title>ok</title>"))

    def resolver(self, host, port):
        self.queries.append((host, port))
        answer = self.dns[host]
        if callable(answer):
            return answer(len(self.queries))
        return answer

    def transport(self):
        def respond(request):
            self.requests.append(request)
            return self.handler(request)
        return httpx.MockTransport(respond)

    def fetcher(self, **kwargs):
        return SafeFetcher(resolver=self.resolver, transport=self.transport(), **kwargs)


def blocked(testcase, url, net=None, code="blocked_destination"):
    net = net or Net({"example.com": [PUBLIC]})
    with testcase.assertRaises(FetchError) as caught:
        net.fetcher().fetch_html(url)
    testcase.assertEqual(caught.exception.code, code, url)
    testcase.assertEqual(net.requests, [], f"a request was sent for {url}")
    return caught.exception


class AddressClassificationTests(unittest.TestCase):
    def test_non_public_addresses_are_refused(self):
        for value in (
            "10.0.0.1", "172.16.5.4", "172.31.255.255", "192.168.1.1", "127.0.0.1", "127.1.2.3", "169.254.169.254", "169.254.0.1",
            "100.64.0.1", "100.100.100.200", "0.0.0.0", "0.1.2.3", "255.255.255.255", "224.0.0.1", "240.0.0.1", "192.0.2.1",
            "198.51.100.7", "203.0.113.9", "198.18.0.1", "192.0.0.8",
            "::1", "::", "fe80::1", "fc00::1", "fd00:ec2::254", "ff02::1", "2001:db8::1", "::127.0.0.1",
            "::ffff:127.0.0.1", "::ffff:10.0.0.1", "::ffff:169.254.169.254", "64:ff9b::7f00:1", "64:ff9b::a00:1", "64:ff9b:1::1",
            "2002:7f00:1::1", "2002:a00:1::1", "2001:0:4136:e378:8000:63bf:3fff:fdd2",
        ):
            with self.subTest(address=value):
                self.assertFalse(is_public_ip(ipaddress.ip_address(value)))

    def test_public_addresses_are_allowed(self):
        for value in (PUBLIC, PUBLIC_B, "1.1.1.1", "2606:4700:4700::1111", "2001:4860:4860::8888", "::ffff:8.8.8.8", "64:ff9b::808:808"):
            with self.subTest(address=value):
                self.assertTrue(is_public_ip(ipaddress.ip_address(value)))


class DestinationTests(unittest.TestCase):
    def test_schemes_ports_and_credentials(self):
        for url in ("ftp://example.com/x", "file:///etc/passwd", "gopher://example.com/", "javascript:alert(1)", "//example.com/x", "https://user:pw@example.com/", "https://@example.com/", "not a url", "", "https://example.com/" + "a" * 5000, "https://exa mple.com/"):
            with self.subTest(url=url[:60]):
                blocked(self, url, code="invalid_url")
        for url in ("http://example.com:8080/", "https://example.com:22/", "https://example.com:6379/", "http://example.com:9200/x", "https://example.com:8443/"):
            with self.subTest(url=url):
                blocked(self, url, code="blocked_destination")

    def test_ip_literals_and_obfuscated_numeric_hosts(self):
        for url in (
            "http://127.0.0.1/", "http://[::1]/", "http://10.0.0.1/", "http://169.254.169.254/latest/meta-data/", "http://[::ffff:127.0.0.1]/",
            "http://[fe80::1]/", "http://192.168.0.1:80/", "https://[fd00:ec2::254]/", "http://100.100.100.200/",
            "http://2130706433/", "http://0x7f.1/", "http://0177.0.0.1/", "http://127.1/", "http://0x7f000001/", "http://017700000001/", "http://0/",
            "http://[::1%25lo0]/",
        ):
            with self.subTest(url=url):
                try:
                    blocked(self, url)
                except AssertionError:
                    blocked(self, url, code="invalid_url")

    def test_names_that_are_local_by_convention(self):
        for url in ("http://localhost/", "http://localhost./", "http://LOCALHOST/", "http://app.localhost/", "http://printer.local/", "http://db.internal/",
                    "http://metadata.google.internal/computeMetadata/v1/", "http://metadata/", "http://intranet/", "http://router.lan/", "http://x.home.arpa/", "http://svc.corp/"):
            with self.subTest(url=url):
                blocked(self, url)

    def test_hex_looking_domains_are_still_ordinary_names(self):
        net = Net({"bad.cafe": [PUBLIC]})
        self.assertEqual(net.fetcher().fetch_html("https://bad.cafe/").status, 200)

    def test_resolver_answers_are_all_checked(self):
        for answer in (["10.0.0.5"], ["127.0.0.1"], ["169.254.169.254"], [PUBLIC, "10.0.0.5"], ["10.0.0.5", PUBLIC], ["::1"], [PUBLIC, "fe80::1"], ["not-an-address"], ["::ffff:192.168.1.1"]):
            with self.subTest(answer=answer):
                blocked(self, "https://example.com/", Net({"example.com": answer}))

    def test_lookup_failures(self):
        blocked(self, "https://example.com/", Net({"example.com": []}), code="dns_failed")

        class Broken(Net):
            def resolver(self, host, port):
                raise OSError("boom 10.0.0.1")
        net = Broken()
        with self.assertRaises(FetchError) as caught:
            net.fetcher().fetch_html("https://example.com/")
        self.assertEqual(caught.exception.code, "dns_failed")
        self.assertNotIn("10.0.0.1", caught.exception.message)

    def test_errors_do_not_reveal_internal_addresses(self):
        error = blocked(self, "https://example.com/", Net({"example.com": ["10.20.30.40"]}))
        self.assertNotIn("10.20.30.40", error.message + str(error))


class RebindingAndPinningTests(unittest.TestCase):
    def test_second_dns_answer_cannot_redirect_the_connection(self):
        # A rebinding server answers a public address first and a private one on the next lookup.
        net = Net({"example.com": lambda count: [PUBLIC] if count == 1 else ["127.0.0.1"]})
        result = net.fetcher().fetch_html("https://example.com/page?x=1")
        self.assertEqual(result.status, 200)
        self.assertEqual(len(net.queries), 1, "the name must be resolved once per hop and then pinned")
        request = net.requests[0]
        self.assertEqual(request.url.host, PUBLIC)
        self.assertEqual(request.headers["host"], "example.com")
        self.assertEqual(request.extensions["sni_hostname"], "example.com")
        self.assertEqual(request.url.query, b"x=1")

    def test_ipv6_addresses_are_bracketed_and_ports_are_explicit(self):
        net = Net({"example.com": ["2606:4700:4700::1111"]})
        net.fetcher().fetch_html("http://example.com/")
        request = net.requests[0]
        self.assertEqual(request.url.host, "2606:4700:4700::1111")
        self.assertIn(request.url.port, (None, 80))
        self.assertEqual(request.headers["host"], "example.com")
        self.assertNotIn("sni_hostname", request.extensions)

    def test_other_validated_address_is_tried_when_connect_fails(self):
        def handler(request):
            if request.url.host == PUBLIC:
                raise httpx.ConnectError("refused")
            return httpx.Response(200, headers={"content-type": "text/html"}, content=b"ok")
        net = Net({"example.com": [PUBLIC, PUBLIC_B]}, handler)
        self.assertEqual(net.fetcher().fetch_html("https://example.com/").body, b"ok")
        self.assertEqual([r.url.host for r in net.requests], [PUBLIC, PUBLIC_B])

    def test_connect_failure_is_reported_without_details(self):
        net = Net({"example.com": [PUBLIC]}, lambda request: (_ for _ in ()).throw(httpx.ConnectError("refused 10.1.1.1")))
        with self.assertRaises(FetchError) as caught:
            net.fetcher().fetch_html("https://example.com/")
        self.assertEqual(caught.exception.code, "connect_failed")
        self.assertNotIn("10.1.1.1", caught.exception.message)

    def test_default_port_is_omitted_from_the_host_header_and_others_are_kept(self):
        net = Net({"example.com": [PUBLIC]})
        net.fetcher().fetch_html("https://example.com:443/")
        net.fetcher().fetch_html("http://example.com:80/")
        self.assertEqual([r.headers["host"] for r in net.requests], ["example.com", "example.com"])


class RedirectTests(unittest.TestCase):
    def redirecting(self, location, dns=None):
        def handler(request):
            if request.url.host == PUBLIC and not request.url.path.startswith("/final"):
                return httpx.Response(302, headers={"location": location})
            return httpx.Response(200, headers={"content-type": "text/html"}, content=b"final")
        return Net(dns or {"example.com": [PUBLIC], "other.example.net": [PUBLIC_B], "intranet.example.org": ["10.0.0.9"]}, handler)

    def test_redirects_to_private_destinations_are_refused_before_any_request(self):
        locations = ("http://169.254.169.254/latest/meta-data/", "http://127.0.0.1:80/admin", "http://[::1]/", "http://10.0.0.1/", "http://localhost/",
                     "http://2130706433/", "http://0x7f.1/", "http://example.com:8080/", "ftp://example.com/x", "file:///etc/passwd", "gopher://example.com/",
                     "https://intranet.example.org/", "https://10.0.0.1/", "https://[fd00:ec2::254]/", "https://localhost/", "https://169.254.169.254/")
        for location in locations:
            # An https start only reaches the destination check for https targets; the
            # other targets start from http so the downgrade rule does not pre-empt it.
            start = "https://example.com/start" if location.startswith("https") else "http://example.com/start"
            with self.subTest(location=location):
                net = self.redirecting(location)
                with self.assertRaises(FetchError) as caught:
                    net.fetcher().fetch_html(start)
                self.assertIn(caught.exception.code, {"blocked_destination", "invalid_url"})
                self.assertEqual([r.url.host for r in net.requests], [PUBLIC], "only the first, public hop may be requested")

    def test_a_public_to_public_redirect_is_followed_with_a_fresh_check(self):
        net = self.redirecting("https://other.example.net/final")
        result = net.fetcher().fetch_html("https://example.com/start")
        self.assertEqual(result.body, b"final")
        self.assertEqual(result.url, "https://other.example.net/final")
        self.assertEqual(result.redirects, 1)
        self.assertEqual([h for h, _ in net.queries], ["example.com", "other.example.net"])
        self.assertEqual(net.requests[1].headers["host"], "other.example.net")

    def test_relative_redirects_resolve_against_the_current_address(self):
        net = self.redirecting("/final/page")
        self.assertEqual(net.fetcher().fetch_html("https://example.com/start").url, "https://example.com/final/page")

    def test_redirect_loops_and_chains_are_bounded(self):
        net = Net({"example.com": [PUBLIC]}, lambda request: httpx.Response(302, headers={"location": "/again"}))
        with self.assertRaises(FetchError) as caught:
            net.fetcher(max_redirects=3).fetch_html("https://example.com/")
        self.assertEqual(caught.exception.code, "too_many_redirects")
        self.assertEqual(len(net.requests), 4)

    def test_https_cannot_be_downgraded(self):
        net = self.redirecting("http://other.example.net/final")
        with self.assertRaises(FetchError) as caught:
            net.fetcher().fetch_html("https://example.com/start")
        self.assertEqual(caught.exception.code, "redirect_downgrade")

    def test_empty_or_huge_location_headers_are_unusable(self):
        for location in ("", "/" + "a" * 5000):
            net = Net({"example.com": [PUBLIC]}, lambda request, location=location: httpx.Response(302, headers={"location": location}))
            with self.subTest(length=len(location)), self.assertRaises(FetchError):
                net.fetcher().fetch_html("https://example.com/")


class LimitTests(unittest.TestCase):
    def respond(self, **kwargs):
        headers = {"content-type": "text/html", **kwargs.pop("headers", {})}
        return Net({"example.com": [PUBLIC]}, lambda request: httpx.Response(kwargs.pop("status", 200), headers=headers, **kwargs))

    def test_declared_oversize_is_refused_without_reading(self):
        net = self.respond(headers={"content-length": "999999"}, content=b"x")
        with self.assertRaises(FetchError) as caught:
            net.fetcher(max_bytes=1000).fetch_html("https://example.com/")
        self.assertEqual(caught.exception.code, "too_large")

    def test_undeclared_oversize_is_stopped_while_streaming(self):
        class Endless(httpx.SyncByteStream):
            sent = 0

            def __iter__(self):
                while True:
                    Endless.sent += 100
                    yield b"x" * 100
        net = Net({"example.com": [PUBLIC]}, lambda request: httpx.Response(200, headers={"content-type": "text/html"}, stream=Endless()))
        with self.assertRaises(FetchError) as caught:
            net.fetcher(max_bytes=1000).fetch_html("https://example.com/")
        self.assertEqual(caught.exception.code, "too_large")
        self.assertLess(Endless.sent, 5000)

    def test_exactly_the_limit_is_accepted(self):
        net = self.respond(content=b"x" * 1000)
        self.assertEqual(len(net.fetcher(max_bytes=1000).fetch_html("https://example.com/").body), 1000)

    def test_slow_sites_hit_the_total_deadline(self):
        clock = {"now": 0.0}

        class Dribble(httpx.SyncByteStream):
            def __iter__(self):
                for _ in range(100):
                    clock["now"] += 2.0
                    yield b"x"
        net = Net({"example.com": [PUBLIC]}, lambda request: httpx.Response(200, headers={"content-type": "text/html"}, stream=Dribble()))
        with self.assertRaises(FetchError) as caught:
            net.fetcher(total_timeout=10, clock=lambda: clock["now"]).fetch_html("https://example.com/")
        self.assertEqual(caught.exception.code, "timeout")

    def test_transport_timeouts_become_timeout_errors(self):
        for exc in (httpx.ReadTimeout("slow"), httpx.WriteTimeout("slow"), httpx.PoolTimeout("slow")):
            net = Net({"example.com": [PUBLIC]}, lambda request, exc=exc: (_ for _ in ()).throw(exc))
            with self.subTest(exc=type(exc).__name__), self.assertRaises(FetchError) as caught:
                net.fetcher().fetch_html("https://example.com/")
            self.assertEqual(caught.exception.code, "timeout")

    def test_only_allowed_content_types_are_read(self):
        for content_type in ("application/octet-stream", "application/pdf", "image/png", "application/javascript", "text/plain", ""):
            with self.subTest(content_type=content_type), self.assertRaises(FetchError) as caught:
                self.respond(headers={"content-type": content_type}, content=b"x").fetcher().fetch_html("https://example.com/")
            self.assertEqual(caught.exception.code, "unsupported_content_type")
        net = self.respond(headers={"content-type": "Text/HTML; charset=UTF-8"}, content=b"ok")
        self.assertEqual(net.fetcher().fetch_html("https://example.com/").body, b"ok")
        with self.assertRaises(FetchError):
            self.respond(headers={"content-type": "text/html"}, content=b"x").fetcher().fetch_json("https://example.com/")
        self.assertEqual(self.respond(headers={"content-type": "application/json; charset=utf-8"}, content=b"{}").fetcher().fetch_json("https://example.com/").body, b"{}")
        self.assertEqual(self.respond(headers={"content-type": "image/webp"}, content=b"x").fetcher().fetch_image("https://example.com/i.webp").status, 200)
        self.assertEqual(self.respond(headers={"content-type": "video/mp4"}, content=b"x").fetcher().fetch_media("https://example.com/v.mp4", 100).status, 200)

    def test_error_statuses_do_not_echo_the_response(self):
        for status in (401, 403, 404, 429, 500, 503):
            net = self.respond(status=status, content=b"SECRET-INTERNAL-ERROR-PAGE")
            with self.subTest(status=status), self.assertRaises(FetchError) as caught:
                net.fetcher().fetch_html("https://example.com/")
            self.assertEqual(caught.exception.code, "http_status")
            self.assertNotIn("SECRET", caught.exception.message)


class IdentityTests(unittest.TestCase):
    def test_honest_user_agent_and_minimal_headers(self):
        net = Net({"example.com": [PUBLIC]})
        net.fetcher().fetch_html("https://example.com/")
        headers = net.requests[0].headers
        self.assertEqual(headers["user-agent"], default_user_agent())
        self.assertTrue(headers["user-agent"].startswith(f"LittleArchive/{__version__} ("))
        for spoof in ("Mozilla", "Googlebot", "bingbot", "facebookexternalhit", "Chrome", "Safari"):
            self.assertNotIn(spoof, headers["user-agent"])
        for forbidden in ("cookie", "authorization", "referer", "x-forwarded-for"):
            self.assertNotIn(forbidden, headers)

    def test_operator_contact_is_appended_and_sanitised(self):
        self.assertTrue(default_user_agent("https://archive.example.org/contact").endswith("; +https://archive.example.org/contact)"))
        self.assertNotIn("\n", default_user_agent("a\r\nX-Evil: 1 b"))

    def test_cookies_are_neither_sent_nor_kept_across_hops(self):
        def handler(request):
            if request.url.path == "/start":
                return httpx.Response(302, headers={"location": "/next", "set-cookie": "session=abc; Path=/"})
            return httpx.Response(200, headers={"content-type": "text/html", "set-cookie": "tracker=1"}, content=b"ok")
        net = Net({"example.com": [PUBLIC]}, handler)
        fetcher = net.fetcher()
        fetcher.fetch_html("https://example.com/start")
        fetcher.fetch_html("https://example.com/other")
        for request in net.requests:
            self.assertNotIn("cookie", request.headers)


if __name__ == "__main__":
    unittest.main()
