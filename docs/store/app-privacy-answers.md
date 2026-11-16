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
| Contact Info: Name | Yes | With Continue with Google, Google gives the Supabase project a name and a picture address. With Continue with Apple, the app asks for the name scope (`requestedScopes = [.fullName, .email]`) but does not read or send the name. | `mobile/ios/App/App/SocialSignInPlugin.swift` line 121; `docs/mobile-app.md`, "App Store Connect and Play Console" and risk 12. |
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

## What must be added to the privacy manifest

`mobile/ios/App/App/PrivacyInfo.xcprivacy` declares three collected types today: email address, purchase history
and other user content. To match the answers above it needs four more entries in `NSPrivacyCollectedDataTypes`,
each with `NSPrivacyCollectedDataTypeLinked` true, `NSPrivacyCollectedDataTypeTracking` false and the single
purpose `NSPrivacyCollectedDataTypePurposeAppFunctionality`:

| Add this value for `NSPrivacyCollectedDataType` | For |
| --- | --- |
| `NSPrivacyCollectedDataTypeUserID` | The account id. |
| `NSPrivacyCollectedDataTypeName` | The name Google or Apple may give at sign-in. Drop this one if the `.fullName` scope is removed and Google sign-in is not offered. |
| `NSPrivacyCollectedDataTypePhotosorVideos` | Preview images the person uploads. |
| `NSPrivacyCollectedDataTypeProductInteraction` | The usage counts. |

The four names follow Apple's published list of collected data types as recalled here; they were not checked
against Apple's page in this work. **Confirm each spelling in Apple's privacy manifest documentation before
editing the file**, since Xcode rejects an unknown value only at upload.

Nothing else in the manifest needs to change: `NSPrivacyTracking` stays `false`, the tracking-domain list stays
empty, and the one required-reason API entry (user defaults, reason `1C8F.1`) is unchanged. The share extension's
own manifest (`mobile/ios/App/ShareExtension/PrivacyInfo.xcprivacy`) collects nothing and is correct as it is: the
extension only hands a link to the app.

This file was not edited here. The `mobile/` folder belongs to another builder.

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
- **The AI providers' terms.** Apple's guideline 5.1.2(i) asks an app to say clearly when personal data goes to a
  third-party AI service and to get permission first. The permission dialog (Allow / Not now before the first AI
  action) is being built and is not in this branch. Check that it names Google Gemini and Groq, as the privacy
  policy does.
- **Sign in with Apple and deletion.** Deleting an account does not yet revoke the Apple sign-in at Apple
  (`docs/STATUS.md`, "Not built"; `docs/mobile-app.md`, risk 9). The privacy policy and the deletion page tell the
  person how to remove it themselves. A reviewer may still raise it under guideline 5.1.1(v).
