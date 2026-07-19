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
const { matchScorecard } = require('../utils/scorecardMatch');
const Team = require('../models/teams');
const Player = require('../models/players');
const Fixture = require('../models/fixture');

const promisify = (fn) => (...args) => new Promise((resolve, reject) =>
  fn(...args, (err, result) => (err ? reject(err instanceof Error ? err : new Error(String(err))) : resolve(result))));

const findTeamByNameP = promisify(Team.findByName);
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
    // 1. Fetch the photo and run Vision + extraction.
    const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    const buffer = Buffer.from(await obj.Body.transformToByteArray());
    const vision = await annotateScorecard(buffer);
    const extraction = extractScorecard(vision);

    // 2. Resolve the two teams (S3 key is authoritative; the handwritten
    //    header is shown alongside as a cross-check).
    const names = teamsFromKey(key);
    if (!names) throw new Error(`Could not parse team names from S3 key "${key}"`);
    const [homeRows, awayRows] = await Promise.all([findTeamByNameP(names.home), findTeamByNameP(names.away)]);
    const homeTeam = homeRows && homeRows[0];
    const awayTeam = awayRows && awayRows[0];
    if (!homeTeam || !awayTeam) {
      throw new Error(`Team not found in DB: ${!homeTeam ? names.home : names.away}`);
    }

    // 3. Rosters + fuzzy matching.
    const [homeRoster, awayRoster] = await Promise.all([getRosterP(names.home), getRosterP(names.away)]);
    const matched = matchScorecard(extraction, homeRoster, awayRoster);

    // 4. Fixture cross-check (advisory — may be missing if already complete).
    let fixture = null;
    try {
      const fx = await getOutstandingFixtureP({ homeTeam: homeTeam.id, awayTeam: awayTeam.id });
      if (fx && fx[0]) {
        const details = await getFixtureDetailsP(fx[0].id);
        fixture = { id: fx[0].id, divisionName: fx[0].name, date: details && details[0] ? details[0].date : null };
      }
    } catch (e) { /* advisory only */ }

    // 5. Handoff URL into the existing prefilled-scorecard flow (ids; 0 = unknown).
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

    res.render('admin/scorecard-ocr-review', renderOpts('Scorecard OCR — Review', {
      s3key: key,
      extraction,
      matched,
      homeTeam, awayTeam,
      fixture,
      handoffUrl,
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
