"""The routes of the one-time purchase, hosted mode only (every one answers 404 on a self-hosted library).

    GET  /api/purchases                         this account's purchases and whether it is unlocked
    POST /api/purchases/apple                   {signed_transaction}        redeem a StoreKit 2 transaction (a JWS)
    POST /api/purchases/google                  {product_id, purchase_token}  redeem a Google Play purchase token
    POST /api/purchases/apple/notifications     {signedPayload}             App Store Server Notifications V2 (from Apple)
    POST /api/purchases/google/notifications    a Pub/Sub push request      Google real-time notifications (from Google)

The first three need the caller's sign-in. The two notification routes are called by the stores and carry no account; each is judged
by its own proof (Apple's signature, Google's signed OpenID token). See docs/hosted-mode.md for the answers and their codes.
"""
from __future__ import annotations

from fastapi import Depends, Request
from pydantic import BaseModel, Field

from ..limits import Refusal
from ..models import StrictModel


class AppleProof(StrictModel):
    signed_transaction: str = Field(min_length=20, max_length=16384)


class GoogleProof(StrictModel):
    product_id: str = Field(min_length=1, max_length=100)
    purchase_token: str = Field(min_length=10, max_length=2048)


class AppleNotification(BaseModel):  # Apple may add fields; only this one is read
    signedPayload: str = Field(min_length=20, max_length=16384)


def install_routes(app, *, owner, service, hosted_route, entitlements):
    from fastapi.responses import JSONResponse

    @app.get("/api/purchases", dependencies=hosted_route)
    def list_purchases(auth=Depends(owner)):
        return {"unlocked": entitlements.is_unlocked(auth.user_id), "unlocked_via": entitlements.unlock_source(auth.user_id), "purchases": service.purchases(auth.user_id)}

    @app.post("/api/purchases/apple", dependencies=hosted_route)
    def redeem_apple(data: AppleProof, auth=Depends(owner)):
        return service.redeem_apple(auth.user_id, data.signed_transaction)

    @app.post("/api/purchases/google", dependencies=hosted_route)
    def redeem_google(data: GoogleProof, auth=Depends(owner)):
        answer = service.redeem_google(auth.user_id, data.product_id, data.purchase_token)
        return JSONResponse(answer, status_code=200 if answer["status"] == "active" else 202)  # 202: Google has not completed the payment yet

    @app.post("/api/purchases/apple/notifications", dependencies=hosted_route)
    def apple_notification(data: AppleNotification):
        return service.apple_notification(data.signedPayload)

    @app.post("/api/purchases/google/notifications", dependencies=hosted_route)
    def google_notification(request: Request, body: dict):
        header = request.headers.get("authorization", "")
        token = header[7:].strip() if header[:7].lower() == "bearer " else ""
        if not token:
            raise Refusal(401, "This notification is not signed for this service.", "notification_unauthenticated", headers={"WWW-Authenticate": "Bearer"})
        return service.google_notification(token, body)
