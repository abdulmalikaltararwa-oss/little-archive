# Owner checklist for the store release

Things only the owner can do, in the order that works. Each is one step. Where a step comes from the project's own
docs, the doc is named so the detail can be looked up; steps marked **not in the docs** are ordinary store
requirements that this project has not written down or tried.

Nothing in this list has been done or tried by a builder.

## Decisions first

1. Decide the unlock's price (`docs/STATUS.md`, "Waiting on the owner").
2. Decide whether the phone apps sell the unlock through the stores' own purchase, which is what the code does today, or through Tap (`docs/STATUS.md`).
3. Decide the production address of the hosted service and have the app rebuilt with it in `mobile/app.config.json` (`docs/STATUS.md`; `docs/mobile-app.md`).
4. Choose a support email address that is not a personal one, and have it put into the four web pages in place of `support@[owner to set]`.
5. Decide where the privacy, terms, support and deletion pages are published; the public demo site does not publish them today.
6. Give the company's exact registered name and country for the legal pages and the copyright line.
7. Have a lawyer or yourself confirm the sentences listed in the builder's report: the Tap refund promise, Kuwait as governing law, the liability limit, the minimum age of 13 and the 30-day notice of closure.
8. Decide whether to launch in English only; the interface has no Arabic yet (`docs/STATUS.md`).
9. Check the plan you use at Google Gemini and at Groq: if its terms let the provider use what it receives for its own purposes, the privacy policy and the Data safety form must say the data is shared.

## Apple developer account

10. Enrol the company in the Apple Developer Program, if not done (**not in the docs**).
11. Register the App ID for the app's bundle id with the Sign in with Apple capability (`docs/mobile-app.md`, "What to switch on and create").
12. Register the app group used by the share extension (`docs/mobile-app.md`, "Changing the bundle id and other names").
13. If the bundle id `app.littlearchive.mobile` is not the one you want, tell the builder before anything else is created, because it is written in many places (same section).

## App Store Connect

14. Accept the Paid Applications agreement and fill in tax and banking details (`docs/mobile-app.md`, "What store setup is still yours").
15. Create the app record for the bundle id.
16. Create the in-app purchase: a Non-Consumable with the product id `unlock_full`, a price, a display name, a description and a review screenshot.
17. Create at least one sandbox tester and make one test purchase on a real iPhone; no real purchase has ever been run.
18. Set the App Store Server Notifications address to `https://YOUR-SERVER/api/purchases/apple/notifications` for Production and Sandbox, so refunds are noticed.
19. Paste the listing text from `app-store-listing.md` and upload the screenshots from `screenshots.md`.
20. Answer App Privacy using `app-privacy-answers.md`.
21. Answer the age rating questionnaire using `app-store-listing.md`.
22. Fill in App Review Information with the demo account and the note from `review-notes.md`.
23. Answer the export compliance question as "uses only standard encryption"; the app already declares this (`ITSAppUsesNonExemptEncryption` is false in `Info.plist`).
24. Upload a build, test it through TestFlight on a real iPhone, then submit for review.

## Play Console

25. Create the Google Play developer account as an organisation, if not done (**not in the docs**).
26. Create the app for the package name and upload a signed build to the internal testing track; products can only be created after that (`docs/mobile-app.md`, "What store setup is still yours").
27. Create the one-time product `unlock_full`, active, with a price.
28. Add licence testers and make one test purchase on a real Android phone.
29. Link a Google Cloud project, create a service account, invite it in the Play Console with permission to view financial data and manage orders, and hand its key file to whoever runs the server.
30. Set up real-time developer notifications to a Pub/Sub topic that pushes to `https://YOUR-SERVER/api/purchases/google/notifications`, so refunds are noticed.
31. Paste the listing text and answers from `play-listing.md`: store listing, ads, app access, content rating, target audience and Data safety.
32. Enter the account deletion address, after the page is live and shows a real contact address.
33. Upload the screenshots, feature graphic and icon from `screenshots.md`.
34. If the developer account is a personal one created after November 2023, run a closed test with at least 12 testers for 14 days before production (**not in the docs**; a Play rule).
35. Submit for review.

## Tap dashboard

36. Open or confirm the Tap Payments merchant account for the company.
37. Wait for the builder's instructions before changing anything else: the Tap payment and its pay page are not built yet (`docs/STATUS.md`, "Not built"), so the keys, addresses and settings they need are not known.
38. Confirm with Tap how a refund is issued from the dashboard, since the terms promise one on request.

## Supabase

39. Set the Site URL to a page you control; its default sends people who confirm their email to a dead address (`docs/mobile-app.md`, "What to switch on and create").
40. Add exactly `littlearchive://auth-callback` to the redirect URLs.
41. Enable the Apple provider and enter the app's bundle id as its client id.
42. Confirm the Google provider has both the client id and the client secret saved.
43. Keep the access-token lifetime short (`docs/hosted-mode.md`, "What is not verified").
44. Give the project's secret key to whoever runs the server, and to nobody else; it is what removes a sign-in when an account is deleted.
45. Create the reviewers' demo account and confirm its email.

## Google Cloud

46. Move the Google sign-in consent screen from Testing to In production; until then only listed test users can sign in (`docs/STATUS.md`).
47. Set the app name and support email shown on Google's sign-in page; today it names the Supabase address, not Little Archive (`docs/STATUS.md`, "Known faults").
48. Check whether Google asks for a verification review of the sign-in setup before launch (`docs/mobile-app.md` says this was not confirmed).

## On the day before review

49. Ask whoever runs the server to confirm every line of "The server on review day" in `review-notes.md`.
50. Sign in to the demo account yourself on a real phone, make a sandbox purchase, restore it, and delete a spare account.

## When someone asks by email for their account to be deleted

51. Have a written way to do it: the server has no admin screen (`docs/hosted-mode.md`, "Operating notes"), so today this means the operator removing the account's folder on the server and the user in Supabase by hand. The deletion page promises it within 30 days.
