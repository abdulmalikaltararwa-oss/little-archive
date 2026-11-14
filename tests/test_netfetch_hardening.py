"""What the page fetcher must also withstand when any account on a public service can ask for a read.

These add to tests/test_enrich_netfetch.py: decompression bombs, a total time that covers lookups and
connections and not only the download, names that turn into addresses once they are prepared, URLs that
confuse a parser about which host they mean, and address ranges whose classification must not depend on
the Python release in use. No network is used.
"""
import gzip
import ipaddress
import time
import tracemalloc
import unittest
import zlib

import httpx

from server.enrich.netfetch import FetchError, SafeFetcher, is_public_ip
from tests.test_enrich_netfetch import Net, PUBLIC, PUBLIC_B, blocked


def html(**extra):
    return {"content-type": "text/html", **extra}


class Stream(httpx.SyncByteStream):
    """A body handed to the client as it is, so the library does not decode it for the test."""

    def __init__(self, *parts):
        self.parts = parts

    def __iter__(self):
        yield from self.parts


class EncodedBodyTests(unittest.TestCase):
    def serve(self, encoding, *parts):
        return Net({"example.com": [PUBLIC]}, lambda request: httpx.Response(200, headers=html(**({"content-encoding": encoding} if encoding else {})), stream=Stream(*parts)))

    def fetch(self, net, **options):
        return net.fetcher(**options).fetch_html("https://example.com/")

    def test_identity_is_what_is_asked_for(self):
        net = self.serve("", b"ok")
        self.fetch(net)
        self.assertEqual(net.requests[0].headers["accept-encoding"], "identity")

    def test_a_gzip_bomb_is_stopped_at_the_byte_limit_without_being_inflated(self):
        # About 200 KiB of zeros become 200 MiB. A reader that decodes before it counts would hold all of it at once.
        bomb = gzip.compress(b"\0" * (200 * 1024 * 1024), compresslevel=9)
        self.assertLess(len(bomb), 400 * 1024)
        net = self.serve("gzip", *[bomb[i:i + 4096] for i in range(0, len(bomb), 4096)])
        tracemalloc.start()
        try:
            with self.assertRaises(FetchError) as caught:
                self.fetch(net, max_bytes=1024 * 1024)
            peak = tracemalloc.get_traced_memory()[1]
        finally:
            tracemalloc.stop()
        self.assertEqual(caught.exception.code, "too_large")
        self.assertLess(peak, 8 * 1024 * 1024, "the output was bounded while it was produced, not after")

    def test_a_deflate_bomb_in_one_chunk_is_stopped_too(self):
        bomb = zlib.compress(b"A" * (100 * 1024 * 1024), 9)
        net = self.serve("deflate", bomb)
        tracemalloc.start()
        try:
            with self.assertRaises(FetchError) as caught:
                self.fetch(net, max_bytes=512 * 1024)
            peak = tracemalloc.get_traced_memory()[1]
        finally:
            tracemalloc.stop()
        self.assertEqual(caught.exception.code, "too_large")
        self.assertLess(peak, 8 * 1024 * 1024)

    def test_ordinary_gzip_and_deflate_within_the_limit_are_read(self):
        text = b"<title>caf\xc3\xa9</title>" + b"x" * 5000
        for encoding, body in (("gzip", gzip.compress(text)), ("x-gzip", gzip.compress(text)), ("GZIP", gzip.compress(text)), ("deflate", zlib.compress(text))):
            with self.subTest(encoding=encoding):
                self.assertEqual(self.fetch(self.serve(encoding, body), max_bytes=len(text)).body, text, "exactly the limit is accepted")
                with self.assertRaises(FetchError) as caught:
                    self.fetch(self.serve(encoding, body), max_bytes=len(text) - 1)
                self.assertEqual(caught.exception.code, "too_large")
        pieces = [gzip.compress(text)[i:i + 7] for i in range(0, len(gzip.compress(text)), 7)]
        self.assertEqual(self.fetch(self.serve("gzip", *pieces)).body, text, "a body that arrives in tiny pieces is read whole")

    def test_other_or_stacked_encodings_are_refused(self):
        for encoding in ("br", "zstd", "compress", "gzip, br", "gzip, gzip", "identity, gzip", "br, gzip", "snappy"):
            with self.subTest(encoding=encoding), self.assertRaises(FetchError) as caught:
                self.fetch(self.serve(encoding, b"x"))
            self.assertEqual(caught.exception.code, "unsupported_encoding")
        self.assertEqual(self.fetch(self.serve("identity", b"plain")).body, b"plain")

    def test_a_broken_gzip_stream_is_a_failed_read_not_an_exception(self):
        for body in (b"this is not gzip data at all", gzip.compress(b"x" * 100)[:-9] + b"\xff" * 9):
            with self.subTest(length=len(body)), self.assertRaises(FetchError) as caught:
                self.fetch(self.serve("gzip", body))
            self.assertEqual(caught.exception.code, "request_failed")
            self.assertNotIn("zlib", caught.exception.message.lower())

    def test_a_declared_length_over_the_limit_is_refused_before_any_decoding(self):
        net = Net({"example.com": [PUBLIC]}, lambda request: httpx.Response(200, headers=html(**{"content-encoding": "gzip", "content-length": "5000000"}), stream=Stream(b"x")))
        with self.assertRaises(FetchError) as caught:
            self.fetch(net, max_bytes=1000)
        self.assertEqual(caught.exception.code, "too_large")


