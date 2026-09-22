// Drawing primitives for the league's social images, on sharp + SVG.
//
// ── What this replaced, and the one fact that governs everything here ────────
//
// The cards used to be drawn with Jimp and pre-baked bitmap fonts (`fonts/*.fnt` plus a
// `.png` atlas). Jimp cannot scale a bitmap font, so the sizes that existed were the sizes
// there were — in white, 30 and 60 and nothing between — and the fixtures card had to
// choose between three whole LAYOUTS to fit its text. All of that goes away when text can
// be any size.
//
// **A MISSING FONT DOES NOT RENDER BLANK.** It falls back to a default face and draws
// perfectly legible text in the wrong typeface, reporting nothing. Measured 22 Sep 2026:
// `font-family="Poppins"` and `font-family="NoSuchFontXYZ"` produced byte-identical output
// on a machine without Poppins installed. That single fact shapes three things:
//
//   * the Dockerfile asserts `fc-list | grep -qx Poppins` at BUILD time, so a missing font
//     fails the build rather than shipping;
//   * `fontsResolve()` below is the runtime equivalent, and the test uses it;
//   * the check is "does this differ from a deliberately nonsense family", never "is it
//     blank" — a blank-text check passes happily while every card is in the wrong face.
//
// Two other things that were tried and do not work, so nobody need try them again:
//
//   * **`FONTCONFIG_PATH` and `FONTCONFIG_FILE` are ignored** by sharp's bundled libvips on
//     macOS, so you cannot point it at a font directory from the shell or from `process.env`.
//   * **librsvg does not honour `@font-face` with a base64 data URI.** Embedding the font in
//     the SVG would have removed the system-font dependency altogether; it renders the
//     fallback face instead.
//
// The practical consequence: **cards rendered outside the container are in the wrong
// typeface.** Build and run the image to look at them for real.

const sharp = require('sharp');

// The site's own typefaces. `views/header.ejs` loads both from Google Fonts and
// `static/css/modern-styles.css` sets Poppins for headings, so the pictures the league
// posts now match the website they point at. Vendored under the OFL in `fonts/vendor/`.
//
// **Only two weights per family exist, and that is deliberate.** A SemiBold static instance
// reports its family as "Poppins SemiBold" rather than as weight 600 of "Poppins", so
// `font-weight="600"` silently synthesises a fake bold instead of selecting it. See
// `fonts/vendor/README.md`.
const HEAD = 'Poppins';
const BODY = 'Inter';

// Rough average glyph advance as a fraction of font-size, used only to decide whether a
// line needs shrinking. Measured off these two faces at the sizes these cards use; it is
// an estimate on purpose: it only has to be close enough to pick a size that fits. There is
// no second line of defence — `textLength` is ignored by librsvg — so it errs high.
// **Deliberately a slight OVER-estimate.** If the estimate is optimistic, `textLength`
// never fires and a long name runs into its neighbour — which is exactly what
// "Manchester Edgeley A" did to the P column on the league table, because 0.55 undersold
// Inter Bold. Erring high costs a little unnecessary squeezing on a borderline line;
// erring low costs a collision, and collisions are only visible by looking at the picture.
const ADVANCE = { [HEAD]: 0.63, [BODY]: 0.58 };

function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/** Estimated rendered width of `text`, in pixels. */
function widthOf(text, size, family = BODY, weight = 'normal') {
  const bold = weight === 'bold' || Number(weight) >= 600 ? 1.06 : 1;
  return String(text == null ? '' : text).length * size * (ADVANCE[family] || 0.55) * bold;
}

/**
 * The largest size from `max` down that fits `maxWidth`, never below `min`.
 *
 * This is the whole reason for moving off bitmap fonts: the old code picked a LAYOUT to
 * fit the text because it could not pick a size. Now a long team name just gets smaller.
 */
function fitSize(text, maxWidth, { family = BODY, weight = 'normal', max = 60, min = 22 } = {}) {
  let size = max;
  while (size > min && widthOf(text, size, family, weight) > maxWidth) size -= 1;
  return size;
}

