# Status

Where the project stands. Keep it under 80 lines. Update it when something moves between the lists; details live
in the linked docs, not here. Last updated: 2026-11-16.

## Decided

- **Two ways to use it.** Your own server (free, open source, every feature with your own keys or a local model),
  or an account on the hosted service. The phone app asks once on first launch; afterwards the choice is in
  Settings, "This device".
- **Hosted service.** The same Python server in hosted mode, with Supabase for sign-in only. All library data
  stays on the server. See [hosted mode](hosted-mode.md).
- **Pricing.** Free tier: unlimited saving, import, titles, folders and search. One one-time unlock for
  transcripts, recipe cards and cook mode, the places map and "ask your archive", with a fair-use cap.
  No subscription, no ads, no credit packs. The price is not set.
- **Payments.** Tap Payments (Kuwait) on the web. The store apps keep Apple and Google in-app purchase for the
  same unlock unless the owner decides otherwise; one account is unlocked everywhere.
- **Sign-in.** Email and password, plus Continue with Google and Continue with Apple.
- **Interface.** React, Tailwind and shadcn in `ui/`; text-art accents only. See [ui/DESIGN.md](../ui/DESIGN.md).

## Built and merged (main)

- Server: single-owner and hosted modes, understanding layer, recipes, places, ask, guided import, purchases
  for Apple and Google.
- React interface, synthetic demo, Chrome extension, Mac app build, container image.
- Phone app (iOS and Android shell): first-launch server choice, hosted and own-server sign-in, share sheet,
  native purchase sheet.
- Release validation is green on main at `4cd0fae`.

## Built, merged locally, not pushed

- Google and Apple sign-in in the phone app (`6ee5138`). The gate passed on that commit. Proven against a local
  stand-in only: Google on an iOS simulator, the interrupted-sign-in notice on an Android emulator. Apple's
  sheet has never been shown, and no real Supabase, Google or Apple account has been used.
- Known fault: on the account screen the keyboard slides the logo under the status bar. It needs the web
  view's keyboard handling (a keyboard plugin), not CSS.

## Running

- A staging copy of the hosted service, pinned to the image built from `4cd0fae`. Proven from the iOS
  simulator: create an account, confirm by email, sign in, save a link, data survives a restart.
  Daily backup; restore proven only with an empty library.
- The committed phone app still points at a placeholder address (`mobile/app.config.json`).

## Not built

- Tap payment on the server and a pay page.
- Browser sign-in for hosted accounts (hosted mode serves the API only).
- Password reset for hosted accounts.
- Revoking an Apple sign-in when an account is deleted.
- Own-server setup guidance inside the app.

## Never run for real

- Store purchases (need sandbox accounts), an Android device, the Mac app window, AI features against a paid
  provider, physical phones, VoiceOver and TalkBack.

## Waiting on the owner

- Switch on the Google and Apple providers and set the Site URL and redirect list in Supabase
  ([checklist](mobile-app.md)).
- The unlock price, and whether the store apps sell the unlock through Tap or through the stores.
- The production address for the hosted service.
- Arabic: the interface is English only today. Decide before a store listing or a payment page.
- Apple and Google developer setup for sandbox purchases and store listings.

## Rules of the road

[AGENTS.md](../AGENTS.md), "Working rules for builders and reviewers": the gate, the candidate-branch push,
quoted proof steps, the task sheet, the fresh reviewer.
