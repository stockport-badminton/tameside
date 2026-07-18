// Shared bootstrap for integration tests.
// 1. Sets fake env vars BEFORE anything loads — app.js throws without AUTH0_*,
//    and controllers init Mailjet/Contentful/S3 clients at require time.
// 2. Stubs the season model so app.js's boot-time season.init() doesn't hit the DB.
// 3. Installs a call-time override seam on the data models so tests can supply
//    canned results without a DB — this works even though the admin controllers
//    capture promisify(Model.method) at load, because the wrapper (not the
//    original) is what gets captured, and it consults the registry per call.
// 4. Requires and exports the Express app (never listens — supertest binds it).

process.env.NODE_ENV = process.env.NODE_ENV || 'test';
const ENV_DEFAULTS = {
  AUTH0_DOMAIN: 'test.auth0.com',
  AUTH0_AUDIENCE: 'test-audience',
  AUTH0_CLIENTID: 'test-client-id',
  AUTH0_CLIENT_SECRET: 'test-client-secret',
  AUTH0_CALLBACK_URL: 'http://localhost/callback',
  MAILJET_KEY: 'test-mailjet-key',
  MAILJET_SECRET: 'test-mailjet-secret',
  CONTENTFUL_KEY: 'test-contentful-key',
  CONTENTFUL_SPACE: 'test-contentful-space',
  GMAPSAPIKEY: 'test-gmaps',
  RECAPTCHA: 'test-recaptcha',
  RECAPTCHA_SECRET: 'test-recaptcha-secret',
  PGPASSWORD: 'test-placeholder',
  DB_ENCODE: 'test-encode-key',
  S3_BUCKET_NAME: 'test-bucket',
  AWS_ACCESS_KEY_ID: 'test-akid',
  AWS_SECRET_ACCESS_KEY: 'test-secret',
};
for (const [k, v] of Object.entries(ENV_DEFAULTS)) {
  if (!process.env[k]) process.env[k] = v;
}

// Stub the season model before app.js requires it (boot must not hit the DB).
const seasonModel = require('../../models/season');
seasonModel.init = async () => ({ current: '20242025', previous: '20232024' });
seasonModel.getAll = async () => [];
seasonModel.current = () => '20242025';
seasonModel.previous = () => '20232024';

// Call-time override registry, keyed "ModelName.method".
const overrides = new Map();
function setModel(name, method, impl) { overrides.set(name + '.' + method, impl); }
function clearModels() { overrides.clear(); }

// Wrap every function export of the data models so a test override (if set)
// wins at call time; otherwise the original runs (and would hit the DB).
const MODELS = {
  Club: require('../../models/club'),
  Team: require('../../models/teams'),
  Division: require('../../models/division'),
  Venue: require('../../models/venue'),
  Player: require('../../models/players'),
  League: require('../../models/league'),
  Fixture: require('../../models/fixture'),
};
for (const [name, mod] of Object.entries(MODELS)) {
  for (const key of Object.keys(mod)) {
    if (typeof mod[key] !== 'function') continue;
    const orig = mod[key];
    mod[key] = function (...args) {
      const ov = overrides.get(name + '.' + key);
      return (ov || orig).apply(this, args);
    };
  }
}

const app = require('../../app');

module.exports = { app, setModel, clearModels };
