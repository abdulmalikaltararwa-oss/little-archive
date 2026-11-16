"""The one page a hosted server serves: paying for the unlock in a browser, at /pay.

A hosted server is an API. It has no web interface and `/` answers 404; this page is the exception, and it exists only while Tap
is configured and the operator has given the Supabase project's publishable key (otherwise /pay answers 404 too). It is served by
this server, so its requests to `/api` are same-origin and need no CORS.

    GET /pay           the page: what is free, what the unlock adds, the price, sign-in and one button
    GET /pay/pay.css   its stylesheet
    GET /pay/pay.js    its script (signs in at Supabase, then calls /api/account and /api/purchases/tap/start)

The page carries no secret. What it is given is public by design: the Supabase project's address and publishable key (the same two
values the phone app ships with), the price, the seller's name if the operator set one (LA_SELLER_NAME), and the public site's
address for the terms, refund and privacy links. The Supabase secret key and the Tap key never reach it. Its content security policy allows no inline script or style, only this origin's files, and
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


def legal_lines(seller, site):
    """What stands beside the Pay button: who sells it (only if the operator said), the refund promise, and what paying agrees to.
    Without a public site address the same sentences are written with no links."""
    def link(page, words):
        return f'<a href="{escape(site, quote=True)}/{page}">{words}</a>' if site else words

    lines = [f"Sold by {escape(seller)}"] if seller else []
    lines.append(f"14-day refund: {link('terms.html#refunds', 'write to us')}.")
    lines.append(f"By paying you agree to the {link('terms.html', 'Terms')} and {link('privacy.html', 'Privacy policy')}.")
    return "\n".join(f'<p class="legal">{line}</p>' for line in lines)


def site_footer(site):
    if not site:
        return ""
    links = "\n".join(f'<li><a href="{escape(site, quote=True)}/{page}">{words}</a></li>' for page, words in (("privacy.html", "Privacy"), ("terms.html", "Terms"), ("support.html", "Support")))
    return f'<footer class="site-footer">\n<ul>\n{links}\n</ul>\n</footer>'


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
                               price=escape(amount_text(service.tap_amount, service.tap_currency)), currency=escape(service.tap_currency),
                               legal=legal_lines(config.seller_name, config.public_site_url), footer=site_footer(config.public_site_url))
        return HTMLResponse(page, headers={"Content-Security-Policy": policy, "Cache-Control": "no-store"})

    @app.get("/pay/pay.css", include_in_schema=False)
    def pay_style():
        required()
        return Response(files["pay.css"], media_type="text/css; charset=utf-8", headers={"Cache-Control": "no-cache"})

    @app.get("/pay/pay.js", include_in_schema=False)
    def pay_script():
        required()
        return Response(files["pay.js"], media_type="text/javascript; charset=utf-8", headers={"Cache-Control": "no-cache"})
