# Owner checklist for the store release

Things only the owner can do, in the order that works. Each is one step. Where a step comes from the project's own
docs, the doc is named so the detail can be looked up; steps marked **not in the docs** are ordinary store
requirements that this project has not written down or tried.

Nothing in this list has been done or tried by a builder.

## Decisions first

1. Decide the unlock's price, for the stores and in Kuwaiti dinars for the web (`docs/STATUS.md`, "Waiting on the owner").
2. Choose a public contact address that is not a personal one and set it as `contact_email` in `web/site.json`; the privacy, terms, support and account deletion pages publish on the next push to `main`, and are not published at all while it is empty.
3. After that push, open the four pages in a browser and check each shows the address; until then the app's "Privacy policy" and "Terms" links and every page address in the listings lead to a page that does not exist.
4. Give the company's exact registered name and country for the legal pages and the copyright line.
5. Have a lawyer or yourself confirm the sentences listed in the builder's report: the refund promise for web payments, Kuwait as governing law, the liability limit, the minimum age of 13, the 30-day notice of closure and the 30 days for a deletion asked for by email.
6. Decide whether to launch in English only; the interface has no Arabic yet (`docs/STATUS.md`).
7. Check the plan you use at Google Gemini and at Groq: if its terms let the provider use what it receives for its own purposes, the privacy policy and the Data safety form must say the data is shared.
8. Have the hosted server brought up at `https://little-archive.altararwah.com`, the address the app is built with; that server is not running yet (`docs/STATUS.md`, "Running").

## Apple developer account

9. Enrol the company in the Apple Developer Program, if not done (**not in the docs**).
10. Confirm the App ID for the app's bundle id has the Sign in with Apple capability; the id is registered (`docs/STATUS.md`, "Sign-in, proven and not").
11. Register the share extension's id and the app group it shares with the app (`docs/STATUS.md`, "Waiting on the owner").
12. Create a Sign in with Apple key and hand it to whoever runs the server, so that deleting an account also ends its Apple sign-in; without the key that step is off (`docs/hosted-mode.md`; `server/apple_signin.py`).
13. If the bundle id `app.littlearchive.mobile` is not the one you want, tell the builder before anything else is created, because it is written in many places (`docs/mobile-app.md`, "Changing the bundle id and other names").

## App Store Connect

14. Accept the Paid Applications agreement and fill in tax and banking details (`docs/mobile-app.md`, "What store setup is still yours").
15. Create the app record for the bundle id, for iPhone only; version 1 is not built for iPad.
16. Create the in-app purchase: a Non-Consumable with the product id `unlock_full`, a price, a display name, a description and a review screenshot.
17. Create at least one sandbox tester and make one test purchase on a real iPhone; no real purchase has ever been run.
18. Set the App Store Server Notifications address to `https://little-archive.altararwah.com/api/purchases/apple/notifications` for Production and Sandbox, so refunds are noticed.
19. Paste the listing text from `app-store-listing.md` and upload the screenshots from `screenshots.md`.
20. Answer App Privacy using `app-privacy-answers.md`.
21. Answer the age rating questionnaire using `app-store-listing.md`.
22. Fill in App Review Information with the demo account and the note from `review-notes.md`.
23. Answer the export compliance question as "uses only standard encryption"; the app already declares this (`ITSAppUsesNonExemptEncryption` is false in `Info.plist`).
24. Upload a build, test it through TestFlight on a real iPhone, then submit for review.

## Play Console

25. Create the Google Play developer account as an organisation, if not done (**not in the docs**).
26. Create an upload keystore, keep it outside the repository, and turn on Play App Signing (`docs/STATUS.md`, "Waiting on the owner").
27. Create the app for the package name and upload a signed build to the internal testing track; products can only be created after that (`docs/mobile-app.md`, "What store setup is still yours").
28. Create the one-time product `unlock_full`, active, with a price.
29. Add licence testers and make one test purchase on a real Android phone.
30. Link a Google Cloud project, create a service account, invite it in the Play Console with permission to view financial data and manage orders, and hand its key file to whoever runs the server.
31. Set up real-time developer notifications to a Pub/Sub topic that pushes to `https://little-archive.altararwah.com/api/purchases/google/notifications`, so refunds are noticed.
32. Paste the listing text and answers from `play-listing.md`: store listing, ads, app access, content rating, target audience and Data safety.
33. Enter the account deletion address, after step 3 shows the page is live with the contact address on it.
34. Upload the screenshots, feature graphic and icon from `screenshots.md`.
35. If the developer account is a personal one created after November 2023, run a closed test with at least 12 testers for 14 days before production (**not in the docs**; a Play rule).
36. Submit for review.

## Tap dashboard

The web payment and its pay page are built and switched off until a key and a price are set (`docs/hosted-mode.md`).
No Tap payment has ever been run, with a test key or a live one (`docs/STATUS.md`, "Never run for real").

37. Open or confirm the Tap Payments merchant account for the company.
38. Give the Tap secret key to whoever runs the server, the test key first, and make one test payment before the live key is used (`LA_TAP_SECRET_KEY`, `LA_TAP_PRICE`, `LA_TAP_CURRENCY`).
39. Complete Apple Pay domain verification in Tap for the hosted server's address, if Apple Pay is to be offered on the pay page (`docs/STATUS.md`, "Waiting on the owner").
40. Learn how a refund is issued from the Tap dashboard, and tell whoever runs the server each time you issue one: the server does not follow Tap refunds, so the unlock is removed by hand (`docs/hosted-mode.md`, "What it does not do").

## Supabase

41. Set the Site URL to a page you control; its default sends people who confirm their email to a dead address (`docs/mobile-app.md`, "What to switch on and create").
42. Confirm `littlearchive://auth-callback` is in the redirect URLs, exactly.
43. Confirm the Apple provider is enabled with the app's bundle id as its client id.
44. Confirm the Google provider has both the client id and the client secret saved.
45. Check the reset-password email template and try one password reset against the staging server (`docs/STATUS.md`, "Waiting on the owner").
46. Keep the access-token lifetime short (`docs/hosted-mode.md`, "What is not verified").
47. Give the project's secret key to whoever runs the server, and to nobody else; it is what removes a sign-in when an account is deleted.
48. Create the reviewers' demo account and confirm its email.

## Google Cloud

49. Move the Google sign-in consent screen from Testing to In production; until then only listed test users can sign in (`docs/STATUS.md`).
50. Set the app name and support email shown on Google's sign-in page; today it names the Supabase address, not Little Archive (`docs/STATUS.md`, "Known fault").
51. Check whether Google asks for a verification review of the sign-in setup before launch (`docs/mobile-app.md` says this was not confirmed).

## On the day before review

52. Ask whoever runs the server to confirm every line of "The server on review day" in `review-notes.md`.
53. Sign in to the demo account yourself on a real phone, make a sandbox purchase, restore it, and delete a spare account.

## When someone asks by email for their account to be deleted

54. Agree with whoever runs the server how such a request is carried out and answered within the 30 days the deletion page gives: the server has no admin screen (`docs/hosted-mode.md`, "Operating notes"), and an operator command for deleting one account is being added; until it is merged the operator removes the account's folder on the server and the user in Supabase by hand.
