// The league's social images: the result card and the per-division league table.
//
// ── Drawn with Jimp, and that is not an accident ──────────────────────────────
//
// Text comes from pre-baked bitmap fonts in `fonts/` (`.fnt` + its `.png` sheet), loaded
// with `Jimp.loadFont`. That is pure JS. The Stockport league site draws the same pictures
// with sharp and an SVG overlay, which needs fontconfig and a system font — neither of
// which is in this image, deliberately (see CLAUDE.md, *Social Image Generation*). Porting
// its drawing code across would render every label blank in production and nowhere else.
// The route SHAPE is what ports; the drawing stays here.
//
// ── Why these are served on demand ───────────────────────────────────────────
//
// The originals wrote PNGs into `static/images/generated/` and expected something to fetch
// them back by URL. That directory is the *container's* own disk: on Cloud Run it belongs
// to one instance, does not outlive it, and is invisible to every other instance. So
// "generate, then fetch" only works when the same instance answers both requests — and
// when Meta is the one fetching, the request arrives later still, from Meta's servers,
// after the container that could have served it has gone.
//
// `GET /league-table-image/:division` renders per request and returns the bytes. There is
// no file to go missing and no instance to hit.
//
// **JPEG, not PNG.** Instagram's publishing API accepts JPEG and nothing else. That single
// fact is why the Stockport league's weekly Instagram carousel never worked in its whole
// existence: the Facebook half of the same automation uploads *bytes* and so never meets
// the format check, so one platform posted and the other silently did not. If you ever see
// that asymmetry again, suspect the fetch rather than the code.
//
// The file-writing routes are left alone on purpose. The live Make.com scenario still
// calls them, and removing them before it is repointed would break the weekly post on the
// Facebook side, which does currently work.

const Jimp = require('jimp');
const fs = require('fs').promises;
const { getAllLeagueTables } = require('../models/league');
const Fixture = require('../models/fixture');
const { stripImageExt } = require('../utils/socialPaths');

const GENERATED_DIR = 'static/images/generated';

// The divisions the weekly post covers, by id. Tameside has two; the Stockport league has
// four. Matched to a NAME at the route, so the URL says what it shows.
const SOCIAL_DIVISION_IDS = [8, 9];

// Ten minutes. Long enough that Meta fetching the same URL several times while it builds a
// carousel does not redraw the composite each time, short enough that a table published on
// a Friday is not still being served on the Saturday. This deliberately differs from the
// Stockport site's 24 hours: these tables change whenever a result is published.
const SOCIAL_IMAGE_CACHE_CONTROL = 'public, max-age=600';

// A 404 from these routes must NOT be cached, and saying so is not belt-and-braces.
//
// Firebase Hosting applies its own `max-age=600` to any response that sets no
// Cache-Control, 404s included. **Meta fetches these URLs itself and retries**, so a
// transient 404 — a deploy in flight, a division renamed mid-season — gets cached and the
// retry hits the cache rather than the fixed route. The window outlives the fault. Same
// reasoning as `utils/render404.js`.
const SOCIAL_IMAGE_MISS_CACHE_CONTROL = 'no-store';

function toBuffer(image, format) {
  return format === 'jpeg'
    ? image.quality(90).getBufferAsync(Jimp.MIME_JPEG)
    : image.getBufferAsync(Jimp.MIME_PNG);
}

// ── The result card ──────────────────────────────────────────────────────────

