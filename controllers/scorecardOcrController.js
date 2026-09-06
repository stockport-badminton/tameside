// Superadmin scorecard OCR: pick an uploaded scorecard photo from S3, run it
// through Google Vision + the anchor-relative extractor, fuzzy-match the
// player names against the two teams' eligible rosters, and present a review
// page. The handoff is a link into the EXISTING prefilled-scorecard flow
// (/populated-scorecard/...), so submission goes through the same validated
// entry path as manual entry — this feature never writes results directly.
require('dotenv').config();
const { GetObjectCommand, PutObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');

// Held as a MODULE, and called as `vision.annotateScorecard(...)`, not destructured.
// Destructuring captures the function at require time, so a test stub installed on the
// module object never intercepts — and the test that asserts the convert endpoint does
// NOT read the card would then pass whether that were true or not, which is worse than
// no test at all.
const vision = require('../utils/scorecardVision');
const { extractScorecard, parseCardDate } = require('../utils/scorecardExtraction');
const { matchScorecard, matchTeamName } = require('../utils/scorecardMatch');
const Team = require('../models/teams');
const Player = require('../models/players');
const Fixture = require('../models/fixture');
const Division = require('../models/division');

const promisify = (fn) => (...args) => new Promise((resolve, reject) =>
  fn(...args, (err, result) => (err ? reject(err instanceof Error ? err : new Error(String(err))) : resolve(result))));

const findTeamByNameP = promisify(Team.findByName);
const getTeamByIdP = promisify(Team.getById);
const getAllTeamsP = promisify(Team.getAll);
const getAllDivisionsP = promisify(Division.getAll);
const getRosterP = promisify(Player.getEligibleByTeamName);
const getOutstandingFixtureP = promisify(Fixture.getOutstandingFixtureId);
const getFixtureDetailsP = promisify(Fixture.getFixtureDetailsById);

// Shared with every other admin-gated controller — utils/authz.js owns the claim key.
const { isSuperAdmin } = require('../utils/authz');

const BUCKET = process.env.S3_BUCKET_NAME || 'badmintontemp';
// Prefer the S3_LOGS_STORAGE key pair (valid both locally and on Cloud Run); fall back to
// the default AWS_* env credentials. utils/s3.js is the one place that knows this, because
// the default pair was silently rotated out once already.
const { s3Client } = require('../utils/s3');
const s3 = s3Client();
// Extension -> the type this route will admit to. Shared with GET /scorecard-photo/:id.
const { contentTypeFor, downloadTypeFor, downloadNameFor } = require('../utils/scorecardPhoto');
// Turning an uploaded pdf/docx into a stored photo. See utils/scorecardDocument.js for
// why this takes a KEY rather than bytes, and utils/documentImage.js for what it can and
// deliberately cannot read.
// The module, not its members — see the note on `vision` above. `convertStoredDocument`
// is the one the tests replace; the two predicates are pure and destructured freely.
const scorecardDocument = require('../utils/scorecardDocument');
const { isDocumentKey, isRefusedArchive } = scorecardDocument;

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
/* ------------------------------------------------------------------ *
 * Vision-response cache: one Vision call per uploaded photo, ever. The raw
 * response is stored beside the upload so re-analysis (e.g. after the user
 * picks the teams the header couldn't identify) re-maps the SAME detection
 * against new inputs instead of re-OCRing.
 * ------------------------------------------------------------------ */
const visionCacheKey = (key) => `scorecard-ocr-cache/${key}.vision.json`;

/* ------------------------------------------------------------------ *
 * Documents
 *
 * A pdf or a docx scorecard is a photo with a wrapper round it, and 41 of our 324
 * scorecard objects are pdfs — an eighth of the archive. Two things were wrong with
 * that before this: the browser will not preview one inline, so `GET /scorecard-photo/:id`
 * has to serve it as a download; and Vision cannot read one, so the OCR wizard could
 * never be used with a scanned card at all.
 *
 * So the photo is pulled out and stored beside the document, and the row points at the
 * photo. The document is left exactly where it is — see utils/scorecardDocument.js.
 *
 * A document this cannot read is NOT an error. 15 of the 41 decline, 11 of them because
 * they are MRC scans whose text lives in a separate layer that would be lost. Those keep
 * the behaviour they have had for two seasons: stored as a pdf, no OCR.
 * ------------------------------------------------------------------ */

// Returns the key to actually read pixels from, plus the photo url when one was made.
// For a photo upload this is a no-op, which is the common case.
async function resolveToImageKey(key) {
  if (!isDocumentKey(key)) return { imageKey: key, photoUrl: null, converted: false };
  const stored = await scorecardDocument.convertStoredDocument(key);
  if (!stored) return { imageKey: null, photoUrl: null, converted: false };
  return { imageKey: stored.key, photoUrl: stored.url, converted: true };
}

// What to tell a captain when a document could not be converted. Named rather than
// inlined because the two endpoints must say the same thing, and because a message that
// sends someone round a loop that cannot close is worse than a plain refusal — the reason
// this one names the alternative that actually works.
const CANNOT_EXTRACT =
  'That file could not be read as a scorecard photo. It has still been attached to the '
  + 'scorecard, so nothing is lost — but to have the card read automatically, send a '
  + 'photo of it instead (JPEG, PNG or HEIC).';



async function getVisionForKey(key) {
  try {
    const cached = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: visionCacheKey(key) }));
    return JSON.parse(Buffer.from(await cached.Body.transformToByteArray()).toString());
  } catch (e) { /* cache miss */ }
  const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  const buffer = Buffer.from(await obj.Body.transformToByteArray());
  const annotated = await vision.annotateScorecard(buffer);
  // Fire-and-forget cache write — analysis shouldn't fail if this does.
  s3.send(new PutObjectCommand({
    Bucket: BUCKET, Key: visionCacheKey(key),
    Body: JSON.stringify(annotated), ContentType: 'application/json',
  })).catch(() => {});
  return annotated;
}

