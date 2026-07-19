// Superadmin scorecard OCR: pick an uploaded scorecard photo from S3, run it
// through Google Vision + the anchor-relative extractor, fuzzy-match the
// player names against the two teams' eligible rosters, and present a review
// page. The handoff is a link into the EXISTING prefilled-scorecard flow
// (/populated-scorecard/...), so submission goes through the same validated
// entry path as manual entry — this feature never writes results directly.
require('dotenv').config();
const { S3Client, GetObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');

const { annotateScorecard } = require('../utils/scorecardVision');
const { extractScorecard, parseCardDate } = require('../utils/scorecardExtraction');
const { matchScorecard, matchTeamName } = require('../utils/scorecardMatch');
const Team = require('../models/teams');
const Player = require('../models/players');
const Fixture = require('../models/fixture');
const Division = require('../models/division');

const promisify = (fn) => (...args) => new Promise((resolve, reject) =>
  fn(...args, (err, result) => (err ? reject(err instanceof Error ? err : new Error(String(err))) : resolve(result))));

const findTeamByNameP = promisify(Team.findByName);
const getAllTeamsP = promisify(Team.getAll);
const getAllDivisionsP = promisify(Division.getAll);
const getRosterP = promisify(Player.getEligibleByTeamName);
const getOutstandingFixtureP = promisify(Fixture.getOutstandingFixtureId);
const getFixtureDetailsP = promisify(Fixture.getFixtureDetailsById);

function isSuperAdmin(req) {
  return !!(req.user && req.user._json && req.user._json['https://my-app.example.com/role'] === 'superadmin');
}

const BUCKET = process.env.S3_BUCKET_NAME || 'badmintontemp';
// Prefer the S3_LOGS_STORAGE key pair (valid both locally and on Cloud Run);
// fall back to the default AWS_* env credentials.
const s3 = new S3Client({
  region: 'eu-west-1',
  credentials: process.env.S3_LOGS_STORAGE_KEY
    ? { accessKeyId: process.env.S3_LOGS_STORAGE_KEY, secretAccessKey: process.env.S3_LOGS_STORAGE_SECRET }
    : undefined,
});

// "tameside-20252026-Mellor B-Syddal Park A.jpg" -> { home, away }
// (older keys omit the season: "tameside-GHAP B-GHAP A.jpeg")
function teamsFromKey(key) {
  const m = /^tameside-(?:\d{8}-)?(.+)\.[a-zA-Z]+$/.exec(key || '');
  if (!m) return null;
  const parts = m[1].split('-');
  if (parts.length !== 2) return null; // team names don't contain hyphens today
  return { home: parts[0].trim(), away: parts[1].trim() };
}

function renderOpts(title, extra) {
  return Object.assign({ static_path: '/static', title, pageDescription: title }, extra);
}

/* ------------------------------------------------------------------ *
 * Shared pipeline: image buffer -> extraction, team resolution, roster
 * matching, fixture cross-check, and the prefilled-form handoff URL.
 * `names` ({home, away} from a team-named S3 key) is preferred when given;
 * otherwise the teams are resolved by fuzzy-matching the handwritten card
 * header against all team names — that's how wizard uploads (generic keys)
 * are handled.
 * ------------------------------------------------------------------ */
async function analyseBuffer(buffer, names) {
  const vision = await annotateScorecard(buffer);
  const extraction = extractScorecard(vision);

  // Candidate pool: real, current teams only (excludes the "No Team"
  // placeholder and division-less leftovers like defunct sides).
  const allTeams = (await getAllTeamsP()).filter((t) => t.division != null && !/^no team$/i.test(t.name));

  // Resolve each side through a fallback chain: exact DB name from the S3 key
  // -> fuzzy match on the key name (handles renames like "Hyde High B" ->
  // "Hyde B") -> fuzzy match on the handwritten card header. A side that
  // still can't be resolved stays null — the caller decides how to degrade
  // (the wizard prefills what it can and lets the user pick the teams).
  const resolveTeam = async (keyName, headerName) => {
    if (keyName) {
      const rows = await findTeamByNameP(keyName);
      if (rows && rows[0]) return { team: rows[0], how: 'key' };
      const fuzzyKey = matchTeamName(keyName, allTeams);
      if (fuzzyKey) return { team: fuzzyKey, how: 'key-fuzzy' };
    }
    const fromHeader = matchTeamName(headerName, allTeams);
    return fromHeader ? { team: fromHeader, how: 'header' } : { team: null, how: 'unresolved' };
  };
  const [homeRes, awayRes] = await Promise.all([
    resolveTeam(names && names.home, extraction.meta.homeTeam),
    resolveTeam(names && names.away, extraction.meta.awayTeam),
  ]);
  const homeTeam = homeRes.team;
  const awayTeam = awayRes.team;
  const teamResolution = `${homeRes.how}/${awayRes.how}`;

  // Rosters + matching only for resolved sides (matchScorecard tolerates an
  // empty roster: those pairs/slots just come back null).
  const [homeRoster, awayRoster] = await Promise.all([
    homeTeam ? getRosterP(homeTeam.name) : [],
    awayTeam ? getRosterP(awayTeam.name) : [],
  ]);
  const matched = matchScorecard(extraction, homeRoster, awayRoster);

  // Fixture cross-check (advisory — may be missing if already complete).
  let fixture = null;
  if (homeTeam && awayTeam) {
    try {
      const fx = await getOutstandingFixtureP({ homeTeam: homeTeam.id, awayTeam: awayTeam.id });
      if (fx && fx[0]) {
        const details = await getFixtureDetailsP(fx[0].id);
        fixture = { id: fx[0].id, divisionName: fx[0].name, date: details && details[0] ? details[0].date : null };
      }
    } catch (e) { /* advisory only */ }
  }

  // Division id: from a resolved team, else mapped from the handwritten Div
  // digit via the division table's rank.
  let divisionId = (homeTeam && homeTeam.division) || (awayTeam && awayTeam.division) || null;
  if (!divisionId && extraction.meta.division) {
    try {
      const divisions = await getAllDivisionsP();
      const byRank = divisions.find((d) => String(d.rank) === extraction.meta.division);
      if (byRank) divisionId = byRank.id;
    } catch (e) { /* advisory only */ }
  }

  // Card date -> yyyy-mm-dd for the form's date input (fixture date fallback).
  // Sanity window: a match card's date can't plausibly be far in the future or
  // more than ~15 months back — misreads (e.g. "2027" from smudged digits)
  // fall through to the fixture's scheduled date instead.
  let cardDate = parseCardDate(extraction.meta.date);
  if (cardDate) {
    const d = new Date(cardDate);
    const now = Date.now();
    if (d.getTime() > now + 60 * 86400e3 || d.getTime() < now - 450 * 86400e3) cardDate = null;
  }
  if (!cardDate && fixture && fixture.date) cardDate = new Date(fixture.date).toISOString().slice(0, 10);

  // Handoff URL for the admin review flow (needs both teams).
  let handoffUrl = null;
  if (homeTeam && awayTeam) {
    const slot = (p) => (p ? p.id : 0);
    const s = matched.slots;
    const scoreParams = [];
    for (let g = 1; g <= 18; g++) {
      scoreParams.push(extraction.games[`Game${g}homeScore`] ?? 0, extraction.games[`Game${g}awayScore`] ?? 0);
    }
    handoffUrl = '/populated-scorecard/' + [
      homeTeam.division, homeTeam.id, awayTeam.id,
      slot(s.home.men[0]), slot(s.home.men[1]), slot(s.home.men[2]), slot(s.home.men[3]),
      slot(s.home.ladies[0]), slot(s.home.ladies[1]),
      slot(s.away.men[0]), slot(s.away.men[1]), slot(s.away.men[2]), slot(s.away.men[3]),
      slot(s.away.ladies[0]), slot(s.away.ladies[1]),
      ...scoreParams,
    ].map(encodeURIComponent).join('/');
  }

  return { extraction, matched, homeTeam, awayTeam, fixture, divisionId, cardDate, handoffUrl, teamResolution };
}

/* ------------------------------------------------------------------ *
 * GET /admin/scorecard-ocr — pick a scorecard photo
 * ------------------------------------------------------------------ */
exports.list = async function (req, res, next) {
  if (!isSuperAdmin(req)) return res.status(403).send('Forbidden');
  try {
    const listed = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: 'tameside-' }));
    const cards = (listed.Contents || [])
      .filter((o) => /\.(jpe?g|png)$/i.test(o.Key))
      .sort((a, b) => new Date(b.LastModified) - new Date(a.LastModified))
      .slice(0, 60)
      .map((o) => ({
        key: o.Key,
        label: o.Key.replace(/^tameside-(\d{8}-)?/, '').replace(/\.[a-zA-Z]+$/, ''),
        uploaded: o.LastModified,
        sizeKb: Math.round(o.Size / 1024),
      }));
    res.render('admin/scorecard-ocr-list', renderOpts('Scorecard OCR', { cards }));
  } catch (err) { next(err); }
};

