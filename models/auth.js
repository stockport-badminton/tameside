// Auth0 Management API access, and the new-signup approval flow.
//
// Authorization itself does NOT live here — it lives on the player table and is
// resolved at login (see migrations/player-auth-roles.sql, models/players.js
// getAuthRoleByEmail, and the Auth0Strategy verify callback in app.js). What is left
// in this file is the two things that genuinely need Auth0: reading an account we only
// know by its Auth0 user_id, and setting the app_metadata flag that gates login.
// One mailer for every league email — see utils/mailer.js.
const mailer = require('../utils/mailer');
const { absoluteUrl } = require('../utils/siteUrl');
const Player = require('./players');
const { isSuperAdmin } = require('../utils/authz');

exports.getManagementAPIKey = async function(){
  const res = await fetch(`https://${process.env.AUTH0_DOMAIN}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: process.env.AUTH0_CLIENTID,
      client_secret: process.env.AUTH0_CLIENT_SECRET,
      audience: `https://${process.env.AUTH0_DOMAIN}/api/v2/`,
      grant_type: 'client_credentials'
    })
  });
  const body = await res.json();
  if (!body.access_token) {
    throw new Error('Auth0 management token request failed: ' + (body.error_description || body.error || 'no access_token'));
  }
  return body.access_token;
}

// Look an account up by Auth0 user_id.
//
// Uses the `?q=user_id:` *query* form rather than /users/:id as a path segment,
// because Auth0 ids contain a `|` ("auth0|abc123", "google-oauth2|123") and putting
// one in a path means getting the encoding exactly right at every call site.
exports.getUserByAuthId = async function(userId){
  const apiKey = await module.exports.getManagementAPIKey();
  const res = await fetch(
    `https://${process.env.AUTH0_DOMAIN}/api/v2/users?q=user_id:${encodeURIComponent(userId)}&fields=user_id,email,nickname,name`,
    { headers: { Authorization: 'Bearer ' + apiKey } }
  );
  const body = await res.json();
  return Array.isArray(body) ? body[0] : undefined;
}

// Every account in the tenant, with the app_metadata the migration cares about.
//
// Cached in-process, because the linking screen reads it on every page load and the
// Management API pages at 100 — three round-trips per render otherwise, for a list that
// changes when somebody signs up. `?refresh=1` on that page clears it.
//
// Remember this is the SHARED tenant: most of what comes back belongs to the Stockport
// league site. utils/authMigration.js decides which accounts are ours.
let _userCache = null;
let _userCacheAt = 0;
const USER_CACHE_MS = 5 * 60 * 1000;

exports.listUsers = async function({ refresh = false } = {}) {
  if (!refresh && _userCache && (Date.now() - _userCacheAt) < USER_CACHE_MS) {
    return _userCache;
  }
  const apiKey = await module.exports.getManagementAPIKey();
  const out = [];
  for (let page = 0; page < 50; page++) {
    const res = await fetch(
      `https://${process.env.AUTH0_DOMAIN}/api/v2/users` +
      `?per_page=100&page=${page}&include_fields=true` +
      `&fields=user_id,email,app_metadata,logins_count,last_login`,
      { headers: { Authorization: 'Bearer ' + apiKey } }
    );
    const batch = await res.json();
    if (!Array.isArray(batch)) {
      throw new Error('Auth0 user list failed: ' + JSON.stringify(batch).slice(0, 300));
    }
    out.push(...batch);
    if (batch.length < 100) break;
  }
  _userCache = out;
  _userCacheAt = Date.now();
  return out;
}

exports._clearUserCacheForTesting = function() { _userCache = null; _userCacheAt = 0; };

