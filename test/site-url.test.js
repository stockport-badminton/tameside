// Absolute urls must come from configuration, never from the request.
//
// tameside-badminton.co.uk resolves to Firebase Hosting, which proxies to Cloud Run and
// REWRITES the Host header on the way through. Verified by experiment: a request sent to
// `https://tameside-badminton.co.uk/hostprobe-...` was recorded by Cloud Run as
// `https://tameside-site-p6gfjwl72q-nw.a.run.app/hostprobe-...`. So in production
// `req.headers.host` is *always* the run.app hostname, and the domain the visitor typed
// cannot be recovered from the request at all.
//
// WHAT THAT BROKE. The scorecard email built its links from req.headers.host, so the
// results secretary received
// `https://tameside-site-...a.run.app/populated-scorecard-beta/2164`. Clicking it put the
// browser on the run.app origin; `secured` then stored `returnTo` in a session whose
// cookie belongs to *.a.run.app; /login sent the user to Auth0, whose callback is
// (correctly) https://tameside-badminton.co.uk/callback; and the browser came back to a
// DIFFERENT ORIGIN, which does not send that cookie. No OAuth state, no `returnTo`, so
// the callback's `|| '/'` fallback fired and you arrived logged in on the homepage having
// asked for a scorecard.
//
// No session store can fix that — two origins cannot share a cookie — so the rule is
// simply never to emit a run.app link.

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { siteUrl, absoluteUrl, canonicalFor, DEFAULT_SITE_URL } = require('../utils/siteUrl');

const withEnv = (value, fn) => {
  const saved = process.env.SITE_URL;
  if (value === undefined) delete process.env.SITE_URL; else process.env.SITE_URL = value;
  try { fn(); } finally {
    if (saved === undefined) delete process.env.SITE_URL; else process.env.SITE_URL = saved;
  }
};

describe('siteUrl', () => {
  it('defaults to the live domain, so a missing env var cannot produce a run.app link', () => {
    withEnv(undefined, () => {
      assert.strictEqual(siteUrl(), 'https://tameside-badminton.co.uk');
      assert.strictEqual(DEFAULT_SITE_URL, 'https://tameside-badminton.co.uk');
    });
  });

  it('honours SITE_URL, for local dev or a staging host', () => {
    withEnv('http://localhost:8080', () => assert.strictEqual(siteUrl(), 'http://localhost:8080'));
  });

  it('tolerates a trailing slash and a bare hostname', () => {
    withEnv('https://example.test/', () => assert.strictEqual(siteUrl(), 'https://example.test'));
    withEnv('staging.example.test', () => assert.strictEqual(siteUrl(), 'https://staging.example.test'));
  });

  it('ignores a blank SITE_URL rather than building "///path"', () => {
    withEnv('   ', () => assert.strictEqual(siteUrl(), DEFAULT_SITE_URL));
  });
});

describe('absoluteUrl', () => {
  it('joins a path with or without its leading slash', () => {
    withEnv(undefined, () => {
      assert.strictEqual(absoluteUrl('/scorecard-photo/2164'), 'https://tameside-badminton.co.uk/scorecard-photo/2164');
      assert.strictEqual(absoluteUrl('tables/All'), 'https://tameside-badminton.co.uk/tables/All');
      assert.strictEqual(absoluteUrl(''), 'https://tameside-badminton.co.uk/');
    });
  });

  it('passes an already-absolute url through untouched', () => {
    withEnv(undefined, () => {
      assert.strictEqual(absoluteUrl('https://other.test/x'), 'https://other.test/x');
    });
  });
});

describe('canonicalFor', () => {
  it('takes only the PATH from the request, never the host', () => {
    // The whole point: a request whose Host is the run.app hostname (which in production
    // is every request) must still produce a canonical url on the real domain.
    const req = { originalUrl: '/tables/All', headers: { host: 'tameside-site-p6gfjwl72q-nw.a.run.app' } };
    withEnv(undefined, () => {
      const url = canonicalFor(req);
      assert.strictEqual(url, 'https://tameside-badminton.co.uk/tables/All');
      assert.ok(!url.includes('a.run.app'), url);
    });
  });

  it('copes with no request at all', () => {
    withEnv(undefined, () => assert.strictEqual(canonicalFor(undefined), 'https://tameside-badminton.co.uk/'));
  });
});

describe('nothing builds a url from the request host any more', () => {
  // A repo-wide source assertion, the same tactic as test/db-retry.test.js. The bug was
  // one expression repeated in seven files, and it is the kind of thing that gets
  // reintroduced by copy-paste from an older handler — a behavioural test of one route
  // would not notice. utils/siteUrl.js is the only place allowed to talk about hosts.
  const ROOTS = ['app.js', 'controllers', 'models', 'utils', 'middleware', 'views'];
  const SKIP = new Set([path.join('utils', 'siteUrl.js')]);

  function walk(rel, out) {
    const abs = path.join(__dirname, '..', rel);
    if (!fs.existsSync(abs)) return out;
    if (fs.statSync(abs).isDirectory()) {
      for (const entry of fs.readdirSync(abs)) walk(path.join(rel, entry), out);
    } else if (/\.(js|ejs)$/.test(rel) && !SKIP.has(rel)) {
      out.push(rel);
    }
    return out;
  }

  it('has no req.headers.host / req.get("host") outside utils/siteUrl.js', () => {
    const offenders = [];
    for (const rel of walk('app.js', []).concat(...ROOTS.slice(1).map(r => walk(r, [])))) {
      const src = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
      src.split('\n').forEach((line, i) => {
        if (/^\s*(\/\/|\*|<%#)/.test(line)) return;       // a comment explaining the rule
        if (/req\.headers\.host|req\.get\(['"]host['"]\)|req\.hostname/.test(line)) {
          offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    assert.deepStrictEqual(offenders, [],
      'build absolute urls with utils/siteUrl.js — Firebase rewrites Host to the run.app hostname:\n'
      + offenders.join('\n'));
  });
});

describe('the scorecard email links', () => {
  // These three are what the results secretary actually clicks, and all three were
  // run.app urls. Pinned at the source, because asserting on them for real means creating
  // a scorecardstore row and stubbing Mailjet (see test/integration/email-scorecard.test.js,
  // which hits the real database).
  const src = fs.readFileSync(path.join(__dirname, '..', 'controllers', 'fixtureController.js'), 'utf8');

  it('are built with absoluteUrl', () => {
    assert.match(src, /let scorecardUrl = absoluteUrl\(/, 'the /populated-scorecard/... confirm link');
    assert.match(src, /absoluteUrl\("\/populated-scorecard-beta\/" \+ rows\[0\]\.id\)/, 'the beta confirm link');
    assert.match(src, /absoluteUrl\("\/scorecard-photo\/" \+ rows\[0\]\.id\)/, 'the photo link');
  });

  it('imports the helper', () => {
    assert.match(src, /require\('\.\.\/utils\/siteUrl'\)/);
  });
});