/* ------------------------------------------------------------------ *
 * GET /admin/scorecard-ocr/review?key=... — extract, match, review
 * ------------------------------------------------------------------ */
exports.review = async function (req, res, next) {
  if (!isSuperAdmin(req)) return res.status(403).send('Forbidden');
  const key = req.query.key;
  if (!key || !/^tameside-/.test(key)) return res.status(400).send('Bad or missing ?key');
  try {
    const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    const buffer = Buffer.from(await obj.Body.transformToByteArray());
    // Team-named keys resolve directly; generic keys (wizard uploads) fall
    // back to fuzzy-matching the handwritten header inside analyseBuffer.
    const r = await analyseBuffer(buffer, teamsFromKey(key));
    if (!r.homeTeam || !r.awayTeam) {
      throw new Error(`Could not identify the ${!r.homeTeam ? 'home' : 'away'} team ` +
        `(card header read "${r.extraction.meta.homeTeam || '?'}" v "${r.extraction.meta.awayTeam || '?'}").`);
    }
    res.render('admin/scorecard-ocr-review', renderOpts('Scorecard OCR — Review', {
      s3key: key,
      extraction: r.extraction,
      matched: r.matched,
      homeTeam: r.homeTeam, awayTeam: r.awayTeam,
      fixture: r.fixture,
      handoffUrl: r.handoffUrl,
    }));
  } catch (err) {
    // Extraction failures are expected occasionally (blurry photo, PDF, wrong
    // template) — show a friendly page rather than a 500.
    res.status(422).render('admin/scorecard-ocr-error', renderOpts('Scorecard OCR — Failed', {
      s3key: key,
      message: err.message,
    }));
  }
};

