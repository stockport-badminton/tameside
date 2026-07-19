// Superadmin scorecard OCR: pick an uploaded scorecard photo from S3, run it
// through Google Vision + the anchor-relative extractor, fuzzy-match the
// player names against the two teams' eligible rosters, and present a review
// page. The handoff is a link into the EXISTING prefilled-scorecard flow
// (/populated-scorecard/...), so submission goes through the same validated
// entry path as manual entry — this feature never writes results directly.
require('dotenv').config();
const { S3Client, GetObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');

const { annotateScorecard } = require('../utils/scorecardVision');
const { extractScorecard } = require('../utils/scorecardExtraction');
const { matchScorecard, matchTeamName } = require('../utils/scorecardMatch');
const Team = require('../models/teams');
const Player = require('../models/players');
const Fixture = require('../models/fixture');

const promisify = (fn) => (...args) => new Promise((resolve, reject) =>
  fn(...args, (err, result) => (err ? reject(err instanceof Error ? err : new Error(String(err))) : resolve(result))));

const findTeamByNameP = promisify(Team.findByName);
const getAllTeamsP = promisify(Team.getAll);
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

  let homeTeam = null;
  let awayTeam = null;
  let teamResolution = 'key';
  if (names) {
    const [homeRows, awayRows] = await Promise.all([findTeamByNameP(names.home), findTeamByNameP(names.away)]);
    homeTeam = homeRows && homeRows[0];
    awayTeam = awayRows && awayRows[0];
  }
  if (!homeTeam || !awayTeam) {
    teamResolution = 'header';
    const allTeams = await getAllTeamsP();
    homeTeam = homeTeam || matchTeamName(extraction.meta.homeTeam, allTeams);
    awayTeam = awayTeam || matchTeamName(extraction.meta.awayTeam, allTeams);
    if (!homeTeam || !awayTeam) {
      const read = `read "${extraction.meta.homeTeam || '?'}" v "${extraction.meta.awayTeam || '?'}"`;
      throw new Error(`Could not identify the ${!homeTeam ? 'home' : 'away'} team from the card header (${read}).`);
    }
  }

  const [homeRoster, awayRoster] = await Promise.all([getRosterP(homeTeam.name), getRosterP(awayTeam.name)]);
  const matched = matchScorecard(extraction, homeRoster, awayRoster);

  // Fixture cross-check (advisory — may be missing if already complete).
  let fixture = null;
  try {
    const fx = await getOutstandingFixtureP({ homeTeam: homeTeam.id, awayTeam: awayTeam.id });
    if (fx && fx[0]) {
      const details = await getFixtureDetailsP(fx[0].id);
      fixture = { id: fx[0].id, divisionName: fx[0].name, date: details && details[0] ? details[0].date : null };
    }
  } catch (e) { /* advisory only */ }

  // Handoff URL into the existing prefilled-scorecard flow (ids; 0 = unknown).
  const slot = (p) => (p ? p.id : 0);
  const s = matched.slots;
  const scoreParams = [];
  for (let g = 1; g <= 18; g++) {
    scoreParams.push(extraction.games[`Game${g}homeScore`] ?? 0, extraction.games[`Game${g}awayScore`] ?? 0);
  }
  const handoffUrl = '/populated-scorecard/' + [
    homeTeam.division, homeTeam.id, awayTeam.id,
    slot(s.home.men[0]), slot(s.home.men[1]), slot(s.home.men[2]), slot(s.home.men[3]),
    slot(s.home.ladies[0]), slot(s.home.ladies[1]),
    slot(s.away.men[0]), slot(s.away.men[1]), slot(s.away.men[2]), slot(s.away.men[3]),
    slot(s.away.ladies[0]), slot(s.away.ladies[1]),
    ...scoreParams,
  ].map(encodeURIComponent).join('/');

  return { extraction, matched, homeTeam, awayTeam, fixture, handoffUrl, teamResolution };
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
    res.json({
      ok: true,
      url: r.handoffUrl,
      homeTeam: r.homeTeam.name,
      awayTeam: r.awayTeam.name,
      result: r.extraction.result,
      teamResolution: r.teamResolution,
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
