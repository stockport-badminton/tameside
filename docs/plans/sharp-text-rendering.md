# Move the social images from Jimp to sharp

**Status: DONE, 22 Sep 2026.** Kept because it records what was measured, and because two
of its own original instructions were wrong — see *What this package got wrong* below.

All three cards (result, division table, fixtures) draw with sharp + SVG text in Poppins
and Inter, the site's own typefaces. `jimp` is off the dependency list. `utils/cardRender.js`
holds the primitives; `utils/socialVideo.js`'s letterbox is a sharp `resize({fit:'contain'})`.

## What this package got wrong, and what replaced it

**1. "Add a test that renders a card, renders the same card with every label blanked, and
asserts the two differ."** That catches BLANK text. It does not catch the failure that
happens: **a missing font does not render blank.** fontconfig falls back to a default face
and draws perfectly legible text in the wrong typeface, reporting nothing. Measured:
`font-family="Poppins"` and `font-family="NoSuchFontXYZ"` produced byte-identical output on
a machine without Poppins. The blank-text test would have passed against every one of those
cards. The real check compares against a deliberately nonsense family **at the same
weight** — an early probe compared bold against normal and read synthetic bolding as
success. It lives in `cardRender.fontsResolve()`.

**2. "Verify inside the built image."** Right instruction, and it was the only thing that
worked — but it was written assuming Docker was unavailable. It was available, and building
locally is what caught everything below. Nothing in `npm test` would have.

## What only showed up by looking at the rendered picture

- **librsvg ignores `textLength`.** The first version used it to guarantee a line could
  never overflow, and said so in a comment. Measured in the image: "Manchester Edgeley A" at
  48px renders 526px wide with or without `textLength="512"`, byte for byte. The league
  table's longest team name ran straight into the P column. `maxWidth` now shrinks the type
  via `fitSize`, which is the only thing that works here.
- **librsvg ignores `@font-face` with a base64 data URI.** Embedding the font in the SVG
  would have removed the system-font dependency entirely. It renders the fallback instead.
- **sharp's bundled libvips ignores `FONTCONFIG_PATH` and `FONTCONFIG_FILE` on macOS**, so
  the vendored fonts cannot be made resolvable outside the container. Cards rendered on a
  laptop are in the wrong face and look fine.
- **The result card collided for long names.** The score was right-aligned on the away
  team's baseline, which works for "Hyde C" and fails for "Manchester Edgeley B". Every test
  passed — the bytes were a valid JPEG of the right size. It is a vertical flow now, and the
  panel height is derived from that flow rather than estimated alongside it.
- **The league table stepped a fixed 115px per number column**, so the digits went ragged as
  soon as a value went from one digit to two, and this league's games-won column reaches
  three. Right-aligned now.

## Where the guarantee actually lives

**In the Dockerfile.** `fc-list : family | grep -qx Poppins` runs at build time, so a
missing or misnamed font fails the build and cannot ship. `fontconfig` is named explicitly
rather than inherited from ffmpeg. `test/card-fonts.test.js` pins that assertion, and
deliberately does not assert the fonts resolve — that would fail on every developer machine,
which is worse than no test.

## The fonts

`fonts/vendor/`, SIL OFL, licences alongside as the OFL requires. **Regular and Bold only:**
a static SemiBold reports its family as "Poppins SemiBold" rather than weight 600 of
"Poppins", so `font-weight="600"` silently synthesises a fake bold instead of selecting it.
Read a font's name table before adding a weight. `fonts/Arial.ttf` was proprietary Monotype
Arial and has been removed.

---

## Original package, for the record

## Why this is now possible, when CLAUDE.md says it is not

`CLAUDE.md` (*Social Image Generation*) says the drawing must stay Jimp because this image
has no fontconfig and no system font, deliberately — and that copying the Stockport site's
sharp + SVG drawing code across "renders every label blank in production and nowhere else".

**That stopped being true on 21 Sep 2026**, and by accident. Adding ffmpeg for the weekly
results video pulled in 200 packages, among them:

```
fontconfig  fontconfig-config  fonts-dejavu-core  libfontconfig1  libfreetype6
libharfbuzz0b  libcairo2  libpango-1.0-0  libpangocairo-1.0-0  libpangoft2-1.0-0  librsvg2-2
```

That is everything sharp's SVG text rendering needs, including an actual font. The rule and
the image now disagree, which is its own reason to resolve this rather than leave it.

**Do not simply start relying on it.** Those are ffmpeg's *transitive* dependencies. If
ffmpeg is ever dropped, the base image changes, or Debian re-packages, text rendering
breaks — and it breaks by rendering **blank**, in production, and nowhere else, because
every developer machine has fonts. Step 1 below exists to close that.

