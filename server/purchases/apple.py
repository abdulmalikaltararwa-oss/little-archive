"""Verifying what the App Store signs: a StoreKit 2 transaction (a JWS) and App Store Server Notifications V2.

What is checked, in this order, for every signed value:

1. Shape: three base64url parts, bounded sizes, a JSON header whose `alg` is exactly `ES256` and which carries `x5c` (a
   certificate chain, leaf first) and nothing marked critical.
2. The chain: exactly three certificates; the last is byte for byte one of the trusted roots (by default the bundled Apple Root CA -
   G3, whose SHA-256 is pinned in this file and checked when it is loaded); each certificate was issued by the next (name and
   signature, ECDSA with SHA-256 or stronger); each was valid when the value was signed; the intermediate may sign certificates
   and carries Apple's marker extension `1.2.840.113635.100.6.2.1`, the leaf may not sign certificates and carries Apple's
   `1.2.840.113635.100.6.11.1`. These are the checks Apple's own server library makes; revocation lists and OCSP are not consulted
   (the library does so only when asked to go online). Revocation of a purchase is carried by the signed transaction itself and by
   notifications, which this module also verifies.
3. The signature of the value itself, by the leaf certificate's P-256 key.
4. Then, and only then, the payload: bundle id, product id, environment, kind of product, and the revocation fields.

The time used to judge certificate validity is the value's own `signedDate`, never later than now and never more than five minutes
ahead, so a transaction signed while a leaf certificate was valid stays verifiable after that certificate expires, as Apple's
library does.

The formats follow Apple's `JWSTransactionDecodedPayload` and `ResponseBodyV2DecodedPayload` as implemented in Apple's open source
App Store Server libraries (checked against their Python library's models and verifier). Everything exercised in this repository
uses certificates and signatures generated in the tests, never a real transaction.
"""
from __future__ import annotations

import base64
from dataclasses import dataclass
import hashlib
import json
from pathlib import Path
import time

from cryptography import x509
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec, utils
from cryptography.x509.oid import ObjectIdentifier

# Source: https://www.apple.com/certificateauthority/AppleRootCA-G3.cer (Apple Root CA - G3, EC P-384, valid to 2039-04-30).
# The file is stored as downloaded. This is the SHA-256 Apple publishes for it at https://support.apple.com/en-us/105116.
APPLE_ROOT_G3_SHA256 = "63343abfb89a6a03ebb57e9b3f5fa7be7c4f5c756f3017b3a8c488c3653e9179"
APPLE_ROOT_PATH = Path(__file__).resolve().parent / "AppleRootCA-G3.cer"
LEAF_MARKER = ObjectIdentifier("1.2.840.113635.100.6.11.1")
INTERMEDIATE_MARKER = ObjectIdentifier("1.2.840.113635.100.6.2.1")
MAX_JWS_BYTES = 16 * 1024
MAX_CERT_BYTES = 4 * 1024
FUTURE_SECONDS = 300
STRONG = (hashes.SHA256, hashes.SHA384, hashes.SHA512)


class AppleVerificationError(Exception):
    """The value is not one the App Store signed for this app. `code` says which kind of refusal; nothing else is revealed."""

    def __init__(self, code):
        super().__init__(code)
        self.code = code


def bundled_root():
    """The bundled Apple Root CA - G3 as DER, refused if the file is not the one whose fingerprint is pinned above."""
    data = APPLE_ROOT_PATH.read_bytes()
    if hashlib.sha256(data).hexdigest() != APPLE_ROOT_G3_SHA256:
        raise ValueError("The bundled Apple root certificate is not the expected file.")
    return data


def _b64(part):
    try:
        return base64.urlsafe_b64decode(part + "=" * (-len(part) % 4))
    except (ValueError, TypeError) as exc:
        raise AppleVerificationError("invalid") from exc


