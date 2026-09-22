// The league's social images: the result card, the per-division league table, and the
// coming week's fixtures.
//
// ── Drawn with sharp and SVG text ────────────────────────────────────────────
//
// This was Jimp and pre-baked bitmap fonts (`fonts/*.fnt` plus a `.png` atlas) until
// 22 Sep 2026. Jimp cannot scale a bitmap font, so the sizes that existed were the sizes
// there were — in white, 30 and 60 and nothing between — and the fixtures card chose
// between three whole LAYOUTS to make its text fit. All of that is gone: text is any size
// now, and `utils/cardRender.js` holds the primitives.
//
// The old note here said porting the Stockport site's sharp+SVG drawing would "render
// every label blank in production and nowhere else", because this image carried no
// fontconfig and no font. **That stopped being true when ffmpeg was added** — it pulled in
// fontconfig, freetype, pango and DejaVu — and the Dockerfile now installs Poppins and
// Inter explicitly rather than relying on that accident.
//
// **A MISSING FONT DOES NOT RENDER BLANK.** It falls back to a default face and draws
// legible text in the wrong typeface with no error. The Dockerfile asserts the fonts
// resolve at build time; `cardRender.fontsResolve()` is the runtime check. Cards rendered
// outside the container are in the wrong face — build the image to look at them properly.
//
// ── Why these are served on demand ───────────────────────────────────────────
//
// The originals wrote PNGs into `static/images/generated/` and expected something to fetch
// them back by URL. That directory is the *container's* own disk: on Cloud Run it belongs
// to one instance, does not outlive it, and is invisible to every other instance. So
// "generate, then fetch" only works when the same instance answers both requests — and
// when Meta is the one fetching, the request arrives later still, from Meta's servers.
//
// **JPEG, not PNG.** Instagram's publishing API documents JPEG only. Serving JPEG costs
// nothing; see utils/metaPublisher.js for what was and was not measured about that.

const card = require('../utils/cardRender');
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

// The background cache lives in utils/cardRender.js now. sharp pipelines are immutable,
// so unlike Jimp there is no clone-per-use rule: the cache holds finished pixels and
// handing the same buffer to two cards cannot leak one into the other.
exports._resetBackgroundCache = card.resetBackgroundCache;

// ── The result card ──────────────────────────────────────────────────────────

