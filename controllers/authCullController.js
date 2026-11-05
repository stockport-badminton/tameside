// The monthly login cull (Nov 2026). Logins nobody uses are attack surface and noise: the
// 81 deleted by hand on 5 Nov 2026 had piled up since 2020.
//
//   1. GET /tasks/login-cull (Cloud Scheduler, monthly) warns every Tameside login unused
//      for a year, and sends the results secretary a summary.
//   2. The warned person keeps the login by logging in to either site, or with the link in
//      the warning: GET /keep-login/:token shows a button, the POST does it. A GET that
//      did it would be done by every mail scanner that prefetches links, as the approve
//      link once was.
//   3. A month on, with no sign of life, the login is listed on /admin/link-auth-accounts
//      as due for deletion. A superadmin deletes it there: from Auth0, which is SHARED with
//      Stockport's site, and its link to a player here. Nothing is deleted automatically,
//      by decision: a club admin can otherwise vanish mid-season with nobody having looked.
//
// Which accounts are ours, and why, is in utils/authCull.js.
const crypto = require('crypto');
const Auth = require('../models/auth');
const Player = require('../models/players');
const AuthCull = require('../models/authCull');
const authz = require('../utils/authz');
const mailer = require('../utils/mailer');
const { absoluteUrl } = require('../utils/siteUrl');
const { classify, GRACE_DAYS } = require('../utils/authCull');

