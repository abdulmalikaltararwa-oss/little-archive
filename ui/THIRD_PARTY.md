# Third-party work in `ui/`

Little Archive is MIT-licensed. Everything listed here may be used in an MIT open-source project, and
everything is vendored or installed from npm and bundled: nothing is fetched from another origin at
runtime, and there is no telemetry. Licences were checked against each project's own LICENSE file on
14 November 2026. If you add something, add a row; if a licence does not clearly allow redistribution
inside an MIT project, do not add it.

## Components copied into the source

These are source files adapted from copy-and-paste component collections. Each file names its origin in
its first comment and says what was changed.

| File | From | Licence | What changed |
| --- | --- | --- | --- |
| `src/components/ui/button.tsx`, `checkbox.tsx`, `command.tsx`, `dropdown-menu.tsx`, `input.tsx`, `popover.tsx`, `select.tsx`, `switch.tsx`, `textarea.tsx` | [shadcn/ui](https://ui.shadcn.com) (`shadcn@4.23.0 add …`) | MIT | Restyled to Little Archive's tokens (pills, radii, 44px touch targets, logical properties); the dialog, sheet and alert-dialog files were replaced by `src/components/modal.tsx` and `confirm.tsx`, written directly on the Radix primitives |
| `src/components/fx/number-ticker.tsx` | [Magic UI: Number Ticker](https://magicui.design/docs/components/number-ticker) | MIT | Locale formatting, the real value always present for assistive technology, counts from the previous value, reduced motion shows the final value |
| `src/components/fx/border-beam.tsx` | [Magic UI: Border Beam](https://magicui.design/docs/components/border-beam) | MIT | Theme colours, a still border under reduced motion, hidden from assistive technology |
| `src/components/fx/text-scramble.tsx` | [Motion Primitives: Text Scramble](https://motion-primitives.com/docs/text-scramble) | MIT | No component created during render, settled text read by assistive technology from the first frame, reserved width, timer cleanup, reduced motion |
| `src/components/island.tsx` | [Cult UI: Dynamic Island](https://www.cult-ui.com/docs/components/dynamic-island) | MIT | Only the idea and its spring (stiffness 400, damping 30, blur on exit) are taken; the queue, tones, live-region roles and the flower are Little Archive's |

Everything else under `src/` is Little Archive's own, including the flower field
(`src/components/fx/ascii-field-engine.ts`), the ASCII drawings, the masonry, the dock, the command
palette's contents and every screen.

## Libraries installed from npm (bundled into the build)

| Package | Version | Licence | Used for |
| --- | --- | --- | --- |
| `react`, `react-dom` | 19.3.1 | MIT | The interface |
| `radix-ui` | 1.8.1 | MIT | Dialog, alert dialog, select, popover, dropdown menu, checkbox, switch primitives |
| `motion` | 14.14.0 | MIT | The island, the flower opening, the number ticker, the border beam |
| `cmdk` | 1.1.1 | MIT | The command palette and the topic filter |
| `zustand` | 5.1.0 | MIT | The library store and interface state |
| `lucide-react` | 1.73.0 | ISC | Icons (the Instagram and TikTok outlines are Little Archive's own) |
| `class-variance-authority` | 0.7.1 | Apache-2.0 | Button variants |
| `cn` | 0.5.2 | MIT | Class-name merging (what the shadcn CLI now generates) |
| `@ui-sdk/core`, `@ui-sdk/react` | 0.1.0-beta.1 | Apache-2.0 | One primitive: the segmented control (`src/components/ui/segmented.tsx`). Beta software; it is imported in that one file only |
| `leaflet` | 1.9.4 | BSD-2-Clause | The places map, loaded only when the owner has set a tile server |
| `tailwindcss`, `@tailwindcss/vite`, `tw-animate-css` | 4.3.5, 4.3.5, 1.4.0 | MIT | Styles (build time) |

Development only (not in the build): `vite` (MIT), `@vitejs/plugin-react` (MIT), `typescript`
(Apache-2.0), `vitest` (MIT), `jsdom` (MIT), `@testing-library/*` (MIT), `@playwright/test`
(Apache-2.0), `eslint` and its plugins (MIT).

## Fonts (vendored, served from the app's own origin)

| Face | Source | Licence |
| --- | --- | --- |
| Fraunces (soft) | `web/fonts/fraunces-soft.woff2`, shared with the buildless interface | SIL OFL 1.1 (`web/fonts/Fraunces-OFL.txt`) |
| Figtree Variable | `@fontsource-variable/figtree` 5.3.0 | SIL OFL 1.1 |
| DM Mono 400 and 500 | `@fontsource/dm-mono` 5.3.0 | SIL OFL 1.1 |

## Looked at and not used

| What | Why not |
| --- | --- |
| Aceternity UI | Its terms reserve all rights and forbid redistributing the components' source. Not usable in an open-source repository |
| Efferd (current registry) | Its licence forbids publishing the blocks; only a legacy repository is MIT |
| 21st.dev components | Terms forbid redistribution without authorisation, and the registry needs a paid key. MIT items should be taken from their authors' own repositories |
| Canvas UI (ASCII from 3D) | "MIT + Commons Clause", and it needs WebGL and three.js |
| ASCII Magic | All rights reserved; a hosted converter, not a library |
| Nyx UI AsciiText | No LICENSE file in the repository |
| asciicn, ascii.rest, ts-ascii-engine, Lightswind Ascii Wave, ascii.cnlibs.com | All MIT and usable. Not needed: the flower field had to be drawn from Little Archive's own mark, on a 2D canvas, and is about 300 lines |
| Magic UI Dock, Origin UI (coss ui), ReUI, UI Layouts | All MIT and usable. The dock's magnification is a pointer effect and the dock here is for touch; the other collections had nothing the shadcn base did not already cover for these screens |
| MapLibre GL | Loads tiles with `fetch` (blocked by the server's `connect-src 'self'`) and needs WebGL |
