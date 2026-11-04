// Security response headers (utils/securityHeaders.js). Ported from Stockport's HARD-12.
//
// "Present on every response" is the requirement, so this asks for one of each kind:
// a rendered page, a static asset, a 404 and the health probe. A header that is missing
// from the one response an attacker cares about is no control.

const { describe, test } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');

const { app } = require('../helpers/app');
const dbHealth = require('../../utils/dbHealth');

// /health answers from the DB; stub it so this file opens no connection.
dbHealth.check = async () => ({ ok: true });

const RESPONSES = [
  ['a rendered page', '/privacy-policy'],
  ['a static asset', '/static/js/main.js'],
  ['a 404', '/no-such-page-at-all'],
  ['the health probe', '/health'],
];

function directives(header) {
  const out = {};
  for (const part of header.split(';')) {
    const [name, ...values] = part.trim().split(/\s+/);
    if (name) out[name] = values;
  }
  return out;
}

describe('security headers are on every response', () => {
  for (const [what, url] of RESPONSES) {
    test(what, async () => {
      const res = await request(app).get(url);
      assert.strictEqual(res.headers['x-content-type-options'], 'nosniff');
      assert.strictEqual(res.headers['x-frame-options'], 'SAMEORIGIN');
      assert.strictEqual(res.headers['strict-transport-security'], 'max-age=31536000');
      assert.strictEqual(res.headers['referrer-policy'], 'strict-origin-when-cross-origin');
      assert.ok(res.headers['content-security-policy'], 'CSP header present');
      assert.strictEqual(res.headers['x-powered-by'], undefined, 'Express is not advertised');
    });
  }
});

describe('the CSP is the baseline only', () => {
  test('it carries the four structural directives', async () => {
    const res = await request(app).get('/privacy-policy');
    const csp = directives(res.headers['content-security-policy']);
    assert.deepStrictEqual(csp['frame-ancestors'], ["'self'"]);
    assert.deepStrictEqual(csp['base-uri'], ["'self'"]);
    assert.deepStrictEqual(csp['object-src'], ["'none'"]);
  });

  // Chrome checks form-action on every redirect a submission follows. A POST to a
  // `secured` route with an expired session goes to /login and then to Auth0, so
  // without the Auth0 host the login is blocked.
  test('form-action allows the Auth0 login a POST can be redirected to', async () => {
    const res = await request(app).get('/privacy-policy');
    const csp = directives(res.headers['content-security-policy']);
    assert.deepStrictEqual(csp['form-action'], ["'self'", `https://${process.env.AUTH0_DOMAIN}`]);
  });

  // The resource allowlist has not been observed yet. With a default-src, or any *-src,
  // enforced today, every CDN script and style the site loads would be blocked.
  test('it names no source of scripts, styles, images or connections', async () => {
    const res = await request(app).get('/privacy-policy');
    const names = Object.keys(directives(res.headers['content-security-policy']));
    const sources = names.filter((n) => n.endsWith('-src') && n !== 'object-src');
    assert.deepStrictEqual(sources, []);
    assert.strictEqual(res.headers['content-security-policy-report-only'], undefined);
  });
});

describe('cross-origin policies leave our images embeddable', () => {
  test('a result card can be shown in an email or a link preview', async () => {
    const res = await request(app).get('/static/js/main.js');
    assert.strictEqual(res.headers['cross-origin-resource-policy'], 'cross-origin');
    assert.strictEqual(res.headers['cross-origin-embedder-policy'], undefined);
  });
});
