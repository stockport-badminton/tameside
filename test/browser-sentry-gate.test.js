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

function loads(href) {
  const gate = html.match(/<script>\s*\(function \(l\) \{[\s\S]*?\}\)\(window\.location\);\s*<\/script>/);
  assert.ok(gate, 'the gate script is in the rendered header');
  const code = gate[0].replace(/^<script>|<\/script>$/g, '');
  const appended = [];
  const u = new URL(href);
  vm.runInNewContext(code, {
    window: { location: { protocol: u.protocol, hostname: u.hostname } },
    document: { createElement: () => ({}), head: { appendChild: s => appended.push(s) } },
  });
  return appended.length === 1;
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
