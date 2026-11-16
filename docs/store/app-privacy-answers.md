# App Privacy answers (Apple's privacy label)

Answers for App Store Connect, App Privacy, one data type at a time, each with the place in the code or docs it
rests on. Apple's meaning of **collect** is: the data leaves the device and is kept longer than it takes to answer
the request. Data that goes to a company working for the developer still counts as collected by the developer.

These answers describe the app used with a **Little Archive account** (the hosted service). With "My own server"
the app sends data only to a server the person runs, and the developer collects nothing.

## Top-level answers

| Question | Answer | Reason |
| --- | --- | --- |
| Do you or your third-party partners collect data from this app? | Yes | See below. |
| Is any data used to track the person? | No | No advertising or analytics software is in the app (`mobile/package.json`), and `NSPrivacyTracking` is `false` in `mobile/ios/App/App/PrivacyInfo.xcprivacy`. |

For every type below: **Linked to the person: Yes. Used for tracking: No. Purpose: App Functionality** only.

## Data types to declare

| Apple's data type | Declare | What it is here | Source |
| --- | --- | --- | --- |
| Contact Info: Email Address | Yes | The account's email address, held by the sign-in service (Supabase). | `mobile/src/supabase.js`; `docs/privacy.md`, "If someone else hosts your library". The server itself stores no email (`server/identity.py`). |
| Contact Info: Name | Yes | With Continue with Google, Google gives the Supabase project a name and a picture address. Continue with Apple asks for the email only. | `mobile/ios/App/App/SocialSignInPlugin.swift` (`requestedScopes = [.email]`); `docs/mobile-app.md`, "App Store Connect and Play Console" and risk 12. |
| Identifiers: User ID | Yes | The account id (a random identifier from Supabase). It selects the library, and a purchase is tagged with it. | `server/identity.py`; `server/tenancy.py`; `mobile/src/purchases.js` (`accountTag`). |
| Purchases: Purchase History | Yes | The App Store's signed transaction for the one-time unlock is sent to the server, which keeps Apple's transaction id. | `mobile/ios/App/App/StorePurchasesPlugin.swift`; `server/purchases/apple.py`; `server/purchases/store.py`. |
| User Content: Other User Content | Yes | Saved links, titles, captions, notes, tags, collections, and the question typed into "ask your archive". Text from saves is also sent to Google Gemini and Groq when the person uses an AI feature. | `server/storage.py`; `server/enrich/understanding.py`; `server/enrich/ask.py`; `server/enrich/transcribe.py`. |
| User Content: Photos or Videos | Yes | A preview image the person picks for a save is uploaded and stored. | Thumbnail upload, `docs/hosted-mode.md`, "Limits". |
| Usage Data: Product Interaction | Yes | Counts of AI requests per day and month, kept under a hash of the account id to apply the fair-use limits. A hash of an id still counts as linked. | `server/entitlements.py`; `docs/hosted-mode.md`, "Tenancy". |

## Data types not collected

| Apple's data type | Reason |
| --- | --- |
| Contact Info: Phone Number, Physical Address, Other | Never asked for. |
| Health and Fitness, Financial Info (payment info, credit info) | Payment is taken by Apple. The app and server never see card details (`ui/src/features/unlock/screen.tsx`: "Little Archive never sees your card"). |
| Location (precise or coarse) | The app never asks for the device's location; no location permission string is in `Info.plist`. The places map shows places named in saved posts. |
| Sensitive Info, Contacts | Never asked for. |
| User Content: Emails or Text Messages, Audio Data, Gameplay Content, Customer Support | None. Audio that is transcribed belongs to a public post, not to the person, and is not kept (`server/enrich/transcribe.py`). |
| Browsing History | The app has no browser. |
| Search History | A search or an "ask" question is sent to the server to be answered and is not stored (`server/enrich/ask.py` writes nothing). The question is declared above under Other User Content because it is sent on to the AI provider. **Owner:** if you prefer the cautious reading, also declare Search History, linked, App Functionality. |
| Identifiers: Device ID | None read or sent. |
| Usage Data: Advertising Data, Other Usage Data | None. |
| Diagnostics: Crash Data, Performance Data, Other | No crash or diagnostics software is in the app. |
| Surroundings, Body | None. |

## The privacy manifest

`mobile/ios/App/App/PrivacyInfo.xcprivacy` declares the seven collected types above (email address, name, user
id, purchase history, other user content, photos or videos, product interaction), each linked to the person, not
used for tracking, for app functionality. The spellings were checked against Apple's reference pages when they
were added. Keep the manifest and these answers the same.

## Things the owner must confirm before answering

- **The production server's settings decide some of this.** The answers assume the hosted service runs with
  `LA_AI_PROVIDER=gemini`, a transcription service (Groq, or Gemini), and `LA_AI_SHARE_PRIVATE_CONTEXT` left off, so
  that notes and collection names are not sent to the AI provider. The repository cannot show what the production
  server is set to.
- **"Ask your archive" can send a title the person typed.** For suggestions the code leaves out a title the person
  wrote; for "ask" it does not make that exception (`passages_for` in `server/enrich/ask.py` calls `build_evidence`
  without `manual_title`). Notes and collection names are left out in both. This is already covered by Other User
  Content above.
- **Places.** Place names from saved posts can go to a place-lookup service, and the map can load tiles from a map
  service (`server/enrich/places.py`; `VITE_LA_TILE_URL`). Both are off unless configured. Neither is the person's
  location, so Location stays undeclared; the privacy policy mentions both.
- **The AI permission step.** Apple's guideline 5.1.2(i) asks an app to say clearly when personal data goes to a
  third-party AI service and to get permission first. The app does this in one step with "Allow" and "Not now"
  that shows what would be sent and to which service; the answer is kept with the account and can be changed in
  Settings (`ui/src/features/ai-permission/`). The service names on that screen come from what the server reports,
  so check on the production server that it names Google's Gemini service and Groq's transcription service, as the
  privacy policy does. The interface enforces the step; the server does not refuse an AI request made without it
  (`docs/STATUS.md`). It has not been run on a phone.
- **Sign in with Apple and deletion.** Deleting an account ends its Apple sign-in at Apple only once the operator
  has set the Sign in with Apple key on the server; until then that step is off (`server/apple_signin.py`). With
  the key set, the server keeps one Apple token per account that used Continue with Apple, until the account is
  deleted. A sign-in token is not one of Apple's listed data types, so no answer above changes; the privacy policy
  has a row for it. This has never met Apple (`docs/STATUS.md`). Set the key before review: a reviewer may check
  guideline 5.1.1(v).
- **Paying on the web.** The unlock can also be bought on the hosted server's pay page through Tap Payments. That
  happens in a browser, not in the app, so it is not part of the app's privacy label; the privacy policy covers it.
