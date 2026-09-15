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
