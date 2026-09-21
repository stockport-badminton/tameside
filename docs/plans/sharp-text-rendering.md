# Move the social images from Jimp to sharp

**Status:** open, agreed 21 Sep 2026. Not started.
**Owns:** `controllers/social_controller.js`, `Dockerfile`, `fonts/`
**Do it after:** this week's fixtures and video posts have gone out cleanly.

Self-contained: pick this up cold, without the conversation that produced it.

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
