// Do the social cards actually render in the fonts they ask for?
//
// ── Why this is not the test the plan called for ─────────────────────────────
//
// `docs/plans/sharp-text-rendering.md` proposed: render a card, render it again with the
// labels blanked, assert the two differ. That catches BLANK text. It does not catch the
// failure that actually happens.
//
// **A missing font does not render blank.** fontconfig falls back to a default face and
// draws perfectly legible text in the wrong typeface, reporting nothing — no error, no
// warning, a card that looks fine until you notice it is not your brand. Measured
// 22 Sep 2026: `font-family="Poppins"` and `font-family="NoSuchFontXYZ"` produced
// byte-identical output on a machine without Poppins installed. The blank-text test would
// have passed against every one of those cards.
//
// So the real question is "does this differ from a deliberately nonsense family name",
// which is what `cardRender.fontsResolve()` asks.
//
// ── Why this does not assert `ok === true` ───────────────────────────────────
//
// **Because it would fail on every developer machine, and that is worse than no test.**
// sharp's bundled libvips ignores `FONTCONFIG_PATH` and `FONTCONFIG_FILE` on macOS, and
// librsvg does not honour `@font-face` with a data URI — both tried, both dead ends — so
// the vendored fonts cannot be made resolvable outside the container. The fonts are
// installed into the image by the Dockerfile, and the **Dockerfile asserts them at build
// time** (`fc-list : family | grep -qx Poppins`), which is where that guarantee belongs: a
// missing font fails the build and never ships.
//
// What this file pins instead is the part that is environment-independent: that the probe
// is capable of telling the two cases apart, and that the card code asks for the right
// families. Then it reports what it found, so a run inside the image reads as a check
// rather than as noise.

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const card = require('../utils/cardRender');

const ROOT = path.join(__dirname, '..');

describe('the font probe', () => {
  // The probe's own logic, which holds everywhere. If both families resolve it must say so;
  // if neither does it must name both. What it must never do is report success because it
  // compared a real bold against a synthesised one — an early version did exactly that, and
  // read a fallback face's synthetic bold as proof the font had loaded.
  it('reports every family it checks, resolved or not', async () => {
    const result = await card.fontsResolve();
    assert.ok(typeof result.ok === 'boolean');
    assert.ok(Array.isArray(result.missing));
    // Four checks: two families times two weights.
    const names = ['Poppins normal', 'Poppins bold', 'Inter normal', 'Inter bold'];
    for (const m of result.missing) assert.ok(names.includes(m), `unexpected entry: ${m}`);
    assert.strictEqual(result.ok, result.missing.length === 0);

    // Reported rather than asserted — see the note at the top. Inside the container this
    // line reads "all resolved"; on a laptop it names what fell back.
    console.log(result.ok
      ? '    [fonts] Poppins and Inter both resolved'
      : `    [fonts] fell back (expected outside the container): ${result.missing.join(', ')}`);
  });

  it('compares against a nonsense family at the SAME weight', () => {
    const src = fs.readFileSync(path.join(ROOT, 'utils/cardRender.js'), 'utf8');
    const probe = src.slice(src.indexOf('async function fontsResolve'));
    // The control must share the weight being tested. Comparing a bold against a normal
    // fallback makes synthetic bolding look like a resolved font.
    assert.match(probe, /png\(family, weight\)/, 'the probe does not vary the family at a fixed weight');
    assert.match(probe, /png\('NoSuchFontXYZ', weight\)/, 'the control does not share the weight');
  });
});

describe('what the cards ask for', () => {
  // The families are named in one place so a rename cannot leave one card behind.
  it('uses the site\'s own typefaces', () => {
    assert.strictEqual(card.HEAD, 'Poppins');
    assert.strictEqual(card.BODY, 'Inter');
  });

  // Every font-family the drawing emits must come from those two constants. A literal
  // family name in a card would render fine locally and fall back in the image, or vice
  // versa, and nothing would say so.
  it('never hardcodes a family name in a card', () => {
    const src = fs.readFileSync(path.join(ROOT, 'controllers/social_controller.js'), 'utf8');
    const hardcoded = src.match(/family:\s*['"][^'"]+['"]/g) || [];
    assert.deepStrictEqual(hardcoded, [],
      `cards must use card.HEAD / card.BODY, found: ${hardcoded.join(', ')}`);
  });

  // The vendored files, and the licences the OFL requires to travel with them.
  it('ships the font files and their licences', () => {
    const dir = path.join(ROOT, 'fonts/vendor');
    for (const f of ['Poppins-Regular.ttf', 'Poppins-Bold.ttf',
                     'Inter-Regular.ttf', 'Inter-Bold.ttf',
                     'POPPINS-OFL.txt', 'INTER-OFL.txt']) {
      assert.ok(fs.existsSync(path.join(dir, f)), `fonts/vendor/${f} is missing`);
    }
  });

  // **The guarantee that actually ships.** A missing font fails the build rather than
  // producing a card in the wrong face, so this pins the Dockerfile assertion.
  it('makes the Dockerfile fail the build if a font is missing', () => {
    const df = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
    assert.match(df, /COPY fonts\/vendor\//, 'the fonts are not copied into the image');
    assert.match(df, /fc-cache -f/, 'fc-cache is not run, so fontconfig will not see them');
    assert.match(df, /fc-list : family \| grep -qx Poppins/, 'the build does not assert Poppins');
    assert.match(df, /fc-list : family \| grep -qx Inter/, 'the build does not assert Inter');
    // fontconfig must be named, not inherited from ffmpeg.
    assert.match(df, /apt-get install[^\n]*fontconfig/, 'fontconfig is not an explicit dependency');
  });

  // No SemiBold: a static SemiBold reports its family as "Poppins SemiBold", so
  // font-weight 600 silently synthesises a fake bold instead of selecting it.
  it('ships only the weights that resolve by weight', () => {
    const files = fs.readdirSync(path.join(ROOT, 'fonts/vendor')).filter(f => f.endsWith('.ttf'));
    assert.deepStrictEqual(files.filter(f => /SemiBold|Medium|Light/i.test(f)), [],
      'a non-Regular/Bold static instance reports its own family name and will not resolve by weight');
  });
});
