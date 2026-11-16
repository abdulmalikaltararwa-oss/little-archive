# Notes for the store reviewers

Two things are here: the note to paste for Apple's and Google's reviewers, and the state the server must be in on
the day of review. Fill every `[owner to fill]` before pasting. Do not put the demo password in this file or in the
repository; type it into the console only.

## Demo account

| Field | Value |
| --- | --- |
| Sign-in method | Email and password (on the "Little Archive account" screen, under the Continue with buttons) |
| Email | `[owner to fill]` |
| Password | `[owner to fill]` |
| State of the account | Email already confirmed. Not unlocked, so the reviewer can see the purchase. Holds about twenty made-up saves, including one recipe video and one post that names a place. |
| Second account, already unlocked (optional) | `[owner to fill]`, for a reviewer who wants to see the paid features without buying. An operator can unlock an account by hand on the server (`set_unlocked` in `server/entitlements.py`). |

Use made-up content only. Do not use a real person's account.

## Note for Apple (App Review Information, Notes, 4000)

The text below is 2,632 of the 4,000 characters Apple allows.

```text
WHAT THE APP IS
Little Archive is a personal library for posts, videos and links a person has saved. They save a link with the share sheet or import an export file, then search and organise their saves. Nothing is shared with other users.

SIGNING IN
On first launch choose "Little Archive account", then sign in with the demo email and password in the form under the "Continue with" buttons. Sign in with Apple is also offered.

"MY OWN SERVER"
The other choice on the first screen is for people who run the open-source Little Archive server themselves. The app then talks only to that server, and there is no account with us and nothing to buy. You do not need it for review. Without a server address it has nothing to connect to.

THE IN-APP PURCHASE
One non-consumable, product id unlock_full. Open a locked feature (Recipes, Places or Ask) and tap "About the unlock", or open Settings and tap "About the one-time unlock". The unlock screen has "Unlock once" and "Restore a purchase". The purchase is checked on our server and unlocks the signed-in account. Restore is the second button on the same screen. Our server accepts sandbox purchases during review.

DELETING THE ACCOUNT
Settings, section "This device", "Delete my account…", type DELETE, then "Delete my account". This removes the library from our server and then the sign-in. The result screen says what was removed. Please use a spare account if you test this, since the demo account will stop working.

THE SHARE EXTENSION
In Safari or another app, tap Share and choose Little Archive. The app opens on its save screen with the link filled in. Nothing is saved until the person taps Save. The extension reads only the shared link or text.

AI FEATURES AND PERMISSION
AI features are optional and start only when the person asks: suggestions for titles and folders, a "closer read" that makes a transcript of a saved video's speech, recipe cards, places, and "Ask your archive". The first time, the app shows a dialog that names the services that will receive the text (Google Gemini, and Groq for transcripts) with "Allow" and "Not now". Nothing is sent before "Allow". What is sent is the text of the chosen saves (title, creator, caption, transcript), for a closer read the public post's media file, and for Ask the typed question and short passages from matching saves. The person's notes are not sent. This is described in the privacy policy.

CONTENT
Everything in the demo account is made up for review. The app shows only what its owner saved. It has no feed, no public content and no way to contact other users.

CONTACT
[owner to fill: name, phone, email]
```

## Note for Google (App access instructions, and the note to the reviewer)

Google's limit for this box was not looked up for this file (**unverified**). The text below is 1,121 characters;
if the console refuses it, cut the sharing and AI paragraphs first.

```text
Little Archive is a personal library for saved posts, videos and links. Nothing is shared with other users.

To sign in: on first launch choose "Little Archive account", then use the demo email and password in the form under "Continue with Google". No two-step code is needed.

"My own server" on the first screen is for people who run the open-source server themselves; it is not needed for review.

In-app product: one one-time product, id unlock_full. Open Recipes, Places or Ask and tap "About the unlock", or Settings, "About the one-time unlock", to reach the unlock screen ("Unlock once", "Restore a purchase").

Delete account: Settings, "This device", "Delete my account…", type DELETE. The same can be requested on the web page given as the account deletion URL.

Sharing: share a link from any app to Little Archive; the app opens its save screen with the link filled in and saves only when the person taps Save.

AI features are optional. Before the first one the app asks permission ("Allow" / "Not now") and names the services that receive the text of the chosen saves (Google Gemini; Groq for transcripts).
```

