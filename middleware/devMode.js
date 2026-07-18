// Development-mode auth bypass — injects a mock superadmin user locally so the
// secured() / isSuperAdmin() admin routes can be exercised without a real Auth0
// login. SAFE: only active when DEV_MODE=true AND NODE_ENV is not production, so
// it can never take effect on Cloud Run (which sets NODE_ENV=production).
//
// Must be registered AFTER passport.session() (so passport doesn't overwrite the
// injected user) and BEFORE the routes.
module.exports = function devMode(req, res, next) {
  const isDevMode = process.env.DEV_MODE === 'true' && process.env.NODE_ENV !== 'production';

  if (isDevMode && !req.user) {
    req.user = {
      id: 'dev|local',
      displayName: 'Dev User',
      user_id: 'dev|local',
      email: 'dev@local.test',
      _json: {
        'https://my-app.example.com/role': 'superadmin',
        'https://my-app.example.com/club': 'All'
      }
    };
  }
  next();
};
