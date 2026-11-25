// Web push notifications: the opt-in page, the subscription API the page calls, the scheduled
// match reminders and the superadmin page. The sending is utils/push/; docs/push.md has the
// design. Ported from Stockport (league-site 1a5f9d2).
//
// Models and utils are called through their modules, not destructured, so test stubs apply.

const Push = require('../models/push');
const push = require('../utils/push');
const subs = require('../utils/push/subscription');
const { siteUrl } = require('../utils/siteUrl');
const { isSuperAdmin } = require('../utils/authz');

function httpError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

// The subscription API is called by fetch() from /notifications, never by a form. A browser
// says where a request came from: refuse one sent by another site's page. A request with
// neither header is not from a browser, and a non-browser could send whatever it liked anyway.
// Compared with SITE_URL, never the Host header, which Firebase rewrites (CLAUDE.md).
function fromOurPage(req) {
  const site = req.get('sec-fetch-site');
  if (site) return site === 'same-origin';
  const origin = req.get('origin');
  return !origin || origin === siteUrl();
}

/** Teams grouped by club, in club order, for the page's picker. */
function byClub(teams) {
  const clubs = new Map();
  for (const t of teams) {
    if (!clubs.has(t.clubId)) clubs.set(t.clubId, { id: t.clubId, name: t.clubName, teams: [] });
    clubs.get(t.clubId).teams.push(t);
  }
  return [...clubs.values()];
}

exports.notificationsPage = async function(req, res, next) {
  try {
    const teams = await Push.followableTeams();
    const wanted = Number(req.query.team);
    const preselect = teams.some(t => t.id === wanted) ? wanted : null;
    res.render('notifications', {
      static_path: '/static',
      title: 'Notifications',
      pageDescription: 'Get a notification on your phone when your team\'s result is published, and a reminder before each match.',
      clubs: byClub(teams),
      preselect,
      vapidPublicKey: process.env.VAPID_PUBLIC_KEY || null,
    });
  } catch (err) {
    next(err);
  }
};

exports.subscribe = async function(req, res, next) {
  try {
    if (!fromOurPage(req)) throw httpError('forbidden', 403);
    const body = req.body || {};
    const subscription = subs.validateSubscription(body.subscription);
    const teams = subs.validateTeams(body.teams, (await Push.followableTeams()).map(t => t.id));
    const types = subs.validateTypes(body.types);
    await Push.upsertSubscription({
      id: subs.subscriptionId(subscription.endpoint),
      endpoint: subscription.endpoint,
      p256dh: subscription.keys.p256dh,
      auth: subscription.keys.auth,
      teams,
      types,
    });
    res.json({ ok: true, teams, types });
  } catch (err) {
    // The validators' messages are written to be shown; anything else is ours.
    if (!err.status && /^(missing|invalid|unsupported|pick)/.test(err.message)) err.status = 400;
    next(err);
  }
};

/** The endpoint a lookup or unsubscribe names. */
function endpointOf(req) {
  const endpoint = req.body && req.body.endpoint;
  if (typeof endpoint !== 'string' || !endpoint || endpoint.length > 1024) throw httpError('missing endpoint');
  return endpoint;
}

// What this browser is subscribed to, so the page shows the server's record rather than a
// guess. Knowing the endpoint is the proof: it is a secret the push service gave this browser.
exports.lookup = async function(req, res, next) {
  try {
    if (!fromOurPage(req)) throw httpError('forbidden', 403);
    const saved = await Push.getSubscription(subs.subscriptionId(endpointOf(req)));
    res.json(saved ? { ok: true, subscribed: true, teams: saved.teams, types: saved.types } : { ok: true, subscribed: false });
  } catch (err) {
    next(err);
  }
};

exports.unsubscribe = async function(req, res, next) {
  try {
    if (!fromOurPage(req)) throw httpError('forbidden', 403);
    await Push.removeSubscriptions([subs.subscriptionId(endpointOf(req))]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
};

// Cloud Scheduler, 17:00 (tonight) and 18:00 (tomorrow) Europe/London. A superadmin may also
// name the day (`date=YYYY-MM-DD`) and ask for a dry run (`dry=1`), which sends nothing.
exports.reminders = async function(req, res) {
  res.set('Cache-Control', 'no-store');
  const when = req.query.when;
  const superadmin = isSuperAdmin(req);
  const date = superadmin && /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || '')) ? String(req.query.date) : undefined;
  const dry = superadmin && req.query.dry === '1';
  try {
    const summary = await push.runReminders(when, { date, dry });
    console.log('[push] reminders run', JSON.stringify({ caller: req.pushCaller, ...summary }));
    res.json(summary);
  } catch (err) {
    // A non-2xx shows as a failed run in Cloud Scheduler.
    const status = /^when must be/.test(err.message) ? 400 : 500;
    if (status === 500) console.error('[push] reminders failed', when, err);
    res.status(status).json({ error: err.message });
  }
};

async function renderAdmin(req, res, notice) {
  const [counts, sends] = await Promise.all([Push.teamCounts(), Push.recentSends(25)]);
  res.render('admin/push', {
    static_path: '/static',
    title: 'Push Notifications',
    pageDescription: 'Who follows which team, and what has been sent',
    configured: push.configured(),
    counts,
    sends,
    notice,
  });
}

exports.adminPage = async function(req, res, next) {
  try {
    await renderAdmin(req, res, null);
  } catch (err) {
    next(err);
  }
};

// "Send a test": to this browser (its endpoint, filled in by the page) or to every subscriber.
exports.adminTest = async function(req, res, next) {
  try {
    const everyone = req.body && req.body.to === 'everyone';
    const endpoint = req.body && typeof req.body.endpoint === 'string' ? req.body.endpoint : '';
    if (!everyone && !endpoint) {
      return renderAdmin(req, res, ['warning', 'This browser has no subscription. Turn notifications on at /notifications first.']);
    }
    const summary = await push.sendTest(everyone ? {} : { subscriptionId: subs.subscriptionId(endpoint) });
    const notice = summary.skipped
      ? ['warning', `Nothing sent: ${summary.skipped}.`]
      : summary.subscribers === 0
        ? ['warning', 'Nothing sent: no matching subscription. Turn notifications on at /notifications first.']
        : [summary.failed ? 'warning' : 'success',
          `Sent ${summary.sent} of ${summary.subscribers}` + (summary.removed ? `; ${summary.removed} expired subscription(s) removed` : '') +
          (summary.failed ? `; ${summary.failed} failed` : '') + '.'];
    await renderAdmin(req, res, notice);
  } catch (err) {
    next(err);
  }
};
