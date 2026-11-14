"""Synthetic stores for the purchase tests: an Apple certificate chain and signer, a Google Play client, and a push verifier.

Nothing here is Apple's or Google's. The certificates are generated for each test and shaped like the real ones (a P-384 root and
intermediate, a P-256 leaf, Apple's marker extensions); a transaction signed here proves only that this code does what its checks say.
"""
import base64
from datetime import datetime, timedelta, timezone
import json
import time

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, utils
from cryptography.x509.oid import NameOID, ObjectIdentifier

from server.purchases.apple import INTERMEDIATE_MARKER, LEAF_MARKER
from server.purchases.google import PlayClient, PlayError, PlayPurchase

BUNDLE = "app.littlearchive.mobile"
PRODUCT = "unlock_full"


def b64(data):
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def now_ms():
    return int(time.time() * 1000)


class AppleChain:
    """A root, an intermediate and a leaf as Apple shapes them, and a signer."""

    def __init__(self, *, root=None, leaf_marker=True, intermediate_marker=True, intermediate_ca=True, leaf_ca=False, leaf_curve=None,
                 leaf_from=None, leaf_until=None, issuer_name_for_leaf=None, hash_algorithm=None):
        self.root_key = ec.generate_private_key(ec.SECP384R1())
        self.inter_key = ec.generate_private_key(ec.SECP384R1())
        self.leaf_key = ec.generate_private_key(leaf_curve or ec.SECP256R1())
        hash_algorithm = hash_algorithm or hashes.SHA384()
        past, far = datetime.now(timezone.utc) - timedelta(days=3650), datetime.now(timezone.utc) + timedelta(days=3650)

        def name(common):
            return x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, common), x509.NameAttribute(NameOID.ORGANIZATION_NAME, "Synthetic Apple")])

        def cert(subject, issuer, key, signer, *, ca, marker=None, before=past, after=far):
            builder = (x509.CertificateBuilder().subject_name(name(subject)).issuer_name(issuer if isinstance(issuer, x509.Name) else name(issuer)).public_key(key.public_key())
                       .serial_number(x509.random_serial_number()).not_valid_before(before).not_valid_after(after)
                       .add_extension(x509.BasicConstraints(ca=ca, path_length=None if ca else None), critical=True))
            if marker is not None:
                builder = builder.add_extension(x509.UnrecognizedExtension(marker, b"\x05\x00"), critical=False)
            return builder.sign(signer, hash_algorithm)

        self.root = cert("Synthetic Root", "Synthetic Root", self.root_key, self.root_key, ca=True)
        self.intermediate = cert("Synthetic Intermediate", "Synthetic Root", self.inter_key, self.root_key, ca=intermediate_ca, marker=INTERMEDIATE_MARKER if intermediate_marker else None)
        self.leaf = cert("Synthetic Leaf", issuer_name_for_leaf or "Synthetic Intermediate", self.leaf_key, self.inter_key, ca=leaf_ca, marker=LEAF_MARKER if leaf_marker else None,
                         before=leaf_from or past, after=leaf_until or far)
        self.root_der = self.root.public_bytes(serialization.Encoding.DER)

    def x5c(self):
        return [base64.b64encode(c.public_bytes(serialization.Encoding.DER)).decode() for c in (self.leaf, self.intermediate, self.root)]

    def sign(self, payload, *, header=None, key=None, raw_signature=None):
        head = {"alg": "ES256", "x5c": self.x5c(), **(header or {})}
        signing = f"{b64(json.dumps(head).encode())}.{b64(json.dumps(payload).encode())}"
        if raw_signature is None:
            signer = key or self.leaf_key
            if signer.curve.name != "secp256r1":
                raw_signature = b"\x01" * 64  # a leaf of the wrong kind cannot sign as ES256; the chain is refused before the signature matters
            else:
                r, s = utils.decode_dss_signature(signer.sign(signing.encode(), ec.ECDSA(hashes.SHA256())))
                raw_signature = r.to_bytes(32, "big") + s.to_bytes(32, "big")
        return signing + "." + b64(raw_signature)

    def transaction(self, **fields):
        stamp = now_ms()
        payload = {"originalTransactionId": "2000000123456789", "transactionId": "2000000123456789", "productId": PRODUCT, "bundleId": BUNDLE, "environment": "Production",
                   "type": "Non-Consumable", "purchaseDate": stamp - 5000, "originalPurchaseDate": stamp - 5000, "signedDate": stamp, "inAppOwnershipType": "PURCHASED",
                   "quantity": 1, "storefront": "USA", "storefrontId": "143441"}
        payload.update(fields)
        return self.sign({k: v for k, v in payload.items() if v is not None})

    def notification(self, kind, *, transaction=None, uuid="11111111-2222-3333-4444-555555555555", subtype=None, **data):
        stamp = now_ms()
        body = {"notificationType": kind, "notificationUUID": uuid, "version": "2.0", "signedDate": stamp,
                "data": {"bundleId": BUNDLE, "environment": "Production", "appAppleId": 1234567890, **data}}
        if subtype:
            body["subtype"] = subtype
        if transaction is not None:
            body["data"]["signedTransactionInfo"] = transaction
        return self.sign(body)


class FakePlay(PlayClient):
    """Google Play as a dictionary: token -> PlayPurchase (or a PlayError kind to raise)."""

    def __init__(self):
        self.purchases, self.calls, self.acknowledged = {}, [], []

    def add(self, token, **fields):
        base = dict(product_id=PRODUCT, state="purchased", order_id="GPA.0000-0000-0000-00000", acknowledged=False, test=False, account_tag=None, purchased_ms=now_ms())
        self.purchases[token] = PlayPurchase(**{**base, **fields})

    def fail(self, token, kind):
        self.purchases[token] = kind

    def get_purchase(self, package, product_id, token):
        self.calls.append(("get", package, product_id, token))
        answer = self.purchases.get(token, "not_found")
        if isinstance(answer, str):
            raise PlayError(answer)
        return answer

    def acknowledge(self, package, product_id, token):
        self.calls.append(("ack", package, product_id, token))
        if isinstance(self.purchases.get(token), PlayPurchase):
            self.acknowledged.append(token)
            old = self.purchases[token]
            self.purchases[token] = PlayPurchase(**{**old.__dict__, "acknowledged": True})


class FakePush:
    """Accepts exactly one bearer value as Google's."""

    def __init__(self, valid="valid-push-token"):
        self.valid = valid

    def verify(self, token):
        return token == self.valid
