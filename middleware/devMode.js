// Development-mode auth bypass — injects a mock superadmin user locally so the
// secured() / isSuperAdmin() admin routes can be exercised without a real Auth0
// login. SAFE: only active when DEV_MODE=true AND NODE_ENV is not production. The
// Dockerfile sets NODE_ENV=production, so this can never take effect in the deployed
// image. (Cloud Run itself does NOT set NODE_ENV — only the buildpack path does, and
// this project builds from a Dockerfile. Don't remove that ENV line.)
//
// Must be registered AFTER passport.session() (so passport doesn't overwrite the
// injected user) and BEFORE the routes.
//
// The mock defaults to a superadmin, but DEV_ROLE / DEV_CLUB / DEV_STATS override it:
//
//   DEV_MODE=true NODE_ENV=development DEV_ROLE=admin DEV_CLUB=Hyde npm run dev
//   DEV_MODE=true NODE_ENV=development DEV_ROLE=none npm run dev
//
// Worth having as env vars rather than a source edit, because the club-scoped admin
// branch is a genuinely different site — different nav, different scoping, different
// views — and it is by far the least-exercised one. It is also the branch that grows
// on cutover: roles now come from the player table, so everyone who used to be an
// Auth0 'admin' lands here. Stockport shipped a crash into exactly this branch
// (their 72f54fa) because nobody had browsed as a plain admin.
const authz = require('../utils/authz');

module.exports = function devMode(req, res, next) {
  const isDevMode = process.env.DEV_MODE === 'true' && process.env.NODE_ENV !== 'production';

  if (isDevMode && !req.user) {
    const role = process.env.DEV_ROLE || 'superadmin';
    // Built through applyRoleClaims, from a row shaped exactly like the one
    // models/players.getAuthRoleByEmail returns — so the mock cannot drift out of step
    // with what a real login produces. On the Stockport site the mock was assembled by
    // hand, went missing a claim production had, and made a production-only breakage
    // invisible locally (their ce6250d).
    const authRow = role === 'none' ? null : {
      id: 0,
      first_name: 'Dev',
      family_name: 'User',
      role: role,
      clubName: process.env.DEV_CLUB || 'Aerospace',
      statsAccess: process.env.DEV_STATS === 'false' ? 0 : 1,
    };

    req.user = {
      id: 'dev|local',
      displayName: 'Dev User',
      user_id: 'dev|local',
      email: 'dev@local.test',
      _json: authz.applyRoleClaims({}, authRow),
    };
  }
  next();
};
