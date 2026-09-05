// Chasing clubs for their team registration forms.
//
// Every club must register its players with the league before its first fixture of the
// season. Chasing that was done from memory, once a season, which is exactly the kind of
// job that is easy to half-finish.
//
// Four routes:
//
//   GET  /admin/registration-reminders                    the worklist
//   POST /admin/registration-reminders/:club/received     tick one off (or untick)
//   POST /admin/registration-reminders/:club/chase        email the club its pre-filled form
//   GET  /tasks/registration-digest?t=<token>             the daily digest, for a scheduler
//
// THE DIGEST ENDPOINT IS NOT `secured`, because Cloud Scheduler cannot log in through
// Auth0. It carries a shared secret in the query string and 404s without one, exactly
// like POST /webhooks/mailjet — a scanner learns nothing about what lives there. It is
// GET because that is what Cloud Scheduler sends by default, and it is idempotent in the
// only sense that matters here: it sends a report and writes nothing.
//
// STATUS IS PER SEASON and resets itself. See migrations/club-registration.sql: a new
// season simply has no rows, which reads as "nothing received, nothing chased". There is
// no annual cleanup to remember.

const ClubRegistration = require('../models/clubRegistration');
const Club = require('../models/club');
const Player = require('../models/players');
const seasonModel = require('../models/season');
const mailer = require('../utils/mailer');
const registrationDocx = require('../utils/registrationDocx');
const { isSuperAdmin } = require('../utils/authz');
const { absoluteUrl, canonicalFor } = require('../utils/siteUrl');

const WORKLIST_PATH = '/admin/registration-reminders';

// How far ahead the digest looks. Three days is what the results secretary asked for: far
// enough to act on, close enough that it is not noise for ten months.
const DEFAULT_WITHIN_DAYS = 3;

const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const getRoster = (club) => new Promise((resolve, reject) =>
  Player.getNamesClubsTeams({ club }, (err, rows) => (err ? reject(err) : resolve(rows || []))));
const getAllClubs = () => new Promise((resolve, reject) =>
  Club.getAll((err, rows) => (err ? reject(err) : resolve(rows || []))));