async function buildResultCard({ homeTeam, awayTeam, homeScore, awayScore, division }, format = 'jpeg') {
  const background = await Jimp.read(
    './static/images/bg/social-' + String(division).replace(/\s+/g, '-') + '.png');

  const lines = [
    'Result: ' + homeTeam + ' vs ',
    String(awayTeam),
    homeScore + '-' + awayScore,
    '#tameside #badminton #tbl #result',
    'https://tameside-badminton.co.uk',
  ];

  const bigFont = await Jimp.loadFont('./fonts/ArialBold_Black_60.fnt');
  const littleFont = await Jimp.loadFont('./fonts/ArialBold_Black_30.fnt');
  const { width, height } = background.bitmap;

  const lineHeight = 1.5;
  let currentY = 500 + ((height / 2) - ((lines.length * 60 * lineHeight) / 2));

  lines.forEach((text, index) => {
    const textSize = index > 2 ? 30 : 60;
    background.print(
      index > 2 ? littleFont : bigFont,
      10, currentY,
      { text, alignmentX: Jimp.HORIZONTAL_ALIGN_LEFT },
      width, textSize);
    currentY += textSize * lineHeight;
  });

  return toBuffer(background, format);
}

// GET /resultImage/:homeTeam/:awayTeam/:homeScore/:awayScore/:division
//
// The trailing `.jpg` is optional and must come off before the division name is used — it
// picks the background file, so `Division 1.jpg` would look for `social-Division-1.jpg.png`
// and fail. See `utils/socialPaths.js` for why the extension is there at all.
exports.social_get_result = async function (req, res, next) {
  try {
    const card = {
      homeTeam: req.params.homeTeam,
      awayTeam: req.params.awayTeam,
      homeScore: req.params.homeScore,
      awayScore: req.params.awayScore,
      division: stripImageExt(req.params.division),
    };

    const buffer = await buildResultCard(card, 'jpeg');

    // The legacy PNG on disk, still written because the live Make.com scenario may name it.
    // Best-effort: it cannot be fetched back reliably anyway (see the note at the top), so
    // failing to write it must not fail the request that serves the bytes that do work.
    // Delete this once the results webhook is retired.
    writeLegacyResultCard(card).catch(err =>
      console.log('legacy result card not written:', err.message));

    res.type('image/jpeg').set('Cache-Control', SOCIAL_IMAGE_CACHE_CONTROL).send(buffer);
  } catch (err) {
    next(err);
  }
};

async function writeLegacyResultCard(card) {
  await fs.mkdir(GENERATED_DIR, { recursive: true });
  const buffer = await buildResultCard(card, 'png');
  const name = String(card.homeTeam).replace(/\s+/g, '-') + String(card.awayTeam).replace(/\s+/g, '-');
  await fs.writeFile(`${GENERATED_DIR}/${name}.png`, buffer);
}

// ── The fixtures card ────────────────────────────────────────────────────────

// The nights and matches a card prints, in order, with a heading whenever the night
// changes. Pure, and exported, so the test reads what the picture will say rather than a
// copy of this loop.
function fixtureCardLines(fixtures) {
  const lines = [];
  let night = null;
  for (const f of fixtures) {
    const label = String(f.dayLabel || '').trim();
    if (label !== night) {
      night = label;
      lines.push({ kind: 'date', text: label });
    }
    lines.push({ kind: 'fixture', text: String(f.homeTeam || '') + '  v  ' + String(f.awayTeam || '') });
  }
  return lines;
}

// The date range the card covers, parsed out of the SQL-formatted `dayLabel`
// ("Wed 16 Sep") rather than recomputed from `fixture.date`.
//
// Two reasons, and the second is the one that bites. A JS Date built from that column is
// local midnight rendered in UTC, so under BST it names the previous day — the heading
// would disagree with the rows underneath it. And `toLocaleDateString('en-GB')` depends on
// the ICU data in the running Node, so the base image moving would change the shape of
// text baked into a picture.
//
// It exists because **"Fixtures this week" means nothing to someone who finds the post
// later**, or who does not follow the league. The card has to stand on its own.
function fixtureDateRange(fixtures) {
  const parts = fixtures
    .map(f => String(f.dayLabel || '').trim().split(/\s+/).slice(1).join(' '))
    .filter(Boolean);
  if (!parts.length) return '';

  const first = parts[0], last = parts[parts.length - 1];
  if (first === last) return first;

  // "21 - 23 Sep" within a month, "28 Sep - 4 Oct" across one.
  const [, firstMonth] = first.split(' ');
  const [lastDay, lastMonth] = last.split(' ');
  return firstMonth === lastMonth
    ? `${first.split(' ')[0]} - ${lastDay} ${lastMonth}`
    : `${first} - ${last}`;
}

