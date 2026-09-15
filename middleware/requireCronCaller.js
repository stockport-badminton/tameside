// A scheduled job authenticating without a session.
//
// Cloud Scheduler cannot log in through Auth0, so the endpoints it drives carry a shared
// secret instead. This is that gate, once. `GET /tasks/registration-digest` and
// `POST /webhooks/mailjet` each grew their own copy of it; the weekly social post is the
// third, and a third caller is what turns a fix into a rule.
//
// Three properties, each here because of a specific way this has gone wrong:
//
// **Not `secured`.** `secured` redirects an anonymous caller to `/login`. A scheduler's
// HTTP client follows the 302, gets a 200 from Auth0, and records a successful run — so an
// endpoint that has been refusing every request for a year looks green the whole time. The
// Stockport league lost a year of invoice sends to exactly that. A superadmin session still
// works here: `req.user` is put there by passport's session deserialisation, which runs
// globally in app.js, not by `secured`.
//
// **An unset token closes the path rather than opening it.** "Empty secret matches empty
// parameter" is how an unconfigured deploy becomes a public endpoint. An unset variable
// means the job is inert, and inert must mean refused.
//
// **A refusal is a 404, and never a redirect.** The Stockport copy answers 403; this repo's
// existing scheduler endpoints answer 404 so that a scanner learns nothing about what lives
// there, and consistency across the three is worth more than matching the other site. The
// property that actually matters — that a refusal can never be mistaken for a success by a
// machine that follows redirects — holds either way.
//
// **Both sides are hashed before comparison**, so `timingSafeEqual` gets two equal-length
// buffers. Comparing raw strings means either a length check that leaks the secret's length,
// or a throw on mismatched lengths.

const crypto = require('crypto');
const { isSuperAdmin } = require('../utils/authz');

function tokenOk(envVar, req, param = 't') {
  const expected = process.env[envVar] || '';
  if (!expected) return false;
  const presented = String((req.query && req.query[param]) || '');
  if (!presented) return false;
  const a = crypto.createHash('sha256').update(expected).digest();
  const b = crypto.createHash('sha256').update(presented).digest();
  return crypto.timingSafeEqual(a, b);
}

/**
 * Build the route middleware for one scheduled endpoint.
 *
 * @param {object} opts
 * @param {string} opts.envVar      env var holding the shared secret; unset closes the path
 * @param {string} [opts.param]     query parameter it is presented in (default `t`)
 * @param {string} opts.callerProp  request property set to 'scheduler' | 'superadmin', so
 *                                  the handler can report which one ran it
 */
function requireCronCaller(opts) {
  const { envVar, param = 't', callerProp } = opts;

  return function (req, res, next) {
    if (tokenOk(envVar, req, param)) {
      req[callerProp] = 'scheduler';
      return next();
    }
    if (isSuperAdmin(req)) {
      req[callerProp] = 'superadmin';
      return next();
    }
    return res.status(404).end();
  };
}

module.exports = requireCronCaller;
module.exports.requireCronCaller = requireCronCaller;
// Exported for the guard test that asserts an unset token refuses rather than admits.
module.exports.tokenOk = tokenOk;
