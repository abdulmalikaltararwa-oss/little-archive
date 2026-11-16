"""Selling the unlock on the web through Tap Payments (Kuwait): create a charge on Tap's hosted page, and ask Tap what became of it.

The buyer never types a card here. The server creates a charge with `source.id = "src_all"`, which makes Tap show its own page with
every method the merchant account has (KNET, cards, Apple Pay and so on), and hands the buyer that page's address. Afterwards Tap
sends the buyer back with `?tap_id=chg_...` and posts the charge to a webhook. Neither is believed: the server asks Tap for the
charge by id (`retrieve_charge`) and acts on that answer alone (see service.py).

The caller reaches Tap through `TapClient`, an interface: `HttpTapClient` is the real one; tests use a stand-in.

The secret key (`LA_TAP_SECRET_KEY`, `sk_test_...` or `sk_live_...`) comes from the environment, is held only in this object, and
is never put in an error, a log line or a `repr`. The key's prefix says whether charges are real; every charge Tap returns says
the same (`live_mode`), and a charge that disagrees with the key is refused.

Shapes follow Tap's API reference (developers.tap.company: Create a Charge, Retrieve a Charge, Webhook), read in November 2026:
`POST /v2/charges` with a Bearer key; `amount` is a JSON number in the currency's own decimals (three for KWD), not a string and not
fils; only the status `CAPTURED` is paid, seven statuses mean the payment ended unpaid, and everything else (`INITIATED`,
`IN_PROGRESS`, `UNKNOWN`, a word Tap adds later) means it is not decided yet; the webhook carries a `hashstring` header, an HMAC-SHA256 in hex, keyed with the secret
key, over `x_id`, `x_amount`, `x_currency`, `x_gateway_reference`, `x_payment_reference`, `x_status`, `x_created` joined with no
separator. Tap's own examples of both answers are kept as fixtures (tests/fixtures/tap): the hosted page there is
`https://checkout.payments.tap.company?mode=page&token=...`, and Retrieve a Charge returns `metadata`. UNVERIFIED (Tap's pages do
not state it): the complete list of hosts a hosted page may be on (if it is short, starting a payment answers 503), what
characters a secret key may hold, and how long after a buyer leaves its page Tap gives a charge a final status. Exercised only against stand-ins: no charge was ever created at Tap by this code.
"""
from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
import hashlib
import hmac
import json
import re
import time
from urllib.parse import quote, urlsplit

import httpx

API = "https://api.tap.company/v2/charges"
# Where Tap's hosted page may be, by whether the key is a live one. Anything else is not handed to a buyer.
PAGE_HOSTS = {True: frozenset({"checkout.payments.tap.company", "kw.payments.tap.company", "checkout.tap.company"}),
              False: frozenset({"checkout.payments.tap.company", "sandbox.payments.tap.company", "acceptance.sandbox.tap.company", "checkout.tap.company"})}
# Decimal places of the currencies Tap settles in. An amount is always written, compared and signed with exactly this many.
DECIMALS = {"KWD": 3, "BHD": 3, "OMR": 3, "JOD": 3, "SAR": 2, "AED": 2, "QAR": 2, "EGP": 2, "USD": 2, "EUR": 2, "GBP": 2}
# Only CAPTURED is paid. These seven mean the payment ended without being paid. Everything else is not decided yet: INITIATED (the
# hosted page is open), IN_PROGRESS (the buyer is at their bank), UNKNOWN, and any word Tap adds later. A payment that is not
# decided is never treated as failed, because a buyer told it failed pays again.
PAID, OPEN = "CAPTURED", "INITIATED"
ENDED_UNPAID = frozenset({"ABANDONED", "CANCELLED", "FAILED", "DECLINED", "RESTRICTED", "VOID", "TIMEDOUT"})
CHARGE_ID = re.compile(r"chg_[A-Za-z0-9_]{6,100}")
KEY = re.compile(r"sk_(test|live)_[!-~]{8,200}")  # Tap does not publish what follows the prefix, so only whitespace and control characters are refused
RESPONSE_BYTES = 64 * 1024


