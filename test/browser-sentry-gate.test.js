// Browser Sentry must not report from a copy of a page served anywhere but here. The gate
// is evaluated by running the script the header ACTUALLY EMITS, in a vm, against fake
// locations — a test restating the predicate could only ever agree with itself.
// (Stockport JAVASCRIPT-1VF: a saved page on a file:// share reporting as production.)
const { it, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const vm = require('vm');
const ejs = require('ejs');

let html;
before(async () => {
  process.env.K_SERVICE = 'tameside-site';     // what makes the header render the block
  html = await ejs.renderFile(path.join(__dirname, '../views/header.ejs'), {
    user: { user_id: 'auth0|test' }, siteHostname: 'tameside-badminton.co.uk',
    static_path: '/static', title: 't', pageDescription: 'd',
    assetUrl: p => p, pastSeasons: [], jsonForScript: JSON.stringify,
  }, { async: false }).catch(err => { throw err; });
});
after(() => { delete process.env.K_SERVICE; });

// The host check (window.tblServedByUs) is shared with PostHog, and the Sentry loader
// reads it, so both are run together in one context.
function loads(href) {
  const gate = html.match(/window\.tblServedByUs = \(function \(l\) \{[\s\S]*?\}\)\(window\.location\);/);
  const loader = html.match(/<script>\s*(\(function \(\) \{\s*if \(!window\.tblServedByUs\) return;[\s\S]*?\}\)\(\);)\s*<\/script>/);
  assert.ok(gate, 'the host check is in the rendered header');
  assert.ok(loader, 'the gated Sentry loader is in the rendered header');
  const appended = [];
  const u = new URL(href);
  const window = { location: { protocol: u.protocol, hostname: u.hostname } };
  vm.runInNewContext(gate[0] + '\n' + loader[1], {
    window,
    document: { createElement: () => ({}), head: { appendChild: s => appended.push(s) } },
  });
  return appended.length === 1 && /sentry-cdn\.com/.test(appended[0].src);
}

it('the loader is never a static <script src>, so the gate cannot be bypassed', () => {
  assert.doesNotMatch(html, /<script[^>]+src="https:\/\/js-de\.sentry-cdn\.com/);
});
it('loads on the live site, www, and our run.app host', () => {
  assert.ok(loads('https://tameside-badminton.co.uk/email-scorecard'));
  assert.ok(loads('https://www.tameside-badminton.co.uk/'));
  assert.ok(loads('https://tameside-site-p6gfjwl72q-nw.a.run.app/populated-scorecard-beta/1'));
});
it('does not load from a saved copy, plain http, or a lookalike host', () => {
  assert.ok(!loads('file://server/Data/tameside-badminton.co.uk/email-scorecard.html'));
  assert.ok(!loads('http://tameside-badminton.co.uk/'));
  assert.ok(!loads('https://tameside-badminton.co.uk.evil.example/'));
  assert.ok(!loads('https://eviltameside-badminton.co.uk/'));
  assert.ok(!loads('https://other-site-abc-nw.a.run.app/'));
});
it('no longer records sessions with Sentry — PostHog does that', () => {
  assert.doesNotMatch(html, /replayIntegration/);
  assert.doesNotMatch(html, /replaysSessionSampleRate/);
});