class DeadlineTests(unittest.TestCase):
    def test_a_slow_name_server_spends_the_same_allowance_as_a_slow_download(self):
        clock = {"now": 0.0}

        def resolver(host, port):
            clock["now"] += 6.0  # each lookup takes six seconds
            return [PUBLIC]

        def handler(request):
            if request.url.path == "/start":
                return httpx.Response(302, headers={"location": "https://other.example.net/next"})
            return httpx.Response(200, headers=html(), content=b"ok")
        transport = httpx.MockTransport(handler)
        fetcher = SafeFetcher(resolver=resolver, transport=transport, total_timeout=10, clock=lambda: clock["now"])
        with self.assertRaises(FetchError) as caught:
            fetcher.fetch_html("https://example.com/start")
        self.assertEqual(caught.exception.code, "timeout", "the second lookup would have started after the allowance was gone")

    def test_each_connection_gets_only_what_is_left_of_the_allowance(self):
        clock = {"now": 0.0}
        seen = []

        def resolver(host, port):
            clock["now"] += 8.0
            return [PUBLIC]

        def handler(request):
            seen.append(dict(request.extensions["timeout"]))
            return httpx.Response(200, headers=html(), content=b"ok")
        fetcher = SafeFetcher(resolver=resolver, transport=httpx.MockTransport(handler), total_timeout=10, timeout=10.0, clock=lambda: clock["now"])
        fetcher.fetch_html("https://example.com/")
        self.assertEqual(len(seen), 1)
        for name, value in seen[0].items():
            self.assertLessEqual(value, 2.0 + 1e-9, name + " may not exceed what remains of the ten seconds")

    def test_an_exhausted_allowance_makes_no_request_at_all(self):
        clock = {"now": 100.0}
        net = Net({"example.com": [PUBLIC]})
        fetcher = SafeFetcher(resolver=net.resolver, transport=net.transport(), total_timeout=0, clock=lambda: clock["now"])
        with self.assertRaises(FetchError) as caught:
            fetcher.fetch_html("https://example.com/")
        self.assertEqual(caught.exception.code, "timeout")
        self.assertEqual((net.queries, net.requests), ([], []))


