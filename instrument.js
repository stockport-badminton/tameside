// Sentry server-side instrumentation.
// MUST be required first in app.js (before express and other modules) so Sentry
// can auto-instrument them. If SENTRY_DSN is unset, Sentry.init is a no-op — so
// this is safe to run locally / in any environment without extra config.
require('dotenv').config();
const Sentry = require('@sentry/node');

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV || 'development',
  // Only actually send events in production. Cloud Run runs the Docker image,
  // which sets NODE_ENV=production, and Cloud Run also sets K_SERVICE. This stops
  // local dev AND the test suite (both load .env via dotenv, so SENTRY_DSN may be
  // present) from shipping synthetic errors to the production Sentry project.
  enabled: process.env.NODE_ENV === 'production' || !!process.env.K_SERVICE,
  // Errors only — no performance tracing spans (keeps free-tier quota for real errors).
  tracesSampleRate: 0,
  sendDefaultPii: false,
});
