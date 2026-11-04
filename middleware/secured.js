// The three session gates the routes are built from. Moved out of app.js so
// middleware/access.js can compose them (REARCH-04); behaviour unchanged.

const authz = require('../utils/authz');

function secured(req, res, next) {
  if (req.isAuthenticated()) return next();
  req.session.returnTo = req.originalUrl;
  res.redirect('/login');
}

// For routes a page's script calls with fetch: a 401 it can read, not `secured`'s redirect
// to /login, which fetch follows silently into an HTML page. (Stockport's /api routes sit
// behind plain `secured`, so an expired session there surfaces as a network-style error.)
function securedApi(req, res, next) {
  if (req.isAuthenticated()) return next();
  res.set('Cache-Control', 'private, no-store');
  res.status(401).json({ ok: false, error: 'Your login has expired. Reload the page to log in again.' });
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
