# Google Play listing

Text and answers to paste into the Play Console. Each text field shows Google's limit in brackets; the text in the
box under it is within that limit. Nothing here has been submitted. Items marked **Owner** need a decision or a real
value first.

## Main store listing

### App name (30)

```text
Little Archive: saved posts
```

### Short description (80)

```text
A quiet home for the posts, videos and links you save. Search, sort, find again.
```

### Full description (4000)

```text
Little Archive is a quiet home for the posts, videos and links you save and then lose track of.

Share a link to Little Archive from any app, or bring in the saved-posts export from your social apps. Everything lands in one gallery that you can search, sort and come back to.

FREE
• Save as many links as you like
• Import your saved posts from an export file
• Search titles, captions, tags and your own notes
• Keep your original collections and make new ones
• Add tags, notes and favourites, and mark things to revisit
• Light and dark themes
• Export your library or download a full backup whenever you want
• A limited number of AI suggestions for titles and folders

ONE-TIME UNLOCK
One purchase, made once, for your account. No subscription and no ads.
• Closer reads: a transcript of what is said in a saved video
• Recipe cards and a cook mode for saved recipes
• A map of the places your saves mention
• Ask your archive: type a question and get an answer drawn from your own saves, with the saves it came from
• A larger allowance of AI suggestions
Fair-use limits apply. The app tells you when you reach one and when it starts again.

YOUR OWN SERVER
Little Archive is open source. If you run it on your own server, choose "My own server" when the app starts and type its address. Every feature is open and there is nothing to buy.

GOOD TO KNOW
• With a Little Archive account, your library is stored on our server. It is kept separate from other accounts. It is not end-to-end encrypted.
• AI features are optional and run only when you start them. They send the text of the saves you choose (title, creator, caption and transcript) to Google Gemini, and for a closer read the post's media file to Groq, to be processed. The app asks for your permission first.
• AI works from a post's text. It has not watched the video, and its suggestions can be wrong.
• You can delete your account and everything in it from Settings at any time.
• Little Archive is not affiliated with any social platform.
```

## Store settings

| Field | Value | Note |
| --- | --- | --- |
| App or game | App | |
| Category | Productivity | |
| Tags | Productivity; Bookmarks and read-later if offered | Pick from the console's list. |
| Contact email | `hello@littlearchive.me` | Google shows it publicly. |
| Website | `https://abdulmalikaltararwa-oss.github.io/little-archive/` | The public demo (`docs/publishing.md` records it as verified; not opened again for this file). |
| Privacy policy | `https://abdulmalikaltararwa-oss.github.io/little-archive/privacy.html` | See the note under "URLs" in `app-store-listing.md`. Open it before submitting. |
| Default language | English (United States) | The interface is English only today. |
| Price | Free, with one in-app product | The one-time product `unlock_full`. **Owner:** the price is not set. |

## App content

### Ads

**No, the app does not contain ads.** No ad software is in the app (`mobile/package.json`, `mobile/android/app/build.gradle`).

### App access

**All or some functionality is restricted.** Give the demo account from `review-notes.md` and paste its
instructions.

### Content rating (IARC questionnaire)

Category: **Utility, productivity, communication or other**. Expected rating: Everyone / PEGI 3.

| Question | Answer | Reason |
| --- | --- | --- |
| Violence, blood, fear | No | The app has no content of its own. |
| Sexuality or nudity | No | Same. |
| Language (profanity) | No | Same. |
| Controlled substances | No | Same. |
| Gambling | No | None exists. |
| Can users interact or exchange content with other users? | No | A library is visible only to its own account. |
| Does the app share the user's location with other users? | No | The app never asks for the device's location. The places map shows places named in saved posts. |
| Does the app allow purchases of digital goods? | Yes | The one-time unlock. |
| Is the app a web browser or search engine? | No | Links open in the system browser. |

### Target audience and content

| Question | Answer | Reason |
| --- | --- | --- |
| Target age groups | 13–15, 16–17, 18 and over | The terms require an account holder to be at least 13. **Owner:** choosing 18 and over only is the more cautious option and avoids extra questions about teenagers. |
| Could the listing unintentionally appeal to children? | No | Nothing in the icon, text or screenshots is aimed at children. |

### News, health, finance, government

None of these apply. Answer No to each declaration.

### Data safety