## Why bother — the case, honestly

**For:**

- **Text scales freely.** The fixtures card currently picks between three *layouts*
  (`ROW_LAYOUTS` in `social_controller.js`) because Jimp cannot scale a bitmap font and
  `fonts/` holds white faces at only 30 and 60. All of that machinery — plus the 23%
  overflow problem it exists to dodge — deletes itself. Expect that file to lose most of
  its awkwardness.
- **Parity with `~/league-site`.** These two sites share an Auth0 tenant, an S3 bucket, a
  Meta app and a steady traffic of ported features. Two different rendering stacks means
  every future port of anything that draws has to be rewritten rather than copied. This is
  the single biggest remaining divergence in the social stack.
- **sharp is already a production dependency** (`utils/scorecardVision.js`), so nothing new
  is added to `package.json`.

**Against, and these are why it is a separate piece of work:**

- It is **three cards, not one** — result, division table, fixtures. The first two are
  posted weekly and work today. A partial migration leaves two rendering stacks, which is
  worse than either one.
- The failure mode is **silent and environment-specific**. See step 3.
- **The typeface changes.** DejaVu is not Arial.

## The trap already in the repo

`fonts/Arial.ttf` and `fonts/fonts.conf` exist, and `FONTCONFIG_PATH` is set on the Cloud
Run service. **None of it is a working setup, and it will cost an hour if believed:**

- `fonts/fonts.conf` points at `<dir>/var/task/fonts/</dir>`. `/var/task` is **AWS
  Lambda's** code directory. It is a leftover from a previous deployment target and matches
  nothing in this image, where the app lives at `/usr/src/app`.
- `FONTCONFIG_PATH=/etc/fonts` on the service is simply the Debian default, so it changes
  nothing.

Either fix `fonts.conf` to point at the real path and install it, or delete both and use a
system font package. Do not leave it half-true.

## Steps

1. **Declare the dependency in the `Dockerfile`.** Add `fontconfig` and a font package to
   the existing `apt-get install` line explicitly, alongside `ffmpeg`, so the fonts survive
   ffmpeg being removed. If the cards are to keep Arial's look, `fonts-liberation`
   (Liberation Sans is metric-compatible with Arial) is the usual answer and is ~2MB;
   otherwise `fonts-dejavu-core` is already there. **Decide the typeface first** — it
   changes every card.

2. **Port the drawing, all three cards together.** `~/league-site/controllers/socialController.js`
   has the shapes: `createFixturesImage`, `createDivisionTableImage`, and its result card.
   Their fixtures card is a good model — dark panel at 0.80, white text, home right-aligned
   / `v` centred / away left-aligned, and an accent colour sampled from the division
   artwork's **top strip** (`accentFor`; sampling the whole image returns the near-white
   fade across the bottom third, which is how an earlier draft of theirs produced white
   text on a near-white bar).

3. **Add the test that can catch blank text, and add it before the migration, not after.**
   Render a card, render the same card with every label blanked, assert the two differ by
   more than JPEG noise. Cheap, runs in CI, and it is precisely the check that would have
   caught the Stockport carousel drawing blank labels for four months. A test that merely
   asserts "bytes came back" passes against a completely empty picture.

4. **Verify inside the built image, not on a laptop.** `docker build . && docker run` and
   fetch `/fixtures-image/Division%201.jpg`, `/league-table-image/Division%201.jpg` and a
   `/resultImage/...`. Look at all three. macOS has fonts and will render correctly whatever
   the Dockerfile says, so a local `npm run dev` proves nothing at all here.

5. **Delete the Jimp path and the `.fnt`/`.png` font sheets** once all three are across, and
   drop `jimp` from `package.json` if nothing else uses it (check `utils/socialVideo.js`,
   which uses Jimp for the letterbox step — that can move to sharp too, or stay).

## Acceptance

- All three cards render correctly **from inside the built image**, checked by eye.
- The Dockerfile names fontconfig and a font explicitly; removing `ffmpeg` from that line
  does not break text.
- A test fails if a card renders with no text on it.
- `ROW_LAYOUTS` and the bitmap-size branching are gone.
- `fonts/fonts.conf` is either correct or deleted, and `FONTCONFIG_PATH` on the service is
  either meaningful or removed.

## Out of scope

- The weekly video's encode. ffmpeg stays regardless; only the slide *drawing* is affected,
  and it comes free with the result card.
- Changing what the cards say. This is a rendering change — if the copy or layout should
  change too, do it in a separate commit so a visual regression has one cause.