/**
 * One `<text>` element.
 *
 * **`maxWidth` shrinks the type. It does NOT use `textLength`, because librsvg ignores
 * that attribute entirely** — measured inside the image 22 Sep 2026: "Manchester Edgeley A"
 * at 48px renders 526px wide with or without `textLength="512"`, byte for byte. An earlier
 * version of this file emitted it and claimed in a comment that it was "a hard guarantee"
 * the text could never overflow. It was decoration, and the league table's longest team
 * name ran straight into the P column underneath it.
 *
 * So the fit is done the only way that works here: pick a smaller size. `widthOf` deliberately
 * over-estimates, so this errs towards shrinking a line that would just about have fitted
 * rather than letting one collide.
 */
function text(content, { x, y, size, family = BODY, weight = 'normal', fill = '#ffffff',
                         anchor = 'start', opacity = 1, letterSpacing = 0, maxWidth = null } = {}) {
  const drawn = maxWidth
    ? fitSize(content, maxWidth, { family, weight, max: size, min: 12 })
    : size;
  const attrs = [
    `x="${x}"`, `y="${y}"`,
    `font-family="${family}"`, `font-size="${drawn}"`, `font-weight="${weight}"`,
    `fill="${fill}"`, `text-anchor="${anchor}"`,
  ];
  if (opacity !== 1) attrs.push(`opacity="${opacity}"`);
  if (letterSpacing) attrs.push(`letter-spacing="${letterSpacing}"`);
  return `<text ${attrs.join(' ')}>${esc(content)}</text>`;
}

/** A filled rectangle — panels and rules. */
function rect(x, y, w, h, { fill = '#000000', opacity = 1, rx = 0 } = {}) {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" ` +
         `fill="${fill}"${opacity !== 1 ? ` opacity="${opacity}"` : ''}/>`;
}

// Decoded, resized backgrounds, cached by file+size.
//
// sharp pipelines are immutable — unlike Jimp, where `print`/`resize`/`composite` mutate in
// place and a shared instance accumulated every card ever drawn on it. So this caches the
// finished PIXELS and there is no clone-per-use rule to remember.
const backgrounds = new Map();

async function background(file, width, height) {
  const key = `${file}@${width}x${height}`;
  if (!backgrounds.has(key)) {
    backgrounds.set(key, sharp(file).resize(width, height, { fit: 'cover' }).png().toBuffer());
  }
  return backgrounds.get(key);
}

function resetBackgroundCache() { backgrounds.clear(); }

/** Compose an SVG body over a background and encode. */
async function render({ file, width, height, body, format = 'jpeg' }) {
  const base = await background(file, width, height);
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${body}</svg>`);
  const pipeline = sharp(base).composite([{ input: svg, top: 0, left: 0 }]);
  return format === 'jpeg' ? pipeline.jpeg({ quality: 90 }).toBuffer() : pipeline.png().toBuffer();
}

/**
 * Do the card fonts actually resolve?
 *
 * Renders each family against a deliberately nonsense family name and reports which ones
 * came out identical — those fell back. **This is the only reliable check**, because a
 * missing font produces readable output rather than an error or a blank.
 *
 * Returns `{ ok, missing: [] }`. Used by the test suite and callable from a shell inside
 * the image (`node -e "require('./utils/cardRender').fontsResolve().then(console.log)"`).
 */
async function fontsResolve() {
  const probe = (family, weight) => Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="420" height="70">` +
    `<rect width="420" height="70" fill="#000"/>` +
    `<text x="10" y="50" font-family="${family}" font-weight="${weight}" ` +
    `font-size="38" fill="#fff">Manchester Edgeley</text></svg>`);
  const png = async (f, w) => (await sharp(probe(f, w)).png().toBuffer()).toString('base64');

  const missing = [];
  for (const family of [HEAD, BODY]) {
    for (const weight of ['normal', 'bold']) {
      // The control shares the weight, so synthetic bolding cannot be mistaken for a
      // resolved face — an early version of this compared bold against normal and read a
      // synthesised bold as success.
      const [got, fallback] = await Promise.all([png(family, weight), png('NoSuchFontXYZ', weight)]);
      if (got === fallback) missing.push(`${family} ${weight}`);
    }
  }
  return { ok: missing.length === 0, missing };
}

module.exports = {
  HEAD, BODY, esc, text, rect, widthOf, fitSize,
  background, render, resetBackgroundCache, fontsResolve,
};