// Under the 60s request ceiling with room to spare. The rest go next month.
const MAX_WARNINGS_PER_RUN = 40;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// By hand, not toLocaleDateString: its answer depends on the ICU data in the running Node.
const ukDate = ms => { const d = new Date(ms); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

async function buildCull({ refresh = false, now = Date.now() } = {}) {
  const [users, accountIndex, notices] = await Promise.all([
    Auth.listUsers({ refresh }),
    Player.getAuthAccountIndex(),
    AuthCull.getAll(),
  ]);
  const linked = new Map(accountIndex.map(r => [r.userId, r]));
  return classify(users, linked, notices, now);
}

const playerName = p => p ? `${p.first_name} ${p.family_name}`.replace(/\s+/g, ' ').trim() : null;

async function warn(entry, now) {
  const token = crypto.randomBytes(24).toString('base64url');
  const firstName = entry.player ? String(entry.player.first_name).trim() : '';
  const lastActive = ukDate(Date.parse(entry.lastActive));
  const deadline = ukDate(now + GRACE_DAYS * 864e5);
  const keepUrl = absoluteUrl('/keep-login/' + token);
  await mailer.send({
    template: 'login-inactive',
    to: entry.user.email,
    replyTo: mailer.RESULTS_MAILBOX,
    subject: 'Do you still use your Tameside Badminton login?',
    text: [
      `Hello${firstName ? ' ' + firstName : ''}.`,
      '',
      `Your login to the Tameside Badminton League website (${entry.user.email}) has not been used since ${lastActive}.`,
      `To keep it, log in to the site, or open this link and press the button, before ${deadline}:`,
      '',
      keepUrl,
      '',
      `If you do nothing, the login will be deleted after ${deadline}, from this site and from the Stockport league's (it is the same login). Your results stay: they are the league's record. You can sign up again at any time.`,
    ].join('\n'),
    data: {
      firstName, email: entry.user.email, lastActive, deadline, keepUrl,
      whyReceiving: 'You are receiving this because you have a login to the Tameside '
        + 'Badminton League website.',
    },
    customId: 'LoginInactive',
  });
  // After the send, never before: a login recorded as warned that never got the email
  // would be listed for deletion a month later with nobody having told them.
  await AuthCull.recordNotice(entry.user.user_id, token);
}

exports.runCull = async function ({ now = Date.now() } = {}) {
  const cull = await buildCull({ refresh: true, now });
  const warned = [];
  const failed = [];
  for (const entry of cull.notify.slice(0, MAX_WARNINGS_PER_RUN)) {
    try {
      await warn(entry, now);
      warned.push({ name: playerName(entry.player) || '(not linked)', email: entry.user.email });
    } catch (err) {
      console.error(`[login-cull] warning ${entry.user.user_id} failed: ${err.message}`);
      failed.push(entry.user.user_id);
    }
  }
  const due = cull.due.length;
  const deferred = Math.max(0, cull.notify.length - MAX_WARNINGS_PER_RUN);

  // A quiet month sends nothing to the results mailbox.
  if (warned.length || due) {
    await mailer.send({
      template: 'login-cull-digest',
      to: mailer.RESULTS_MAILBOX,
      subject: `Login cull: ${warned.length} warned, ${due} due for deletion`,
      text: [
        `${warned.length} login(s) unused for a year were warned today. ${due} are due for deletion.`,
        ...warned.map(w => `  ${w.name}: ${w.email}`),
        '',
        `Review: ${absoluteUrl('/admin/link-auth-accounts#cull')}`,
        'Nothing is deleted until you press Delete. Deleting removes the login from Stockport\'s site as well.',
      ].join('\n'),
      data: {
        warned, due,
        reviewUrl: absoluteUrl('/admin/link-auth-accounts#cull'),
        whyReceiving: 'You are receiving this because you are the league&rsquo;s results '
          + 'secretary and the monthly login cull ran.',
      },
      customId: 'LoginCullDigest',
    });
  }
  return { warned: warned.length, failed: failed.length, deferred, waiting: cull.waiting.length, due };
};

exports.run = async function (req, res, next) {
  try {
    res.json(await exports.runCull());
  } catch (err) { next(err); }
};

// ---- The keep link. Public: the token is the credential. ----

function renderKeep(res, status, state) {
  // The page is per-token; never let the CDN hold it.
  res.set('Cache-Control', 'no-store');
  res.status(status).render('keep-login', {
    static_path: '/static',
    theme: process.env.THEME || 'flatly',
    title: 'Keep your login',
    pageDescription: 'Keep your Tameside Badminton League login',
    state,
  });
}

const tokenParam = req => String(req.params.token || '').slice(0, 100);

exports.keepGet = async function (req, res, next) {
  try {
    const row = await AuthCull.findByToken(tokenParam(req));
    renderKeep(res, row ? 200 : 404, row ? 'confirm' : 'invalid');
  } catch (err) { next(err); }
};

exports.keepPost = async function (req, res, next) {
  try {
    const row = await AuthCull.keepByToken(tokenParam(req));
    if (row) console.log(`[login-cull] kept by link: ${row.user_id}`);
    renderKeep(res, row ? 200 : 404, row ? 'kept' : 'invalid');
  } catch (err) { next(err); }
};

// ---- Superadmin, on /admin/link-auth-accounts. ----

exports.buildCull = buildCull;

function back(res, message) {
  res.redirect('/admin/link-auth-accounts?done=' + encodeURIComponent(message) + '#cull');
}

// Someone the results secretary knows is still about.
exports.adminKeep = async function (req, res, next) {
  if (!authz.isSuperAdmin(req)) return next(httpError(403, 'Forbidden'));
  try {
    const users = await Auth.listUsers();
    const user = users.find(u => u.user_id === req.body.userId);
    if (!user) return next(httpError(404, 'No Auth0 account with that id'));
    await AuthCull.keep(user.user_id);
    back(res, `Kept ${user.email || user.user_id} for another year.`);
  } catch (err) { next(err); }
};

// Deletes the accounts the page showed AND a fresh classification still says are due, so
// a login used since the page loaded, or one that became due without being looked at,
// is left alone.
exports.deleteDue = async function (req, res, next) {
  if (!authz.isSuperAdmin(req)) return next(httpError(403, 'Forbidden'));
  try {
    const shown = new Set([].concat(req.body.userId || []).map(String));
    const cull = await buildCull({ refresh: true });
    const targets = cull.due.filter(e => shown.has(e.user.user_id));
    const apiKey = targets.length ? await Auth.getManagementAPIKey() : null;
    let deleted = 0;
    for (const e of targets) {
      try {
        await Auth.deleteUser(e.user.user_id, { apiKey });
        await Player.unlinkAuthAccount(e.user.user_id, e.user.email);
        await AuthCull.remove(e.user.user_id);
        console.log(`[login-cull] deleted ${e.user.user_id}`);
        deleted++;
      } catch (err) {
        console.error(`[login-cull] delete ${e.user.user_id} failed: ${err.message}`);
        return back(res, `Deleted ${deleted}; stopped at ${e.user.email || e.user.user_id}: ${err.message}`);
      }
    }
    const skipped = shown.size - targets.length;
    back(res, `Deleted ${deleted} ${deleted === 1 ? 'login' : 'logins'}.`
      + (skipped ? ` ${skipped} no longer due and left alone.` : ''));
  } catch (err) { next(err); }
};

exports.MAX_WARNINGS_PER_RUN = MAX_WARNINGS_PER_RUN;
