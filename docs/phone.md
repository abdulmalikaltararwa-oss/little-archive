# Using Little Archive on a phone

Your Little Archive instance can be installed on a phone like an app, and on Android it appears in the share sheet, so a link shared from a browser or another app opens the "Save a little discovery" dialog with the link already filled in. Sharing into the app never saves by itself: the dialog waits for your tap. Everything talks to your own instance; nothing goes through a project-operated service.

There is also a native iOS and Android app (development software) that adds a share-sheet entry on iPhone as well; see [the mobile app guide](mobile-app.md). This page is about installing the web app.

What is verified and what is not is listed [at the end](#what-was-and-was-not-verified). In short: the pieces were exercised with desktop Chromium, an older WebKit build, and HTTP clients against a local server. Nothing here has been run on a real Android phone or a real iPhone yet.

## Before you start: HTTPS

Browsers offer installation and share targets only on a secure origin. That means HTTPS; `localhost` is the one exception, and it only reaches the machine it runs on, not your phone. So your instance needs an HTTPS address that the phone can open:

- Set `LA_PUBLIC_URL` to that exact address (for example `https://archive.example.com`) and open the instance there. Mixing addresses fails the state-changing origin check. See [self-hosting](self-hosting.md#browser-facing-origin).
- Put a reverse proxy or a private-network HTTPS service you control in front of the server. See [reverse proxy](self-hosting.md#reverse-proxy). This guide does not verify any particular setup.
- Keep the instance private. The share address `/share` is the same public page as the sign-in screen; nobody can save anything without your owner session.

## Install

**Android (Chrome).** Open your instance, sign in, then use the browser menu and choose Install app (or Add to Home screen, then Install). Little Archive then has its own icon, opens without browser controls, and is offered in the share sheet.

**iPhone and iPad (Safari).** Choose Share, then Add to Home Screen. This gives you the icon and a full-screen app for browsing, searching and organizing. iOS does not support web share targets for installed web apps, so Little Archive will not appear in the iPhone share sheet. See [saving from an iPhone](#saving-from-an-iphone). If the Home Screen app asks you to sign in, sign in there; do not assume it shares Safari's session.

There is no offline mode. The app is a view onto your instance and needs it to be reachable. See [limits](#limits).

## Sharing a link on Android

1. In Instagram, TikTok, a browser or any app that shares links, choose Share, then Little Archive.
2. Little Archive opens the save dialog with the link, a title and a note filled in from what was shared. The dialog says the link was shared and from which site.
3. Check the link and tap Save to archive. Add topics or collections first if you like.

What happens to the shared values:

- Apps send a link in different fields. Little Archive takes the link from the shared link field, then the text, then the title. If the text is a sentence with a link in it, the first link is used and the rest of the sentence becomes your note. Other links in the text stay in the note.
- Only `http` and `https` links are accepted, without embedded credentials. Anything else is ignored. Trailing punctuation, quotes and brackets around a link are trimmed. A link containing hidden or direction-changing characters, or longer than 4,096 characters, is refused. The link is shown in its normalized form, so an internationalized host appears in its safe `xn--` form.
- Titles and notes are cut to 500 and 4,000 characters, and control and direction-changing characters are removed. Shared text only ever fills form fields as plain text; it is never inserted as markup.
- Nothing is saved until you tap Save. A shared link opens the dialog and nothing more, so a crafted address cannot add items by itself. The server serves the same static page for `/share` whatever the query says.
- If you are signed out, the sign-in screen says a shared link is waiting. Sign in and the dialog opens. If the page is reloaded before you finish, the address still holds the shared values and the dialog opens again. After you save or cancel, the address returns to `/`.
- If nothing usable was shared, the dialog opens with a note and an empty link field.

Privacy: the shared values travel in the page address (`/share?...`) to your own instance. The built-in `serve` command does not write access logs, and the app sends no referrer. A reverse proxy in front of it may log addresses; check its configuration if that matters to you.

Known limits:

- **TikTok short links.** TikTok often shares short `vm.tiktok.com` or `vt.tiktok.com` links. The server never follows a link, so it cannot save them, and the dialog says so. Open the video in your browser and share or copy the full link instead.
- Instagram post and reel links are recognized and cleaned of tracking parameters. Other links are saved as web links. Only the link is stored; no caption, thumbnail or title is fetched from the site.
- Which of the three fields an app fills varies by app and version. The parser accepts all three; the exact payloads of the Instagram and TikTok apps were not observed.
- Share targets are a Chrome feature on Android. Other Android browsers were not tried.

## Saving from an iPhone

Three ways, from simplest to most automatic.

**1. Copy and paste.** Copy the link, open Little Archive, tap Save a link and paste it. This works everywhere and needs nothing set up.

**2. A shortcut that opens the save dialog.** Build a Shortcut in the Shortcuts app that appears in the share sheet, accepts a link, and opens this address in Safari:

```
https://YOUR-HOST/share?url=<the shared link, URL-encoded>
```

You land on the same prefilled dialog as on Android and tap Save. The address opens in your browser, so that browser needs to be signed in to your instance; whether iOS would hand it to an installed Home Screen app instead was not checked. The address itself works as described: it was loaded in a browser against a local server with the dialog prefilled and nothing saved until Save. Building the Shortcut, and its exact action names, were not run on an iPhone.

**3. A shortcut that saves straight through the API with an import token.** This opens no page: the Shortcut saves when it runs, which is the one case where nothing waits for a tap in the app. It only accepts full Instagram or TikTok post links. Create an import-only token in Settings, under Connect your browser, and copy it when it is shown once. Then the Shortcut makes three requests with "Get Contents of URL", each with the method POST, the header `Authorization: Bearer YOUR-TOKEN`, and a JSON body:

| Step | URL | JSON body |
| --- | --- | --- |
| 1. Start | `https://YOUR-HOST/api/extension/imports` | `{"platform":"instagram","source_account":"iphone","scope":"Share sheet"}` |
| 2. Send the link | `https://YOUR-HOST/api/extension/imports/RUN_ID/batches` | `{"batch_id":"UNIQUE","sequence":0,"items":[{"url":"THE-LINK"}]}` |
| 3. Finish | `https://YOUR-HOST/api/extension/imports/RUN_ID/finish` | `{"expected_batches":1,"coverage":"partial"}` |

`RUN_ID` is the `run_id` in the answer to step 1. `batch_id` is any text of up to 100 characters that is new each time, for example the current date and time down to the millisecond, such as `20261114101500123`. Use `"platform":"tiktok"` for a TikTok link.

These requests were replayed with a plain HTTP client, with no cookie, no `Origin` header and no CSRF token, against a local server, and are also covered by `tests/test_installable_app.py`:

- All three returned 200. The link then appeared in the library as an Instagram save with the source account `iphone`, its address cleaned to `https://www.instagram.com/p/<code>/` and tracking parameters removed. The same three requests with `"platform":"tiktok"` saved a full TikTok video link.
- Each share is one finished import run, listed under Import activity.
- A link whose site does not match `platform` is refused (400, "A batch item does not match the import platform."). That includes every ordinary web link: this path cannot save them. Use option 2 for those.
- A TikTok short link is refused (400) with the same advice as above.
- A missing, wrong or revoked token is refused (401).

Treat the token like a password. It cannot read your library or change your notes, but anyone holding it can add imports. It lives inside the Shortcut on your phone; revoke it in Settings if the phone is lost. Building this Shortcut in the Shortcuts app was not run on an iPhone.

## Limits

- **No service worker and no offline mode.** Installation and the Android share target do not need one, and the app is only useful with its live, signed-in API. A service worker would also have to be kept from caching anything private, would need to be cleared on sign-out, and would let an old copy of the buildless app files linger after a server update. That risk is not worth it here. If you add one later, review it against [SECURITY.md](../SECURITY.md) first.
- **One colour in the manifest.** The manifest can hold only one colour, so it holds the light background, and a launch screen built from the manifest cannot follow dark mode. Once the page has loaded it sets its theme colour from your light or dark theme (checked: the `theme-color` tag becomes `#1c231f` in dark mode).
- **The public demo is not installable** and does not advertise a share target. It has no backend.
- Little Archive is independent software. Instagram and TikTok are named only as places you can share from; there is no affiliation or endorsement.

## What changed in the phone layout

The save-a-link flow and the gallery were measured at 390 by 844 with touch emulation. Controls on touch screens and screens up to 500 px wide now have a hit area of at least 44 px (some through an invisible area around a smaller icon), form text is 16 px so iOS Safari does not zoom into a field, the Save row stays pinned when the dialog scrolls on a short screen, collection edit buttons are visible where there is no hover, and the keyboard-shortcut hint is hidden. Dropdowns are sized with `height` because the WebKit build tried here ignores `min-height` on them. The look is otherwise unchanged.

## What was and was not verified

Run, with the results recorded in the test files named:

- **Manifest and installability.** Chromium (Chrome for Testing build 1254 from Playwright 1.65.0) parsed the manifest with no errors or warnings and reported no installability errors on a loopback origin. The manifest, each declared icon, its type and its pixel size are checked in `web/install.test.mjs`, `tests/test_installable_app.py` and `tests/e2e/phone.spec.mjs`. The page loads with no Content Security Policy violation, and the policy is unchanged.
- **Share flow** (`tests/e2e/phone.spec.mjs`, `web/share.test.mjs`). Signed in and signed out, a share launch fills the dialog and sends no write request until Save; cancelling and saving both return the address to `/`; hostile values (`javascript:`, `data:`, credentials, markup, hidden and direction-changing characters, huge input) end up as inert text or are dropped; a TikTok short link is explained and refused by the real server.
- **Phone layout** (`tests/e2e/phone.spec.mjs`). In Chromium with touch emulation: no sideways scroll, every control in the gallery, the save dialog, the detail dialog and the navigation drawer is hit-testable over at least 44 px, form text is at least 16 px, and Save stays on screen on a 560 px tall viewport. As an exploratory check only, the same spec also passed on an older cached WebKit build (2336, not the build Playwright 1.65.0 pins), apart from the Chromium-only DevTools test; that run is what showed the dropdown sizing problem above.
- **Import-token requests** for the iPhone Shortcut, as described above.
- The public demo build still contains exactly the files in its allowlist and boots with 60 synthetic saves.

Not verified, and not claimed:

- Installing on a real Android phone, the share sheet listing, and what Instagram and TikTok actually send.
- Add to Home Screen on a real iPhone, Safari's behavior, and building either Shortcut.
- Firefox (the only cached build does not match this Playwright version), the Playwright-pinned WebKit build (not installed here), Safari on a device, other Android browsers, and an on-screen keyboard resizing the page.
- Any particular HTTPS or reverse-proxy setup.

## For contributors

The PNG icons are generated from `web/icon.svg` and committed. After changing the SVG, run `npm run build:icons` (it uses the Chromium that the browser tests install) and review `web/icons/` and `web/apple-touch-icon.png`. The maskable and Apple icons are full-bleed and opaque; the ordinary icons keep the rounded tile.