// A translucent panel behind the copy.
//
// **Dark at 0.80, with white text.** A light panel was tried first and shipped briefly;
// the dark one is better and the reason is opacity. To be legible a light panel has to be
// near-opaque, and at that point the division artwork underneath may as well not be there
// — which defeats the only reason for using the artwork. Dark lets the colour read
// through while white text sits on it comfortably, so the card keeps its division
// identity and the fixtures stay readable. Confirmed on real Stockport posts before being
// adopted here.
//
// Jimp has no rounded-rect or alpha-fill primitive, so this is a solid image composited
// at an opacity. The same call draws the hairline rule under the header.
function panel(image, x, y, w, h, opacity, colour = 0x0d0d0fff) {
  const fill = new Jimp(w, h, colour);
  fill.opacity(opacity);
  image.composite(fill, x, y);
}

// ── Choosing a layout, because Jimp cannot scale a bitmap font ───────────────
//
// This is the whole awkwardness of the card. Stockport sizes its type to fit by rendering
// SVG text, which scales to any pixel size. Here the sizes that exist in `fonts/` are the
// sizes there are, and **in white there are only two: 30 and 60.** So the card cannot
// shrink the type to fit — it picks a LAYOUT that fits, and the three below are ordered
// most to least generous.
//
// Measured against the real database, 21 Sep 2026:
//
//   - Every one of the 18 team names fits on its own line at 60 (widest is
//     "Manchester Edgeley B" at 636px of 940 usable). **Zero overflow**, which is what
//     makes the stacked layout safe rather than a gamble.
//   - 58 of 249 distinct pairings — 23% — overflow at 60 when put on ONE line
//     ("Manchester Edgeley A  v  Manchester Edgeley B" is 1373px). That is why `inline60`
//     has to check its own width and cannot simply be preferred for being shorter.
//   - 86% of division-weeks have 1-3 fixtures; 4% have five and 1% have six. So `stacked`
//     carries almost every real week and `inline30` is a genuine edge case, not the
//     common path.
const ROW_LAYOUTS = [
  // Home / v / away on three centred lines. The "v" column lines up down the card and the
  // eye runs down it, and no pairing can overflow because no single name can.
  { name: 'stacked', rowSize: 60, parts: f => [
      { text: f.homeTeam, size: 60, gap: 62 },
      { text: 'v', size: 30, gap: 36 },
      // 104, not the ~78 the line height wants. At the tighter value a two-fixture night
      // read as one four-line list — "Mellor B" and "Manor A" sat as close together as
      // "Aerospace B" and its own opponent, so the grouping the stack exists to create was
      // undone by the gap between stacks. The separation between fixtures has to beat the
      // separation inside one.
      { text: f.awayTeam, size: 60, gap: 96 },
    ] },
  // One line at 60, a third of the height — but only when every line in THIS week clears
  // the panel. Checked per card, not per league.
  { name: 'inline60', rowSize: 60, parts: f => [
      { text: `${f.homeTeam}  v  ${f.awayTeam}`, size: 60, gap: 84 },
    ] },
  // The compact fallback. Small, but a legible list beats an overlapping one, and it only
  // appears in a week that is both long and full of long names.
  { name: 'inline30', rowSize: 30, parts: f => [
      { text: `${f.homeTeam}  v  ${f.awayTeam}`, size: 30, gap: 52 },
    ] },
];

