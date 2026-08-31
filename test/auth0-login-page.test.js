// The Auth0 login page (auth0/tameside-login-page.html) is deployed into Auth0 rather
// than served by this app, so nothing else in the suite would notice it breaking — and
// when it breaks, nobody can log in. These checks are deliberately about the things that
// are silent and expensive to get wrong, not about styling.
//
// See auth0/README.md for how it's deployed and why it lives per-application.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const PAGE_PATH = path.join(__dirname, '..', 'auth0', 'tameside-login-page.html');
const page = fs.readFileSync(PAGE_PATH, 'utf8');

describe('Auth0 custom login page', () => {
  it('keeps the @@config@@ placeholder', () => {
    // Auth0 substitutes the client id, callback URL and session state through this
    // token. Lose it and the page renders but cannot authenticate anyone — the worst
    // failure shape available, because it looks fine.
    assert.ok(page.includes('@@config@@'), '@@config@@ must be present');
  });

  it('still reads that config rather than hardcoding anything', () => {
    assert.match(page, /window\.atob\('@@config@@'\)/);
    // The client id and callback come from the injected config, never from the file:
    // this same HTML shape is what Auth0 serves for whichever client it is set on.
    assert.match(page, /new Auth0Lock\(\s*config\.clientID,\s*config\.auth0Domain/);
    assert.match(page, /redirectUrl:\s*config\.callbackURL/);
  });

  it('loads the Lock widget over https from Auth0\'s CDN', () => {
    // The tenant serves Classic Universal Login, so Lock is what renders. An http or
    // relative URL here would be blocked or broken on the login page.
    assert.match(page, /https:\/\/cdn\.auth0\.com\/js\/lock\/11[^"']*lock\.min\.js/);
  });

  it('shows Tameside branding, not the other league\'s', () => {
    // The bug this page exists to fix: the shared tenant-wide page had Stockport's logo
    // hardcoded, so Tameside users were shown a different league on signup.
    assert.match(page, /logo:\s*'https:\/\/tameside-badminton\.co\.uk\//);
    assert.ok(!/stockport-badminton\.co\.uk/.test(page),
      'must not reference the Stockport site — that was the original fault');
    assert.match(page, /<title>Tameside Badminton League<\/title>/);
  });

  it('serves its logo over https from the live site', () => {
    // A mixed-content or 404 logo is worse than no logo on a login page.
    const m = page.match(/logo:\s*'([^']+)'/);
    assert.ok(m, 'a logo must be configured');
    assert.match(m[1], /^https:\/\//, 'logo must be https');
  });

  it('does not close the widget or leak a debug flag', () => {
    // closable:true on a hosted login page gives a dismiss button that leads nowhere.
    assert.match(page, /closable:\s*false/);
  });
});