def money(value, currency):
    """`value` as an exact Decimal in the currency's own decimals, or None when it is not an amount of that currency (wrong precision, not a number, not positive)."""
    places = DECIMALS.get(currency)
    try:
        amount = Decimal(str(value).strip())
    except (InvalidOperation, ValueError):
        return None
    if places is None or not amount.is_finite() or amount <= 0 or amount >= 1000000 or amount != amount.quantize(Decimal(1).scaleb(-places)):
        return None
    return amount.quantize(Decimal(1).scaleb(-places))


def amount_text(amount, currency):
    """The amount as Tap writes and signs it: `2.500` for KWD, never `2.5`."""
    return format(amount.quantize(Decimal(1).scaleb(-DECIMALS[currency])), "f")


class TapError(Exception):
    """`kind`: 'not_found' (Tap has no such charge), 'forbidden' (the key is wrong or not allowed), 'refused' (Tap would not make the
    charge), 'unavailable' (try again), or 'invalid' (an answer that is not a charge)."""

    def __init__(self, kind):
        super().__init__(kind)
        self.kind = kind


@dataclass(frozen=True)
class TapCharge:
    id: str
    status: str
    amount: Decimal
    currency: str
    live_mode: bool
    order: str = ""              # reference.order: the reference this server made for the attempt
    account: str | None = None         # metadata.account_id: the account the charge was started for; None when Tap returned none
    metadata_order: str | None = None  # metadata.order: the same reference again; None when Tap returned none
    url: str = ""                # transaction.url: Tap's hosted page, while the charge is open
    gateway_reference: str = ""
    payment_reference: str = ""
    created: str = ""


def _text(value, limit=200):
    return value[:limit] if isinstance(value, str) else str(value)[:limit] if isinstance(value, int) and not isinstance(value, bool) else ""


def parse_charge(body):
    """A charge from Tap's JSON (parsed with `parse_float=Decimal`). Raises TapError('invalid') for anything that is not one."""
    try:
        reference, transaction, metadata = (body.get(name) if isinstance(body.get(name), dict) else {} for name in ("reference", "transaction", "metadata"))
        currency = body["currency"]
        amount = money(body["amount"], currency) if isinstance(currency, str) and not isinstance(body["amount"], bool) else None
        if body.get("object", "charge") != "charge" or not CHARGE_ID.fullmatch(body["id"]) or amount is None or not isinstance(body["status"], str) or not isinstance(body["live_mode"], bool):
            raise TapError("invalid")
        return TapCharge(id=body["id"], status=body["status"][:40], amount=amount, currency=currency, live_mode=body["live_mode"], order=_text(reference.get("order")),
                         account=_text(metadata["account_id"]) if "account_id" in metadata else None, metadata_order=_text(metadata["order"]) if "order" in metadata else None, url=_text(transaction.get("url"), 2048), gateway_reference=_text(reference.get("gateway")),
                         payment_reference=_text(reference.get("payment")), created=_text(transaction.get("created")))
    except (KeyError, TypeError, AttributeError):
        raise TapError("invalid") from None


def read_charge(raw):
    """A charge from the bytes of a response or a webhook body."""
    try:
        return parse_charge(json.loads(raw, parse_float=Decimal))
    except (ValueError, UnicodeError, RecursionError):
        raise TapError("invalid") from None


def hashstring(key, charge):
    """What Tap puts in a webhook's `hashstring` header for this charge."""
    text = (f"x_id{charge.id}x_amount{amount_text(charge.amount, charge.currency)}x_currency{charge.currency}x_gateway_reference{charge.gateway_reference}"
            f"x_payment_reference{charge.payment_reference}x_status{charge.status}x_created{charge.created}")
    return hmac.new(key.encode(), text.encode(), hashlib.sha256).hexdigest()