// One division's coming week, at 1080x1350 — the artwork's own size, and the same 4:5
// portrait as the result card, so a fixtures post and a result post look like the same
// league.
//
// **The panel is sized to its contents and anchored to the bottom.** It used to be a fixed
// 880px box with the list centred inside it, which laid out correctly and looked wrong:
// a one-fixture week — 20% of them, and the week this shipped in — put two lines of copy
// in the middle of a large empty rectangle, reading as a rendering fault rather than a
// quiet week. Growing upward from a fixed bottom margin keeps the card's proportions
// consistent whatever the week holds, and leaves more of the artwork visible when there
// is less to say.
async function buildFixturesCard(divisionName, fixtures, format = 'jpeg') {
  const W = 1080, H = 1350;
  const background = await fixturesBackground(divisionName);
  const image = background.bitmap.width === W && background.bitmap.height === H
    ? background
    : background.cover(W, H);

  const titleFont = await Jimp.loadFont('./fonts/ArialBold_White_60.fnt');
  const smallFont = await Jimp.loadFont('./fonts/ArialBold_White_30.fnt');
  const fontFor = size => (size >= 60 ? titleFont : smallFont);

  const PANEL_X = 40;
  const PANEL_W = W - PANEL_X * 2;
  const PAD = 36;
  const INNER_X = PANEL_X + PAD;
  const INNER_W = PANEL_W - PAD * 2;
  const PANEL_BOTTOM = H - 50;
  // Leaves the top of the artwork — the player, and the big division numeral — visible at
  // every length. A panel taller than this would cover the thing it is sitting on.
  //
  // **1160 is tuned to a measured boundary, not picked round.** At 1100 a three-fixture
  // week overflowed the stacked layout by seven pixels and dropped to the compact list —
  // and three fixtures is 29% of division-weeks, so the common case was landing in the
  // fallback over a rounding margin. With this, 1-3 fixtures all stack, which is 86% of
  // weeks; four or more move to the inline form, which is what that form is for.
  const PANEL_MAX_H = 1160;

  const range = fixtureDateRange(fixtures);

  // The header, as draw items. Everything is centred now, header and list alike.
  const header = [
    { text: String(divisionName), size: 60, gap: 74 },
    { text: 'Fixtures this week', size: 30, gap: 40 },
  ];
  if (range) header.push({ text: range, size: 30, gap: 40 });

  const RULE_GAP_ABOVE = 14, RULE_GAP_BELOW = 30;
  const footer = { text: 'tameside-badminton.co.uk  #tameside #badminton #tbl', size: 30 };
  const FOOTER_GAP_ABOVE = 26;

  const headerH = header.reduce((n, i) => n + i.gap, 0);
  const chromeH = PAD + headerH + RULE_GAP_ABOVE + 3 + RULE_GAP_BELOW
                + FOOTER_GAP_ABOVE + 40 + PAD;
  const roomForList = PANEL_MAX_H - chromeH;

  // Build the list under each layout and take the first that fits — in height, and in
  // width, because a bitmap font cannot be narrowed either.
  let items = null;
  for (const layout of ROW_LAYOUTS) {
    const candidate = [];
    let night = null;
    for (const f of fixtures) {
      const label = String(f.dayLabel || '').trim();
      if (label !== night) {
        night = label;
        candidate.push({ text: label, size: 30, gap: 46 });
      }
      for (const part of layout.parts(f)) candidate.push(part);
    }
    const height = candidate.reduce((n, i) => n + i.gap, 0);
    const widest = candidate.reduce((n, i) => Math.max(n, Jimp.measureText(fontFor(i.size), i.text)), 0);
    if (height <= roomForList && widest <= INNER_W) { items = candidate; break; }
    items = candidate;   // keep the last, so an impossible week still draws something
  }

  const listH = items.reduce((n, i) => n + i.gap, 0);
  const panelH = Math.min(PANEL_MAX_H, chromeH + listH);
  const panelY = PANEL_BOTTOM - panelH;

  panel(image, PANEL_X, panelY, PANEL_W, panelH, 0.80);

  const centre = (item, y) => image.print(
    fontFor(item.size), INNER_X, y,
    { text: String(item.text), alignmentX: Jimp.HORIZONTAL_ALIGN_CENTER },
    INNER_W, item.size + 8);

  let y = panelY + PAD;
  for (const item of header) { centre(item, y); y += item.gap; }

  y += RULE_GAP_ABOVE;
  panel(image, INNER_X + 120, y, INNER_W - 240, 3, 0.35, 0xffffffff);
  y += 3 + RULE_GAP_BELOW;

  for (const item of items) { centre(item, y); y += item.gap; }

  centre(footer, PANEL_BOTTOM - PAD - 34);

  return toBuffer(image, format);
}

