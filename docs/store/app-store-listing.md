# App Store listing

Text to paste into App Store Connect. Each field shows Apple's limit in brackets; the text in the box under it is
within that limit (checked by counting, see the end of this file). Apple's text must not name other platforms or
state a price, so none of it does.

Nothing here has been submitted. Items marked **Owner** need a decision or a real value first.

## Text fields

### Name (30)

```text
Little Archive
```

### Subtitle (30)

```text
A home for everything you save
```

### Promotional text (170)

```text
Save posts, videos and links from any app, then find them again. Search, collections and notes, plus optional recipe cards, a places map and answers from your own saves.
```

### Description (4000)

```text
Little Archive is a quiet home for the posts, videos and links you save and then lose track of.

Save a link from any app with the share sheet, or bring in the saved-posts export from your social apps. Everything lands in one gallery that you can search, sort and come back to.

INCLUDED
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
• You can delete your account and your library from Settings at any time.
• Little Archive is not affiliated with any social platform.
```

### Keywords (100)

```text
saved posts,bookmarks,links,read later,recipes,collections,organize,notes,archive,places,self-hosted
```

## URLs

These are the addresses of the four pages in `web/` on the public site, beside the demo. They are
published because the contact address is set (`contact_email` in `web/site.json`, `hello@littlearchive.me`);
`scripts/build_demo.py` leaves them out whenever that value is empty. **Owner:** open each one before pasting it.

| Field | Value |
| --- | --- |
| Support URL | `https://abdulmalikaltararwa-oss.github.io/little-archive/support.html` |
| Marketing URL | `https://abdulmalikaltararwa-oss.github.io/little-archive/` (the public demo; `docs/publishing.md` records it as verified after its last publish, and it was not opened again for this file) |
| Privacy Policy URL | `https://abdulmalikaltararwa-oss.github.io/little-archive/privacy.html` |

## Other fields

| Field | Value | Note |
| --- | --- | --- |
| Copyright | `2026 Nuzio` | **Owner:** use the company's exact registered name. |
| Primary category | Productivity | The app organises things a person saved. |
| Secondary category | Utilities | Lifestyle is the alternative if recipes and places are the main pitch. |
| Primary language | English | The interface is English only today (`docs/STATUS.md`). |
| Price | Free, with one in-app purchase | The non-consumable `unlock_full`. Owner chose USD 9.99 (KWD 3.000 on the web) on 16 November 2026. |
| Devices | iPhone only | Version 1 is built for iPhone only (`TARGETED_DEVICE_FAMILY = 1`), so no iPad screenshots are needed. |

## Age rating questionnaire

Apple's questionnaire asks how often each kind of content appears. The expected result is **4+**. The wording of the
live questionnaire changes; read each question and keep these answers only where they still fit.

| Question | Answer | Reason |
| --- | --- | --- |
| Violence (cartoon, realistic, graphic) | None | The app has no content of its own. |
| Sexual content or nudity | None | Same. |
| Profanity or crude humour | None | Same. |
| Alcohol, tobacco or drug use | None | Same. |
| Mature or suggestive themes | None | Same. |
| Horror or fear themes | None | Same. |
| Medical or treatment information | None | Recipe cards are not health advice. |
| Gambling, simulated gambling, contests | None | None exist. |
| Loot boxes | No | The only purchase is one fixed unlock. |
| Unrestricted web access | No | The app has no browser. "Open original" hands the link to the system browser (`docs/mobile-app.md`, "What was and was not verified"). |
| User-generated content shared with others | No | A library is visible only to its own account. Nothing is published or shared between users. |
| Messaging or chat between users | No | None exists. |
| Advertising | No | The app shows no ads and contains no ad software (`mobile/package.json` lists no such package). |
| Parental controls or age assurance | No | None exists. |
| AI assistant or chatbot | **Owner to read the question.** | "Ask your archive" answers one typed question from the person's own saves. It is not a chat and keeps no conversation. Answer for that, in the questionnaire's own words. |

One thing to keep in mind when answering: what a person sees in the app is whatever they chose to save. The app
shows the title, caption and cover of those posts. That is the person's own material, not content the app
supplies, and nobody else can see it.

## Checked before this file was written

- Lengths: Name 14/30, Subtitle 30/30, Promotional text 169/170, Description 2,016/4,000, Keywords 100/100 bytes.
- The text fields were searched for other platform names, store names, payment-provider names and prices. None
  appear. "Google Gemini" appears once, as the name of the AI service that receives text, which Apple's guideline
  5.1.2(i) asks an app to name.
- "The app asks for your permission first" is the permission step in the app: one screen with "Allow" and "Not now"
  that shows what would be sent and to which service, kept with the account, with a switch in Settings
  (`ui/src/features/ai-permission/`). It has not yet been run on a phone (`docs/STATUS.md`, "Never run for real").
- The text does not mention that the unlock can also be bought on the web.