/* ------------------------------------------------------------------ *
 * POST /scorecard-ocr/analyse — the entry-wizard integration.
 * Any logged-in user (secured route, no superadmin check): the wizard
 * uploads the photo to S3 first (existing /sign-s3 flow), then posts the
 * key here. Responds with JSON: the prefilled-form URL plus what was read,
 * so the wizard can confirm and navigate. Nothing is written to the DB.
 * ------------------------------------------------------------------ */
exports.analyse = async function (req, res) {
  const key = req.body && req.body.key;
  if (!key || !/^tameside-/.test(key)) return res.status(400).json({ ok: false, error: 'Bad or missing key' });
  try {
    const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    const buffer = Buffer.from(await obj.Body.transformToByteArray());
    const r = await analyseBuffer(buffer, teamsFromKey(key));
    // Partial results are fine: unresolved teams come back null and the
    // wizard still prefills division/date/scores, leaving team/player picks
    // to the user (failing the whole flow put people off using it).
    const slotIds = (side) => ({
      men: r.matched.slots[side].men.map((p) => (p ? p.id : null)),
      ladies: r.matched.slots[side].ladies.map((p) => (p ? p.id : null)),
    });
    res.json({
      ok: true,
      teams: {
        home: r.homeTeam ? { id: r.homeTeam.id, name: r.homeTeam.name } : null,
        away: r.awayTeam ? { id: r.awayTeam.id, name: r.awayTeam.name } : null,
      },
      headerRead: { home: r.extraction.meta.homeTeam, away: r.extraction.meta.awayTeam },
      teamResolution: r.teamResolution,
      divisionId: r.divisionId,
      date: r.cardDate,
      slots: { home: slotIds('home'), away: slotIds('away') },
      games: r.extraction.games,
      result: r.extraction.result,
      warnings: r.extraction.warnings,
    });
  } catch (err) {
    res.status(422).json({ ok: false, error: err.message });
  }
};

/* ------------------------------------------------------------------ *
 * GET /admin/scorecard-ocr/image?key=... — stream the photo for preview
 * ------------------------------------------------------------------ */
exports.image = async function (req, res, next) {
  if (!isSuperAdmin(req)) return res.status(403).send('Forbidden');
  const key = req.query.key;
  if (!key || !/^tameside-/.test(key)) return res.status(400).send('Bad or missing ?key');
  try {
    const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    res.set('Content-Type', obj.ContentType || 'image/jpeg');
    res.set('Cache-Control', 'private, max-age=3600');
    obj.Body.pipe(res);
  } catch (err) { next(err); }
};