// Each division's own artwork — the same file the result card uses, so the two posts look
// like one league. A division whose name has no matching file falls back to the plain
// background rather than throwing: a rename or a new division should produce a duller
// card, not a 500 on a route Meta is fetching.
//
// Returns a Jimp image rather than a path because every caller composites onto it, and
// because `Jimp.read` is the thing that can fail.
async function fixturesBackground(divisionName) {
  const named = './static/images/bg/social-' + String(divisionName).replace(/\s+/g, '-') + '.png';
  try {
    return await Jimp.read(named);
  } catch {
    return await Jimp.read('./static/images/bg/social.png');
  }
}

// GET /fixtures-image/:division — one division's coming week, as a JPEG, built now.
//
// Public and unauthenticated, exactly like the league-table image and for the same reason:
// **Meta fetches it from Meta's own servers**, not from a logged-in browser, so anything
// behind `secured` can never be posted. It shows nothing that is not already on the
// fixtures page.
exports.fixtures_image = async function (req, res, next) {
  try {
    const wanted = stripImageExt(req.params.division).trim().toLowerCase();
    const rows = await Fixture.getUpcomingWeek();
    const mine = rows.filter(r => String(r.divisionName || '').trim().toLowerCase() === wanted);

    // A division with no matches this week is a 404 and NOT a blank card. The caller builds
    // its post from the divisions that have fixtures, so it should never ask for one that
    // does not — but if it does, an empty picture posted to Instagram is the failure nobody
    // notices, and a 404 is the one that shows up in the post's own report.
    if (!mine.length) {
      return res.status(404)
        .set('Cache-Control', SOCIAL_IMAGE_MISS_CACHE_CONTROL)
        .type('text/plain')
        .send('No fixtures this week for that division');
    }

    const buffer = await buildFixturesCard(mine[0].divisionName, mine, 'jpeg');
    res.type('image/jpeg').set('Cache-Control', SOCIAL_IMAGE_CACHE_CONTROL).send(buffer);
  } catch (err) {
    next(err);
  }
};

exports.fixtureCardLines = fixtureCardLines;
exports.fixtureDateRange = fixtureDateRange;
exports.buildFixturesCard = buildFixturesCard;

// ── The division table ───────────────────────────────────────────────────────

// One table row's four numbers, as the strings the picture prints. Exported so the guard
// tests what the image actually draws rather than a copy of this arithmetic — a test that
// restates the implementation passes against the bug just as happily.
//
// **`played` is 0 until a team's first result of the season**, and the original divided by
// it unguarded: `(0 / 0).toFixed(1)` is the three characters "NaN", printed down the Avg.
// column of every table for the opening weeks of every season. Nobody had seen it because
// the URL serving the picture answered 404 from anywhere but the container that drew it —
// a broken link was hiding a broken picture, exactly as on the Stockport side, where the
// same column read "0 null null" for its own reasons.
//
// Note W and L are GAMES won and lost, not league points: this league ranks on games, all
// 18 of a fixture counting, which is why a team with 6 played shows 60 and 48. The database
// columns say "points" and mean games.
function tableRowValues(row) {
  const played = Number(row.played) || 0;
  const won = Number(row.pointsFor) || 0;
  const lost = Number(row.pointsAgainst) || 0;
  return {
    played: String(played),
    won: String(won),
    lost: String(lost),
    avg: played > 0 ? Math.max(0, won / played).toFixed(1) : '0',
  };
}

exports.tableRowValues = tableRowValues;

