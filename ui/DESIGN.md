# Little Archive: design

The React interface in `ui/`. This file is the direction and the rules. The tokens it names live in
`src/styles/tokens.css` and `src/styles/index.css`; if this file and the code disagree, the code is what
ships and this file is wrong and should be fixed.

## Direction: a paper desk with a small terminal heart

Little Archive is a home for things you saved. It should feel like a tidy desk: cream paper, a sage ink
stamp, a pink flower pressed in a book. Soft, cute, unhurried. Underneath it there is a machine that reads
captions and files things, and that machine is allowed to show: in a mono face, in square brackets, in
ASCII drawings and progress bars. The two voices never swap roles.

- **Paper voice** (Fraunces, Figtree, rounded cards, pills, sage and petal): everything a person reads,
  edits or presses.
- **Terminal voice** (DM Mono, `[ whispers ]`, counts, evidence labels, ASCII art): what the machine knows,
  how much there is, what is happening, and where a claim came from.

ASCII is an accent, never the interface. If a screen would still work with every ASCII piece deleted, it is
being used correctly.

### Restraint and spectacle

A working screen (the library with a search in it, the detail form, settings) is quiet: no ambient motion,
nothing competing with the content. Spectacle is saved for moments:

| Moment | What happens |
| --- | --- |
| First paint, sign-in, the home hero | The flower field: mono characters arrive as noise and settle into the mark; they ripple under the pointer and are otherwise still |
| Opening a save | The card's cover moves into the detail's cover (a browser view transition) |
| Saving a link | The save tray opens the flower petal by petal beside "Kept in your archive."; the new card gets a one-off ring when you return to the wall from the save |
| Counts | Numbers in the hero and in an import result count up once |
| Import, AI jobs | An ASCII progress bar that is also a real `progressbar` |
| Nothing to show | A small ASCII drawing above the words. A library with no saves at all shows how to save instead: three steps, worded for where it is open (`emptyLibraryWords`) |
| The end of a page | The border garden: one row of text-art flowers. Static: it never moves, in any motion setting |
| An AI suggestion | A slow beam travels the card's border, beside the evidence label in words |

If an effect is not in this table it needs a reason to exist.

## Tokens

Both themes are first-class: every colour token has a light and a dark value, and
`src/styles/tokens.test.ts` checks each text/background pairing against WCAG AA in both.

| Group | Tokens | Use |
| --- | --- | --- |
| Paper | `paper`, `paper-deep`, `card`, `card-2`, `card-3` | Page, sidebar, cards, wells |
| Ink | `ink`, `ink-soft`, `line`, `line-strong` | Text, secondary text, hairlines, field borders |
| Sage | `sage`, `sage-deep`, `sage-pale`, `on-sage` | The one working colour: actions, selection, focus |
| Flower | `petal`, `petal-pale`, `petal-ink`, `butter`, `butter-pale`, `butter-ink`, `sky-*`, `lilac-*`, `clay-*` | Decoration and gentle status. Never the only signal |
| Status | `danger`, `danger-pale` | Destructive actions and errors |
| Island | `island`, `on-island`, `on-island-soft` | The dark pill for feedback, the dock, the bulk bar |

Rules:

- Components name tokens (`bg-card`, `text-ink-soft`), never hex values. The mark is the one exception: its
  colours are the brand's and do not change with the theme.
- On a `*-pale` ground, text uses the matching `*-ink` (or `ink`). `petal` and `butter` themselves are for
  shapes, not text.
- `text-sage` on a pale ground needs `dark:text-sage-deep` beside it.
- Colour never carries meaning alone. "To review" is a petal chip that says "To review".

## Type

| Role | Face | Where |
| --- | --- | --- |
| Display | Fraunces (soft), class `display` | Screen titles, dialog titles, the hero line, empty states |
| Working | Figtree Variable, the default | Everything else a person reads |
| Whisper | DM Mono, classes `label-mono`, `num`, `ascii` | Section labels, counts, evidence, ASCII |

Scale (Tailwind names): `2xs` 11px mono whisper, `xs` 12, `sm` 13 supporting, `base` 15 working, `lg` 17,
`xl` 20, `2xl` 24, `3xl` 30, `4xl` 40, `5xl` 52, `6xl` 68. Titles use `text-wrap: balance`. Form fields are
16px on touch so iOS does not zoom. All fonts are vendored; nothing is fetched from another origin.

Arabic and other scripts fall through to the system face. Any element showing text a person saved or wrote
has `dir="auto"`.

## Shape and space

- Radius: `xs` 8, `sm` 12, `md` 16 (fields, menus), `lg` 22 (cards), `xl` 28 (dialogs, sheets), `2xl` 36
  (the hero). Buttons, chips, tabs and the search box are full pills.
