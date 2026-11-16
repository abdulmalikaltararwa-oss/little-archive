"""The one page a hosted server serves: paying for the unlock in a browser, at /pay.

A hosted server is an API. It has no web interface and `/` answers 404; this page is the exception, and it exists only while Tap
is configured and the operator has given the Supabase project's publishable key (otherwise /pay answers 404 too). It is served by
this server, so its requests to `/api` are same-origin and need no CORS.

    GET /pay           the page: what the unlock adds, sign-in, the price and one button
    GET /pay/pay.css   its stylesheet
    GET /pay/pay.js    its script (signs in at Supabase, then calls /api/account and /api/purchases/tap/start)

The page carries no secret. What it is given is public by design: the Supabase project's address and publishable key (the same two
values the phone app ships with), the price, and the public site's address for the privacy and terms links. The Supabase secret
key and the Tap key never reach it. Its content security policy allows no inline script or style, only this origin's files, and
connections only to this origin and the Supabase project.
"""
from __future__ import annotations

from html import escape
from pathlib import Path

from .tap import amount_text

WEB = Path(__file__).resolve().parent / "web"


def pay_policy(supabase_url):
    return "; ".join(["default-src 'none'", "script-src 'self'", "style-src 'self'", "img-src 'self'", "font-src 'self'", f"connect-src 'self' {supabase_url}",
                      "form-action 'self'", "frame-ancestors 'none'", "base-uri 'none'"])


def install_pay_routes(app, *, config, service):
    from fastapi import HTTPException
    from fastapi.responses import HTMLResponse, Response

    files = {name: (WEB / name).read_bytes() for name in ("pay.css", "pay.js")}
    template = (WEB / "pay.html").read_text(encoding="utf-8")
    policy = pay_policy(config.supabase_url)

    def offered():
        return service.pay_page

    def required():
        if not offered():
            raise HTTPException(404, "Not found.")

    @app.get("/pay", include_in_schema=False)
    def pay_page():
        required()
        page = template.format(supabase_url=escape(config.supabase_url, quote=True), supabase_key=escape(config.supabase_publishable_key, quote=True),
                               price=escape(amount_text(service.tap_amount, service.tap_currency)), currency=escape(service.tap_currency), site=escape(config.public_site_url, quote=True))
        return HTMLResponse(page, headers={"Content-Security-Policy": policy, "Cache-Control": "no-store"})

    @app.get("/pay/pay.css", include_in_schema=False)
    def pay_style():
        required()
        return Response(files["pay.css"], media_type="text/css; charset=utf-8", headers={"Cache-Control": "no-cache"})

    @app.get("/pay/pay.js", include_in_schema=False)
    def pay_script():
        required()
        return Response(files["pay.js"], media_type="text/javascript; charset=utf-8", headers={"Cache-Control": "no-cache"})