@dataclass(frozen=True)
class Transaction:
    original_transaction_id: str
    transaction_id: str
    product_id: str
    bundle_id: str
    environment: str
    kind: str                       # "Non-Consumable", ...
    signed_ms: int
    purchase_ms: int | None
    revoked_ms: int | None          # set once the App Store refunded or revoked it
    revocation_reason: int | None
    account_token: str | None       # the app's own tag for the account that bought it, if the app set one
    ownership: str | None           # PURCHASED or FAMILY_SHARED

    @property
    def revoked(self):
        return self.revoked_ms is not None


@dataclass(frozen=True)
class Notification:
    kind: str                       # REFUND, REVOKE, REFUND_REVERSED, ONE_TIME_CHARGE, TEST, ...
    subtype: str | None
    uuid: str
    signed_ms: int
    transaction: Transaction | None


class AppleVerifier:
    def __init__(self, bundle_id, product_id, environments=("Production",), app_apple_id=0, roots=None, clock=time.time):
        self.bundle_id, self.product_id, self.environments = bundle_id, product_id, frozenset(environments)
        self.app_apple_id, self.clock = int(app_apple_id or 0), clock
        self.roots = [bytes(root) for root in (roots if roots is not None else [bundled_root()])]
        self._trusted = [x509.load_der_x509_certificate(root) for root in self.roots]

    # -- the signed container ------------------------------------------------------
    def _open(self, token):
        """Verify a JWS end to end and return its payload as a dict. Raises AppleVerificationError('invalid')."""
        if not isinstance(token, str) or not 0 < len(token) <= MAX_JWS_BYTES or token.count(".") != 2 or not token.isascii():
            raise AppleVerificationError("invalid")
        head, body, sig = token.split(".")
        try:
            header, payload = json.loads(_b64(head)), json.loads(_b64(body))
        except (ValueError, RecursionError) as exc:
            raise AppleVerificationError("invalid") from exc
        if not isinstance(header, dict) or not isinstance(payload, dict) or header.get("alg") != "ES256" or "crit" in header:
            raise AppleVerificationError("invalid")
        chain = header.get("x5c")
        if not isinstance(chain, list) or len(chain) != 3 or any(not isinstance(c, str) or len(c) > MAX_CERT_BYTES for c in chain):
            raise AppleVerificationError("invalid")
        now = self.clock()
        signed = payload.get("signedDate")
        moment = now if not isinstance(signed, int) or isinstance(signed, bool) else min(signed / 1000, now)
        if isinstance(signed, int) and not isinstance(signed, bool) and signed / 1000 > now + FUTURE_SECONDS:
            raise AppleVerificationError("invalid")
        leaf = self._chain(chain, moment)
        signature = _b64(sig)
        if len(signature) != 64:
            raise AppleVerificationError("invalid")
        try:
            leaf.verify(utils.encode_dss_signature(int.from_bytes(signature[:32], "big"), int.from_bytes(signature[32:], "big")), f"{head}.{body}".encode("ascii"), ec.ECDSA(hashes.SHA256()))
        except InvalidSignature as exc:
            raise AppleVerificationError("invalid") from exc
        return payload

    def _chain(self, chain, moment):
        """The leaf's public key, once the three certificates are shown to run from a trusted root to it."""
        try:
            ders = [base64.b64decode(c, validate=True) for c in chain]
            leaf, intermediate, root = (x509.load_der_x509_certificate(d) for d in ders)
        except (ValueError, TypeError) as exc:
            raise AppleVerificationError("invalid") from exc
        if not any(ders[2] == trusted for trusted in self.roots):
            raise AppleVerificationError("invalid")
        from datetime import datetime, timezone
        at = datetime.fromtimestamp(moment, timezone.utc)
        for certificate in (leaf, intermediate, root):
            if not certificate.not_valid_before_utc <= at <= certificate.not_valid_after_utc:
                raise AppleVerificationError("invalid")
        for child, parent in ((leaf, intermediate), (intermediate, root)):
            self._issued_by(child, parent)
        try:
            intermediate.extensions.get_extension_for_oid(INTERMEDIATE_MARKER)
            leaf.extensions.get_extension_for_oid(LEAF_MARKER)
            if not intermediate.extensions.get_extension_for_class(x509.BasicConstraints).value.ca:
                raise AppleVerificationError("invalid")
        except x509.ExtensionNotFound as exc:
            raise AppleVerificationError("invalid") from exc
        try:
            if leaf.extensions.get_extension_for_class(x509.BasicConstraints).value.ca:
                raise AppleVerificationError("invalid")
        except x509.ExtensionNotFound:
            pass
        key = leaf.public_key()
        if not isinstance(key, ec.EllipticCurvePublicKey) or not isinstance(key.curve, ec.SECP256R1):
            raise AppleVerificationError("invalid")
        return key

    @staticmethod
    def _issued_by(child, parent):
        key = parent.public_key()
        if child.issuer != parent.subject or not isinstance(key, ec.EllipticCurvePublicKey) or not isinstance(child.signature_hash_algorithm, STRONG):
            raise AppleVerificationError("invalid")
        try:
            key.verify(child.signature, child.tbs_certificate_bytes, ec.ECDSA(child.signature_hash_algorithm))
        except InvalidSignature as exc:
            raise AppleVerificationError("invalid") from exc

    # -- what the container says --------------------------------------------------------
    @staticmethod
    def _text(payload, name, limit=200, required=True):
        value = payload.get(name)
        if value is None and not required:
            return None
        if not isinstance(value, str) or not value or len(value) > limit:
            raise AppleVerificationError("invalid")
        return value

    @staticmethod
    def _millis(payload, name):
        value = payload.get(name)
        if value is None:
            return None
        if not isinstance(value, int) or isinstance(value, bool) or not 0 <= value < 10 ** 14:
            raise AppleVerificationError("invalid")
        return value

    def _transaction(self, payload):
        reason = payload.get("revocationReason")
        return Transaction(
            original_transaction_id=self._text(payload, "originalTransactionId", 64), transaction_id=self._text(payload, "transactionId", 64),
            product_id=self._text(payload, "productId"), bundle_id=self._text(payload, "bundleId"), environment=self._text(payload, "environment", 20),
            kind=self._text(payload, "type", 40), signed_ms=self._millis(payload, "signedDate") or 0, purchase_ms=self._millis(payload, "purchaseDate"),
            revoked_ms=self._millis(payload, "revocationDate"), revocation_reason=reason if isinstance(reason, int) and not isinstance(reason, bool) else None,
            account_token=self._text(payload, "appAccountToken", 64, required=False), ownership=self._text(payload, "inAppOwnershipType", 30, required=False))

    def transaction(self, signed_transaction):
        """A verified transaction for this app's one product, or AppleVerificationError with a code:
        invalid, wrong_app, wrong_environment, wrong_product."""
        found = self._transaction(self._open(signed_transaction))
        if found.bundle_id != self.bundle_id:
            raise AppleVerificationError("wrong_app")
        if found.environment not in self.environments:
            raise AppleVerificationError("wrong_environment")
        if found.product_id != self.product_id or found.kind != "Non-Consumable":
            raise AppleVerificationError("wrong_product")
        return found

    def notification(self, signed_payload):
        """A verified App Store Server Notification V2 for this app, with its transaction (itself verified) when it has one."""
        payload = self._open(signed_payload)
        data = payload.get("data")
        if not isinstance(data, dict):
            data = {}
        if data and data.get("bundleId") != self.bundle_id:
            raise AppleVerificationError("wrong_app")
        if data and (data.get("environment") not in self.environments):
            raise AppleVerificationError("wrong_environment")
        if data and self.app_apple_id and data.get("appAppleId") != self.app_apple_id:
            raise AppleVerificationError("wrong_app")
        kind = self._text(payload, "notificationType", 40)
        signed = data.get("signedTransactionInfo")
        found = None
        if signed is not None:
            found = self._transaction(self._open(signed))
            if found.bundle_id != self.bundle_id:
                raise AppleVerificationError("wrong_app")
            if found.environment not in self.environments:
                raise AppleVerificationError("wrong_environment")
        return Notification(kind=kind, subtype=self._text(payload, "subtype", 60, required=False), uuid=self._text(payload, "notificationUUID", 64),
                            signed_ms=self._millis(payload, "signedDate") or 0, transaction=found)
