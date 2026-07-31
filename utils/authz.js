// Role checks against the Auth0 `_json` claim.
//
// Six controllers each carry their own identical copy of isSuperAdmin (teamController,
// club_controller, siteSettingsController, scorecardOcrController,
// homepageContentController, fixtureController). This is the shared home for it —
// spamAdminController uses it, and the existing copies can migrate here when they're
// next touched rather than all at once in an unrelated change.
const SUPERADMIN_CLAIM = 'https://my-app.example.com/role';

function isSuperAdmin(req) {
  return !!(req && req.user && req.user._json && req.user._json[SUPERADMIN_CLAIM] === 'superadmin');
}

module.exports = { isSuperAdmin, SUPERADMIN_CLAIM };
