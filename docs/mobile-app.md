# The iOS and Android app

The app is the existing Little Archive interface in a native shell ([Capacitor](https://capacitorjs.com)). It adds what a browser cannot do well on a phone: a first-launch choice of server, sign-in with the platform's secure storage, and an entry in the share sheet. Everything you see after signing in is `web/app.js`, unchanged, running against your own server or the hosted service.

**Status.** Development software, first version. Section [What was and was not verified](#what-was-and-was-not-verified) lists exactly what was run. No store listing, in-app purchase, push notification or on-device page reading exists yet; [what is not done](#what-is-not-done) says where each one attaches.

## What it does

1. **Choose a server on first launch.** *Little Archive account* (the hosted service) or *My own server* (you type its address). The app asks the server what it is (`GET /api/discovery`, which needs no credentials) before sending anything secret, and explains in words what went wrong if it cannot connect.
2. **Sign in.**
   - *Own server:* the owner password goes once to `POST /api/auth/devices` and is exchanged for a revocable `lad_…` device token. The password is never stored.
   - *Hosted account:* email and password against Supabase Auth's REST routes (sign-up, sign-in, refresh, sign-out), with the token refreshed before it expires.
   - The credential is kept in the iOS Keychain or an Android Keystore-backed store, never in `localStorage`.
3. **Use the full interface** against that server (browse, search, save, organize, import, export, settings).
4. **Save from the share sheet.** Android: *Little Archive* appears for text and links. iOS: a Share Extension. Both open the app on the ordinary save dialog with the link filled in. Nothing is saved until you tap Save, the same as the `/share` page of the web app ([phone guide](phone.md)).
5. **Account screen** (Settings, "This device"): sign out, switch server and, for a hosted account, delete the account.

## How it is built

```
web/                      the interface, unchanged in behaviour (app.js, utils.js, styles.css, icon, font)
web/transport.js          the transport: server address + bearer token + native HTTP; not imported by app.js
mobile/
  app.config.json         the hosted service's address and public Supabase values (the only place they are written)
  src/                    the app shell: boot.js, server-url, discovery, setup, supabase, credentials, store, share, files, ui, native.css
  scripts/build-web.mjs   builds mobile/www from ../web and bundles the shell with esbuild
  tests/                  node tests for the shell
  dev/stub_supabase.py    a local stand-in for Supabase Auth, for trying the hosted flow on this computer
  ios/, android/          the Capacitor projects (committed as Capacitor intends; Pods, build output and web assets are ignored)
```

`mobile/www` is generated, never committed. `npm run build:web` copies `app.js`, `utils.js`, `styles.css`, `icon.svg` and the font from `web/` byte for byte, writes a copy of `index.html` with a handful of changes (the shell script instead of `app.js`, a content security policy, safe-area viewport, no web manifest) and bundles the shell. A test (`mobile/tests/build.test.mjs`) checks that the interface files are identical and that nothing else changed.

**The page is loaded by the shell.** The app's `index.html` loads `native/boot.js`. It finds out which server this phone belongs to, signs in, builds the transport, sets `globalThis.__littleArchiveNative`, and then loads `/app.js` exactly as the browser would. This is the same pattern as the public demo's `demo.js`. In a browser the global does not exist and `web/app.js` takes its original path on every line that mentions it (same-origin `fetch`, the owner's cookie, the page's own address); `web/transport.test.mjs` asserts this.

What `app.js` does differently when the global exists:

| Where | In the app |
| --- | --- |
| `api()` and downloads | `native.fetch` instead of `fetch`: bearer token, native HTTP, only `/api/…` |
| thumbnails | fetched with the token and shown from a blob URL when the card scrolls near the screen (an `<img>` cannot send a header) |
| sign-in screen | `renderLogin` hands over to the shell, which clears the credential and reloads to its own sign-in |
| Settings | "This device" section; no browser-extension section for a hosted account (those routes do not exist there); the server address shown is the server's, not the page's |
| exports and backups | written to the app's cache and handed to the share sheet, then deleted at the next start |
| a link shared while the app is open | `native.onShare` opens the same save dialog |

## Why native HTTP, and no server change

The brief allowed either a tightly scoped CORS allowance on the server or native HTTP. The app uses **Capacitor's native HTTP client, called explicitly** (Capacitor's option to patch `fetch` is off), and the server is **unchanged**.

- A native request is not a cross-origin browser request. There is nothing to allow, so there is no CORS list to keep right, and `capacitor://localhost` and `https://localhost` never become trusted origins. `https://localhost` in particular is the origin of any app that serves from it on Android, and of a stray process on a developer's machine.
- The owner-password routes check `Origin` (`same_origin` in `server/app.py`) and answer 403 to a browser request from another origin. A CORS design would have had to loosen that check for `POST /api/auth/devices`, the most sensitive route. Native requests carry no `Origin` header, so it stays exactly as strict.
- It keeps the hosted guarantee that a cookie is never a credential, and keeps the self-hosted rule that a presented bearer token is judged by itself alone. The app never sends or accepts a cookie (see the cookie note below).
- The web view's own content security policy is `connect-src 'self'`: page script cannot reach any server directly. Only the shell's explicit calls to the native client can, and `web/transport.js` refuses any path that is not an absolute `/api/…` path, so a hostile value in server data (a thumbnail URL on another host, say) cannot carry the token elsewhere.
- Thumbnails need the same fetch-and-blob step under either design (`<img>` cannot send `Authorization`, and a token in a query string would end up in logs), so CORS would not have saved that work.

Costs of this choice: uploads and downloads cross the app's bridge as base64 (an import of 16 MiB is about 21 MiB of text; fine on a phone, and `@capacitor/file-transfer` is the seam if it ever is not), and the web view cannot be pointed at a server's own page.

## Building and running

Needs Node 22 or newer for the Capacitor tools (`mobile/package.json` says so). Use the same Node you run `npm` with.

```sh
cd mobile
npm ci
npm test                 # shell and transport tests
npm run sync             # build mobile/www and copy it into ios/ and android/
```

**iOS.** Xcode 26 or newer. The project uses Swift Package Manager (Capacitor 8's default), so CocoaPods is not used.

```sh
open ios/App/App.xcodeproj           # or:
xcodebuild -project ios/App/App.xcodeproj -scheme App -configuration Debug \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro Max' build
```

Run it from Xcode, or install the built `App.app` with `xcrun simctl install booted …` and `xcrun simctl launch booted app.littlearchive.mobile`. A simulator reaches a server on the same Mac at `http://localhost:PORT`.

**Android.** JDK 21 (Capacitor 8 needs it) and the Android SDK.

```sh
cd android
JAVA_HOME=/path/to/jdk21 ANDROID_HOME=~/Library/Android/sdk ./gradlew assembleDebug
# app/build/outputs/apk/debug/app-debug.apk
```

In an emulator, run `adb reverse tcp:PORT tcp:PORT` and use `http://localhost:PORT`. (`http://10.0.2.2:PORT` also reaches the computer and debug builds allow it, but the server then sees the host `10.0.2.2` and refuses it unless `LA_PUBLIC_URL` is set to that address; the app shows that explanation.) Debug builds allow plain http to `localhost`, `127.0.0.1` and `10.0.2.2`, nothing else.

### Trying it against a server on this computer

Self-hosted:

```sh
LA_ADMIN_PASSWORD='a password of 12 or more characters' LA_DATA_DIR=/tmp/la-data \
LA_PUBLIC_URL=http://localhost:8851 python -m uvicorn server.app:create_app --factory --port 8851
```

then choose *My own server* and enter `http://localhost:8851`. (`http` is accepted for this device only.)

Hosted, without touching a real Supabase project: start `mobile/dev/stub_supabase.py` and a hosted-mode server that trusts its signing secret (the commands are at the top of that file), and build the app with a development config:

```sh
LA_APP_CONFIG=/path/to/dev-config.json npm run sync     # hostedServerUrl http://localhost:8852, supabaseUrl http://127.0.0.1:8853
```

A development config goes through the same validation as the real one. Do not commit one, and rebuild with the real `app.config.json` for anything you keep.

## The hosted service's address and keys

`mobile/app.config.json` is the one place they are written:

```json
{
  "hostedServerUrl": "https://app.little-archive.example",
  "supabaseUrl": "https://kzrupzzoaxynlzlzxjwp.supabase.co",
  "supabasePublishableKey": "sb_publishable_…"
}
```

- **`hostedServerUrl` is a placeholder** (`.example` never resolves). Choosing *Little Archive account* says so ("Could not reach app.little-archive.example") until it is replaced.
- The publishable key and Supabase URL are public by design. **No other key or secret may be in the repository or the bundle.** `validateConfig` refuses unknown settings and anything shaped like a secret key, JWT or private key; `build-web.mjs` scans every file it writes for the same and for any `sb_…` key that is not the configured one; `mobile/tests/build.test.mjs` runs both.
- **The sign-in service is pinned.** The app sends an email and password only to `supabaseUrl` from this file, and only after `GET /api/discovery` shows that the server names the same Supabase URL. A server that names another one (a compromised or malicious server, or someone's own hosted deployment) is refused: "this app does not trust it, so it will not send your email or password there." Typing a hosted server's address under *My own server* works only when it passes this check.

## Security model

- **Where credentials live.** One record in the platform's secure storage through [`@aparajita/capacitor-secure-storage`](https://github.com/aparajita/capacitor-secure-storage) 8.0.1: the iOS Keychain (accessible only while the phone is unlocked, this device only, never iCloud Keychain) or Android Keystore AES-GCM keys with the data in app-private storage. The record holds the server, and the device token or the Supabase tokens. The owner password is never stored; neither is a Supabase password.
- **No fallback to `localStorage`.** That plugin falls back to `localStorage` in a browser. The shell refuses to start unless Capacitor reports a native platform, so a credential is never written there.
- **Fresh install means signed out.** iOS keeps Keychain items after the app is deleted. The shell keeps a flag in the web view's storage (deleted with the app) and clears the Keychain record when it is missing.
- **Android backup is off** (`allowBackup=false`), so a backup cannot copy the token off the phone.
- **Server addresses.** `https` always. Plain `http` only for this device (`localhost`, `127.x`, `[::1]`, `*.localhost`) and the Android emulator's `10.0.2.2`; a server on a home network without a certificate is refused with an explanation. iOS carries `NSAllowsLocalNetworking`; Android release builds forbid cleartext, debug builds allow it for those hosts only (`src/debug/res/xml/network_security_config.xml`).
- **Redirects are never followed** (the native client is told not to), so the token cannot be sent to a second address. A redirect is shown as an error.
- **Cookies.** The app never calls a cookie-issuing route, and the transport drops `Set-Cookie` from what it hands to the interface. Capacitor's native client does keep cookies a response sets in the platform's cookie store (nothing the app calls sets one). The server's rules are untouched: in hosted mode a cookie is never a credential, and in self-hosted mode a presented bearer token is judged alone.
- **The web view reaches nothing itself.** The app's content security policy is the server's, plus `blob:` for thumbnails, with `connect-src 'self'`, `frame-src 'none'` and no inline or eval script.
- **Shared text is untrusted.** It passes through the same `parseSharedContent` as a browser share (http and https links only, no credentials in the link, hidden and direction characters removed, length limits), only fills form fields, and never saves by itself. The native side caps its length and passes strings only. The Android plugin accepts `text/*` intents only; the iOS extension reads a URL or plain text attachment only.
- **Exports are temporary.** An export or backup is written to the app cache so the share sheet can take it, and removed the next time the app starts and before the next export.
- **Signing out** revokes the device token on the server (`POST /api/auth/logout`) or ends the Supabase session, then clears the phone whether or not the server could be reached.

## Share from other apps

**Android.** `MainActivity` has an `ACTION_SEND`, `text/plain` intent filter. `ShareInboxPlugin` (in `android/app/src/main/java/app/littlearchive/mobile`) keeps the latest share (from `onCreate` or `onNewIntent`) until the web side takes it, then clears the intent so a recreated activity cannot deliver it twice.

**iOS.** `ShareExtension` (its own target) receives a URL or text, stores `{title, text, url}` as JSON in the App Group `group.app.littlearchive.mobile`, and asks iOS to open `littlearchive://share`. The app's `ShareInboxPlugin` reads and clears it. The App Group carries the data, so a share is not lost if iOS declines to open the app from an extension; it is waiting the next time the app opens. Opening the app from an extension uses the responder chain, which is unofficial and best effort (see risks).

In both, the shell takes a pending share only when the interface can show it (on start, on resume, and on `appUrlOpen`), then `app.js` opens the ordinary save dialog.

## Changing the bundle id and other names

`app.littlearchive.mobile` is a placeholder. To change it, change all of:

- `mobile/capacitor.config.json` (`appId`)
- iOS: `PRODUCT_BUNDLE_IDENTIFIER` in the App target (`app.littlearchive.mobile`) and the ShareExtension target (`….ShareExtension`), `CFBundleURLName` in `ios/App/App/Info.plist`, the App Group `group.app.littlearchive.mobile` in `App.entitlements`, `ShareExtension.entitlements`, `ShareInboxPlugin.swift` and `ShareViewController.swift` (register the group in your Apple developer account too)
- Android: `namespace` and `applicationId` in `android/app/build.gradle`, the package of `MainActivity.java` and `ShareInboxPlugin.java` and their folder, `strings.xml`

The URL scheme `littlearchive` is in `Info.plist` and `ShareViewController.swift`. The icons come from `web/icon.svg` (the iOS 1024 px icon and the Android launcher images were rendered from it; render them again if the SVG changes).

## What was and was not verified

**Observed** (iPhone 17 Pro Max simulator, iOS 26.5, a self-hosted server and a hosted-mode server on this Mac):

- First launch, choice of server, discovery, a wrong owner password shown on the password field (so no `Origin` header problem on the password route), the right one exchanged for a device token, and the full interface loading from the bundled files.
- Saving a link and seeing it on the server; an authenticated thumbnail shown in the grid (blob URL); the library still open after the app was relaunched (Keychain).
- **Share extension, end to end:** in the simulator's Safari, Share, *Little Archive*; the app came to the front on the save dialog with the link filled in and a "Shared with Little Archive" note; the server had saved nothing.
- Settings "This device"; Sign out revoked the app's device token on the server (the other device token stayed) and returned to the sign-in screen for the same server. "Use a different server" on that screen returned to the first screen. A token revoked from the server side ended the session at the next request, with "Your session expired. Sign in to continue."
- **Hosted flow against local stand-ins** (not Supabase): the app discovered a hosted-mode server, checked the Supabase pin, created an account and signed in through `mobile/dev/stub_supabase.py`; the server created that account's empty library on the first authenticated request. The stand-in signs HS256 tokens that the server's verifier accepts. With 90-second tokens the library kept working past expiry, which means the refresh ran. "Delete my account" (typing DELETE) removed the account's directory on the hosted-mode server, signed the app out and said so; the stand-in's user was, as documented below, not removed. The hosted account screen hid the browser-extension section.
- 64 node tests (shell, transport, build) and the existing web, Python and demo checks.

**Android, in an emulator** (a Pixel 7, API 36, started read-only and headless): the debug APK (`./gradlew assembleDebug`, JDK 21) installed and launched; the first-launch screen showed; entering `http://10.0.2.2:PORT` produced the "does not recognise this address, set `LA_PUBLIC_URL`" explanation (the native client reached the server and the server refused the host, which is what a real server does), and with `adb reverse` and `http://localhost:PORT` the owner password was exchanged for a device token, kept in Android's secure storage, and the library loaded with its thumbnail. A text share with a subject and a link in the text, delivered to the running app as an `ACTION_SEND` intent, opened the save dialog with the link, title and note filled in and a "Shared with Little Archive" note; the server had saved nothing. The package manager lists the app among the `text/plain` share targets. The merged manifest has `allowBackup=false` and the network security config. Not exercised on Android: sign-out, hosted sign-in, a cold start from a share, the real share sheet's chooser.

**Not verified:**

- Android beyond the emulator run above: a physical device, TalkBack, and everything listed as not exercised there.
- Any physical iPhone or Android phone. The simulator and emulator have no real hardware-backed key protection, and Apple signing, the App Group on a device, TestFlight and Play Console were not touched.
- The real Supabase project and the placeholder hosted server (neither was contacted; no user was created in the real project).
- Export and backup download through the share sheet; picking an image for a local preview; large imports over the bridge; "Open original" leaving the app for the browser; the Switch server button in Settings (its code path is the sign-out one plus forgetting the server); the iOS share extension opening the app on a real device (it did in the simulator).
- Account deletion against a real Supabase project (see the gap below).
- VoiceOver, TalkBack and Dynamic Type; right-to-left layout on the first-launch screens.

## Open risks and decisions you may want to reverse

1. **Deleting an account does not delete the Supabase Auth user.** The app calls `POST /api/account/delete`, which removes the library, thumbnails, allowance and unlock records ([hosted mode](hosted-mode.md#account-deletion)), then signs out. A publishable key and a user's own token cannot delete an Auth user (that needs the service-role key). The email therefore stays registered, and the dialog says so. App Store guideline 5.1.1(v) expects deletion of the account itself. Closing this needs a server-side step with a key that must never be in the app: an Edge Function or a call from the Little Archive server with an operator-supplied service key. That is a server change this wave did not make.
2. **Opening the app from the iOS share extension is unofficial.** It uses the responder chain; Apple has changed this behaviour before and may again. The share is stored in the App Group either way, so the failure mode is "open the app yourself", not data loss, and the extension says so. Apple has accepted this pattern in many apps, but it is not documented API.
3. **Plain http is refused except for this device.** A home-network server needs https (the [phone guide](phone.md) already says so). This is the conservative choice for store review and for the owner password; allowing private-network http is a policy change in `server-url.js` and the iOS and Android network configs.
4. **Native HTTP does not follow redirects.** A server behind a proxy that redirects `http` to `https` must be entered with its `https` address; a redirect is reported as an error rather than followed.
5. **The privacy manifest and `ITSAppUsesNonExemptEncryption=false`** are starting points that match what the app does (an email address and what you save go to the server you chose; HTTPS and the Keychain only). They are your declarations to the stores: check them against your own answers before submitting.
6. **Thumbnail memory.** Up to 400 thumbnails are kept as blob URLs and the oldest are released. A very long scroll can release one that is still on screen, which then shows the text cover until it is reloaded.
7. **A token revoked on the server** shows up as a sign-out at the next request (observed), not at the moment of revocation. Hosted access tokens live as long as the Supabase project sets; the server never asks Supabase whether a session was ended ([hosted mode](hosted-mode.md#what-is-not-verified)).
8. **No password reset, no email-link deep links, no offline mode.**

## What is not done

Each of these has a place to attach; none is built.

- **In-app purchase and credit packs.** `GET /api/account` already returns `entitlements.unlocked` and the deep-read allowance for a hosted account, and `server/entitlements.py` documents `set_unlocked` as the seam for a verified-receipt webhook ([hosted mode](hosted-mode.md#unlock-and-deep-reads)). On the app side, a purchase plugin would go in `mobile/src/` and expose itself as another member of `globalThis.__littleArchiveNative`; `app.js` would show it in `accountSection()`. Self-hosters stay free: the self-hosted server's `OwnerEntitlements` is always unlocked, and the app shows no purchase UI for a self-hosted server.
- **On-device page reading or transcription.** The server routes already accept client-supplied page details and transcripts (`POST /api/items/{id}/page`, `…/transcript`, [understanding](understanding.md)). A native plugin that reads a shared page would call them through `native.fetch` after the save.
- **Push notifications** (for finished closer reads). Needs a token registration route on the server; the shell already has a place to register at sign-in (`boot.js`, after `whoAmI`).
- **Store listings, screenshots, signing, release builds,** and the account-deletion gap above.
- Larger uploads: `@capacitor/file-transfer` instead of base64 over the bridge.

## Tests

```sh
node --test web/*.test.mjs            # includes web/transport.test.mjs (no dependencies)
cd mobile && npm ci && npm test       # shell tests, transport tests and the build checks (Node 22+)
```

`web/transport.test.mjs` covers the address rules, the bearer token, refresh after a 401, redirects, aborts, thumbnails and that `app.js` still takes its original path in a browser. `mobile/tests` cover the server-address policy, discovery and the Supabase pin, the sign-in flows, the native HTTP adapter's handling of binary bodies and answers, secure-storage records and token refresh, the share inbox, config validation and the bundle's contents.
