// Tameside scorecard extraction: Google Vision DOCUMENT_TEXT_DETECTION response
// -> structured match data. Pure (no I/O) so it's unit-testable against cached
// Vision responses (test/fixtures/vision-*.json) without spending API calls.
//
// How it works (validated against real cards — see scorecard-poc/README.md):
//  1. Normalise orientation: some photos are 90°/180° rotated. We detect the
//     upright rotation from printed-anchor geometry (the header labels
//     Events/Points/Games must span X not Y, title above the grid) and rotate
//     the TEXT-BLOCK COORDINATES by k*90° — no re-OCR, no pixel warping.
//  2. Anchors: the printed form labels (Events, Points, Games, the 9 event
//     labels, Played at:, Date:, Div:) locate every region RELATIVE to the
//     card, so modest skew/scale is handled implicitly.
//  3. Scores: Vision merges each Points row into one token ("1621" = 16 & 21,
//     sometimes with the Games digits fused on: "92102" = 9,21 + games 0,2).
//     splitScores() enumerates the possible splits and disambiguates with the
//     badminton scoring rules (utils/scorecardValidation).
//  4. Games-won and RESULT are DERIVED from the point pairs, not OCR'd.
//
// The 9 card rows map 1:1 onto the entry form's Game1..Game18 (see GAME_MAP).

const { isValidGameScore } = require('./scorecardValidation');

const EVENT_NAMES = ['Open A', 'Ladies', 'Open B', 'Mixed A', 'Mixed B', 'Mixed C', 'Mixed D', 'Open C', 'Open D'];
// event index -> [first game number, second game number] in the entry form.
const GAME_MAP = [[1, 2], [3, 4], [5, 6], [7, 8], [9, 10], [11, 12], [13, 14], [15, 16], [17, 18]];

/* ------------------------------------------------------------------ *
 * Vision-response plumbing
 * ------------------------------------------------------------------ */

// textAnnotations[0] is the whole-page blob; [1..] are word tokens with boxes.
function rawTokens(resp) {
  return ((resp && resp.textAnnotations) || []).slice(1).map((w) => {
    const v = w.boundingPoly.vertices;
    const xs = v.map((p) => p.x || 0);
    const ys = v.map((p) => p.y || 0);
    return {
      t: w.description,
      x0: Math.min(...xs), x1: Math.max(...xs),
      y0: Math.min(...ys), y1: Math.max(...ys),
    };
  });
}

const withCentres = (toks) => toks.map((w) => ({ ...w, cx: (w.x0 + w.x1) / 2, cy: (w.y0 + w.y1) / 2 }));

// Rotate token boxes by k*90° clockwise within a WxH page.
function rotateTokens(toks, k, W, H) {
  if (k === 0) return toks;
  const map = (x, y) => (k === 1 ? [H - y, x] : k === 2 ? [W - x, H - y] : [y, W - x]);
  return toks.map((w) => {
    const p0 = map(w.x0, w.y0);
    const p1 = map(w.x1, w.y1);
    return {
      t: w.t,
      x0: Math.min(p0[0], p1[0]), x1: Math.max(p0[0], p1[0]),
      y0: Math.min(p0[1], p1[1]), y1: Math.max(p0[1], p1[1]),
    };
  });
}

// Uprightness score for a candidate rotation: header labels should run
// horizontally (Events left of Games, low y-variance) with the title on top.
function uprightScore(toks) {
  const find = (re) => {
    const m = toks.find((w) => re.test(w.t));
    return m ? { cx: (m.x0 + m.x1) / 2, cy: (m.y0 + m.y1) / 2 } : null;
  };
  const ev = find(/^Events$/i);
  const pt = find(/^Points$/i);
  const gm = find(/^Games$/i);
  const ti = find(/^Tameside$/i);
  if (!ev || !pt || !gm) return -Infinity;
  const ys = [ev.cy, pt.cy, gm.cy];
  const xs = [ev.cx, pt.cx, gm.cx];
  let score = (Math.max(...xs) - Math.min(...xs)) - (Math.max(...ys) - Math.min(...ys));
  if (ev.cx < gm.cx) score += 300;
  if (ti && ti.cy < ev.cy) score += 200;
  return score;
}