Google's form uses its own meanings. **Collected** means sent off the device. **Shared** means passed to another
company, except a company that only processes the data on the developer's behalf, and except a transfer the person
starts themselves after being told about it.

Top-level answers:

| Question | Answer | Reason |
| --- | --- | --- |
| Does the app collect or share any required user data types? | Yes | See the table. |
| Is all collected data encrypted in transit? | Yes | The app accepts only `https` server addresses; release builds allow no cleartext traffic (`mobile/src/server-url.js`, Android network security config). |
| Can users request that their data is deleted? | Yes | In the app, and by email. |
| Account deletion URL | `https://abdulmalikaltararwa-oss.github.io/little-archive/delete-account.html` | The page shows the contact address from `web/site.json`. Open it before submitting. |

Data types. Every row: purpose **App functionality** (and **Account management** where noted), not used for
advertising or analytics, not processed ephemerally unless noted.

| Data type (Google's name) | Collected | Shared | Required or optional | Purpose | Where it comes from |
| --- | --- | --- | --- | --- | --- |
| Personal info: Email address | Yes | No | Required | App functionality, Account management | Sign-in at Supabase (`mobile/src/supabase.js`). The Little Archive server does not store it (`server/identity.py`). |
| Personal info: Name | Yes | No | Optional | Account management | Only with Continue with Google: Google gives the Supabase project a name and picture address (`docs/mobile-app.md`, "App Store Connect and Play Console"). The app does not read it. |
| Personal info: User IDs | Yes | No | Required | App functionality, Account management | The account id in the sign-in token selects the library (`server/identity.py`, `server/tenancy.py`). |
| Financial info: Purchase history | Yes | No | Optional | App functionality | The purchase token is sent to the server and checked with Google; a hash of it is kept (`server/purchases/google.py`, `server/purchases/store.py`). |
| Photos and videos: Photos | Yes | No | Optional | App functionality | A preview image the person chooses to attach to a save is uploaded and stored. |
| Files and docs | Yes | No | Optional | App functionality | An export file the person imports is uploaded, read on the server and removed when the import ends (`server/guided_import.py`). |
| App activity: Other user-generated content | Yes | See below | Required | App functionality | Saved links, titles, captions, notes, tags and collections are the library (`server/storage.py`). |
| App activity: In-app search history | No | No | | | Searches and "ask" questions are sent to the server to be answered and are not stored (`server/enrich/ask.py` writes nothing). |
| App activity: App interactions | Yes | No | Required | App functionality | Counts of AI requests per day and month, kept under a hash of the account id for the fair-use limits (`server/entitlements.py`). |
| Location, Contacts, Messages, Audio, Calendar, Health, Web browsing, Device or other IDs | No | No | | | The app asks for none of these. Its only Android permissions are internet and billing (`AndroidManifest.xml`). A place named in a saved post, which the server may send to a place-lookup service (`server/enrich/places.py`), is not the person's location. |
| App info and performance (crash logs, diagnostics) | No | No | | | No crash or analytics software is in the app. |

**The one answer that needs the owner's judgement: is saved content "shared"?** When a person uses an AI feature,
the text of the saves they chose goes to Google Gemini and, for a closer read, the post's media file goes to Groq.

- If Nuzio uses both under paid terms in which the provider processes the data only to return the result, they are
  service providers and the answer is **Shared: No**.
- If either is used on a free tier whose terms let the provider use the content for its own purposes (for example
  to improve its products), the honest answer is **Shared: Yes**, purpose App functionality, and the privacy policy
  must say so.

**Owner:** check the terms of the Gemini and Groq plans in use before answering. The privacy policy names both
companies either way.

**If the places map is switched on with a map-tile service** (`VITE_LA_TILE_URL`, empty by default), the phone
loads map pictures straight from that service, which sees the phone's network address. Google's form does not
list a network address as a data type on its own, so no row changes, but the privacy policy has a line for it and
the owner should know which service is used.

## Checked before this file was written

- Lengths: App name 27/30, Short description 80/80, Full description 2,010/4,000.
- The text names no other store and no other phone platform.
- "The app asks for your permission first" is the permission step in the app: one screen with "Allow" and "Not now"
  that shows what would be sent and to which service, kept with the account, with a switch in Settings. It has not
  yet been run on a phone.
- The text does not mention that the unlock can also be bought on the web.