// GET /approve-user/:userId — pure display, no side effects.
//
// This used to be the whole flow: one unauthenticated GET that PATCHed Auth0, emailed
// the new user and rendered a page. Two problems with that. It was reachable by anyone
// who knew or guessed an Auth0 user_id; and because the side effects hung off a GET,
// an email client or corporate scanner prefetching the link in the notification email
// could approve someone before a human ever clicked it. Approving is now a POST, and
// both halves are superadmin-only.
//
// Approval and role assignment were also two disconnected manual steps — approve here,
// then go and find the right player row in /player/:id/update. This page does both.
exports.approve_signup_get = async function(req, res, next){
  try {
    if (!isSuperAdmin(req)) return res.status(403).send('Forbidden');

    const user = await module.exports.getUserByAuthId(req.params.userId);
    if (!user) {
      const err = new Error('No matching Auth0 account for ' + req.params.userId);
      err.status = 404;
      return next(err);
    }

    // Warn if this login email already resolves to a player, so a second visit to the
    // link doesn't silently move the role onto somebody else.
    const existingLink = await Player.getAuthRoleByEmail(user.email);

    res.render('approve-signup', {
      static_path: '/static',
      theme: process.env.THEME || 'flatly',
      title: 'Approve New Signup',
      pageDescription: 'Approve a new signup and link it to a player',
      userId: req.params.userId,
      authUser: user,
      existingLink: existingLink || null
    });
  } catch (err) {
    next(err);
  }
}

// POST /approve-user/:userId — everything happens here.
//
// The Auth0 account is re-fetched server-side rather than taken from the form, so the
// only things the request body decides are which player to link and what role to give
// them.
exports.approve_signup_post = async function(req, res, next){
  try {
    if (!isSuperAdmin(req)) return res.status(403).send('Forbidden');

    const playerId = parseInt(req.body.playerId, 10);
    if (!playerId) {
      const err = new Error('Pick a player to link this account to');
      err.status = 400;
      return next(err);
    }

    const user = await module.exports.getUserByAuthId(req.params.userId);
    if (!user) {
      const err = new Error('No matching Auth0 account for ' + req.params.userId);
      err.status = 404;
      return next(err);
    }

    // betaAccess looks dead — nothing in this repo reads it. It is not: a separate
    // Auth0 Action gates real login on this flag, confirmed on the Stockport site,
    // and the Auth0 tenant is shared between the two leagues so that Action applies
    // to Tameside logins too. Removing this PATCH would leave approved users unable
    // to log in at all. Leave it exactly as it is.
    const apiKey = await module.exports.getManagementAPIKey();
    await fetch(`https://${process.env.AUTH0_DOMAIN}/api/v2/users/${encodeURIComponent(req.params.userId)}`, {
      method: 'PATCH',
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ app_metadata: { betaAccess: true } })
    });

    // authEmail is the login address, which is very often not the player's registered
    // contact email — this is the only place it gets set from a known-good source, so
    // it is worth writing even when no role is being granted.
    await Player.setAuthRole(playerId, {
      role: req.body.role || null,
      statsAccess: req.body.statsAccess == 1,
      authEmail: user.email
    });

    // Was a one-line "i've approved your access" with no indication of what to do next.
    // From was `website@` here and `results@` everywhere else; utils/mailer.js settles that.
    await mailer.send({
      template: 'access-approved',
      subject: 'Your results access is ready',
      text: 'Your account has been approved, so you can now sign in and enter results for '
          + 'your club: ' + absoluteUrl('/email-scorecard')
          + '\n\nStuck, or something looks wrong? Reply to this email.',
      to: user.email,
      bcc: true,
      data: {
        enterUrl: absoluteUrl('/email-scorecard'),
        whyReceiving: 'You are receiving this because you asked for results-entry access on the league website.',
      },
      customId: 'AccessApproved',
    });

    res.render('userapproved', {
      static_path: '/static',
      theme: process.env.THEME || 'flatly',
      title: 'Results Access Approved',
      pageDescription: 'Results Access Approved',
      result: `Approved ${user.email} — linked to player #${playerId} as ${req.body.role || 'no site role'}.`
    });
  } catch (err) {
    next(err);
  }
}