- Spacing is Tailwind's 4px scale. Page gutters: 16px phone, 24px tablet, 40px desktop.
- Shadows: `shadow-xs` resting, `shadow-md` lifted, `shadow-lg` floating (dialogs, island, dock).
- The page is dotted paper (one fixed radial gradient). Do not put a second texture on top of it. The one named
  exception is the **border garden** (`Garden` in `components/fx/ascii.tsx`), and it is bounded:
  - It is one row, planted only where a page ends: under the line at the true end of the wall (never while saves
    are loading or more can be loaded), at the foot of the wide sidebar under its last line (dropped whole, first,
    when the window is short), and under the library's empty states (sprouts and grass only: nothing saved, nothing
    bloomed).
  - It is in the page's flow. It is never behind text or a card, never fixed to the screen, and it ends above the
    dock's reserved space.
  - It is decoration: `aria-hidden`, not focusable, drawn left to right (`dir="ltr"`) in any page direction, thinned
    to a watermark in both themes, and still. Real text beside it carries anything worth knowing.
  - A bed shows as many whole plants as its width holds. A plant is never cut in half.

## Motion

- Two curves: `ease-out` (settles) and `ease-spring` (overshoots a little, for things that pop).
- Four lengths: `--dur-1` 120ms, `--dur-2` 200ms, `--dur-3` 320ms, `--dur-4` 520ms. Anything longer is a
  moment from the table above.
- Hover lifts and tilts a card by half a degree; press shrinks it by 1.5%. Hover styles use the `hov:`
  variant so they never stick on touch.
- **Reduced motion.** With `prefers-reduced-motion: reduce` CSS transitions are off (not shortened: a
  transition that runs at all keeps the old value for a frame, and the code that measures the wall would act
  on the old layout) and CSS animations are cut to a single frame, view transitions are off, the flower field draws its settled frame once and ignores the pointer,
  tickers show their final value, the beam is a still border, spinners hold one frame. State changes still
  happen; only the movement goes. Motion components are wrapped in `MotionConfig reducedMotion="user"`.
- Effects never change layout. Every effect is absolutely positioned inside a box whose size is set by
  content or by a fixed height.

## Layout

- **Wide (1024px and up):** a 264px sidebar, the top bar, the wall. Detail is a 540px drawer on the end edge.
- **Narrow:** no sidebar. A floating dock at the bottom (Library, Search, Save, Browse, Settings) with Save in
  the middle. Dialogs are sheets rising from the bottom edge; the detail is full screen. While a selection is
  active the dock steps aside for the bulk bar.
- **The detail's footer** holds Save changes, and for a save with a recipe to cook from, Start cooking beside it
  with a line of what the cooking takes. One of the two is the strong button: Start cooking while the form is clean,
  Save once there is something to save.
- **The save tray** (`features/save-moment/`) answers a saved link: an island-coloured card above the dock (bottom
  end corner on a wide screen) that says the link was kept and offers up to two of the person's own collections,
  the fullest first, and "To revisit" as chips. A chosen chip carries a tick as well as the petal colour. It
  leaves after five seconds unless it is touched or a key is pressed in it, then stays until Done or Escape; it
  steps aside for any dialog, an opened save or another view. A link that was already in the library gets the
  same card with when and where the first copy is, and no countdown. It is never drawn over a dialog.
- **The wall** is a shortest-column masonry computed from data (`features/library/masonry.ts`). A card's
  height is known before it is drawn, so nothing shifts and only the cards near the screen exist in the page.
- **RTL-safe.** Use logical utilities only: `ps-`/`pe-`, `ms-`/`me-`, `start-`/`end-`, `text-start`,
  `border-s`. Never `left`/`right`, `pl-`/`pr-`, `ml-`/`mr-`, `text-left`. Positioned cards use
  `inset-inline-start`.
- **Safe areas.** `--safe-top` and `--safe-bottom` are added to the top bar, the island, the dock, sheet
  footers and the detail header. The viewport is `viewport-fit=cover`.
- Touch targets are 44px. A small control gets the class `hit-44`, which extends its hit area without
  changing how it looks.

## Accessibility

- WCAG AA contrast in both themes (tested). One focus treatment everywhere: a 2.5px sage outline, keyboard
  focus only.
- Every dialog is a Radix dialog: focus is trapped, Escape closes, focus returns to what opened it. If that
  is gone (a card that left the wall), focus goes to a card that is on screen, else to the view's heading.
  Focus never falls to `<body>`.
- The view title is the page's `h1` and takes focus when a view is reached from the phone's sheet.
- The wall is a `feed` of `article`s with position and set size. Counts and progress are `status` regions;
  errors are `alert`s.
- Decorative ASCII and moving digits are `aria-hidden`; the real value is always present as text.
- Leaving a save with unsaved edits asks first, including with the browser's Back button.
- Text from a saved post is untrusted. It is rendered as text; `dangerouslySetInnerHTML` is a lint error.

## Building blocks

Use these before writing something new.