// ── Laid out as a vertical flow, after the first attempt collided ────────────
//
// The first sharp version put the score right-aligned on the same baseline as the away
// team, which works for "Hyde C" and fails completely for "Manchester Edgeley B": the name
// ran straight through the score, and the home name's ascenders ran through the RESULT
// label above it. Rendered inside the container and looked at, which is the only way that
// shows up — every test still passed, because the bytes were a valid JPEG of the right size.
//
// So nothing shares a baseline with anything now. A cursor walks down the card and each
// element claims its own band, which means a long name can only ever make the card taller
// (and it cannot, because `fitSize` shrinks it first), never overlap a neighbour.
async function buildResultCard({ homeTeam, awayTeam, homeScore, awayScore, division }, format = 'jpeg') {
  const W = 1080, H = 1350;
  const file = './static/images/bg/social-' + String(division).replace(/\s+/g, '-') + '.png';

  const PAD = 56;
  const inner = W - PAD * 2;

  // One size for both names, from the longer, so a short home team does not tower over a
  // long away one. The artwork fades pale across its lower third, so the text is dark.
  const longest = String(homeTeam).length >= String(awayTeam).length ? homeTeam : awayTeam;
  const nameSize = card.fitSize(longest, inner, { family: card.HEAD, weight: 'bold', max: 76, min: 34 });

  // **The panel height is derived from the flow, not estimated alongside it.** The first
  // version kept a separate `blockH` guess and pinned the footer to the card bottom; the
  // two disagreed, and the score ended up 14px from the footer. Every gap below is named
  // once and summed once, so they cannot drift apart again.
  const TOP_PAD = 46, LABEL_H = 34, LABEL_GAP = 18;
  const VEE_GAP = 12, VEE_H = 32, SCORE_GAP = 30, SCORE = 104;
  const FOOT_GAP = 46, FOOT_H = 27, BOTTOM_PAD = 40;

  const blockH = TOP_PAD + LABEL_H + LABEL_GAP + nameSize + VEE_GAP + VEE_H + nameSize
               + SCORE_GAP + SCORE + FOOT_GAP + FOOT_H + BOTTOM_PAD;
  const panelTop = H - blockH;

  let y = panelTop + TOP_PAD;
  const body = [card.rect(0, panelTop, W, H - panelTop, { fill: '#ffffff', opacity: 0.55 })];

  y += LABEL_H;
  body.push(card.text('RESULT', { x: PAD, y, size: 26, family: card.BODY, weight: 'bold',
                                  fill: '#1b1b1f', opacity: 0.65, letterSpacing: 4 }));

  y += LABEL_GAP + nameSize;
  body.push(card.text(homeTeam, { x: PAD, y, size: nameSize, family: card.HEAD, weight: 'bold',
                                  fill: '#111114', maxWidth: inner }));

  y += VEE_GAP + VEE_H;
  body.push(card.text('v', { x: PAD, y, size: 30, family: card.BODY, fill: '#111114', opacity: 0.5 }));

  y += nameSize;
  body.push(card.text(awayTeam, { x: PAD, y, size: nameSize, family: card.HEAD, weight: 'bold',
                                  fill: '#111114', maxWidth: inner }));

  y += SCORE_GAP + SCORE;
  body.push(card.text(`${homeScore} - ${awayScore}`, { x: PAD, y, size: SCORE, family: card.HEAD,
                                                       weight: 'bold', fill: '#111114' }));

  y += FOOT_GAP + FOOT_H;
  body.push(card.text('tameside-badminton.co.uk  #tameside #badminton #tbl', {
    x: PAD, y, size: FOOT_H, family: card.BODY, weight: 'bold',
    fill: '#1b1b1f', opacity: 0.7, maxWidth: inner }));

  return card.render({ file, width: W, height: H, body: body.join(''), format });
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

// One division's coming week, at 1080x1350 — the artwork's own size, and the same 4:5
// portrait as the result card so the two posts look like the same league.
//
// ── The three-layout mechanism is gone, and that is the point ────────────────
//
// Jimp cannot scale a bitmap font, and in white `fonts/` held 30 and 60 and nothing else.
// So this card used to pick between three whole LAYOUTS — stacked, inline-60, inline-30 —
// measuring each against the available height and width and taking the first that fitted,
// because it could not simply make the text smaller. Now it can: `fitSize` picks a size
// per line and `textLength` guarantees the fit, so one layout serves every week.
//
// **Dark panel, white text, everything centred.** A light panel has to be near-opaque to be
// legible, and at that point the division artwork underneath may as well not be there —
// which defeats the only reason for using it.
//
// **The panel is sized to its contents and anchored to the bottom.** It was a fixed 880px
// box with the list centred inside, which laid out correctly and looked wrong: a
// one-fixture week — 20% of them — put two lines of copy in the middle of a large empty
// rectangle and read as a rendering fault rather than a quiet week.
async function buildFixturesCard(divisionName, fixtures, format = 'jpeg') {
  const W = 1080, H = 1350;
  const PANEL_X = 40, PAD = 40;
  const panelW = W - PANEL_X * 2;
  const innerX = PANEL_X + PAD;
  const innerW = panelW - PAD * 2;
  const centre = PANEL_X + panelW / 2;
  const PANEL_BOTTOM = H - 50;
  // Leaves the player and the big division numeral visible at every length.
  const PANEL_MAX_H = 1180;

  const lines = fixtureCardLines(fixtures);
  const range = fixtureDateRange(fixtures);

  // Heights are known up front because the sizes are chosen up front, so the panel can be
  // sized to the content instead of the content squeezed into the panel.
  const HEAD_H = 86 + 40 + (range ? 40 : 0) + 18 + 2 + 26;
  const FOOT_H = 30 + 24;
  const DATE_H = 58;

  // One size for every fixture line, taken from the longest, so the list reads as a column
  // rather than a ransom note. `fitSize` walks down from 58 only as far as it must.
  const longest = lines.filter(l => l.kind === 'fixture')
    .reduce((a, l) => (l.text.length > a.length ? l.text : a), '');
  const fixtureCount = lines.length - lines.filter(l => l.kind === 'date').length;
  const roomForList = PANEL_MAX_H - PAD * 2 - HEAD_H - FOOT_H
                    - lines.filter(l => l.kind === 'date').length * DATE_H;
  const perFixture = fixtureCount ? Math.floor(roomForList / fixtureCount) : 0;
  const fixtureSize = Math.min(
    card.fitSize(longest, innerW, { family: card.HEAD, weight: 'bold', max: 58, min: 26 }),
    Math.max(26, Math.round(perFixture * 0.62)));
  const fixtureStep = Math.round(fixtureSize * 1.42);

  const listH = lines.reduce((n, l) => n + (l.kind === 'date' ? DATE_H : fixtureStep), 0);
  const panelH = Math.min(PANEL_MAX_H, PAD * 2 + HEAD_H + listH + FOOT_H);
  const panelY = PANEL_BOTTOM - panelH;

  const body = [
    // Dark at 0.80, so the division's artwork still reads through it.
    card.rect(PANEL_X, panelY, panelW, panelH, { fill: '#0d0d0f', opacity: 0.80, rx: 10 }),
  ];

  let y = panelY + PAD + 64;
  body.push(card.text(divisionName, { x: centre, y, size: 68, family: card.HEAD, weight: 'bold',
                                      anchor: 'middle', maxWidth: innerW }));
  y += 40;
  body.push(card.text('Fixtures this week', { x: centre, y, size: 30, family: card.BODY,
                                              anchor: 'middle', opacity: 0.85 }));
  if (range) {
    y += 40;
    body.push(card.text(range, { x: centre, y, size: 30, family: card.BODY,
                                 anchor: 'middle', opacity: 0.6 }));
  }
  y += 18;
  body.push(card.rect(centre - 140, y, 280, 2, { fill: '#ffffff', opacity: 0.3 }));
  y += 2 + 26;

  for (const line of lines) {
    if (line.kind === 'date') {
      // More space above a night heading than below it, so it groups with the fixtures it
      // introduces rather than floating between two of them.
      y += Math.round(DATE_H * 0.95);
      body.push(card.text(line.text, { x: centre, y, size: 28, family: card.BODY, weight: 'bold',
                                       anchor: 'middle', opacity: 0.8 }));
      y += Math.round(DATE_H * 0.35);
    } else {
      y += Math.round(fixtureStep * 0.78);
      body.push(card.text(line.text, { x: centre, y, size: fixtureSize, family: card.HEAD,
                                       weight: 'bold', anchor: 'middle', maxWidth: innerW }));
      y += fixtureStep - Math.round(fixtureStep * 0.78);
    }
  }

  body.push(card.text('tameside-badminton.co.uk  #tameside #badminton #tbl', {
    x: centre, y: PANEL_BOTTOM - PAD + 4, size: 26, family: card.BODY, weight: 'bold',
    anchor: 'middle', opacity: 0.75, maxWidth: innerW }));

  return card.render({ file: await fixturesBackground(divisionName),
                       width: W, height: H, body: body.join(''), format });
}

// Each division's own artwork — the same file the result card uses, so a fixtures post and
// a result post for the same division look like the same league. A division whose name has
// no matching file falls back to the plain background rather than throwing: a rename or a
// new division should produce a duller card, not a 500 on a route Meta is fetching.
//
// Returns a PATH now rather than a decoded image. sharp opens the file itself and
// `cardRender` caches the decoded result, so there is nothing to hand around.
async function fixturesBackground(divisionName) {
  const named = './static/images/bg/social-' + String(divisionName).replace(/\s+/g, '-') + '.png';
  try {
    await fs.access(named);
    return named;
  } catch {
    return './static/images/bg/social.png';
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
  const W = 1080, H = 1080;
  const PAD = 48;

  // Right-aligned number columns, so the digits line up down the card. The Jimp version
  // stepped a fixed 115px from the left for each, which left ragged columns the moment a
  // number went from one digit to two — and this league's games-won column reaches three.
  const COLS = [W - PAD - 420, W - PAD - 290, W - PAD - 160, W - PAD];
  const HEADS = ['P', 'W', 'L', 'Avg.'];
  // A 52px gutter, not 30. The name is clamped to this, so the widest team in the league
  // cannot touch the P column — which it did at 30, because the width estimate was
  // optimistic and `textLength` never fired.
  const nameWidth = COLS[0] - PAD - 52;

  // Fit the rows to the space rather than assuming nine of them: a division can gain a
  // team, and the old fixed 1.6 line-height simply ran off the bottom when it did.
  // Capped, then the block is centred in what is left. Without the cap a five-team
  // division spreads five rows over the whole card; without the centring it huddles at the
  // top with a void beneath. Division 1 has nine teams, but a division can lose one.
  const listBottom = H - 92;
  const step = rows.length ? Math.min(78, Math.floor((listBottom - 250) / rows.length)) : 0;
  const listTop = 250 + Math.max(0, Math.round((listBottom - 250 - step * rows.length) / 2));
  const rowSize = Math.max(26, Math.min(52, Math.round(step * 0.62)));

  const body = [
    card.rect(0, 0, W, H, { fill: '#ffffff', opacity: 0.35 }),
    card.text(divisionName, { x: PAD, y: 110, size: 72, family: card.HEAD, weight: 'bold',
                              fill: '#111114', maxWidth: W - PAD * 2 }),
    card.text('League table', { x: PAD, y: 156, size: 30, family: card.BODY,
                                fill: '#1b1b1f', opacity: 0.7 }),
    ...HEADS.map((h, i) => card.text(h, { x: COLS[i], y: 214, size: 30, family: card.BODY,
                                          weight: 'bold', fill: '#1b1b1f', opacity: 0.75, anchor: 'end' })),
    card.rect(PAD, 232, W - PAD * 2, 2, { fill: '#111114', opacity: 0.25 }),
  ];

  rows.forEach((row, i) => {
    const y = listTop + step * i + Math.round(step * 0.7);
    const { played, won, lost, avg } = tableRowValues(row);
    body.push(card.text(row.name, { x: PAD, y, size: rowSize, family: card.BODY,
                                    weight: 'bold', fill: '#111114', maxWidth: nameWidth }));
    [played, won, lost, avg].forEach((v, j) =>
      body.push(card.text(v, { x: COLS[j], y, size: rowSize, family: card.BODY,
                               fill: '#111114', anchor: 'end' })));
  });

  body.push(card.text('tameside-badminton.co.uk', { x: PAD, y: H - 40, size: 26,
    family: card.BODY, weight: 'bold', fill: '#1b1b1f', opacity: 0.7 }));

  return card.render({ file: './static/images/bg/social.png', width: W, height: H,
                       body: body.join(''), format });
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
