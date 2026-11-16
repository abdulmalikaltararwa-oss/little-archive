"""The routes of the one-time purchase, hosted mode only (every one answers 404 on a self-hosted library).

    GET  /api/purchases                         this account's purchases and whether it is unlocked
    POST /api/purchases/apple                   {signed_transaction}        redeem a StoreKit 2 transaction (a JWS)
    POST /api/purchases/google                  {product_id, purchase_token}  redeem a Google Play purchase token
    POST /api/purchases/apple/notifications     {signedPayload}             App Store Server Notifications V2 (from Apple)
    POST /api/purchases/google/notifications    a Pub/Sub push request      Google real-time notifications (from Google)
    POST /api/purchases/tap/start               {email, name?}              begin a payment on Tap's hosted page; answers its address
    POST /api/purchases/tap/confirm             {tap_id}                    ask what became of a payment this account started
    GET  /api/purchases/tap/return?tap_id=      a browser, sent by Tap      the page a buyer lands on afterwards (HTML)
    POST /api/purchases/tap/notifications       a charge, signed            Tap's webhook (from Tap)

The page a buyer starts from in a browser, /pay, is in pay.py.

The first three and Tap's start and confirm need the caller's sign-in. The notification routes are called by the stores and carry no
account; each is judged by its own proof (Apple's signature, Google's signed OpenID token, Tap's `hashstring`), and Tap's is then
checked again by asking Tap. The return page carries no sign-in either and decides nothing by itself: it asks Tap about a payment this
server started. See docs/hosted-mode.md for the answers and their codes.
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


class TapBuyer(StrictModel):
    """Tap asks who is paying, for its receipt. The server passes both on and keeps neither."""
    email: str = Field(min_length=3, max_length=254, pattern=r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
    name: str = Field(default="Little Archive customer", min_length=1, max_length=80, pattern=r"^[^\x00-\x1f\x7f]+$")


class TapReturn(StrictModel):
    tap_id: str = Field(min_length=10, max_length=104, pattern=r"^chg_[A-Za-z0-9_]+$")


# The page a buyer lands on after Tap: plain HTML, no script, no inline style (the response's content security policy allows
# neither), and nothing from the request is written into it. Where the pay page is on, it borrows that page's stylesheet and
# links back to it; otherwise it is unstyled.
RETURN_PAGE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="robots" content="noindex">
<title>{title} - Little Archive</title>{style}
</head>
<body>
<div class="wrap">
<main class="returned">
<p class="whisper">a one-time unlock</p>
<h1>{title}</h1>
<p class="notice {tone}">{text}</p>{more}
<p class="soft">You can close this page and go back to Little Archive.</p>
</main>
</div>
</body>
</html>
"""
RETURN_PAGES = {
    "paid": (200, "Payment received", "Thank you. Your Little Archive account is unlocked."),
    "pending": (200, "Payment still being confirmed", "Your payment is still being confirmed. Reload this page in a minute. If you paid, your account unlocks by itself as soon as it is confirmed; you do not need to pay twice."),
    "unpaid": (200, "Payment not completed", "The payment was not completed, so nothing was unlocked."),
    "later": (503, "Payment could not be checked", "The payment could not be checked just now. Reload this page in a minute. If you paid, your account unlocks as soon as the payment is confirmed."),
    "unknown": (404, "Payment not found", "This address does not match a payment started from a Little Archive account, so nothing was unlocked."),
}
RETURN_STYLE = '\n<link rel="stylesheet" href="/pay/pay.css">'
RETURN_LINKS = {"unpaid": "Start again on the pay page", "pending": "Back to the pay page", "later": "Back to the pay page"}
RETURN_TONES = {"paid": "sage", "pending": "petal", "unpaid": "err", "later": "petal", "unknown": "err"}  # class names in pay.css


def install_routes(app, *, owner, service, hosted_route, entitlements):
    from fastapi.concurrency import run_in_threadpool
    from fastapi.responses import HTMLResponse, JSONResponse

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

    # -- Tap: the same unlock, paid for on Tap's own page in a browser --------------------------------------------
    @app.post("/api/purchases/tap/start", dependencies=hosted_route)
    def start_tap(data: TapBuyer, auth=Depends(owner)):
        return service.start_tap(auth.user_id, data.name, data.email)

    @app.post("/api/purchases/tap/confirm", dependencies=hosted_route)
    def confirm_tap(data: TapReturn, auth=Depends(owner)):
        answer = service.settle_tap(data.tap_id, auth.user_id)
        return JSONResponse(answer, status_code=200 if answer["unlocked"] else 202)  # 202: Tap has not finished the payment yet

    @app.get("/api/purchases/tap/return", dependencies=hosted_route, include_in_schema=False)
    def return_from_tap(tap_id: str = ""):
        """Where Tap sends the buyer's browser. It carries no sign-in, so the charge id is only a hint: what Tap says about it decides."""
        try:
            kind = "paid" if service.settle_tap(tap_id)["unlocked"] else "pending"
        except Refusal as refusal:
            kind = {"purchase_not_paid": "unpaid", "purchases_unavailable": "later"}.get(refusal.code, "unknown")
        status, title, text = RETURN_PAGES[kind]
        pay = service.pay_page
        more = f'\n<p><a class="btn primary lg" href="/pay">{RETURN_LINKS[kind]}</a></p>' if pay and kind in RETURN_LINKS else ""
        return HTMLResponse(RETURN_PAGE.format(title=title, text=text, tone=RETURN_TONES[kind], style=RETURN_STYLE if pay else "", more=more), status_code=status)

    @app.post("/api/purchases/tap/notifications", dependencies=hosted_route)
    async def tap_notification(request: Request):
        raw = await request.body()
        return await run_in_threadpool(service.tap_notification, raw, request.headers.get("hashstring", ""))
