// /admin/missed-three — superadmin (gated in app.js). The list, a per-player preview of the
// notice, the rendered email for the preview's iframe, and the send. See models/missedThree.js
// for the rule and utils/missedThreeEmail.js for the notice.
const MissedThree = require('../models/missedThree');
const { buildMissedThreeNotice } = require('../utils/missedThreeEmail');
const mailer = require('../utils/mailer');
const seasonModel = require('../models/season');

const seasonLabel = (name) => /^\d{8}$/.test(name) ? `${name.slice(0, 4)}/${name.slice(6)}` : name;

exports.list = async function (req, res, next) {
  try {
    const rows = await MissedThree.getPlayers();
    // Only whether each club has someone to write to; the addresses are shown on the
    // preview, where they are about to be used.
    const officers = await MissedThree.getOfficers(rows.map(r => r.clubId));
    rows.forEach(row => {
      row.canNotify = officers.some(o => Number(o.clubId) === Number(row.clubId) && o.email);
    });
    res.render('admin/missed-three', {
      static_path: '/static',
      title: 'Missed three',
      pageDescription: 'Nominated players who have missed their team\'s last three matches',
      rows,
      seasonLabel: seasonLabel(seasonModel.current()),
      side: MissedThree.SIDE,
      sent: req.query.sent ? String(req.query.sent).slice(0, 120) : '',
    });
  } catch (err) {
    next(err);
  }
};

// The notice for one player, derived entirely server-side. A player no longer on the list —
// they played, or were re-ranked, since the page was loaded — is a 404 rather than a notice
// about something that is no longer true.
async function noticeFor(req) {
  const playerId = Number(req.params.playerId);
  const rows = await MissedThree.getPlayers();
  const row = rows.find(r => Number(r.playerId) === playerId);
  if (!row) {
    const err = new Error('That player is no longer on the missed-three list');
    err.status = 404;
    throw err;
  }
  const officers = await MissedThree.getOfficers([row.clubId]);
  return buildMissedThreeNotice(row, officers, req.user && req.user.displayName);
}

exports.preview = async function (req, res, next) {
  try {
    const notice = await noticeFor(req);
    res.render('admin/missed-three-notice', {
      static_path: '/static',
      title: 'Missed three: ' + notice.subject,
      pageDescription: 'Preview the missed-three notice before it is sent',
      notice,
      resultsMailbox: mailer.RESULTS_MAILBOX,
      playerId: Number(req.params.playerId),
    });
  } catch (err) {
    next(err);
  }
};

// The email itself, for the preview's iframe — rendered by the mailer's own renderer from
// the same data the send uses, so what is checked is what lands in the inbox.
exports.previewEmail = async function (req, res, next) {
  try {
    const notice = await noticeFor(req);
    res.send(await mailer.renderTemplate(notice.template, notice.data));
  } catch (err) {
    next(err);
  }
};

// Sends it. Nothing is read from the body.
exports.send = async function (req, res, next) {
  try {
    const notice = await noticeFor(req);
    if (!notice.to.length) {
      const err = new Error('Nobody at this club has a contact email on file');
      err.status = 422;
      throw err;
    }
    const { recipients, ...sendArgs } = notice;
    await mailer.send(sendArgs);
    res.redirect(303, '/admin/missed-three?sent=' + encodeURIComponent(notice.subject));
  } catch (err) {
    next(err);
  }
};