// Try all four rotations; return the upright token set (+ how far we rotated).
function normaliseOrientation(resp) {
  const page = resp.fullTextAnnotation && resp.fullTextAnnotation.pages && resp.fullTextAnnotation.pages[0];
  const W = page ? page.width : Math.max(...rawTokens(resp).map((w) => w.x1), 1);
  const H = page ? page.height : Math.max(...rawTokens(resp).map((w) => w.y1), 1);
  const base = rawTokens(resp);
  let best = { k: 0, score: -Infinity, toks: base };
  for (let k = 0; k < 4; k++) {
    const toks = rotateTokens(base, k, W, H);
    const score = uprightScore(toks);
    if (score > best.score) best = { k, score, toks };
  }
  return { tokens: withCentres(best.toks), rotationDegrees: best.k * 90 };
}

/* ------------------------------------------------------------------ *
 * Score parsing
 * ------------------------------------------------------------------ */

// Split a merged digit string into two 0-30 game scores, using the badminton
// rules to disambiguate ("121" -> 1-21, not 12-1). Handles the fused
// points+games case ("92102" = 9,21 + games 0,2) by preferring the longest
// valid prefix whose remainder looks like games-won digits (each 0-2).
function splitScores(str) {
  const s = String(str || '').replace(/\D/g, '');
  if (s.length < 2) return [null, null];

  const splitsOf = (digits) => {
    const out = [];
    for (let k = 1; k < digits.length; k++) {
      const a = digits.slice(0, k);
      const b = digits.slice(k);
      if (a.length > 2 || b.length > 2) continue;
      if (+a <= 30 && +b <= 30) out.push([+a, +b]);
    }
    return out;
  };
  const pick = (cands) =>
    cands.filter(([a, b]) => isValidGameScore(a, b))[0] ||
    cands.find(([a, b]) => a === 21 || b === 21) ||
    cands[0] || null;

  // Prefer a rule-valid split of the whole string.
  if (s.length <= 4) {
    const direct = splitsOf(s).filter(([a, b]) => isValidGameScore(a, b));
    if (direct.length) return direct[0];
  }

  // Fused points+games ("92102" = 9,21 + games 0,2 — or "2182" = 21,8 + a
  // leaked games digit): peel 1-2 trailing digits (games-won are each 0-2)
  // and take the longest prefix that forms a rule-valid game.
  for (let prefixLen = Math.min(4, s.length - 1); prefixLen >= 2; prefixLen--) {
    const remainder = s.slice(prefixLen);
    if (remainder.length > 2 || ![...remainder].every((d) => +d <= 2)) continue;
    const valid = splitsOf(s.slice(0, prefixLen)).filter(([a, b]) => isValidGameScore(a, b));
    if (valid.length) return valid[0];
  }
  // No rule-valid interpretation: fall back to the least-bad direct split.
  return pick(splitsOf(s.slice(0, 4))) || [null, null];
}

/* ------------------------------------------------------------------ *
 * Extraction
 * ------------------------------------------------------------------ */

