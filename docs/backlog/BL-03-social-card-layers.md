# BL-03: Build the social cards from layers

**Size:** large (artwork as well as code) · **Parked:** 2 Oct 2026 · **Upstream:** league-site
`docs/hardening/done/HARD-37-social-card-artwork.md`, `tools/artwork/README.md`

## Why

Each division's card background is one flattened PNG, with the numeral and the fade baked
in (`static/images/bg/social-Division-1.png`, `social-Division-2.png`, `social.png`). That
fixes the composition. The 9:16 story had to inset the 4:5 artwork over a blurred copy of
itself because nothing could be moved. With the background, the foreground players, the
division numeral, the text and the text panel kept as separate layers, each format could
place them where they fit.

## What Stockport learned (HARD-37)

- **The layers were never lost.** Subject, background, letter and fade are separate in the
  GIMP `.xcf` and are only welded together at export.
- Where a clean background could not be recovered from the `.xcf`, they **generated** one
  (`tools/artwork/lowpolybg.js`, seeded so a render can be reproduced). `polyart.js`
  reproduces the subject filter. The abstraction is there to de-identify the players, so
  "sharper" is the wrong direction.
- **Re-pointing the background and redesigning the text layout are one job.** The old cards
  put dark text where the artwork faded to white. On a clean background that renders and
  passes the tests, but the text is unreadable.
- Source photos and `.xcf` files stay **out of git**. They are the un-abstracted originals.

## Where to start

- The layered sources are probably `~/Desktop/tameside-1.xcf` and
  `~/Desktop/division2social.xcf` (Aug 2024). Nobody has inspected them yet. List their
  layers first. GIMP 2.10 is installed.
- The cards are drawn in `controllers/social_controller.js` on `utils/cardRender.js`.
- **Look at every render inside the container.** Fonts resolve only there (see CLAUDE.md,
  Social Image Generation).
