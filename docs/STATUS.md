# Status

Where the project stands. Keep it under 80 lines. Update it when something moves between the lists; details live
in the linked docs, not here. Last updated: 2026-11-16.

## Decided

- **Two ways to use it.** Your own server (free, open source, every feature with your own keys or a local model),
  or an account on the hosted service: the same server in [hosted mode](hosted-mode.md), Supabase for sign-in only.
- **Pricing.** Free: unlimited saving, import, titles, folders and search. One one-time unlock for transcripts,
  recipe cards and cook mode, the places map and "ask your archive", with a fair-use cap. No subscription, no
  ads, no credit packs. The price is not set.
- **Payments.** Tap Payments (Kuwait) on the web. The store apps sell the same unlock through Apple and Google
  in-app purchase and never point at the web purchase (store rules); one account is unlocked everywhere.
- **Sign-in.** Email and password, plus Continue with Google and Continue with Apple.
- **Interface.** React, Tailwind and shadcn in `ui/`; text-art accents only. See [ui/DESIGN.md](../ui/DESIGN.md).

## Built and merged (main)

- Server: single-owner and hosted modes, understanding layer, recipes, places, ask, guided import, purchases
  for Apple, Google and Tap (Tap against stand-ins only), a pay page at `/pay` on a hosted server, and an
  operator command that deletes an account.
- React interface, synthetic demo, Chrome extension, Mac app build, container image.
- Phone app (iOS and Android shell): first-launch server choice with own-server guidance, hosted and
  own-server sign-in, Google and Apple sign-in, password reset for hosted accounts, share sheet, native
  purchase sheet. iPhone only in version 1.
- A permission step before saved content is sent to an AI service (kept per account, switch in Settings).
  The interface enforces it; the server does not refuse AI routes without it.
- Privacy policy and terms links in Settings and on the unlock screen. Privacy, terms, support and account
  deletion pages in `web/`, published because `web/site.json` names the contact address
  `hello@littlearchive.me` (not opened in a browser since; no mail to it has been seen arriving). The store listing pack in `docs/store/`.
- A flower border where a page ends, an empty library that teaches saving, Start cooking pinned on a recipe
  save, and a garden on the phone app's first screens, which fit the screen without scrolling.
- Revoking a Sign in with Apple when an account is deleted (off until the Apple key is set).
- Release validation was last green on main at `038f7e7`.

## Sign-in, proven and not

- Google: proven end to end on 2026-11-16 from the iOS simulator against staging and the real Supabase
  project. The Google setup is in testing mode: only listed test users can sign in until it is published.
- Apple: switched on in Supabase and the app id is registered with Apple. The sheet has never run: it needs
  a signed build on a real device. Revoking on deletion has never met Apple.
- Password reset: proven only in tests against a stand-in. The link must be opened within about five minutes
  on the same phone. Never run on a simulator or against the real project.
- Known fault: Google's page names the Supabase address, not Little Archive.
- The keyboard no longer slides the page under the status bar on iOS. Proven on the iOS 26.5 simulator only.

## Running

- A staging copy of the hosted service, pinned to the image built from `4cd0fae`. Proven from the iOS
  simulator: create an account, confirm by email, sign in, save a link, data survives a restart.
- The phone app names the production address the hosting operator chose, `https://little-archive.altararwah.com`.
  That server does not exist yet.

## Not built

- Following a refund of a web payment automatically (the operator removes the unlock by hand); Arabic.
- Browser sign-in for hosted accounts beyond the pay page (hosted mode serves the API only).
- Server-side refusal of AI routes without the permission (the interface asks; the server does not check).

## Never run for real

- Store purchases (need sandbox accounts), a Tap payment (test or live key), an Android device, the Mac app
  window, AI features against a paid provider, physical phones, VoiceOver and TalkBack, the AI permission
  dialog on a phone.

## Waiting on the owner

- The unlock price (stores and KWD), the Tap secret key (test first), Apple Pay domain verification in Tap.
- Setting the password for the `hello@littlearchive.me` mailbox at Migadu (an invitation went to the owner).
- On the hosted server for the pay page: the Supabase publishable key and `/pay` as a redirect address.
- Publish the Google sign-in setup before real users. Register the share extension id and the app group
  with Apple; create a Sign in with Apple key for revocation.
- An Android upload keystore kept outside the repository, and Play App Signing.
- Check the Supabase reset-password email template and try one reset against staging.
- Arabic (the interface is English only today). Store accounts: agreements, tax and banking, sandbox testers, listings (text is in `docs/store/`).

## Rules of the road

[AGENTS.md](../AGENTS.md), "Working rules for builders and reviewers".