async function buildDivisionTable(divisionName, rows, format = 'jpeg') {
  const background = (await Jimp.read('./static/images/bg/social.png')).resize(1080, 1080);
  const { width } = background.bitmap;

  const bigFont = await Jimp.loadFont('./fonts/ArialBold_Black_65.fnt');
  const littleFont = await Jimp.loadFont('./fonts/Arial_Black_55.fnt');

  const TEAM_SPACE = 600;
  const NUMBER_SPACE = 115;
  const lineHeight = 1.6;

  let posY = 10;
  let posX = 10;
  let textSize = 65;

  [divisionName, 'P', 'W', 'L', 'Avg.'].forEach((text, i) => {
    background.print(i > 0 ? littleFont : bigFont, posX, posY,
      { text: String(text), alignmentX: Jimp.HORIZONTAL_ALIGN_LEFT }, width, textSize);
    posX += i > 0 ? NUMBER_SPACE : TEAM_SPACE;
  });

  posY += textSize * lineHeight;
  textSize = 55;

  for (const row of rows) {
    const { played, won, lost, avg } = tableRowValues(row);
    posX = 10;
    [row.name, played, won, lost, avg].forEach((text, j) => {
      background.print(littleFont, posX, posY,
        { text: String(text), alignmentX: Jimp.HORIZONTAL_ALIGN_LEFT }, width, textSize);
      posX += j > 0 ? NUMBER_SPACE : TEAM_SPACE;
    });
    posY += (textSize + 5) * lineHeight;
  }

  return toBuffer(background, format);
}

// GET /league-table-image/:division — one division's table, as a JPEG, built now.
exports.league_table_image = function (req, res, next) {
  const wanted = stripImageExt(req.params.division).trim().toLowerCase();

  getAllLeagueTables(req.params.season, async function (err, result) {
    if (err) return next(err);
    try {
      // Matched on the division's NAME, not its id, so the URL says what it shows and stays
      // readable in a caption or a scheduler job. Names carry spaces, which is why
      // utils/socialPaths.js percent-encodes them.
      const rows = result
        .filter(r => SOCIAL_DIVISION_IDS.includes(Number(r.division)))
        .filter(r => String(r.divisionName || '').trim().toLowerCase() === wanted);

      if (!rows.length) {
        // 404 explicitly, and uncached. `res.send(err)` serialises an Error to `{}` and
        // goes out as 200, which a crawler banks as a real page.
        return res.status(404)
          .set('Cache-Control', SOCIAL_IMAGE_MISS_CACHE_CONTROL)
          .type('text/plain')
          .send('No league table for that division');
      }

      const buffer = await buildDivisionTable(rows[0].divisionName, rows, 'jpeg');
      res.type('image/jpeg').set('Cache-Control', SOCIAL_IMAGE_CACHE_CONTROL).send(buffer);
    } catch (e) {
      next(e);
    }
  });
};

// GET /tables-social — the file-writing original, kept because the live Make.com scenario
// still drives it. Drawing comes from the same builder as the route above, so the file on
// disk and the image served on demand cannot say different things.
exports.social_get_tables = function (req, res, next) {
  getAllLeagueTables(req.params.season, async function (err, result) {
    if (err) return next(err);
    try {
      await fs.mkdir(GENERATED_DIR, { recursive: true });

      for (const divisionId of SOCIAL_DIVISION_IDS) {
        const rows = result.filter(row => Number(row.division) === divisionId);
        if (!rows.length) continue;
        const name = rows[0].divisionName;
        const buffer = await buildDivisionTable(name, rows, 'png');
        await fs.writeFile(`${GENERATED_DIR}/league-table-${name}.png`, buffer);
      }

      res.sendStatus(200);
    } catch (e) {
      next(e);
    }
  });
};

exports.SOCIAL_DIVISION_IDS = SOCIAL_DIVISION_IDS;
exports.buildDivisionTable = buildDivisionTable;
exports.buildResultCard = buildResultCard;