## What each note depends on

| Sentence in the notes | Is it true in the code today? |
| --- | --- |
| First-launch choice, sign-in, share sheet, account screen | Yes (`docs/mobile-app.md`, "What it does"). |
| "Unlock once", "Restore a purchase" | Yes, these are the button labels (`ui/src/features/unlock/screen.tsx`). No real store purchase has ever been run (`docs/STATUS.md`, "Never run for real"). |
| Delete path and the word DELETE | Yes (`ui/src/features/dialogs/settings.tsx`, `ui/src/features/dialogs/basic.tsx`). |
| Sign in with Apple is offered | The button exists. It has never run against Apple, because the app is not registered with Apple yet (`docs/STATUS.md`). |
| The Allow / Not now dialog | **Not in this branch.** It is being built. Read the finished dialog and correct the notes to match its exact words before pasting. |
| "Our server accepts sandbox purchases during review" | Only if the server is set as below. |

## The server on review day

Each line names where the requirement is written.

1. **A production address exists and the app is built against it.** `mobile/app.config.json` still holds the
   placeholder `https://app.little-archive.example` (`docs/mobile-app.md`, "The hosted service's address and keys").
   With the placeholder the first screen cannot connect, and review fails at once.
2. **The server is up, in hosted mode, with the Supabase secret key set** (`LA_SUPABASE_SERVICE_KEY`), so that
   deleting an account also removes the sign-in (`docs/hosted-mode.md`, "Configure" and "Account deletion").
3. **Apple purchases accept the sandbox:** `LA_APPLE_ENVIRONMENTS=Production,Sandbox`, with the real
   `LA_APPLE_BUNDLE_ID`, `LA_APPLE_PRODUCT_ID=unlock_full` and `LA_APPLE_APP_ID` (`docs/mobile-app.md`, "What store
   setup is still yours", App Store Connect step 6). Apple's reviewers buy in the sandbox; with `Production` alone
   their purchase is refused.
4. **Google purchases work:** the service account file is in place (`LA_GOOGLE_SERVICE_ACCOUNT_FILE`), with
   `LA_GOOGLE_PACKAGE_NAME` and `LA_GOOGLE_PRODUCT_ID=unlock_full` (same section, Play Console step 4). Whether
   Google's reviewers count as licence testers, and so need `LA_GOOGLE_ALLOW_TEST_PURCHASES=true`, is not stated in
   the docs. **Unverified.**
5. **AI is switched on**, or every AI feature answers "not available": an AI provider and its key, a transcription
   service and its key, and server-side page reading (`LA_FETCH_ENABLED=true`), which a closer read needs
   (`docs/hosted-mode.md`, "The understanding layer"; `docs/understanding.md`).
6. **Sign-in providers are ready:** Google's sign-in setup is published, not in testing mode, or only listed test
   users can sign in; Apple is enabled in Supabase with the app's bundle id (`docs/STATUS.md`, "Sign-in, proven and
   not"; `docs/mobile-app.md`, the owner checklist).
7. **The demo account exists, its email is confirmed, and it holds made-up saves.** New accounts must confirm by
   email (`docs/STATUS.md`, "Running"), and a reviewer cannot read the demo inbox.
8. **The privacy, support and deletion pages are live** at the addresses given in the listing, with a real contact
   address in place of the placeholder.
9. **Keep it that way until both reviews finish.** After approval, set `LA_APPLE_ENVIRONMENTS` back to `Production`
   (sandbox purchases cost nothing to make).