| Need | Use |
| --- | --- |
| A dialog, sheet or drawer | `components/modal.tsx` (`Modal`, `variant="panel"` for a drawer) |
| A yes/no question | `confirm({...})` from `app/ui-state.ts` |
| An action that may send saved content to an AI service | `await allowAi(archive, action)` from `features/ai-permission/gate.ts`, before the call; stop on false |
| A link to the privacy policy or the terms | `components/legal-links.tsx` (addresses come from `lib/site.ts`) |
| Feedback after an action | `toast(text)`, `toast(text, { error: true })`, `toast(text, { tone: 'saved' })` |
| The answer to a saved link | `showSaveMoment(item)` from `features/save-moment/store.ts` (the tray, not a toast) |
| A button that runs something async | `useBusy()` from `app/archive-context.tsx` with `aria-busy` |
| Buttons | `components/ui/button.tsx`: `primary`, `soft`, `outline` (default), `ghost`, `danger`, `danger-ghost` |
| A labelled field, form error, notice, section | `components/field.tsx` |
| One choice from a few | `components/ui/segmented.tsx` |
| One choice from a menu | `components/pick.tsx` |
| A section label in the terminal voice | `Whisper` |
| ASCII art, spinner, progress | `components/fx/ascii.tsx` |
| The row of flowers at the end of a page | `Garden` in `components/fx/ascii.tsx`, with a bed: `wall`, `side` or `sprouts` |
| A number that counts up | `components/fx/number-ticker.tsx` |
| Marking an AI suggestion | `components/fx/border-beam.tsx`, always with the evidence label in words |
| A feature screen's header, gate and empty states | `features/feature-kit.tsx` |

A new screen is a default export in `src/features/<name>/screen.tsx`, registered in
`src/features/screens.tsx`, with its address handled by `src/data/location.ts`. It makes its calls through
`useArchive().api.request` (or typed calls in `src/features/<name>/api.ts`), never through `fetch`.

## Honesty rules carried into the design

- An AI suggestion always shows what it rests on (the evidence label) and changes nothing until accepted.
- Before saved content is sent to a service outside the person's own server, the app asks once and says what is sent
  and to whom, in the server's own terms (`features/ai-permission`). It never says "private" about a hosted account.
- A transcript says it is automatic and says nothing about what is on screen.
- An import says what the file establishes and what it does not.
- A placeholder says it is a placeholder. A locked feature says it is locked and what stays free.
- Instructions describe the place they are read in. The share sheet is taught only inside the phone app, and it says
  the app opens on the save dialog and keeps nothing until Save is tapped.
- A way into a feature is shown only when the data says it leads somewhere: "Start cooking" is pinned to a save's
  detail only for a recipe card with steps, and never on a locked account, which is not asked about the save.
- The demo says, on every screen, that it is synthetic.

## Performance budget

- No WebGL anywhere on the path to the library. The flower field is a 2D canvas in its own chunk; it draws
  only while something is unsettled and stops its frame loop otherwise.
- Heavy dialogs (settings, activity, organize, import, the palette) and every feature screen are separate
  chunks, loaded on first use.
- The wall renders a window of cards (about 900px beyond the screen each way). Thumbnails are lazy and
  decoded off the main thread.
- Nothing is fetched from another origin at runtime: no fonts, scripts, icons or telemetry. Remote previews
  and map tiles are off until the owner turns them on.

## Content-Security-Policy

The server sends `script-src 'self'`, `style-src 'self' 'nonce-…'` and `img-src 'self' data: https:`, with a fresh
nonce on every response for the page (`server/webui.py`); there is no `'unsafe-inline'` for styles. The demo page in
`ui/demo.html` carries its own stricter policy for connections (`connect-src 'none'`, `img-src 'self'`) but allows
inline styles, because a static host cannot make a nonce. So:

- No inline scripts (the theme is set by `public/theme-init.js`), no `style` attributes and no `<style>` in markup:
  use classes. The page's first frame in `index.html` is styled by `.boot` in `src/styles/index.css`.
- Styles set from script (`element.style`, React's `style` prop) are fine: to the browser they are not inline styles.
- A library that adds its own `<style>` element at run time must be given the nonce. `cspNonce()` in
  `src/lib/nonce.ts` returns it. Today that is the dialog's scroll lock (it reads `window.__webpack_nonce__`, which
  `theme-init.js` sets), the select's scrollbar rule (`nonce` on the viewport, in `components/ui/select.tsx`), motion's
  pop layout (`nonce` on `MotionConfig`) and the segmented control (it reads `meta[property="csp-nonce"]` itself).
  Add the next one beside these.
- No `data:` images in CSS and no requests from the demo.

`tests/e2e/fixtures.mjs` fails any browser test on a policy violation, and `tests/e2e/screens.spec.mjs` opens every screen
and dialog on a real server, so a new inline style is found by the suite, not by a user.
