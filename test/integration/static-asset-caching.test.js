// The cache policy on /static and /scripts (utils/assets.js). Ported from Stockport's
// HARD-42 test (league-site __tests__/integration/static-asset-caching.test.js).
//
// Before this every asset carried a flat 30-day max-age, hashed URL or not, behind a CDN
// with no purge. The cases that matter most are the ones that stop a long cache being
// WRONG: the version must change with the bytes, a version this instance does not hold
// must not be marked immutable, a missing file must not be cached publicly, and /sw.js
// must never be cached at all.

const { describe, test, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const request = require('supertest');

const { app } = require('../helpers/app');
const assets = require('../../utils/assets');

const ROOT = path.join(__dirname, '..', '..');
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, file))).digest('hex').slice(0, 12);

const YEAR = 'public, max-age=31536000, immutable';

// What every page asks for. style.css is compiled by `npm run build:css` and gitignored,
// but the suite already relies on it existing (the rendered pages link it).
const SHELL = [
  ['/static/css/style.css', 'static/css/style.css'],
  ['/static/css/modern-styles.css', 'static/css/modern-styles.css'],
  ['/static/js/main.js', 'static/js/main.js'],
];

describe('the rendered page asks for versioned shell assets', () => {
  test('each carries the hash of its contents, and none is left bare', async () => {
    const res = await request(app).get('/privacy-policy');
    assert.strictEqual(res.status, 200);
    for (const [url, file] of SHELL) {
      assert.ok(res.text.includes(`${url}?v=${sha(file)}"`), `${url} at its current hash`);
      assert.ok(!res.text.includes(`"${url}"`), `${url} unversioned`);
    }
  });
});

describe('Cache-Control on the static mounts', () => {
  for (const [url, file] of SHELL) {
    test(`${url} at its current version is cached for a year, immutable`, async () => {
      const res = await request(app).get(`${url}?v=${sha(file)}`);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.headers['cache-control'], YEAR);
    });
  }

  test('the vendor files are served from their own mounts', async () => {
    for (const url of [
      '/scripts/bootstrap/dist/js/bootstrap.bundle.min.js',
      '/scripts/ejs/ejs.js',
      '/scripts/jquery/dist/jquery.min.js',
    ]) {
      const res = await request(app).get(url);
      assert.strictEqual(res.status, 200, url);
      assert.strictEqual(res.headers['cache-control'], 'public, max-age=3600', url);
    }
  });

  // Two revisions serve side by side during a deploy, so the new page's `?v=<new>` can
  // reach the old instance. Marking that immutable would pin the old bytes under the new
  // URL for a year, at the CDN and in the browser.
  test('a version this instance does not hold is not cached', async () => {
    const res = await request(app).get('/static/css/modern-styles.css?v=000000000000');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers['cache-control'], 'no-cache');
  });

  test('an unversioned asset gets an hour, not a month', async () => {
    const res = await request(app).get('/static/js/main.js');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers['cache-control'], 'public, max-age=3600');
  });

  test('runtime-generated images are not held', () => {
    assert.strictEqual(assets.cacheControlFor('/static/images/generated/table-Division 1.png'), 'public, max-age=0');
    assert.strictEqual(assets.cacheControlFor('/static/generated/x.png'), 'public, max-age=0');
  });

  test('/sw.js stays no-cache — a cached service worker pins users to an old site', async () => {
    const res = await request(app).get('/sw.js');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers['cache-control'], 'no-cache');
  });
});

describe('the service worker precaches what the page requests', () => {
  test('style.css and modern-styles.css at their versioned URLs', async () => {
    const res = await request(app).get('/sw.js');
    for (const [url, file] of SHELL.slice(0, 2)) {
      assert.ok(res.text.includes(`${url}?v=${sha(file)}`), url);
    }
  });
});

describe('/scripts serves the vendor files the pages use, not node_modules', () => {
  for (const url of [
    '/scripts/express/package.json',
    '/scripts/bootstrap/package.json',
    '/scripts/@fortawesome/fontawesome-free/css/all.css',
  ]) {
    test(`${url} is not served`, async () => {
      const res = await request(app).get(url);
      assert.strictEqual(res.status, 404);
    });
  }

  // A public max-age on a 404 outlives the deploy that adds the file: Firebase holds it.
  for (const url of [
    '/scripts/express/package.json',
    '/static/does-not-exist.css',
    '/static/does-not-exist.css?v=000000000000',
  ]) {
    test(`the 404 for ${url} carries no public cache policy`, async () => {
      const res = await request(app).get(url);
      assert.strictEqual(res.status, 404);
      assert.doesNotMatch(res.headers['cache-control'] || '', /public|max-age=[1-9]/);
    });
  }
});

describe('assetUrl() follows the file\'s contents', () => {
  const rel = `static/__asset-test-${process.pid}.css`;
  const file = path.join(ROOT, rel);
  const url = '/' + rel;
  after(() => { try { fs.unlinkSync(file); } catch (e) { /* already gone */ } });

  test('a change to the file changes its URL', () => {
    fs.writeFileSync(file, 'body{color:red}');
    const before = assets.assetUrl(url);
    assert.match(before, /\?v=[0-9a-f]{12}$/);
    assert.strictEqual(assets.assetUrl(url), before);

    fs.writeFileSync(file, 'body{color:blue;}');
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(file, later, later);
    assert.notStrictEqual(assets.assetUrl(url), before);
  });

  test('a path it cannot resolve comes back unchanged, on the short-cache path', () => {
    assert.strictEqual(assets.assetUrl('/static/does-not-exist.css'), '/static/does-not-exist.css');
    assert.strictEqual(assets.assetUrl('/scripts/express/index.js'), '/scripts/express/index.js');
    assert.strictEqual(assets.assetUrl('/static/../package.json'), '/static/../package.json');
  });
});
