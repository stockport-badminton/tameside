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

describe('the enforced CSP is the baseline only', () => {
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

  // The allowlist is still report-only. With a default-src, or any *-src, enforced
  // today, a host nobody remembered would be blocked for real visitors.
  test('it names no source of scripts, styles, images or connections', async () => {
    const res = await request(app).get('/privacy-policy');
    const names = Object.keys(directives(res.headers['content-security-policy']));
    const sources = names.filter((n) => n.endsWith('-src') && n !== 'object-src');
    assert.deepStrictEqual(sources, []);
  });
});

describe('the resource allowlist is report-only', () => {
  async function observed() {
    const res = await request(app).get('/privacy-policy');
    assert.ok(res.headers['content-security-policy-report-only'], 'report-only header present');
    return { res, csp: directives(res.headers['content-security-policy-report-only']) };
  }

  test('it is on every kind of response', async () => {
    for (const [, url] of RESPONSES) {
      const res = await request(app).get(url);
      assert.ok(res.headers['content-security-policy-report-only'], url);
    }
  });

  test('it reports to our own collector, both ways browsers do it', async () => {
    const { res, csp } = await observed();
    assert.deepStrictEqual(csp['report-uri'], ['/csp-report']);
    assert.deepStrictEqual(csp['report-to'], ['csp-endpoint']);
    assert.strictEqual(res.headers['reporting-endpoints'], 'csp-endpoint="/csp-report"');
  });

  test('default-src is self', async () => {
    const { csp } = await observed();
    assert.deepStrictEqual(csp['default-src'], ["'self'"]);
  });

  // The scorecard pages' client-side EJS needs eval. The fix is to stop templating in
  // the browser (Stockport 9e6f2df), not to allow it: with 'unsafe-inline' already in,
  // eval as well would leave script-src constraining only where scripts load from.
  test("script-src does not allow 'unsafe-eval'", async () => {
    const { csp } = await observed();
    assert.ok(!csp['script-src'].includes("'unsafe-eval'"));
  });

  // The photo is PUT from the browser straight to the presigned URL.
  test('connect-src allows the photo upload to the bucket, both host spellings', async () => {
    const { csp } = await observed();
    assert.ok(csp['connect-src'].includes('https://test-bucket.s3.eu-west-1.amazonaws.com'));
    assert.ok(csp['connect-src'].includes('https://test-bucket.s3-eu-west-1.amazonaws.com'));
  });

  // The PDF previews are iframes on URL.createObjectURL(file).
  test('frame-src allows the blob: PDF preview', async () => {
    const { csp } = await observed();
    assert.ok(csp['frame-src'].includes('blob:'));
  });

  test('img-src allows the data: and blob: photo previews', async () => {
    const { csp } = await observed();
    assert.ok(csp['img-src'].includes('data:'));
    assert.ok(csp['img-src'].includes('blob:'));
  });
});

describe('cross-origin policies leave our images embeddable', () => {
  test('a result card can be shown in an email or a link preview', async () => {
    const res = await request(app).get('/static/js/main.js');
    assert.strictEqual(res.headers['cross-origin-resource-policy'], 'cross-origin');
    assert.strictEqual(res.headers['cross-origin-embedder-policy'], undefined);
  });
});
