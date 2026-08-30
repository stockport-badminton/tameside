// Authorization helpers.
//
// The three `_json` claim keys below are the app's authorization interface, read in
// ~46 places across controllers and views. They are still Auth0-shaped strings, but
// they are no longer *sourced* from Auth0: the Auth0Strategy verify callback in app.js
// fills them from the player table at login (models/players.js getAuthRoleByEmail,
// migrations/player-auth-roles.sql). Auth0 proves who you are; Postgres decides what
// you can do.
//
// Keeping the keys unchanged is what made that switch a small diff — every existing
// read site kept working. So don't rename them casually: the string literals are load
// bearing, and a rename has to land in every reader in the same commit.
//
// Six controllers each carried their own identical copy of isSuperAdmin. This is the
// shared home; the copies migrate here as they're next touched rather than all at once
// in an unrelated change.
const SUPERADMIN_CLAIM = 'https://my-app.example.com/role';
const ROLE_CLAIM = 'https://my-app.example.com/role';
const CLUB_CLAIM = 'https://my-app.example.com/club';
const STATS_CLAIM = 'https://my-app.example.com/stats';

function claims(req) {
  return (req && req.user && req.user._json) || {};
}

// The other end of the interface: fills the three claim keys from a player row, for
// the Auth0Strategy verify callback in app.js to call at login. `authRow` is what
// models/players.getAuthRoleByEmail returns — undefined when the login email matches
// no player with a site role, which is the same thing an absent Auth0 claim meant.
//
// Kept pure and here, next to the readers, for two reasons: the writer and the readers
// cannot drift apart, and the mapping is testable without standing up passport.
//
// Pass authRow = null for the failure case — no role, which is the safe direction.
function applyRoleClaims(json, authRow) {
  const role = (authRow && authRow.role) || undefined;
  json[ROLE_CLAIM] = role;
  // 'All' is a sentinel meaning "every club", NOT a club name — a superadmin has no
  // single club. Anything building a URL or a club lookup out of this has to branch on
  // it first; the Stockport site shipped /manage-players/club-All to its own superadmin
  // by forgetting that (their ce6250d).
  json[CLUB_CLAIM] = role === 'superadmin' ? 'All'
    : (role === 'admin' ? (authRow && authRow.clubName) : undefined);
  json[STATS_CLAIM] = !!(authRow && authRow.statsAccess);
  return json;
}

function isSuperAdmin(req) {
  return claims(req)[ROLE_CLAIM] === 'superadmin';
}

// A club-scoped admin. Deliberately NOT true for a superadmin — the two branches
// differ everywhere they're used (a superadmin has no single club), so callers that
// want "any site role" should say `isSuperAdmin(req) || isAdmin(req)` and mean it.
function isAdmin(req) {
  return claims(req)[ROLE_CLAIM] === 'admin';
}

function role(req) {
  return claims(req)[ROLE_CLAIM];
}

// The club an admin is scoped to, as a club *name*. Returns the literal 'All' for a
// superadmin, which is why this must never be interpolated straight into a URL or a
// club lookup — see hasClubAccess below, and the note in views/nav.ejs.
function userClub(req) {
  return claims(req)[CLUB_CLAIM];
}

// True when this user may act on `club` (a club name): a superadmin may act on any,
// an admin only on their own. Mirrors documentsController.hasClubAccess, which
// predates this file.
function hasClubAccess(req, club) {
  const mine = userClub(req);
  return mine === 'All' || (!!club && mine === club);
}

// Lets an *admin* see the Individual/Pair Stats pages. Superadmins reach them
// regardless, so callers generally want `isSuperAdmin(req) || hasStatsAccess(req)`.
function hasStatsAccess(req) {
  return !!claims(req)[STATS_CLAIM];
}

// Restrict a model search object to the caller's own club when they are a club-scoped
// admin; leave it alone for a superadmin ('All') or a user with no site role.
//
// One helper because this decision was written out longhand at three call sites (both
// stats pages and the admin results grid) and they have to agree — on the Stockport
// site the pair-stats copy drifted behind a condition that was never true, so it
// scoped nobody and leaked every club's stats until someone read it (their bb43968).
function scopeToAdminClub(req, searchObj) {
  const club = userClub(req);
  if (isAdmin(req) && club && club !== 'All') {
    searchObj.club = club;
  }
  return searchObj;
}

module.exports = {
  applyRoleClaims,
  isSuperAdmin,
  isAdmin,
  role,
  userClub,
  hasClubAccess,
  hasStatsAccess,
  scopeToAdminClub,
  SUPERADMIN_CLAIM,
  ROLE_CLAIM,
  CLUB_CLAIM,
  STATS_CLAIM,
};