def page_address(url, live):
    """Tap's hosted page for a charge, or None when the address is not one a buyer should be sent to."""
    try:
        parts = urlsplit(url)
        if parts.scheme == "https" and parts.hostname in PAGE_HOSTS[bool(live)] and not parts.username and not parts.password and parts.port is None and len(url) <= 2048 and "\\" not in url and url.isprintable():
            return url
    except ValueError:
        pass
    return None


class TapClient:
    """What the purchase service needs from Tap."""
    live = False   # whether this client's key makes real charges

    def create_charge(self, amount, currency, *, order, idempotent, account, name, email, redirect_url, post_url="") -> TapCharge:
        raise NotImplementedError

    def retrieve_charge(self, charge_id) -> TapCharge:
        raise NotImplementedError

    def signed(self, charge, header) -> bool:
        """Is `header` the `hashstring` Tap would send with this charge?"""
        raise NotImplementedError


class HttpTapClient(TapClient):
    def __init__(self, secret_key, *, merchant_id="", transport=None, timeout=10.0, clock=time.monotonic):
        if not isinstance(secret_key, str) or not KEY.fullmatch(secret_key):
            raise ValueError("The Tap secret key must be an sk_test_ or sk_live_ key.")
        self._key, self._merchant, self._transport, self._timeout, self._clock = secret_key, merchant_id, transport, float(timeout), clock
        self.live = secret_key.startswith("sk_live_")

    def __repr__(self):
        return f"HttpTapClient({'live' if self.live else 'test'} key)"

    def _call(self, method, url, content=None):
        headers = {"Authorization": "Bearer " + self._key, "Accept": "application/json", "lang_code": "en"}
        if content is not None:
            headers["Content-Type"] = "application/json"
        deadline = self._clock() + self._timeout  # for the whole answer: a server that keeps sending a little is cut off too
        try:
            with httpx.Client(transport=self._transport, timeout=httpx.Timeout(self._timeout, connect=min(5.0, self._timeout)), follow_redirects=False, trust_env=False) as client:
                with client.stream(method, url, headers=headers, content=content) as response:
                    raw = b""
                    for chunk in response.iter_bytes():
                        raw += chunk
                        if len(raw) > RESPONSE_BYTES or self._clock() > deadline:
                            raise TapError("unavailable")
                    status = response.status_code
        except (httpx.HTTPError, OSError):
            raise TapError("unavailable") from None  # nothing of the request, and so nothing of the key, goes into the error
        if status in (401, 403):
            raise TapError("forbidden")
        if status in (400, 404, 410, 422):
            raise TapError("not_found" if method == "GET" else "refused")
        if status != 200:
            raise TapError("unavailable")
        return read_charge(raw)

    def create_charge(self, amount, currency, *, order, idempotent, account, name, email, redirect_url, post_url=""):
        body = {"amount": "__AMOUNT__", "currency": currency, "customer_initiated": True, "threeDSecure": True, "save_card": False, "description": "Little Archive unlock",
                "source": {"id": "src_all"}, "reference": {"order": order, "transaction": order, "idempotent": idempotent}, "metadata": {"account_id": account, "order": order},
                "customer": {"first_name": name, "email": email}, "redirect": {"url": redirect_url}}
        if post_url:
            body["post"] = {"url": post_url}
        if self._merchant:
            body["merchant"] = {"id": self._merchant}
        # The amount goes in as a number with every decimal of its currency (2.500), which no float can be trusted to print.
        content = json.dumps(body).replace('"__AMOUNT__"', amount_text(amount, currency), 1).encode()
        charge = self._call("POST", API, content)
        url = page_address(charge.url, self.live)
        if url is None:
            raise TapError("invalid")
        return charge

    def retrieve_charge(self, charge_id):
        if not CHARGE_ID.fullmatch(charge_id):
            raise TapError("not_found")
        return self._call("GET", API + "/" + quote(charge_id, safe=""))

    def signed(self, charge, header):
        return isinstance(header, str) and bool(re.fullmatch(r"[0-9a-fA-F]{64}", header)) and hmac.compare_digest(hashstring(self._key, charge), header.lower())