const findToken = (toks, re) => toks.find((w) => re.test(w.t));
const NOISE = /^[|.,:;'"“”‘’!_\-–—=~*()\[\]{}\/\\]+$/;

// Division is a handwritten "1" or "2" next to the printed "Div:". Vision
// often reads a handwritten 1 as | I l / ( ) and a 2 as z/Z — normalise the
// lookalikes and resolve a token to '1', '2', or null.
function divisionDigit(t) {
  const tail = String(t).replace(/^div[.:]*/i, '').trim(); // "Div:1" -> "1"
  if (/^1$/.test(tail) || /^[|Il/()\[\]!]$/.test(tail)) return '1';
  if (/^2$/.test(tail) || /^[zZ]$/.test(tail)) return '2';
  const m = /^[:.\s]*([12])[:.\s]*$/.exec(tail);
  return m ? m[1] : null;
}

function extractScorecard(resp) {
  const warnings = [];
  const { tokens: toks, rotationDegrees } = normaliseOrientation(resp);

  const A = {
    events: findToken(toks, /^Events$/i),
    points: findToken(toks, /^Points$/i),
    games: findToken(toks, /^Games$/i),
    played: findToken(toks, /^Played$/i),
    date: findToken(toks, /^Date/i),
    div: findToken(toks, /^Div/i),
    home: null,
    away: null,
  };
  for (const [name, tok] of Object.entries({ events: A.events, points: A.points, games: A.games })) {
    if (!tok) throw new Error(`Scorecard anchors missing: could not find "${name}" — is this a Tameside scorecard photo?`);
  }
  // "Home"/"Away" sub-headers under Players (between Events and Points, above the rows).
  const headerY = A.points.cy;
  A.home = toks.find((w) => /^Home$/i.test(w.t) && Math.abs(w.cy - headerY) < 60 && w.cx > A.events.x0 && w.cx < A.points.x0);
  A.away = toks.find((w) => /^Away$/i.test(w.t) && Math.abs(w.cy - headerY) < 60 && w.cx > A.events.x0 && w.cx < A.points.x0);

  const eventsRight = A.events.x1 + 30;
  const ptsLo = A.points.x0 - 45;
  const ptsHi = A.games.x0 - 18;

  // Row anchors: the 9 printed event labels down the Events column.
  const rowAnchors = toks
    .filter((w) => /^(Open|Ladies|Mixed)$/i.test(w.t) && w.cx < eventsRight)
    .sort((a, b) => a.cy - b.cy);
  if (rowAnchors.length !== 9) {
    warnings.push(`Expected 9 event-row anchors, found ${rowAnchors.length} — extraction may be incomplete.`);
  }
  if (rowAnchors.length < 2) throw new Error('Could not locate the event rows on the scorecard.');

  /* ---- metadata ---- */
  const sameLine = (w, anchor, tol) => Math.abs(w.cy - anchor.cy) < tol;
  const byX = (a, b) => a.cx - b.cx;

  const gridTop = rowAnchors[0].cy - (rowAnchors[1].cy - rowAnchors[0].cy) / 2;

  const dateText = A.date
    ? toks.filter((w) => sameLine(w, A.date, 20) && w.cx > A.date.x1 && /^[\d/.\-:]+$/.test(w.t))
        .sort(byX).map((w) => w.t).join('').replace(/^[:.\-/]+/, '')
    : '';
  const divisionText = A.div
    ? (toks.filter((w) => sameLine(w, A.div, 22) && w.x1 > A.div.x0 && w.cx < A.div.x1 + 200)
        .sort(byX).map((w) => divisionDigit(w.t)).find(Boolean) || '')
    : '';
  const playedAtText = A.played
    ? toks.filter((w) =>
        sameLine(w, A.played, 18) && w.cx > A.played.x1 &&
        !/^(at|Date)$/i.test(w.t) && !NOISE.test(w.t) &&
        !(A.date && sameLine(A.date, A.played, 25) && w.cx > A.date.x0 - 20))
        .sort(byX).map((w) => w.t).join(' ').trim()
    : '';

  // Team names: the handwritten "<home> v <away>" line between the printed
  // title and the grid. Handwriting slopes across the page (40px+ of baseline
  // drift on real cards) and the "Played at" handwriting can rise above its
  // printed label, so a fixed y-band is unreliable. Instead: seed on the "v"
  // and CHAIN-WALK outward token by token, following the sloped baseline —
  // each next token must sit within 28px of the previously accepted one.
  let homeTeamText = '';
  let awayTeamText = '';
  const headerCeiling = A.played ? A.played.y1 + 12 : gridTop - 30;
  const vTok = toks
    .filter((w) => /^v$/i.test(w.t) && w.cy < headerCeiling)
    .sort((a, b) => a.cy - b.cy).pop();
  if (vTok) {
    const cands = toks.filter((w) =>
      w !== vTok && w.cy < headerCeiling && !NOISE.test(w.t) &&
      !/^\d/.test(w.t) && !/^(Div|v|Played|at|Date|Tameside|Badminton|League)$/i.test(w.t));
    const walk = (side, ordered) => {
      const out = [];
      let refY = vTok.cy;
      for (const w of ordered) {
        if (Math.abs(w.cy - refY) < 28) { out.push(w); refY = w.cy; }
      }
      return out.sort(byX).map((w) => w.t).join(' ').trim();
    };
    homeTeamText = walk('home', cands.filter((w) => w.cx < vTok.cx).sort((a, b) => b.cx - a.cx));
    awayTeamText = walk('away', cands.filter((w) => w.cx > vTok.cx && (!A.div || w.cx < A.div.x0 - 10)).sort((a, b) => a.cx - b.cx));
  }

  /* ---- per-event rows ---- */
  const nameMid = A.home && A.away ? (A.home.cx + A.away.cx) / 2 : (eventsRight + ptsLo) / 2;

  // The last row's bottom extends to the printed RESULT line when we can find
  // it (handwriting in Open D often sits below the midpoint extrapolation).
  const resultAnchor = findToken(toks, /^RESULT/i);

  const events = rowAnchors.map((row, i) => {
    const top = i === 0 ? row.cy - (rowAnchors[1].cy - row.cy) / 2 : (rowAnchors[i - 1].cy + row.cy) / 2;
    const bot = i === rowAnchors.length - 1
      ? (resultAnchor && resultAnchor.cy > row.cy ? resultAnchor.y0 - 4 : row.cy + (row.cy - rowAnchors[i - 1].cy) / 2)
      : (row.cy + rowAnchors[i + 1].cy) / 2;
    const inBand = (w) => w.cy > top && w.cy < bot;

    // Points: digit tokens overlapping the points block (overlap, not centre —
    // a fused points+games blob like "92102" straddles the column boundary),
    // clustered into (up to) 2 game rows by y, each row's digits concatenated
    // then split into H-A. Rows with fewer than 2 digits are dropped: they're
    // games-won digits that leaked left into the points band, and would
    // otherwise consume one of the two game slots.
    const pointToks = toks.filter((w) => /\d/.test(w.t) && w.x1 > ptsLo && w.x0 < ptsHi && inBand(w)).sort((a, b) => a.cy - b.cy);
    const yRows = [];
    for (const t of pointToks) {
      const g = yRows.find((r) => Math.abs(r.cy - t.cy) < 24);
      if (g) { g.toks.push(t); g.cy = (g.cy + t.cy) / 2; } else yRows.push({ cy: t.cy, toks: [t] });
    }
    const gameScores = yRows
      .map((r) => r.toks.sort(byX).map((t) => t.t).join('').replace(/\D/g, ''))
      .filter((digits) => digits.length >= 2)
      .slice(0, 2)
      .map((digits) => splitScores(digits));
    while (gameScores.length < 2) gameScores.push([null, null]);

    const gamesWon = [0, 0];
    let complete = 0;
    for (const [h, a] of gameScores) {
      if (h != null && a != null) { gamesWon[h > a ? 0 : 1]++; complete++; }
    }
    if (complete < 2) warnings.push(`${EVENT_NAMES[i] || 'row ' + i}: only ${complete}/2 game scores read.`);

    // Player-name tokens split into home/away by the Home/Away column centres.
    const nameToks = toks.filter((w) => !/\d/.test(w.t) && !NOISE.test(w.t) && w.cx > eventsRight && w.cx < ptsLo && inBand(w));
    const sortNames = (a, b) => a.cy - b.cy || a.cx - b.cx;
    const joinNames = (arr) => arr.sort(sortNames).map((w) => w.t).join(' ').trim();

    return {
      event: EVENT_NAMES[i] || `row ${i}`,
      games: GAME_MAP[i] || null,
      home: { playersRaw: joinNames(nameToks.filter((w) => w.cx < nameMid)), g1: gameScores[0][0], g2: gameScores[1][0] },
      away: { playersRaw: joinNames(nameToks.filter((w) => w.cx >= nameMid)), g1: gameScores[0][1], g2: gameScores[1][1] },
      gamesWon: { home: gamesWon[0], away: gamesWon[1] },
    };
  });

  const result = events.reduce(
    (acc, e) => ({ home: acc.home + e.gamesWon.home, away: acc.away + e.gamesWon.away }),
    { home: 0, away: 0 }
  );

  // Flat Game1..Game18 map for the entry-form handoff.
  const games = {};
  events.forEach((e, i) => {
    const [g1, g2] = GAME_MAP[i] || [];
    if (g1) { games[`Game${g1}homeScore`] = e.home.g1; games[`Game${g1}awayScore`] = e.away.g1; }
    if (g2) { games[`Game${g2}homeScore`] = e.home.g2; games[`Game${g2}awayScore`] = e.away.g2; }
  });

  return {
    rotationDegrees,
    meta: { date: dateText, division: divisionText, playedAt: playedAtText, homeTeam: homeTeamText, awayTeam: awayTeamText },
    result,
    events,
    games,
    warnings,
  };
}

module.exports = { extractScorecard, splitScores, normaliseOrientation, divisionDigit, EVENT_NAMES, GAME_MAP };
