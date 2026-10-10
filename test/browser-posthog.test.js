// PostHog loads site-wide for analytics without cookies, and records only the
// results-entry pages. Ported from Stockport's __tests__/unit/browser-posthog.test.js.
//
// It replaced Sentry's replay because the 50-a-month quota ran out within days, mostly on
// the stats pages, and it is running beside Google Analytics to see whether it can replace
// that too. What matters is the gate: production, served by us, not a superadmin, nothing
// stored in the browser, and recording only where captains enter results. As in
// browser-sentry-gate.test.js, this runs the block THE TEMPLATE ACTUALLY EMITS against a
// fake `location`, rather than a copy of it written here.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const ejs = require('ejs');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const jsonForScript = require('../utils/jsonForScript');

const HEADER = path.join(__dirname, '..', 'views', 'header.ejs');
const KEY = 'phc_test_not_a_real_project';

function renderHeader(env, user) {
  const keys = ['NODE_ENV', 'K_SERVICE', 'POSTHOG_KEY'];
  const before = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) {
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  try {
    return ejs.render(fs.readFileSync(HEADER, 'utf8'), {
      static_path: '/static', title: 't', pageDescription: 'd',
      assetUrl: (p) => p, pastSeasons: [], jsonForScript,
      siteHostname: 'tameside-badminton.co.uk',
      ...(user ? { user } : {}),
    }, { filename: HEADER });
  } finally {
    for (const k of keys) {
      if (before[k] === undefined) delete process.env[k];
      else process.env[k] = before[k];
    }
  }
}

// Run the emitted PostHog block against a fake browser. Returns null if it did not load
// PostHog, otherwise the config it passed to init() and the properties it registered.
function runPostHog(html, { pathname, servedByUs = true }) {
  const m = html.match(/\(function \(\) \{\s*var RECORD_PATHS[\s\S]*?\}\)\(\);/);
  if (!m) throw new Error('PostHog block not found in rendered header');
  const injected = [];
  const sandbox = {
    window: { tblServedByUs: servedByUs },
    location: { pathname, hostname: 'www.tameside-badminton.co.uk' },
    document: {
      createElement: () => ({}),
      head: { appendChild: (el) => injected.push(el) },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(m[0], sandbox);
  const script = injected.find((el) => /posthog\.com\/static\/array\.js$/.test(el.src));
  if (!script) return null;
  const seen = {};
  sandbox.window.posthog = {
    init: (key, config) => { seen.key = key; seen.config = config; },
    register: (props) => { seen.registered = props; },
  };
  script.onload();
  return seen;
}

const PROD = { NODE_ENV: 'production', POSTHOG_KEY: KEY };
const CAPTAIN = { user_id: 'auth0|captain' };
const SUPERADMIN = { user_id: 'auth0|admin', _json: { 'https://my-app.example.com/role': 'superadmin' } };

describe('PostHog', () => {
  const captain = renderHeader(PROD, CAPTAIN);
  const anon = renderHeader(PROD, undefined);

  it('loads on every page, logged in or not', () => {
    assert.ok(runPostHog(captain, { pathname: '/player-stats' }));
    assert.ok(runPostHog(anon, { pathname: '/' }));
    assert.ok(runPostHog(anon, { pathname: '/tables/Division-1' }));
  });

  // The whole reason it can replace GA without a consent bar.
  it('stores nothing in the browser, and builds no person profiles', () => {
    const { key, config } = runPostHog(anon, { pathname: '/' });
    assert.strictEqual(key, KEY);
    assert.strictEqual(config.cookieless_mode, 'always');
    assert.strictEqual(config.person_profiles, 'never');
    assert.strictEqual(config.api_host, 'https://eu.i.posthog.com');
  });

  it('records the results-entry pages for a logged-in captain, with the scores visible', () => {
    for (const pathname of ['/email-scorecard', '/populated-scorecard-beta/2176', '/populated-scorecard/Division-1/1/2']) {
      const { config } = runPostHog(captain, { pathname });
      assert.strictEqual(config.disable_session_recording, false, pathname);
      assert.strictEqual(config.session_recording.maskAllInputs, false);
    }
  });

  it('records nowhere else — the stats pages are what emptied Sentry\'s quota', () => {
    for (const pathname of ['/player-stats', '/pair-stats', '/', '/admin/scorecard-ocr']) {
      assert.strictEqual(runPostHog(captain, { pathname }).config.disable_session_recording, true, pathname);
    }
    // A secured page cannot render for an anonymous visitor, but the gate should not rely on that.
    assert.strictEqual(runPostHog(anon, { pathname: '/email-scorecard' }).config.disable_session_recording, true);
  });

  // The project is shared with Stockport, so `league` is what tells the two apart.
  it('tags events with the league and the account, not identify(), which cookieless mode does not support', () => {
    assert.deepStrictEqual({ ...runPostHog(captain, { pathname: '/' }).registered }, {
      league: 'tameside-badminton.co.uk', logged_in: true, account_id: 'auth0|captain',
    });
    assert.deepStrictEqual({ ...runPostHog(anon, { pathname: '/' }).registered }, {
      league: 'tameside-badminton.co.uk', logged_in: false, account_id: null,
    });
    assert.doesNotMatch(captain, /posthog\.identify/);
  });

  it('cannot be broken out of by an account id', () => {
    const html = renderHeader(PROD, { user_id: 'auth0|</script><script>alert(1)//' });
    assert.strictEqual(runPostHog(html, { pathname: '/' }).registered.account_id, 'auth0|</script><script>alert(1)//');
    assert.doesNotMatch(html, /account_id: "auth0\|<\/script>/);
  });

  it('does not load for a superadmin, or on a page not served by us', () => {
    assert.strictEqual(runPostHog(renderHeader(PROD, SUPERADMIN), { pathname: '/email-scorecard' }), null);
    assert.strictEqual(runPostHog(anon, { pathname: '/', servedByUs: false }), null);
  });

  it('emits no PostHog without a key, or outside production', () => {
    assert.doesNotMatch(renderHeader({ NODE_ENV: 'production' }, CAPTAIN), /RECORD_PATHS/);
    assert.doesNotMatch(renderHeader({ NODE_ENV: 'development', POSTHOG_KEY: KEY }, CAPTAIN), /RECORD_PATHS/);
  });

  // tblTrack is called unconditionally by the scorecard wizard and the homepage, so it must
  // exist on every render — dev included — or they throw where PostHog is absent.
  it('always defines tblTrack, as a no-op where PostHog is not loaded', () => {
    for (const html of [renderHeader({ NODE_ENV: 'development' }, CAPTAIN), renderHeader({ NODE_ENV: 'development' })]) {
      const m = html.match(/window\.tblTrack = function[\s\S]*?\n\s*\};/);
      assert.ok(m);
      const sandbox = { window: {} };
      vm.createContext(sandbox);
      vm.runInContext(m[0], sandbox);
      assert.doesNotThrow(() => sandbox.window.tblTrack('x', {}));
    }
  });
});
