// The CSP allowlist in utils/securityHeaders.js, without booting the app. The env switch
// is tested by calling the functions with the variable set, not by requiring app.js a
// second time: Stockport did that and leaked a second pool, which looked exactly like the
// suite's known DB flakiness.

const { describe, test, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const sh = require('../utils/securityHeaders');

const saved = { ...process.env };
afterEach(() => {
  for (const k of ['CSP_ENFORCE', 'CSP_REPORT_URI', 'S3_BUCKET_NAME']) {
    if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
});

describe('CSP_ENFORCE', () => {
  test('unset: the allowlist is report-only and the baseline names no source', () => {
    delete process.env.CSP_ENFORCE;
    const enforced = sh.enforcedDirectives();
    assert.ok(!('script-src' in enforced));
    assert.ok(!('report-uri' in enforced));
    assert.ok(sh.observedDirectives()['script-src']);
  });

  test('true: one enforced header with the baseline, the allowlist and reporting', () => {
    process.env.CSP_ENFORCE = 'true';
    const enforced = sh.enforcedDirectives();
    assert.strictEqual(sh.observedDirectives(), null);
    assert.deepStrictEqual(enforced['default-src'], ["'self'"]);
    assert.deepStrictEqual(enforced['frame-ancestors'], ["'self'"]);
    assert.ok(enforced['form-action'].some((s) => s.startsWith('https://')), 'Auth0 kept');
    assert.ok(enforced['script-src'].includes('https://js-de.sentry-cdn.com'));
    assert.deepStrictEqual(enforced['report-uri'], ['/csp-report']);
  });

  test('anything but "true" does not enforce', () => {
    process.env.CSP_ENFORCE = '1';
    assert.ok(sh.observedDirectives());
  });
});

describe('CSP_REPORT_URI', () => {
  test("'' emits no reporting at all", () => {
    process.env.CSP_REPORT_URI = '';
    assert.ok(!('report-uri' in sh.observedDirectives()));
    assert.strictEqual(sh.reportingEndpointsHeader(), null);
  });

  test('a value redirects both report-uri and the endpoints header', () => {
    process.env.CSP_REPORT_URI = 'https://example.test/r';
    assert.deepStrictEqual(sh.observedDirectives()['report-uri'], ['https://example.test/r']);
    assert.strictEqual(sh.reportingEndpointsHeader(), 'csp-endpoint="https://example.test/r"');
  });
});

test('no bucket name, no bucket host (rather than https://undefined.s3…)', () => {
  delete process.env.S3_BUCKET_NAME;
  assert.ok(!sh.allowlist()['connect-src'].some((s) => s.includes('amazonaws')));
});

// A new <script src>/<link href> on a CDN not in the policy is exactly what the report-
// only period exists to find, and what an enforcing policy would block. Catch the
// statically visible ones here instead. Runtime-injected hosts (PostHog, Maps' own
// follow-ups, reCAPTCHA's) can only be found by the reports.
describe('every CDN a view loads from is allowed', () => {
  const VIEWS = path.join(__dirname, '..', 'views');
  function ejsFiles(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? ejsFiles(path.join(dir, e.name))
        : e.name.endsWith('.ejs') ? [path.join(dir, e.name)] : []);
  }
  const files = ejsFiles(VIEWS).map((f) => [path.relative(VIEWS, f), fs.readFileSync(f, 'utf8')]);
  const policy = sh.allowlist();

  function hostOf(url) {
    return new URL(url.startsWith('//') ? 'https:' + url : url).origin;
  }

  test('script hosts are in script-src', () => {
    const missing = [];
    for (const [name, src] of files) {
      const re = /(?:<script[^>]*\bsrc=["']|data-maps-src=["']|\.src\s*=\s*['"])((?:https?:)?\/\/[^"'<\s]+)/g;
      for (const m of src.matchAll(re)) {
        const origin = hostOf(m[1]);
        if (!policy['script-src'].includes(origin)) missing.push(`${name}: ${origin}`);
      }
    }
    assert.deepStrictEqual(missing, []);
  });

  test('stylesheet hosts are in style-src', () => {
    const missing = [];
    for (const [name, src] of files) {
      const re = /<link[^>]*rel=["']stylesheet["'][^>]*href=["']((?:https?:)?\/\/[^"']+)|<link[^>]*href=["']((?:https?:)?\/\/[^"']+)["'][^>]*rel=["']stylesheet/g;
      for (const m of src.matchAll(re)) {
        const origin = hostOf(m[1] || m[2]);
        if (!policy['style-src'].includes(origin)) missing.push(`${name}: ${origin}`);
      }
    }
    assert.deepStrictEqual(missing, []);
  });
});
