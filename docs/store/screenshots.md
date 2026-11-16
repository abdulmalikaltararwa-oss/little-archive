# Screenshots

What each store needs, and the six screens to capture. Every screenshot uses made-up content: the 60 synthetic
saves that ship with the demo (`web/demo-data.js`) are suitable. No real account, real person's post or real
email address may appear.

## Sizes

| Store | Asset | Size in pixels | How many | Format |
| --- | --- | --- | --- | --- |
| App Store | iPhone 6.9-inch screenshots | 1320 x 2868 (portrait) | 1 to 10; use the 6 below | PNG or JPEG, no transparency |
| App Store | iPad 13-inch screenshots | 2064 x 2752 (portrait) | 1 to 10 | Needed only if the app stays available on iPad. The build runs on iPad today (`TARGETED_DEVICE_FAMILY = "1,2"`), and the app has never been run on one (`docs/STATUS.md`). **Owner:** supply iPad shots or make the app iPhone only. |
| Google Play | Phone screenshots | 1080 x 1920 (portrait) | 2 to 8; use the 6 below | PNG or JPEG |
| Google Play | Feature graphic | 1024 x 500 | 1 | JPEG or 24-bit PNG, no transparency |
| Google Play | App icon | 512 x 512 | 1 | 32-bit PNG, at most 1 MB |

Capture from a simulator or emulator of the matching size, running the real app, not from a browser window.
The iPhone 17 Pro Max simulator gives 1320 x 2868.

## The six screens

The caption is the line of text placed above or below the phone in the finished image. Captions are sentence
case, at most 40 characters, and say what the screen does. The same six serve both stores; in the Play set, shot 2
must show the Android share sheet, and no caption names the other platform.

| # | Screen | What must be visible | Caption |
| --- | --- | --- | --- |
| 1 | The library | The wall of cards with covers, a mix of recipes, places and articles, the dock at the bottom. Light theme. | Everything you saved, in one place |
| 2 | Saving from the share sheet | The save screen with a shared link filled in and the Save button, reached from the system share sheet. | Save from any app in two taps |
| 3 | One save, opened | The detail screen: cover, title, the person's own note, tags, a collection. | Add your own notes and tags |
| 4 | Search | A search typed into the search box with matching cards under it. | Find it again by any word |
| 5 | A recipe card | A recipe card with ingredients and steps, or cook mode. Dark theme, to show it exists. | Recipes pulled out of saved videos |
| 6 | Ask your archive | A typed question, the answer, and the saves it came from under it. | Ask a question, get your own saves |

Notes on the list:

- Shots 5 and 6 show features that come with the one-time unlock. Do not put a price in a caption or on a screen.
- Shots 5 and 6 need a server with AI switched on and an unlocked account. No AI feature has been run against a
  paid provider yet (`docs/STATUS.md`, "Never run for real"), so these two cannot be captured until that works.
- The places map is left out on purpose: it needs a map-tile service that is not configured by default
  (`VITE_LA_TILE_URL`). If one is set up, it can replace shot 4 with the caption "See the places you saved on a map".
- An AI suggestion on screen must keep its evidence label ("from the caption", for example) visible. Do not crop it
  out.
- The sign-in screen and the first-launch choice are not screenshots. Apple asks for the app in use.

## Feature graphic and icon (Google Play)

- **Feature graphic, 1024 x 500.** The paper background (`#f8f3ea`), the flower mark from `web/icon.svg` on the
  left, the words "Little Archive" in Fraunces and under them "A home for everything you save". No screenshots, no
  price, no store badges. Keep text out of the outer 15 percent, which Play may crop.
- **Icon, 512 x 512.** Render `web/icon.svg` on its own background, the same artwork as the launcher icon
  (`docs/mobile-app.md` says the app icons were rendered from this file).
