// Who may call a route, declared as the route's first middleware (REARCH-04). Ported from
// Stockport (league-site middleware/access.js).
//
//   app.get('/tables/:division', access.public,     …)
//   app.get('/email-scorecard',  access.member,     …)
//   app.get('/admin/spam',       access.superadmin, …)
//
// Before this, who could call a route was decided in four places: route middleware, a
// check inside the handler, a shared secret checked by the handler, or nothing. "Nothing"
// reads exactly like "public on purpose". That is how /fixture-gen/publish, which rewrites
// the live season's fixtures, sat behind a bare `secured` until 4 Nov 2026. A declaration
// makes the choice visible: an open route says `access.public`, and docs/routes.md lists it.
//
// Each level wraps the middleware that already does the work and tags the function with
// `.access`, which is what the route-table walker (test/helpers/routeTable.js) reads.
//
// Fewer levels than Stockport's. There are no Messer, SNS, publish-token or club-admin
// write routes here. `memberThen` is ours: it is the honest label for a route that only
// needs a login at the route and decides the rest inside the handler (own club, own
// scorecard). It enforces the login and nothing more.

const { secured, securedApi, requireSuperAdmin } = require('./secured');

function declare(level, fn) {
  fn.access = level;
  return fn;
}

// Runs `mws` in order as one middleware. next(err), next('route') and next('router')
// leave the chain and go to the outer `next` unchanged, so devOnly's fall-through to the
// 404 still works. A rejected promise from an async middleware is an error.
function compose(mws) {
  return function (req, res, next) {
    let i = 0;
    const step = (err) => {
      if (err !== undefined && err !== null) return next(err);
      const mw = mws[i++];
      if (!mw) return next();
      try {
        const r = mw(req, res, step);
        if (r && typeof r.catch === 'function') r.catch(next);
      } catch (e) {
        next(e);
      }
    };
    step();
  };
}

// Anyone. Say why in a comment on the route when it is not obvious.
exports.public = declare('public', function (req, res, next) { next(); });

// Logged in.
exports.member = declare('member', function (req, res, next) { return secured(req, res, next); });

// Logged in, and the handler decides the rest. `what` says what it checks, for the table.
exports.memberThen = function (what) {
  if (!what) throw new Error('access.memberThen() needs to say what the handler checks');
  return declare('member, then ' + what, function (req, res, next) { return secured(req, res, next); });
};

// Logged in, and the superadmin (results secretary).
exports.superadmin = declare('superadmin', compose([secured, requireSuperAdmin]));

// The same for a route a page's script fetches: an expired session is a 401 JSON answer
// rather than a redirect into the login page's HTML.
exports.superadminApi = declare('superadmin (api)', compose([securedApi, requireSuperAdmin]));

// A Cloud Scheduler token or a superadmin session. Takes the middleware requireCronCaller
// built, and refuses anything else, so this cannot label an arbitrary function as gated.
exports.cron = function (gate) {
  if (typeof gate !== 'function' || !gate.cronEnvVar) {
    throw new Error('access.cron() takes a middleware built by requireCronCaller');
  }
  return declare('cron:' + gate.cronEnvVar, function (req, res, next) { return gate(req, res, next); });
};

// The handler checks a shared secret itself (a webhook's or a task's `?t=`). Declares
// that; enforces nothing. `what` names the secret, for the table.
exports.token = function (what) {
  if (!what) throw new Error('access.token() needs to say which token the handler checks');
  return declare('token:' + what, function (req, res, next) { next(); });
};

// Exists only on a dev server (the same test middleware/devMode.js uses); anywhere else
// it falls through to the 404.
exports.devOnly = declare('devOnly', function (req, res, next) {
  if (process.env.DEV_MODE === 'true' && process.env.NODE_ENV !== 'production') return next();
  next('route');
});

exports.compose = compose;
