// The three session gates the routes are built from. Moved out of app.js so
// middleware/access.js can compose them (REARCH-04); behaviour unchanged.

const authz = require('../utils/authz');

// Logged in is not enough (Nov 2026). The Auth0 tenant and its betaAccess flag are shared
// with Stockport, so their approvals let people log in here: 22 of 112 accounts able to
// log in were Stockport-only. A login counts as ours when it is linked to a Tameside player
// (req.user.tameside, set at login from player_auth_account) or holds a site role.
//
// req.user.tameside is an object when linked, null when looked up and not linked, and
// absent when unknown: a session from before linking existed, or a link lookup that failed
// at login (app.js). Unknown gets one fresh login per session, which re-runs the lookup,
// and is then let through: a DB blip must not lock a captain out of result entry.
function linkedGate(req) {
  if (authz.role(req) !== undefined || (req.user && req.user.tameside)) return 'ok';
  if (req.user && req.user.tameside === undefined) {
    if (req.session && !req.session.relinkTried) return 'relink';
    console.log('[authz] member gate: link still unknown after a fresh login; letting through');
    return 'ok';
  }
  return 'unlinked';
}

// Shown to a login that is not linked to a Tameside player — most often a Stockport
// account. Linking is done by a superadmin, never by the visitor.
function renderNotLinked(res) {
  res.set('Cache-Control', 'private, no-store');
  res.status(403).render('not-linked', { static_path: '/static', title: 'Login not linked', pageDescription: 'Your login is not linked to a player' });
}

function secured(req, res, next) {
  if (!req.isAuthenticated()) {
    req.session.returnTo = req.originalUrl;
    return res.redirect('/login');
  }
  const gate = linkedGate(req);
  if (gate === 'ok') return next();
  if (gate === 'relink') {
    req.session.relinkTried = true;
    req.session.returnTo = req.originalUrl;
    return res.redirect('/login');
  }
  return renderNotLinked(res);
}

// For routes a page's script calls with fetch: a 401 it can read, not `secured`'s redirect
// to /login, which fetch follows silently into an HTML page. (Stockport's /api routes sit
// behind plain `secured`, so an expired session there surfaces as a network-style error.)
// An unknown link is let through here: the page that made the call already passed
// `secured`, which gave it its fresh login.
function securedApi(req, res, next) {
  if (!req.isAuthenticated()) {
    res.set('Cache-Control', 'private, no-store');
    return res.status(401).json({ ok: false, error: 'Your login has expired. Reload the page to log in again.' });
  }
  if (linkedGate(req) === 'unlinked') {
    res.set('Cache-Control', 'private, no-store');
    return res.status(403).json({ ok: false, error: 'Your login isn\'t linked to a Tameside player. Ask the results secretary to link it.' });
  }
  next();
}

// A logged-in user without the role gets a 403 through the central handler, which answers
// an err.status 4xx without spending a Sentry event.
function requireSuperAdmin(req, res, next) {
  if (authz.isSuperAdmin(req)) return next();
  const err = new Error('Forbidden');
  err.status = 403;
  next(err);
}

module.exports = { secured, securedApi, requireSuperAdmin };
