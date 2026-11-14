# The iOS and Android app

The app is the React interface in `ui/` in a native shell ([Capacitor](https://capacitorjs.com)). It adds what a browser cannot do well on a phone: a first-launch choice of server, sign-in with the platform's secure storage, an entry in the share sheet and, for a hosted account, the App Store and Google Play purchase sheet for the one-time unlock. Everything you see after signing in is the interface in `ui/`, the same build the server serves to a browser, running against your own server or the hosted service. (The older buildless interface in `web/` is no longer loaded by the app.)

**Status.** Development software, first version. Section [What was and was not verified](#what-was-and-was-not-verified) lists exactly what was run. The purchase code has not met a real App Store or Google Play sandbox; [the purchase section](#the-one-time-purchase) says what that leaves open. No store listing, push notification or on-device page reading exists yet; [what is not done](#what-is-not-done) says where each one attaches.

## What it does

1. **Choose a server on first launch.** *Little Archive account* (the hosted service) or *My own server* (you type its address). The app asks the server what it is (`GET /api/discovery`, which needs no credentials) before sending anything secret, and explains in words what went wrong if it cannot connect.
2. **Sign in.**
   - *Own server:* the owner password goes once to `POST /api/auth/devices` and is exchanged for a revocable `lad_…` device token. The password is never stored.
   - *Hosted account:* email and password against Supabase Auth's REST routes (sign-up, sign-in, refresh, sign-out), with the token refreshed before it expires.
   - The credential is kept in the iOS Keychain or an Android Keystore-backed store, never in `localStorage`.
3. **Use the full interface** against that server (browse, search, save, organize, import, export, settings).
4. **Save from the share sheet.** Android: *Little Archive* appears for text and links. iOS: a Share Extension. Both open the app on the ordinary save dialog with the link filled in. Nothing is saved until you tap Save, the same as the `/share` page of the web app ([phone guide](phone.md)).
5. **Account screen** (Settings, "This device"): sign out, switch server and, for a hosted account, delete the account. The dialog says what the server did: the library and the sign-in are both gone (`auth_user_deleted: true`); the library is gone and the sign-in will follow (`auth_deletion: "pending"`, with the server's own sentence); or the library is gone but this service is not set up to remove sign-ins, so the email is still registered (`auth_deletion: "not_configured"`). The words are in `ui/src/features/dialogs/words.ts`.
6. **Unlock** (hosted accounts only): the store's purchase sheet for the one-time unlock, and Restore. See [the one-time purchase](#the-one-time-purchase).

## How it is built

```
ui/                       the React interface (Vite, React, TypeScript): the one interface for the browser, the demo and the app
ui/src/data/backend.ts    the three backends the interface can run on, and NativeBridge and PurchaseBridge, the two halves of the agreement with this app
web/transport.js          the transport: server address + bearer token + native HTTP
mobile/
  app.config.json         the hosted service's address and public Supabase values (the only place they are written)
  src/                    the app shell: boot, bridge, purchases, server-url, discovery, setup, supabase, credentials, store, share, files, ui, native.css
  scripts/build-web.mjs   builds ../ui and bundles it, with the shell, into mobile/www
  tests/                  node tests for the shell, the bridge, the purchase logic and the bundle
  dev/stub_supabase.py    a local stand-in for Supabase Auth, for trying the hosted flow on this computer
  ios/, android/          the Capacitor projects (committed as Capacitor intends; Pods, build output and web assets are ignored)
  ios/App/App/StorePurchasesPlugin.swift
  android/app/src/main/java/app/littlearchive/mobile/StorePurchasesPlugin.java
                          the two store plugins (see the purchase section)
```

`mobile/www` is generated, never committed. `npm run build:web` runs `vite build --manifest` in `ui/` (which needs `npm ci` there first), then copies into `mobile/www` only what the page `ui/dist/index.html` reaches, found through Vite's manifest, so the public demo that the same project also builds, its records and its photos, stay out of the app (the interface's entry can reach its demo and browser backends; the build leaves those two out, and a test checks that nothing in the bundle refers to a file that is missing). It writes a copy of `index.html` with two changes: a content security policy and the shell's script, `native/boot.js`, in place of the interface's chunk scripts. Then it bundles the shell with esbuild. `mobile/tests/build.test.mjs` tests this against a small fixture shaped like Vite's output, so the mobile-only CI job needs no interface dependencies, and, when `ui/node_modules` exists, against the real build.

**The page is loaded by the shell.** The app's `index.html` starts `native/boot.js`. It finds out which server this phone belongs to, signs in, builds the transport, sets `globalThis.__littleArchiveNative` (built in `src/bridge.js`), and only then imports the interface's entry, a hashed file that the build writes into the shell. The entry's `createBackend()` finds the global and runs the interface on the native backend (`ui/src/data/backends/native.ts`). In a browser the global does not exist and the interface takes the browser backend.

**The two ends of the bridge agree by test.** `NativeBridge` and `PurchaseBridge` are declared in `ui/src/data/backend.ts`. `mobile/tests/bridge.test.mjs` reads that file and checks that the object the shell builds has every required member, nothing the interface does not know, and the same purchase members, for a hosted and for a self-hosted account.

What the interface does differently on the native backend:

| Where | In the app |
| --- | --- |
| every `/api` call and download | `native.fetch` instead of the page's `fetch`: bearer token, native HTTP, only `/api/…`; the interface never sees the token |
| thumbnails | `native.localAsset` recognises a stored thumbnail, and `native.attachImage` fetches it with the token and shows it from a blob URL when the card scrolls near the screen (an `<img>` cannot send a header) |
| sign-in | there is none in the interface: `native.signedOut` hands over to the shell, which clears the credential and reloads to its own sign-in screens |
| Settings | the "This device" section (email, sign out, switch server, delete account) comes from `native.account`; the server address shown is the server's, not the page's |
| exports and backups | `native.saveFile` writes the file to the app's cache and hands it to the share sheet, then it is deleted at the next start |
| a link shared while the app is open | `native.onShare` opens the same save dialog |
| the unlock | `native.purchases` (hosted accounts only) |

**Styling.** The interface's own stylesheet is loaded first, then `src/native.css`, which uses its design tokens (`--paper`, `--ink`, `--sage`, … in both themes) for the screens that run before the interface (choosing a server, signing in) so nothing changes style at sign-in, and supplies the safe-area values the interface reads. It also gives the interface's top bar room for the notch: the bar is `h-16` with `padding-top: var(--safe-top)`, which leaves about 5px for its content on a phone with a dynamic island. The right fix is one line in `ui/src/features/shell/shell.tsx` (`h-[calc(4rem+var(--safe-top))]`); `native.css` compensates until then.

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
(cd ui && npm ci)        # the interface's dependencies, needed to build the bundle
cd mobile
npm ci
npm test                 # shell, bridge, purchase, transport and bundle tests
npm run sync             # build ../ui, make mobile/www, and copy it into ios/ and android/
```

**iOS.** Xcode 26 or newer. The project uses Swift Package Manager (Capacitor 8's default), so CocoaPods is not used.

```sh
open ios/App/App.xcodeproj           # or:
xcodebuild -project ios/App/App.xcodeproj -scheme App -configuration Debug \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro Max' build
```

Run it from Xcode, or install the built `App.app` with `xcrun simctl install booted …` and `xcrun simctl launch booted app.littlearchive.mobile`. A simulator reaches a server on the same Mac at `http://localhost:PORT`. A launch from the command line has no store: the unlock screen offers its buttons but the App Store has no product, and a tap says so. To try a purchase in the simulator, run from Xcode (see [trying a purchase](#trying-a-purchase-without-real-money)).

**Android.** JDK 21 (Capacitor 8 needs it) and the Android SDK.

```sh
cd android
JAVA_HOME=/path/to/jdk21 ANDROID_HOME=~/Library/Android/sdk ./gradlew assembleDebug
# app/build/outputs/apk/debug/app-debug.apk
```

In an emulator, run `adb reverse tcp:PORT tcp:PORT` and use `http://localhost:PORT`. (`http://10.0.2.2:PORT` also reaches the computer, but only a development bundle accepts that address: build the web bundle with `LA_DEBUG_BUILD=1 npm run sync`. The server then sees the host `10.0.2.2` and refuses it unless `LA_PUBLIC_URL` is set to that address; the app shows that explanation. Never ship a bundle built that way. A release bundle refuses the address as "not encrypted", like any other address on a network.) The Android debug build type allows plain http to `localhost`, `127.0.0.1` and `10.0.2.2`, nothing else; release builds allow no cleartext traffic to any host.

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
- **Server addresses.** `https` always. Plain `http` only for this device (`localhost`, `127.x`, `[::1]`, `*.localhost`), and, in a bundle built with `LA_DEBUG_BUILD=1` only, the Android emulator's `10.0.2.2` (a build-time constant, not something a page, a setting or a stored value can switch on); a server on a home network without a certificate is refused with an explanation. iOS carries `NSAllowsLocalNetworking`; Android release builds forbid cleartext to every host, debug builds allow it for `localhost`, `127.0.0.1` and `10.0.2.2` only (`src/debug/res/xml/network_security_config.xml`). `mobile/tests/android-network.test.mjs` checks that the two Android configs and the address check agree, and `tests/build.test.mjs` that a release bundle holds no trace of the emulator host. A loopback `http` address still passes the app's own check in a release build while Android's release config blocks it, so it fails at the platform rather than being offered; that is the fail-closed side of the difference.
- **Redirects are never followed** (the native client is told not to), so the token cannot be sent to a second address. A redirect is shown as an error.
- **Cookies.** The app never calls a cookie-issuing route, and the transport drops `Set-Cookie` from what it hands to the interface. Capacitor's native client does keep cookies a response sets in the platform's cookie store (nothing the app calls sets one). The server's rules are untouched: in hosted mode a cookie is never a credential, and in self-hosted mode a presented bearer token is judged alone.
- **The web view reaches nothing itself.** The app's content security policy is the server's, plus `blob:` for thumbnails, with `connect-src 'self'`, `frame-src 'none'` and no inline or eval script.
- **Shared text is untrusted.** It passes through the same `parseSharedContent` as a browser share (http and https links only, no credentials in the link, hidden and direction characters removed, length limits), only fills form fields, and never saves by itself. The native side caps its length and passes strings only. The Android plugin accepts `text/*` intents only; the iOS extension reads a URL or plain text attachment only.
- **Exports are temporary.** An export or backup is written to the app cache so the share sheet can take it, and removed the next time the app starts and before the next export.
- **Signing out** revokes the device token on the server (`POST /api/auth/logout`) or ends the Supabase session, then clears the phone whether or not the server could be reached.

## The one-time purchase

One product, bought once, opens recipe cards, places, ask your archive and the larger allowances of a hosted account. It is a **non-consumable on the App Store and a one-time product on Google Play, both with the product id `unlock_full`**. No subscriptions, no ads, no third-party purchase service, no credit packs. The server is the only thing that unlocks an account: it checks the store's proof with the store ([hosted mode](hosted-mode.md#purchases); the answers are in `API_CONTRACT.md`). The app only carries the proof.

**A self-hosted server has no purchase at all.** Its bridge has no `purchases` (`mobile/src/bridge.js` refuses to build one), the unlock screen says everything is open and there is nothing to buy (`unlockView` in `ui/src/features/unlock/purchase.ts`), and nothing in the app asks the store anything. The iOS plugin is registered at launch like every plugin and, as StoreKit asks of every app, listens to `Transaction.updates` from the start; with no purchases on the page there is nobody to tell.

### The plugin: custom, in the app, one per platform

`StorePurchasesPlugin.swift` (190 lines, StoreKit 2) and `StorePurchasesPlugin.java` (312 lines, Play Billing Library 9.1.0) sit beside the share plugin, as app code, not packages. `mobile/src/purchases.js` (199 lines, with its tests) is the only code that decides anything. **No new package is added to `package.json`.**

Why not a maintained plugin: the candidate that supports Capacitor 8 and Swift Package Manager, `@capgo/native-purchases` 8.9.16, was downloaded and read. It does return the StoreKit 2 `jwsRepresentation` and the Play `purchaseToken`, declares `capacitor-swift-pm` `from: "8.0.0"` in a `Package.swift`, and would have worked. It was not chosen because it is a subscription-oriented plugin of several thousand lines (offers, introductory eligibility, subscription management, a manifest that looks for installed SDK files while it resolves) of which the unlock needs a small part; because its defaults finish the Apple transaction and acknowledge the Google purchase on their own before the server has seen the proof (both can be switched off, but the order is the whole point); and because it brings its own `Transaction.updates` listener, a second thing to keep out of the way. A purchase path of a few hundred lines on Apple's and Google's own libraries is the smaller thing to read, test and trust. RevenueCat and similar services were excluded by the brief.

What was verified for the choice: the StoreKit symbols used (`VerificationResult<Transaction>.jwsRepresentation`, `Transaction.unfinished`, `.currentEntitlements`, `.updates`, `finish()`, `Product.purchase(options:)` with `.appAccountToken`, `purchase(confirmIn:)`, `AppStore.sync()`) are in the iOS 26.5 SDK's StoreKit interface, and the plugin compiles for the simulator; the Billing Library 9.1.0 calls used (`enablePendingPurchases(PendingPurchasesParams)`, `enableAutoServiceReconnection`, `queryProductDetailsAsync` with `QueryProductDetailsResult`, `queryPurchasesAsync(QueryPurchasesParams)`, `setObfuscatedAccountId`, `acknowledgePurchase`, `AccountIdentifiers`) were listed with `javap` from the library's AAR, and the plugin compiles in `./gradlew assembleDebug`. The deployment target is iOS 15 and the minimum SDK Android 24.

### What happens

1. **The price.** `product()` loads `unlock_full` and returns the store's own localized price. On the App Store a product that is not a non-consumable is never sold. With no price the screen shows none.
2. **Buying.** The unlock screen asks the server who this account is (`GET /api/account`), then `buy({ accountId })`. The purchase is bound to the account: Apple's `appAccountToken` is the account's UUID, Google's obfuscated account id is the lowercase hex SHA-256 of it (`accountTag` in `purchases.js`).
3. **The proof goes to the server, from the interface.** The StoreKit JWS to `POST /api/purchases/apple`, or `{product_id, purchase_token}` to `POST /api/purchases/google`.
4. **Only then is the store told.** On `200` the Apple transaction is finished. For Google the server acknowledges the purchase itself when it can and says so (`acknowledged`); the app acknowledges only when that is `false`, never both. A `400` or `409` `purchase_*` refusal is final: the Apple transaction is finished so it is not offered at every start; a Google purchase is left unacknowledged (Google refunds it after three days). Anything else, such as a network failure, `503`, `429`, leaves the purchase open.

| Case | What the person sees, and what stays |
| --- | --- |
| closed the sheet | "No purchase was made." Nothing is sent. |
| Ask to Buy, or a Play payment still pending | "Your purchase is waiting for the store." Nothing is sent. When it completes, `Transaction.updates` (Apple) or the purchases-updated callback (Google) wakes the app, which sends it; if the app was closed, the next start does. The interface refreshes itself and says so. |
| Google answers `202` (the payment is not complete) | "The store is still completing the payment", with Check again. The next start sends it again. |
| already owned | Apple returns the existing transaction; Google answers `ITEM_ALREADY_OWNED` and the plugin hands over the purchase it holds. Both go to the server as a restore (`restored: true`). |
| the phone was offline, or the server unreachable, after paying | The transaction stays unfinished (Google: unacknowledged). It is sent again at the next start, when the app comes back to the front, and on any update from the store. |
| Restore | Apple: `AppStore.sync()` (which may ask for the Apple ID), then every current entitlement. Google: what Play holds. Each is sent; the first the server accepts wins. |
| the server refuses | The server's reason, in words: another account holds it, the store took it back, it is not this app's unlock, the wrong environment. |

**A purchase is never given to a different account by the app.** The background pass (start, resume, store updates) sends only a purchase bound to the signed-in account, or bound to none, because the server gives a purchase to the first account that presents it. Restore, pressed by the person, sends everything the store account holds.

### What store setup is still yours

None of this was done, and nothing here touched a store console. In order:

**App Store Connect**

1. Accept the Paid Applications agreement and fill in tax and banking (Business).
2. Create the app record for the bundle id `app.littlearchive.mobile` (or yours, see below).
3. Monetization, In-App Purchases: create a **Non-Consumable** with product id exactly `unlock_full`, a reference name, a price, a display name and description, and the review screenshot. It is submitted with the first app version.
4. The In-App Purchase capability is recorded in the Xcode project (it adds no entitlement key); with automatic signing Xcode enables it on the App ID. With manual signing, enable it on the App ID in the developer portal.
5. Users and Access, Sandbox: create one or more sandbox testers with email addresses that are not real Apple IDs.
6. On the server: `LA_APPLE_BUNDLE_ID`, `LA_APPLE_PRODUCT_ID=unlock_full`, `LA_APPLE_APP_ID`, and `LA_APPLE_ENVIRONMENTS=Production,Sandbox` while testing and in review (the app is sold only through `Production` otherwise). Set the App Store Server Notifications V2 URL to `https://YOUR-SERVER/api/purchases/apple/notifications` for Production and Sandbox.
7. App Privacy: the manifest in the app (`PrivacyInfo.xcprivacy`) now declares purchase history, linked to the account and used for app functionality, beside the email address and the content a person saves. Give the same answers in App Store Connect.

**Play Console**

1. Create the app for the package `app.littlearchive.mobile` (or yours) and upload a signed build to an internal testing track: products can be set up and tested only once a build with the billing permission has been uploaded.
2. Monetize, Products, One-time products: create `unlock_full`, active, with a price.
3. Settings, License testing: add the testers' Google accounts, and add them to the testing track.
4. Give the server a service account: link a Google Cloud project under API access, create the service account, invite it in the Play Console with permission to view financial data and manage orders for this app, and put its key file outside the repository at `LA_GOOGLE_SERVICE_ACCOUNT_FILE`. Set `LA_GOOGLE_PACKAGE_NAME` and `LA_GOOGLE_PRODUCT_ID=unlock_full`; `LA_GOOGLE_ALLOW_TEST_PURCHASES=true` only while testing with licence testers.
5. For refunds: Monetization setup, real-time developer notifications to a Pub/Sub topic with a push subscription to `https://YOUR-SERVER/api/purchases/google/notifications`, and `LA_GOOGLE_RTDN_AUDIENCE` and `LA_GOOGLE_RTDN_SERVICE_ACCOUNT`.
6. Data safety: declare purchase history, as above.

### Trying a purchase without real money

- **iOS, local test file.** `mobile/ios/App/LittleArchive.storekit` defines `unlock_full` as a non-consumable at 4.99 (test data; the price is not the real one). The shared scheme (`App.xcodeproj/xcshareddata/xcschemes/App.xcscheme`) names it in its **Run** action only, so running from Xcode on a simulator opens a working App Store with that product. Profile, Analyze and Archive (the release build) do not name it, and the file is a member of no target, so it is not in the app. (The path in the scheme is relative to the project folder, as in other projects' schemes; opening the scheme in Xcode once confirms it finds the file.) A launch from `xcrun simctl` does not apply a scheme's test file. Purchases made this way are signed with a local certificate, not Apple's, so a real server refuses them (`purchase_invalid`); they exercise the sheet, the plugin and the interface, not the server's verification.
- **iOS, sandbox.** Sign in to the sandbox tester under Settings, Developer on a real device with a TestFlight or development build; the server then needs `LA_APPLE_ENVIRONMENTS=Production,Sandbox`.
- **Android.** Install a build from the internal testing track on a device signed in with a licence tester account. Test cards are offered in the Play sheet.

## Share from other apps

**Android.** `MainActivity` has an `ACTION_SEND`, `text/plain` intent filter. `ShareInboxPlugin` (in `android/app/src/main/java/app/littlearchive/mobile`) keeps the latest share (from `onCreate` or `onNewIntent`) until the web side takes it, then clears the intent so a recreated activity cannot deliver it twice.

**iOS.** `ShareExtension` (its own target) receives a URL or text, stores `{title, text, url}` as JSON in the App Group `group.app.littlearchive.mobile`, and asks iOS to open `littlearchive://share`. The app's `ShareInboxPlugin` reads and clears it. The App Group carries the data, so a share is not lost if iOS declines to open the app from an extension; it is waiting the next time the app opens. Opening the app from an extension uses the responder chain, which is unofficial and best effort (see risks).

In both, the shell takes a pending share only when the interface can show it (on start, on resume, and on `appUrlOpen`), then the interface opens the ordinary save dialog.

## Changing the bundle id and other names

`app.littlearchive.mobile` is a placeholder. To change it, change all of:

- `mobile/capacitor.config.json` (`appId`)
- iOS: `PRODUCT_BUNDLE_IDENTIFIER` in the App target (`app.littlearchive.mobile`) and the ShareExtension target (`….ShareExtension`), `CFBundleURLName` in `ios/App/App/Info.plist`, the App Group `group.app.littlearchive.mobile` in `App.entitlements`, `ShareExtension.entitlements`, `ShareInboxPlugin.swift` and `ShareViewController.swift` (register the group in your Apple developer account too)
- Android: `namespace` and `applicationId` in `android/app/build.gradle`, the package of `MainActivity.java`, `ShareInboxPlugin.java` and `StorePurchasesPlugin.java` and their folder, `strings.xml`
- The stores and the server: the app record and the product in App Store Connect and Play Console, and the server's `LA_APPLE_BUNDLE_ID` and `LA_GOOGLE_PACKAGE_NAME` ([the purchase section](#what-store-setup-is-still-yours)). The product id `unlock_full` is in `mobile/src/purchases.js`, `StorePurchasesPlugin.swift`, `StorePurchasesPlugin.java`, `LittleArchive.storekit` and the server's `LA_APPLE_PRODUCT_ID` and `LA_GOOGLE_PRODUCT_ID`.

The URL scheme `littlearchive` is in `Info.plist` and `ShareViewController.swift`. The icons come from `web/icon.svg` (the iOS 1024 px icon and the Android launcher images were rendered from it; render them again if the SVG changes).

## What was and was not verified

**Observed with the React interface** (iPhone 17 Pro Max simulator, iOS 26.5, a throwaway self-hosted server on a loopback port, and a hosted-mode server with the Supabase stand-in):

- The bundle built from `ui/` runs in the app: the first-launch screens in the interface's own paper, ink and sage; own-server sign-in with the owner password; the library rendering as a wall of cards; opening a save (the full-screen detail); saving a link from the Save dialog, which the server then listed; an authenticated thumbnail on a card (fetched with the token, shown from a blob URL); Settings, "This device" with the server address, Sign out and Switch server (Switch server confirmed and returned to the first screen); and the sign-in surviving a reinstall of the app over itself.
- **A self-hosted account** shows "Everything is open. There is nothing to buy." on the unlock screen, with no purchase button.
- **A hosted account** (created through the stand-in) shows "Signed in to a Little Archive account as <email>", the Delete my account entry, and the unlock screen's "Unlock once" and "Restore a purchase". With no store product in that launch, tapping "Unlock once" asked the server who the account was and then showed the Swift plugin's own sentence, "The unlock is not available from the App Store…". So the interface, `purchases.js`, Capacitor and `StorePurchasesPlugin.swift` are wired end to end as far as StoreKit.
- Screenshots of these are in the working notes of the change, not in the repository.
- The top bar was found covered by the page on a phone with a dynamic island (see Styling above), and fixed in `native.css`.

**Not run against the React interface**: the share extension and sign-out of a hosted account; they use code that did not change. Where this page says "observed" below, it is from the earlier interface (`web/app.js`) and the same shell, which has not changed since.

**Observed earlier, with the buildless interface** (iPhone 17 Pro Max simulator, iOS 26.5, a self-hosted server and a hosted-mode server on this Mac):

- First launch, choice of server, discovery, a wrong owner password shown on the password field (so no `Origin` header problem on the password route), the right one exchanged for a device token, and the full interface loading from the bundled files.
- Saving a link and seeing it on the server; an authenticated thumbnail shown in the grid (blob URL); the library still open after the app was relaunched (Keychain).
- **Share extension, end to end:** in the simulator's Safari, Share, *Little Archive*; the app came to the front on the save dialog with the link filled in and a "Shared with Little Archive" note; the server had saved nothing.
- Settings "This device"; Sign out revoked the app's device token on the server (the other device token stayed) and returned to the sign-in screen for the same server. "Use a different server" on that screen returned to the first screen. A token revoked from the server side ended the session at the next request, with "Your session expired. Sign in to continue."
- **Hosted flow against local stand-ins** (not Supabase): the app discovered a hosted-mode server, checked the Supabase pin, created an account and signed in through `mobile/dev/stub_supabase.py`; the server created that account's empty library on the first authenticated request. The stand-in signs HS256 tokens that the server's verifier accepts. With 90-second tokens the library kept working past expiry, which means the refresh ran. "Delete my account" (typing DELETE) removed the account's directory on the hosted-mode server, signed the app out and said so; the stand-in's user was not removed (that run was made before the server deleted sign-ins; it now does, with the secret key, and the stand-in accepts that call). The hosted account screen hid the browser-extension section.
- 64 node tests (shell, transport, build) and the existing web, Python and demo checks, at that time. The current counts are under [Tests](#tests).

**Android, in an emulator** (a Pixel 7, API 36, started read-only and headless): the debug APK (`./gradlew assembleDebug`, JDK 21, with a web bundle built before 10.0.2.2 became a development-bundle-only address) installed and launched; the first-launch screen showed; entering `http://10.0.2.2:PORT` produced the "does not recognise this address, set `LA_PUBLIC_URL`" explanation (the native client reached the server and the server refused the host, which is what a real server does), and with `adb reverse` and `http://localhost:PORT` the owner password was exchanged for a device token, kept in Android's secure storage, and the library loaded with its thumbnail. A text share with a subject and a link in the text, delivered to the running app as an `ACTION_SEND` intent, opened the save dialog with the link, title and note filled in and a "Shared with Little Archive" note; the server had saved nothing. The package manager lists the app among the `text/plain` share targets. The merged manifest has `allowBackup=false` and the network security config. Not exercised on Android: sign-out, hosted sign-in, a cold start from a share, the real share sheet's chooser.

**Not verified:**

- **Any real purchase.** No App Store sandbox purchase, no TestFlight, no Google Play licence tester, no Apple certificate chain or Play Developer API answer. Nothing ran the Xcode StoreKit test file (a command-line launch does not apply it), so the buy, pending, cancel, restore and refund paths of the two plugins have not run against any store, only against test doubles in `mobile/tests/purchases.test.mjs`. The Android plugin was compiled (`assembleDebug`) and its merged manifest inspected, and not run. The first real sandbox purchase on each platform is the check that remains.
- Which `identifier` path in the shared scheme Xcode resolves to the StoreKit file was taken from other projects' schemes, not from running Xcode's own editor.
- Android beyond the emulator run above: a physical device, TalkBack, and everything listed as not exercised there.
- Any physical iPhone or Android phone. The simulator and emulator have no real hardware-backed key protection, and Apple signing, the App Group on a device, TestFlight and Play Console were not touched.
- The real Supabase project and the placeholder hosted server (neither was contacted; no user was created in the real project).
- Export and backup download through the share sheet; picking an image for a local preview; large imports over the bridge; "Open original" leaving the app for the browser; the Switch server button in Settings (its code path is the sign-out one plus forgetting the server); the iOS share extension opening the app on a real device (it did in the simulator).
- Account deletion against a real Supabase project (see the gap below).
- VoiceOver, TalkBack and Dynamic Type; right-to-left layout on the first-launch screens.

## Open risks and decisions you may want to reverse

1. **Account deletion deletes the Supabase Auth user, on the server, and the dialog now says which of three things happened.** `POST /api/account/delete` removes the library and unlock records and then the sign-in with the operator's secret key ([hosted mode](hosted-mode.md#account-deletion)). The key lives only on the server; a publishable key and a user's own token cannot delete an Auth user. The answer says which happened and the interface (`ui/src/features/dialogs/words.ts`, with tests) reads it: `auth_user_deleted: true` ("your library and your sign-in are both gone"), `auth_deletion: "pending"` (the server keeps retrying; the server's own sentence is shown), or `auth_deletion: "not_configured"` (a server run without the key on purpose; the dialog says the email is still registered with its provider and to ask whoever runs the service). The old line that said the email stays registered is gone from the app. Checked only against a stand-in for Supabase. The old buildless interface (`web/app.js`) still has that line in its own copy of the dialog; the app no longer loads it.
2. **Opening the app from the iOS share extension is unofficial.** It uses the responder chain; Apple has changed this behaviour before and may again. The share is stored in the App Group either way, so the failure mode is "open the app yourself", not data loss, and the extension says so. Apple has accepted this pattern in many apps, but it is not documented API.
3. **Plain http is refused except for this device.** A home-network server needs https (the [phone guide](phone.md) already says so). This is the conservative choice for store review and for the owner password; allowing private-network http is a policy change in `server-url.js` and the iOS and Android network configs.
4. **Native HTTP does not follow redirects.** A server behind a proxy that redirects `http` to `https` must be entered with its `https` address; a redirect is reported as an error rather than followed.
5. **The privacy manifest and `ITSAppUsesNonExemptEncryption=false`** are starting points that match what the app does (an email address, what you save and, once a hosted account buys the unlock, the App Store's signed receipt for it go to the server you chose; HTTPS and the Keychain only). The manifest declares email, other user content and purchase history, all linked to the account, for app functionality, none for tracking. StoreKit and the Billing Library need no usage-description string and, on iOS, no entitlement key, so `Info.plist` and the entitlements did not change. They are your declarations to the stores: check them against your own answers before submitting.
6. **Thumbnail memory.** Up to 400 thumbnails are kept as blob URLs and the oldest are released. A very long scroll can release one that is still on screen, which then shows the text cover until it is reloaded.
7. **A token revoked on the server** shows up as a sign-out at the next request (observed), not at the moment of revocation. Hosted access tokens live as long as the Supabase project sets; the server never asks Supabase whether a session was ended ([hosted mode](hosted-mode.md#what-is-not-verified)).
8. **No password reset, no email-link deep links, no offline mode.**

## What is not done

Each of these has a place to attach; none is built.

- **A real purchase, end to end.** The app side is built ([the one-time purchase](#the-one-time-purchase)) and so is the server side ([hosted mode](hosted-mode.md#purchases)); they have not met a real store. What remains is yours: the products and testers in the two consoles, the server's store settings, and a first sandbox purchase on each platform ([the steps](#what-store-setup-is-still-yours)). Self-hosters stay free: the self-hosted server's `OwnerEntitlements` is always unlocked, the purchase routes answer `404`, and the app shows no purchase UI for a self-hosted server. No credit packs.
- **On-device page reading or transcription.** The server routes already accept client-supplied page details and transcripts (`POST /api/items/{id}/page`, `…/transcript`, [understanding](understanding.md)). A native plugin that reads a shared page would call them through `native.fetch` after the save.
- **Push notifications** (for finished closer reads). Needs a token registration route on the server; the shell already has a place to register at sign-in (`boot.js`, after `whoAmI`).
- **Store listings, screenshots, signing and release builds.**
- Larger uploads: `@capacitor/file-transfer` instead of base64 over the bridge.

## Tests

```sh
node --test web/*.test.mjs            # includes web/transport.test.mjs (no dependencies)
cd mobile && npm ci && npm test       # shell, bridge, purchase, transport and bundle tests (Node 22+)
cd ui && npm ci && npm test           # the interface's own tests, including the purchase rules
```

When this was written: `npm run test:mobile` 95 tests (the mobile job in CI, which installs nothing in `ui/`, skips the one that builds the real interface), `node --test web/*.test.mjs` 59, `ui` 557 across 35 files, with `npm run typecheck` and `npm run lint` clean.

`web/transport.test.mjs` covers the address rules, the bearer token, refresh after a 401, redirects, aborts, thumbnails and that `web/app.js` still takes its original path in a browser (the app no longer loads that file, but the browser version still does). `mobile/tests` cover the server-address policy, discovery and the Supabase pin, the sign-in flows, the native HTTP adapter's handling of binary bodies and answers, secure-storage records and token refresh, the share inbox, config validation, the bundle's contents (against a fixture shaped like Vite's output, and against the real interface when it is installed), the bridge (read against `ui/src/data/backend.ts`) and the purchase driver. `tests/purchases.test.mjs` uses a scripted plugin and a scripted server and covers: the account tags (Apple's UUID, Google's SHA-256), finishing only after the server's answer, Google acknowledgement only when the server says it did not, a final refusal finishing Apple and not Google, offline and `503` and `429` leaving a purchase open, a purchase for another account left alone, Ask to Buy and pending purchases, restore, passes not overlapping, and a proof in the interface's hands being left alone. The tests were checked by breaking the code in thirteen ways, one at a time; each was caught. `ui/src/features/unlock/settled.test.ts` covers the same order from the interface's side.
