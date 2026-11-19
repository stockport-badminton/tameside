// robots.txt, sitemap.xml, llms.txt, X-Robots-Tag and the canonical (Nov 2026).
//
// The rule being protected: nothing that needs a login is crawlable or indexable, and
// everything public is. robots.txt is derived from the route table, so these tests check
// it against the REAL router in both directions — a hand-written expected list would just
// be a second copy of the thing that drifts.

const { describe, test, afterEach } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');

const { app, setModel, clearModels } = require('../helpers/app');
const { routeTable, sampleUrlsFor } = require('../../utils/routeTable');
const robots = require('../../utils/robots');
const { eventPath, canonicalFor } = require('../../utils/siteUrl');

const SITE = 'https://tameside-badminton.co.uk';
const rules = robots.disallowRules(app);
const extras = robots.EXTRA_DISALLOW.map(([p]) => p);
const getRoutes = routeTable(app).filter((r) => r.method === 'GET');

afterEach(() => clearModels());

describe('robots.txt is derived from the route access declarations', () => {
  test('every GET route that is not public is disallowed', () => {
    const open = [];
    for (const r of getRoutes.filter((r) => r.access !== 'public')) {
      for (const url of sampleUrlsFor(app, r)) {
        if (!robots.isDisallowed(rules, url)) open.push(`${r.path} (${r.access}): ${url}`);
      }
    }
    assert.deepStrictEqual(open, []);
  });

  test('no public GET route is disallowed, apart from the listed extras', () => {
    const blocked = [];
    for (const r of getRoutes.filter((r) => r.access === 'public')) {
      for (const url of sampleUrlsFor(app, r)) {
        if (robots.isDisallowed(rules, url) && !robots.isDisallowed(extras, url)) {
          blocked.push(`${r.path}: ${url}`);
        }
      }
    }
    assert.deepStrictEqual(blocked, []);
  });

  test('a shared literal prefix does not hide the public route', () => {
    // /player/:id/update needs a login; /player/:id does not.
    assert.ok(robots.isDisallowed(rules, '/player/7/update'));
    assert.ok(!robots.isDisallowed(rules, '/player/7'));
    assert.ok(!robots.isDisallowed(rules, '/playerStats/7/Dave-Lee'));
    assert.ok(!robots.isDisallowed(rules, '/clubs'));
    assert.ok(!robots.isDisallowed(rules, '/info/clubs'));
  });

  test('ruleFor turns parameters into wildcards and drops trailing ones', () => {
    assert.strictEqual(robots.ruleFor('/player/:id(\\d+)/update'), '/player/*/update');
    assert.strictEqual(robots.ruleFor('/club/:id'), '/club/');
    assert.strictEqual(robots.ruleFor('/admin/results/*'), '/admin/results/');
    assert.strictEqual(robots.ruleFor('/players/club-:club?'), '/players/club-');
    assert.strictEqual(robots.ruleFor('/admin'), '/admin');
  });

  test('is served as text, welcomes the AI crawlers by name and names the sitemap', async () => {
    const res = await request(app).get('/robots.txt');
    assert.strictEqual(res.status, 200);
    assert.match(res.headers['content-type'], /^text\/plain/);
    assert.strictEqual(res.headers['cache-control'], 'public, max-age=3600');
    for (const ua of ['GPTBot', 'ClaudeBot', 'PerplexityBot', 'CCBot', '*']) {
      assert.ok(res.text.includes('User-agent: ' + ua + '\n'), ua);
    }
    // One group: no bot may be told `Disallow: /`.
    assert.ok(!/^Disallow: \/\s*$/m.test(res.text), 'nothing disallows the whole site');
    assert.ok(res.text.includes(`Sitemap: ${SITE}/sitemap.xml\n`));
  });
});

describe('X-Robots-Tag', () => {
  test('a login-gated route says noindex, even on its redirect to /login', async () => {
    const res = await request(app).get('/email-scorecard');
    assert.strictEqual(res.status, 302);
    assert.strictEqual(res.headers['x-robots-tag'], 'noindex, nofollow');
  });

  test('a public page does not', async () => {
    const res = await request(app).get('/privacy-policy');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers['x-robots-tag'], undefined);
  });
});