/* ---------------------------------------------------------------- *
 * Presentation. Shared by the page and the emails so a date can only
 * be wrong in one place.
 * ---------------------------------------------------------------- */

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// "Wed 2 Sep 2026".
//
// Spelled out rather than handed to toLocaleDateString, for two reasons. The month names
// are UTC-based: `firstFixture` is a Postgres DATE, which the driver hands over as a JS
// Date at UTC midnight, and any local-time formatting slips it to the day before for a
// reader west of Greenwich — the same trap as reading fixture.date through a local Date,
// which is what prints league nights on a Sunday. And en-GB's own answer depends on the
// ICU data compiled into the running Node: current versions render this "Wed, 2 Sept
// 2026". A date in an email should not change shape because the base image moved.
function formatDate(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

// "in 3 days" / "today" / "8 days ago". Plain English beats a signed number in an email
// that somebody reads on a phone at breakfast.
function dueLabel(daysAway) {
  if (daysAway === 0) return 'today';
  if (daysAway === 1) return 'tomorrow';
  if (daysAway > 1) return `in ${daysAway} days`;
  if (daysAway === -1) return 'was yesterday';
  return `was ${Math.abs(daysAway)} days ago`;
}

function decorate(club) {
  return {
    ...club,
    firstFixtureLabel: formatDate(club.firstFixture) || 'no fixture found',
    dueLabel: dueLabel(club.daysAway),
    chasedLabel: formatDate(club.chasedAt) || null,
    receivedLabel: formatDate(club.receivedAt) || null,
    overdue: club.daysAway < 0,
    emailable: club.officers.some(o => o.email),
  };
}

// "20262027" reads badly in a sentence.
const seasonLabel = (name) => `${String(name).slice(0, 4)}/${String(name).slice(4)}`;

function forbidden(res) { return res.status(403).send('Forbidden'); }

const actor = (req) => (req.user && (req.user.emails && req.user.emails[0] && req.user.emails[0].value))
  || (req.user && (req.user.email || req.user.nickname))
  || 'admin';

const backTo = (msg, err) => WORKLIST_PATH
  + (err ? '?err=' + encodeURIComponent(err) : msg ? '?msg=' + encodeURIComponent(msg) : '');

/* ---------------------------------------------------------------- *
 * GET /admin/registration-reminders
 * ---------------------------------------------------------------- */
exports.index = async function (req, res, next) {
  if (!isSuperAdmin(req)) return forbidden(res);
  try {
    const season = seasonModel.current();
    const clubs = (await ClubRegistration.getStatus(season)).map(decorate);
    res.render('admin/registration-reminders', {
      static_path: '/static',
      title: 'Registration Reminders',
      pageDescription: 'Which clubs still owe their team registration form',
      season,
      seasonLabel: seasonLabel(season),
      withinDays: DEFAULT_WITHIN_DAYS,
      clubs,
      outstanding: clubs.filter(c => !c.received),
      received: clubs.filter(c => c.received),
      message: req.query.msg || null,
      error: req.query.err || null,
      canonical: canonicalFor(req),
    });
  } catch (err) { next(err); }
};

/* ---------------------------------------------------------------- *
 * POST /admin/registration-reminders/:club/received
 *
 * The club comes from the URL as an id and is checked against the worklist before
 * anything is written, so a tampered post cannot create a row for a club that has no
 * fixture — or for another league's club id, which this database is full of.
 * ---------------------------------------------------------------- */
exports.setReceived = async function (req, res, next) {
  if (!isSuperAdmin(req)) return forbidden(res);
  try {
    const season = seasonModel.current();
    const clubId = Number(req.params.club);
    if (!Number.isInteger(clubId)) return res.redirect(backTo(null, 'Not a club id'));

    const clubs = await ClubRegistration.getStatus(season);
    const club = clubs.find(c => c.id === clubId);
    if (!club) return res.redirect(backTo(null, 'No club with that id has a fixture this season'));

    const received = String(req.body.received) === 'true';
    if (received) await ClubRegistration.markReceived(season, clubId, actor(req));
    else await ClubRegistration.markNotReceived(season, clubId, actor(req));

    res.redirect(backTo(received
      ? `${club.name} marked as received`
      : `${club.name} put back on the list`));
  } catch (err) { next(err); }
};

/* ---------------------------------------------------------------- *
 * POST /admin/registration-reminders/:club/chase
 * ---------------------------------------------------------------- */
exports.chase = async function (req, res, next) {
  if (!isSuperAdmin(req)) return forbidden(res);
  try {
    const season = seasonModel.current();
    const clubId = Number(req.params.club);
    if (!Number.isInteger(clubId)) return res.redirect(backTo(null, 'Not a club id'));

    const clubs = await ClubRegistration.getStatus(season);
    const club = clubs.find(c => c.id === clubId);
    if (!club) return res.redirect(backTo(null, 'No club with that id has a fixture this season'));

    const result = await exports.sendChase(club, actor(req));
    if (!result.sent) return res.redirect(backTo(null, result.reason));
    res.redirect(backTo(`Chased ${club.name} — sent to ${result.recipients.join(', ')}`));
  } catch (err) { next(err); }
};

/**
 * Send one club its pre-filled form and record the chase.
 *
 * Exported so the worklist route and any future scheduled chase share one implementation;
 * the chase is only recorded if Mailjet accepted the message, so a failed send leaves the
 * club looking un-chased rather than silently ticked.
 */
exports.sendChase = async function (club, updatedBy) {
  const recipients = club.officers.filter(o => o.email).map(o => o.email);
  if (!recipients.length) {
    return { sent: false, reason: `${club.name} has no club or match secretary with an email address` };
  }

  // Built from the live roster at send time, not from anything cached: the whole point of
  // the attachment is that it shows the club what the league currently believes.
  const roster = await getRoster(club.name);
  if (!roster.length) {
    return { sent: false, reason: `No players are registered to ${club.name}, so there is no form to send` };
  }
  const built = await registrationDocx.build(roster, club.name);

  const decorated = decorate(club);
  const dueSentence = decorated.overdue
    ? `That has already been played, so this is overdue — please send the form back as soon as you can.`
    : `Please send the form back before then.`;

  await mailer.send({
    template: 'registration-chase',
    subject: `${club.name}: team registration form still needed`,
    text: `We have not had ${club.name}'s team registration form for the season yet.`
      + `\n\nYour first fixture is ${decorated.firstFixtureLabel} (${decorated.dueLabel}). ${dueSentence}`
      + `\n\nThe form is attached, already filled in with the players we currently have`
      + ` registered to ${club.name}. Open it in Word, correct anything that is wrong, and`
      + ` reply to this email with it attached.`
      + `\n\nThe letter beside each name is the team that player is nominated for, and R`
      + ` means reserve. The order of the names within a team is the ranking order.`
      + `\n\nAlready sent it? Reply and say so and we will find it.`,
    to: recipients,
    bcc: true,
    replyTo: mailer.RESULTS_MAILBOX,
    data: {
      clubName: club.name,
      teams: club.teams,
      firstFixtureLabel: decorated.firstFixtureLabel,
      dueSentence,
      whyReceiving: 'You are receiving this because you are listed as a club or match '
        + 'secretary for ' + club.name + ' in the league&rsquo;s records.',
    },
    attachments: [{
      filename: `${built.baseName} Registrations.docx`,
      contentType: DOCX_TYPE,
      content: built.buffer,
    }],
    customId: 'RegistrationChase',
  });

  await ClubRegistration.recordChase(club.season, club.id, updatedBy);
  return { sent: true, recipients };
};

/* ---------------------------------------------------------------- *
 * GET /tasks/registration-digest?t=<token>
 *
 * The daily report. Runs from Cloud Scheduler; see docs/registration-reminders.md.
 * ---------------------------------------------------------------- */
exports.digestTask = async function (req, res, next) {
  const expected = process.env.REGISTRATION_DIGEST_TOKEN;
  // No token configured means the endpoint is not in use; behave as if it does not exist,
  // rather than advertising it with a 401.
  if (!expected) return res.status(404).end();
  if (req.query.t !== expected) return res.status(404).end();

  try {
    const sent = await exports.sendDigest();
    // The scheduler only reads the status code, but a human curling the URL to test it
    // wants to know whether anything went out and why not.
    res.json(sent);
  } catch (err) { next(err); }
};

/**
 * Build and send the daily digest. Returns what it did, and does not throw for "nothing
 * to report" — a quiet day is a successful run.
 */
exports.sendDigest = async function (withinDays = DEFAULT_WITHIN_DAYS) {
  const season = seasonModel.current();
  const digest = await ClubRegistration.getDigest(season, withinDays);

  // Nothing due and nothing outstanding that has been chased: send no email. Ten months
  // of "nothing to do" is how a daily report becomes a filter rule. The trade is that a
  // quiet day looks the same as a broken scheduler, which is why the run still answers
  // with what it decided.
  if (!digest.dueSoon.length && !digest.chased.length) {
    return { sent: false, reason: 'nothing due and nothing outstanding that has been chased', ...counts(digest) };
  }

  const dueSoon = digest.dueSoon.map(decorate);
  const chased = digest.chased.map(decorate);
  const worklistUrl = absoluteUrl(WORKLIST_PATH);

  const line = (c) => `  ${c.name} — first fixture ${c.firstFixtureLabel} (${c.dueLabel})`
    + (c.chaseCount ? `, chased ${c.chaseCount}x` : '');

  await mailer.send({
    template: 'registration-digest',
    // The chased half is dropped from the subject when it is empty, rather than reading
    // "0 chased and waiting" — the subject is the whole message for anyone triaging on a
    // phone, and a zero in it is noise.
    subject: `Registration forms: ${digest.dueSoon.length} due`
      + (digest.chased.length ? `, ${digest.chased.length} chased and waiting` : ''),
    text: `${digest.received} of ${digest.total} clubs have sent their team registration`
      + ` form in for ${seasonLabel(season)}.`
      + (dueSoon.length
        ? `\n\nDue within ${withinDays} days:\n${dueSoon.map(line).join('\n')}` : '')
      + (chased.length
        ? `\n\nChased already, still nothing back:\n${chased.map(line).join('\n')}` : '')
      + `\n\nWorklist: ${worklistUrl}`,
    to: process.env.REGISTRATION_DIGEST_TO || mailer.RESULTS_MAILBOX,
    data: {
      dueSoon,
      chased,
      withinDays,
      received: digest.received,
      total: digest.total,
      seasonLabel: seasonLabel(season),
      worklistUrl,
      whyReceiving: 'You are receiving this because you are the league&rsquo;s results '
        + 'secretary and clubs still owe their registration forms.',
    },
    customId: 'RegistrationDigest',
  });

  return { sent: true, ...counts(digest) };
};

const counts = (digest) => ({
  season: digest.season,
  dueSoon: digest.dueSoon.length,
  chased: digest.chased.length,
  outstanding: digest.outstanding,
  received: digest.received,
  total: digest.total,
});

// The test seam the other controllers use, so an integration test can stub Mailjet and be
// sure nothing real goes out. It MUST be mailer.client — a separate instance would leave
// the stub intercepting nothing.
exports._mailjetClientForTesting = mailer.client;

// Exported for the tests, which pin the wording rather than re-deriving it.
exports._formatDate = formatDate;
exports._dueLabel = dueLabel;
exports._seasonLabel = seasonLabel;
exports.WORKLIST_PATH = WORKLIST_PATH;
exports.DEFAULT_WITHIN_DAYS = DEFAULT_WITHIN_DAYS;