class HostSpellingTests(unittest.TestCase):
    def test_names_that_become_addresses_once_prepared_are_refused(self):
        for url in ("http://１２７.０.０.１/", "http://127。0。0。1/", "http://１２７．0．0．1/",
                    "http://２１３０７０６４３３/", "http://０x7f.1/", "http://①②⑧.0.0.1/"):
            with self.subTest(url=url):
                net = Net({})
                with self.assertRaises(FetchError):
                    net.fetcher().fetch_html(url)
                self.assertEqual((net.queries, net.requests), ([], []), "not even a lookup is made")

    def test_scoped_addresses_are_refused_even_when_the_address_is_public(self):
        for url in ("http://[2001:4860:4860::8888%25eth0]/", "http://[2001:4860:4860::8888%eth0]/", "https://[2606:4700:4700::1111%251]/"):
            with self.subTest(url=url):
                net = Net({})
                with self.assertRaises(FetchError):
                    net.fetcher().fetch_html(url)
                self.assertEqual(net.requests, [])

    def test_urls_built_to_confuse_which_host_is_meant_never_reach_a_private_address(self):
        for url in ("http://example.com@127.0.0.1/", "http://example.com:80@127.0.0.1/", "http://127.0.0.1#@example.com/", "http://127.0.0.1?@example.com/",
                    "http://127.0.0.1\\@example.com/", "http://example.com\\@127.0.0.1/", "http://[::1]:80\\@example.com/", "http://127.0.0.1%2f@example.com/",
                    "http://example.com%00.127.0.0.1/", "http://example.com\t.evil/", "http://example.com\n127.0.0.1/", "http://127.0.0.1。example.com/",
                    "http://example.com:80:80/", "http://:80/", "http://./", "http://..com/", "http://-.example.com/", "http://exa_mple.com/"):
            with self.subTest(url=url):
                net = Net({"example.com": [PUBLIC]})
                try:
                    net.fetcher().fetch_html(url)
                except FetchError:
                    pass
                self.assertEqual([r.url.host for r in net.requests if r.url.host != PUBLIC], [], "nothing but the public address may ever be requested")
                for request in net.requests:
                    self.assertEqual(request.headers["host"], "example.com")

    def test_a_redirect_cannot_smuggle_a_credentialed_or_odd_target(self):
        for location in ("https://user:pw@other.example.net/", "https://other.example.net:443@127.0.0.1/", "//127.0.0.1/", "///127.0.0.1/", "https:127.0.0.1", "\\\\127.0.0.1\\x"):
            def handler(request, location=location):
                if request.url.host == PUBLIC and request.url.path == "/start":
                    return httpx.Response(302, headers={"location": location})
                return httpx.Response(200, headers=html(), content=b"ok")
            net = Net({"example.com": [PUBLIC], "other.example.net": [PUBLIC_B]}, handler)
            with self.subTest(location=location):
                try:
                    net.fetcher().fetch_html("http://example.com/start")
                except FetchError:
                    pass
                self.assertEqual({r.url.host for r in net.requests} - {PUBLIC, PUBLIC_B}, set())


class RebindingAcrossHopsTests(unittest.TestCase):
    def test_a_name_that_turns_private_on_a_later_hop_is_judged_again_on_that_hop(self):
        lookups = {"second": 0}

        def second(_):
            lookups["second"] += 1
            return [PUBLIC_B] if lookups["second"] == 1 else ["169.254.169.254"]
        answers = {"first.example.com": [PUBLIC], "second.example.net": second}

        def handler(request):
            if request.url.host == PUBLIC:
                return httpx.Response(302, headers={"location": "https://second.example.net/a"})
            if request.url.host == PUBLIC_B and request.url.path == "/a":
                return httpx.Response(302, headers={"location": "https://second.example.net/b"})  # same name, a second lookup
            return httpx.Response(200, headers=html(), content=b"never")
        net = Net(answers, handler)
        with self.assertRaises(FetchError) as caught:
            net.fetcher().fetch_html("https://first.example.com/")
        self.assertEqual(caught.exception.code, "blocked_destination")
        self.assertEqual([r.url.host for r in net.requests], [PUBLIC, PUBLIC_B])


class RangesWhoseClassificationMustNotDependOnThePythonReleaseTests(unittest.TestCase):
    def test_listed_ranges_are_refused_by_the_list_itself(self):
        for value in ("168.63.129.16", "::ffff:0:7f00:1", "::ffff:0:a00:1", "3fff::1", "3fff:fff:ffff::1", "2001:1::1", "2001:1::2", "2001:3::1", "2001:20::1",
                      "2001:4:112::1", "5f00::1", "2001:1ff:ffff::1"):
            with self.subTest(address=value):
                self.assertFalse(is_public_ip(ipaddress.ip_address(value)))

    def test_neighbours_that_are_ordinary_public_addresses_are_not_caught(self):
        for value in ("168.63.129.15", "168.63.129.17", "2001:200::1", "2001:4860::1", "2606:4700::1", "2a00:1450:4001::1"):
            with self.subTest(address=value):
                self.assertTrue(is_public_ip(ipaddress.ip_address(value)))

    def test_a_name_that_resolves_into_one_of_them_is_refused(self):
        for answer in (["168.63.129.16"], ["::ffff:0:7f00:1"], ["3fff::1"], [PUBLIC, "168.63.129.16"]):
            with self.subTest(answer=answer):
                blocked(self, "https://example.com/", Net({"example.com": answer}))


if __name__ == "__main__":
    unittest.main()