describe('canonical and og tags', () => {
  test('every page declares itself on the configured domain, absolutely', async () => {
    const res = await request(app).get('/privacy-policy?utm_source=fb&fbclid=x');
    assert.ok(res.text.includes(`<link rel="canonical" href="${SITE}/privacy-policy">`));
    assert.ok(res.text.includes(`<meta property="og:url" content="${SITE}/privacy-policy">`));
    assert.ok(res.text.includes(`<meta property="og:image" content="${SITE}/static/images/Logo.png">`));
  });

  test('tracking params are dropped from a canonical, real ones kept', () => {
    assert.strictEqual(canonicalFor({ originalUrl: '/results/All?club=Hyde&utm_medium=x' }),
      `${SITE}/results/All?club=Hyde`);
    assert.strictEqual(canonicalFor({ originalUrl: '/rules?gclid=1' }), `${SITE}/rules`);
  });
});

describe('sitemap.xml', () => {
  function stubData() {
    setModel('Division', 'getAll', (done) => done(null, [{ name: 'Division 1' }, { name: 'Division 2' }]));
    setModel('Fixture', 'getForSitemap', async () => [
      { id: 7001, date: new Date(2026, 9, 7), status: 'complete', homeTeam: 'Hyde A', awayTeam: 'G.H.A.P A' },
      { id: 7002, date: new Date(2026, 11, 2), status: 'outstanding', homeTeam: 'Manor B', awayTeam: 'Mellor A' },
    ]);
  }

  test('lists the public pages, the divisions and this season\'s fixtures', async () => {
    stubData();
    const res = await request(app).get('/sitemap.xml');
    assert.strictEqual(res.status, 200);
    assert.match(res.headers['content-type'], /^application\/xml/);
    const locs = [...res.text.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    for (const p of ['/', '/info/clubs', '/tables/Division-1', '/results/Division-2', '/results-grid/Division-1',
                     '/event/7001/07102026-Hyde%20A-G.H.A.P%20A']) {
      assert.ok(locs.includes(SITE + p), p);
    }
    assert.ok(res.text.includes('<lastmod>2026-10-07</lastmod>'), 'a played fixture carries its date');
    assert.strictEqual((res.text.match(/<lastmod>/g) || []).length, 1, 'an upcoming one carries none');
  });

  test('every URL in it is one robots.txt allows', async () => {
    stubData();
    const res = await request(app).get('/sitemap.xml');
    const paths = [...res.text.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].slice(SITE.length));
    assert.ok(paths.length > 10);
    assert.deepStrictEqual(paths.filter((p) => robots.isDisallowed(rules, p)), []);
  });

  test('event URLs are built the way the homepage links them', () => {
    assert.strictEqual(eventPath({ id: 5, date: new Date(2026, 0, 3), homeTeam: 'A/B', awayTeam: 'C D' }),
      '/event/5/03012026-A-B-C%20D');
  });
});

describe('llms.txt', () => {
  test('describes the league from the club data, minus the placeholder club', async () => {
    setModel('Division', 'getAll', (done) => done(null, [{ name: 'Division 1' }, { name: 'Division 2' }]));
    setModel('Club', 'clubDetail', (done) => done(null, [
      { clubId: 1, name: 'Hyde', clubNightText: 'Wednesday 8pm', clubvenue: 'Astley Sports College',
        clubaddress: 'Yew Tree Lane,\n Dukinfield', clubWebsite: 'https://www.hydebadminton.co.uk/' },
      { clubId: 1, name: 'Hyde', clubNightText: 'Wednesday 8pm' },
      { clubId: 63, name: 'No Club', clubNightText: 'None' },
    ]));
    const res = await request(app).get('/llms.txt');
    assert.strictEqual(res.status, 200);
    assert.match(res.headers['content-type'], /^text\/plain/);
    assert.ok(res.text.startsWith('# Tameside Badminton League\n'));
    assert.ok(res.text.includes('2 divisions (Division 1, Division 2) and 1 member clubs'));
    assert.ok(res.text.includes('- **Hyde**: club night Wednesday 8pm at Astley Sports College (Yew Tree Lane, Dukinfield).'));
    assert.ok(!res.text.includes('No Club'));
    assert.ok(res.text.includes(`(${SITE}/tables/Division-1)`));
  });
});
