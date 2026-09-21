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

// A translucent light panel behind the list.
//
// The division artwork is busy and dark across its top two thirds — see it on any result
// card — and this league's bitmap fonts are black. Printing a nine-line fixture list
// straight onto the art gives black text on a red-and-navy photograph, which is
// unreadable, and there is no room for the list in the pale strip at the bottom that the
// result card uses.
//
// **Light panel and black text, where Stockport uses a dark panel and white text.** Not a
// style preference: `fonts/` holds black faces at 30, 55, 60 and 65 and white ones at only
// 30 and 60, so a dark panel would cost the type hierarchy this card is built on. Jimp
// cannot scale a bitmap font — the sizes that exist are the sizes there are.
function panel(image, x, y, w, h, opacity) {
  const fill = new Jimp(w, h, 0xffffffff);
  fill.opacity(opacity);
  image.composite(fill, x, y);
}

// One division's coming week, at 1080x1350 — the artwork's own size, and the same 4:5
// portrait as the result card, so a fixtures post and a result post look like the same
// league.
//
// The row font is CHOSEN, not scaled, because Jimp draws pre-baked bitmaps: the layout
// works out how much vertical room each line gets and drops to the smaller face when the
// larger one would not clear it. Six fixtures on three nights is the worst week this
// league has had (measured over four seasons) and sits comfortably in the large face; six
// fixtures on six separate nights would not, and gets the small one rather than an
// overlapping list.
async function buildFixturesCard(divisionName, fixtures, format = 'jpeg') {
  const W = 1080, H = 1350;
  const background = await fixturesBackground(divisionName);
  const image = background.bitmap.width === W && background.bitmap.height === H
    ? background
    : background.cover(W, H);

  const PANEL_X = 40, PANEL_Y = 430, PANEL_W = W - 80, PANEL_H = 880;
  panel(image, PANEL_X, PANEL_Y, PANEL_W, PANEL_H, 0.82);

  const titleFont = await Jimp.loadFont('./fonts/ArialBold_Black_65.fnt');
  const rowFontBig = await Jimp.loadFont('./fonts/Arial_Black_55.fnt');
  const smallFont = await Jimp.loadFont('./fonts/ArialBold_Black_30.fnt');

  const lines = fixtureCardLines(fixtures);
  const range = fixtureDateRange(fixtures);
  const textX = PANEL_X + 30;
  const textW = PANEL_W - 60;

  let y = PANEL_Y + 30;
  image.print(titleFont, textX, y, { text: String(divisionName), alignmentX: Jimp.HORIZONTAL_ALIGN_LEFT }, textW, 75);
  y += 90;
  image.print(smallFont, textX, y, { text: 'Fixtures this week', alignmentX: Jimp.HORIZONTAL_ALIGN_LEFT }, textW, 35);
  y += 40;
  if (range) {
    image.print(smallFont, textX, y, { text: range, alignmentX: Jimp.HORIZONTAL_ALIGN_LEFT }, textW, 35);
    y += 40;
  }

  // A rule under the heading, drawn as a one-pixel-tall opaque panel: Jimp has no line
  // primitive and this is the same composite the panel above uses.
  y += 15;
  panel(image, textX, y, textW, 3, 0.35);
  y += 25;

  const FOOTER_TOP = PANEL_Y + PANEL_H - 55;
  const HEADING_STEP = 42;
  const MAX_ROW_STEP = 88;
  const headings = lines.filter(l => l.kind === 'date').length;
  const rows = lines.length - headings;
  const roomForRows = FOOTER_TOP - y - 20 - headings * HEADING_STEP;

  // Capped, then the whole block is centred in what is left.
  //
  // Without the cap, dividing all the remaining room between the rows means a two-fixture
  // week prints two lines 300px apart — technically laid out, and it reads as a rendering
  // fault rather than a quiet week. The cap is what makes a short list look deliberate,
  // and the division of the remainder is what stops a long one overlapping.
  const rowStep = rows ? Math.min(MAX_ROW_STEP, Math.floor(roomForRows / rows)) : 0;

  // 66 is the 55px face's own line height (63) plus breathing room. Below it the large
  // face would overlap the next line, so the small one is used and the list stays legible
  // rather than staying large.
  const rowFont = rowStep >= 66 ? rowFontBig : smallFont;
  const rowSize = rowStep >= 66 ? 63 : 35;

  const blockHeight = headings * HEADING_STEP + rows * rowStep;
  y += Math.max(0, Math.round((FOOTER_TOP - 20 - y - blockHeight) / 2));

  for (const line of lines) {
    if (line.kind === 'date') {
      image.print(smallFont, textX, y, { text: line.text, alignmentX: Jimp.HORIZONTAL_ALIGN_LEFT }, textW, 35);
      y += HEADING_STEP;
    } else {
      image.print(rowFont, textX, y, { text: line.text, alignmentX: Jimp.HORIZONTAL_ALIGN_LEFT }, textW, rowSize);
      y += rowStep;
    }
  }

  image.print(smallFont, textX, FOOTER_TOP,
    { text: 'tameside-badminton.co.uk  #tameside #badminton #tbl', alignmentX: Jimp.HORIZONTAL_ALIGN_LEFT },
    textW, 35);

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