async function analyseVision(vision, names, overrides) {
  const extraction = extractScorecard(vision);

  // Candidate pool: real, current teams only (excludes the "No Team"
  // placeholder and division-less leftovers like defunct sides).
  const allTeams = (await getAllTeamsP()).filter((t) => t.division != null && !/^no team$/i.test(t.name));

  // Resolve each side through a fallback chain: an explicit team id from the
  // user (the wizard's re-analyse after a manual pick) -> exact DB name from
  // the S3 key -> fuzzy match on the key name (handles renames like "Hyde
  // High B" -> "Hyde B") -> fuzzy match on the handwritten card header. A
  // side that still can't be resolved stays null — the caller decides how to
  // degrade (the wizard prefills what it can and lets the user pick teams).
  const resolveTeam = async (keyName, headerName, overrideId) => {
    if (overrideId) {
      const rows = await getTeamByIdP(overrideId);
      if (rows && rows[0]) return { team: rows[0], how: 'user' };
    }
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
    resolveTeam(names && names.home, extraction.meta.homeTeam, overrides && overrides.homeTeamId),
    resolveTeam(names && names.away, extraction.meta.awayTeam, overrides && overrides.awayTeamId),
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
    // Team-named keys resolve directly; generic keys (wizard uploads) fall
    // back to fuzzy-matching the handwritten header inside analyseVision.
    const vision = await getVisionForKey(key);
    const r = await analyseVision(vision, teamsFromKey(key));
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
  if (isRefusedArchive(key)) {
    return res.status(400).json({ ok: false, error: 'Archives are not accepted. Send the photo or the document itself.' });
  }
  try {
    // Optional overrides: the wizard re-analyses with the user's team picks
    // when the header couldn't be read — same cached detection, new mapping.
    const overrides = {
      homeTeamId: req.body.homeTeamId || null,
      awayTeamId: req.body.awayTeamId || null,
    };

    // A pdf or docx becomes a stored jpeg first, and everything downstream — Vision, the
    // cache, teamsFromKey — then works on the photo exactly as it would on an uploaded
    // one. On a re-analyse the document has already been converted, so this reruns on the
    // photo key the client sent back and is a no-op.
    const { imageKey, photoUrl } = await resolveToImageKey(key);
    if (!imageKey) return res.status(422).json({ ok: false, error: CANNOT_EXTRACT });

    const vision = await getVisionForKey(imageKey);
    const r = await analyseVision(vision, teamsFromKey(imageKey), overrides);
    // Partial results are fine: unresolved teams come back null and the
    // wizard still prefills division/date/scores, leaving team/player picks
    // to the user (failing the whole flow put people off using it).
    const slotIds = (side) => ({
      men: r.matched.slots[side].men.map((p) => (p ? p.id : null)),
      ladies: r.matched.slots[side].ladies.map((p) => (p ? p.id : null)),
    });
    res.json({
      ok: true,
      // Present only when a document was converted. The page swaps scoresheet-url onto
      // this, so the row records the photo rather than the pdf — otherwise the whole
      // conversion would happen and then be thrown away at submit time.
      photoUrl,
      photoKey: photoUrl ? imageKey : null,
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
 * POST /scorecard-document/convert — pull the photo out, and DO NOT read the card
 *
 * The wizard has two upload boxes and the split is deliberate: the auto-fill box reads
 * the card, and the plain photo box does not. A captain who would rather a machine did
 * not read their scorecard can use the second one, and that promise has to survive a
 * document upload too — so this endpoint converts and stores and never calls Vision.
 *
 * There is a test asserting Vision is not called, because if that ever changes the
 * promise the form makes is broken and nothing else would say so.
 * ------------------------------------------------------------------ */
exports.convert_document = async function (req, res) {
  const key = req.body && req.body.key;
  // Same ownership gate as everything else that names an object: this bucket is shared
  // with the other league, and `tameside-` is what makes one ours.
  if (!key || !/^tameside-/.test(key)) return res.status(400).json({ ok: false, error: 'Bad or missing key' });
  if (isRefusedArchive(key)) {
    return res.status(400).json({ ok: false, error: 'Archives are not accepted. Send the photo or the document itself.' });
  }
  if (!isDocumentKey(key)) {
    return res.status(400).json({
      ok: false,
      error: 'That is not a PDF or Word file. A photo does not need converting.',
    });
  }
  try {
    const stored = await scorecardDocument.convertStoredDocument(key);
    // Not an error: the document is still uploaded and still attached. The caller keeps
    // the url it already has.
    if (!stored) return res.json({ ok: true, converted: false, reason: CANNOT_EXTRACT });
    res.json({ ok: true, converted: true, url: stored.url, key: stored.key });
  } catch (err) {
    if (err.status === 413) return res.status(413).json({ ok: false, error: err.message });
    console.log('[scorecard-document] conversion failed:', err.message);
    res.status(502).json({
      ok: false,
      error: 'The file was uploaded but the photo could not be pulled out of it. '
        + 'It is still attached to the scorecard.',
    });
  }
};

/* ------------------------------------------------------------------ *
 * GET /admin/scorecard-ocr/image?key=... — stream the photo for preview
 * ------------------------------------------------------------------ */
// Unlike GET /scorecard-photo/:id this one legitimately takes a key, because the whole
// point of the OCR list is to preview objects that have no row yet. The `tameside-` test
// is what keeps it from being a proxy for the rest of a bucket that also holds another
// league's scorecards and their SES mail drop.
//
// The content type is NOT echoed from S3. These objects were uploaded through a /sign-s3
// that was unauthenticated and took the caller's content type, so one can claim anything
// — and reflecting that back would serve attacker-chosen HTML from our own origin, which
// is worse than from the bucket because here it is same-origin with the session cookie.
// The extension decides, and anything unrecognised is a 404 rather than a guess.
exports.image = async function (req, res, next) {
  if (!isSuperAdmin(req)) return res.status(403).send('Forbidden');
  const key = req.query.key;
  if (!key || !/^tameside-/.test(key)) return res.status(400).send('Bad or missing ?key');
  const contentType = contentTypeFor(key);
  const downloadType = contentType ? null : downloadTypeFor(key);
  if (!contentType && !downloadType) return res.status(404).end();
  try {
    const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    res.set('Content-Type', contentType || downloadType);
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Content-Disposition', contentType
      ? 'inline'
      : 'attachment; filename="' + downloadNameFor(key) + '"');
    res.set('Cache-Control', 'private, max-age=3600');
    obj.Body.on('error', () => res.destroy());
    obj.Body.pipe(res);
  } catch (err) { next(err); }
};
