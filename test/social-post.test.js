// Posting the league's images to Facebook and Instagram.
//
// Every assertion here corresponds to a way this has actually gone wrong, on this site or
// on the Stockport one that shares the Meta app, the Make.com account and the Instagram
// account with it. None of them are hypothetical.

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const http = require('http');

const paths = require('../utils/socialPaths');
const meta = require('../utils/metaPublisher');
const social = require('../controllers/social_controller');
const requireCronCaller = require('../middleware/requireCronCaller');

const ENV_KEYS = ['META_TAMESIDE_PAGE_ID', 'META_TAMESIDE_PAGE_TOKEN', 'META_IG_USER_ID',
  'SITE_URL', 'SOCIAL_WEEKLY_TABLES_TOKEN', 'META_GRAPH_ORIGIN'];
let saved;
beforeEach(() => { saved = {}; for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; } });
afterEach(() => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

describe('the URLs handed to Meta', () => {
  // Interpolated raw, "Hyde A" puts a literal space in the URL and Facebook answers
  // `Missing or invalid image file (324, OAuthException)` — for a route that is fine the
  // whole time. Almost every team and division name in this league contains a space.
  it('percent-encodes every segment', () => {
    const url = paths.resultImagePath({
      homeTeam: 'Hyde A', awayTeam: 'Alderley Park B',
      homeScore: 13, awayScore: 5, division: 'Division 1',
    });
    assert.ok(!/ /.test(url), `a raw space survived: ${url}`);
    assert.strictEqual(url, '/resultImage/Hyde%20A/Alderley%20Park%20B/13/5/Division%201.jpg');
    assert.strictEqual(paths.leagueTableImagePath('Division 1'), '/league-table-image/Division%201.jpg');
  });

  // A team name containing a slash would otherwise open a new path segment and match a
  // different route, or nothing.
  it('encodes a slash rather than letting it open a path segment', () => {
    const url = paths.leagueTableImagePath('Division 1/2');
    assert.ok(url.includes('%2F'), url);
  });

  // Instagram inspects the bytes rather than the extension, so an extensionless URL is
  // accepted — but then nothing upstream can tell a JPEG URL from the PNG one that broke
  // the Stockport carousel, and metaPublisher's guard has to choose between crying wolf and
  // being useless. The extension is what lets the guard stay strict.
  it('ends .jpg, and the routes take it back off', () => {
    assert.ok(paths.leagueTableImagePath('Division 2').endsWith('.jpg'));
    assert.strictEqual(paths.stripImageExt('Division 2.jpg'), 'Division 2');
    assert.strictEqual(paths.stripImageExt('Division 2.JPEG'), 'Division 2');
    assert.strictEqual(paths.stripImageExt('Division 2'), 'Division 2');
  });
});

describe('the Instagram format guard', () => {
  // Meta DOCUMENTS Instagram publishing as JPEG-only. Measured against v21.0 on
  // 15 Sep 2026, the container step does not enforce it — PNG children, a PNG carousel
  // parent and even a WebP child were all accepted and all reached FINISHED. So this guard
  // enforces the documentation, cheaply and locally, rather than a measured refusal; see
  // the long note at the top of utils/metaPublisher.js. Keeping it costs nothing and
  // `media_publish` is the one step that cannot be tested without publishing something.
  it('refuses a PNG url for Instagram', () => {
    assert.throws(
      () => meta.assertPublishableImage('https://tameside-badminton.co.uk/x.png', { forInstagram: true }),
      /JPEG-only/);
  });

  it('accepts a JPEG url for Instagram', () => {
    meta.assertPublishableImage('https://tameside-badminton.co.uk/x.jpg', { forInstagram: true });
    meta.assertPublishableImage('https://tameside-badminton.co.uk/x.jpeg?v=2', { forInstagram: true });
  });

  // Meta fetches image_url from its own servers, later. A relative or http url can never
  // resolve for it, however well it renders in a browser here.
  it('refuses anything that is not absolute https', () => {
    for (const bad of ['/league-table-image/Division%201.jpg', 'http://x/y.jpg', '', null]) {
      assert.throws(() => meta.assertPublishableImage(bad), /absolute https/);
    }
  });
});

describe('targets', () => {
  // An unset credential must mean "this league does not post" and never "post somewhere
  // else". Absence closes the path rather than opening it.
  it('is empty when nothing is configured', () => {
    assert.deepStrictEqual(meta.targets(), { page: null, instagram: null });
    assert.deepStrictEqual(meta.configuredTargets(), []);
  });

  // Posting to Facebook only has to stay a supported configuration, and it has to be
  // reachable by unsetting one variable rather than by editing code. (It was the whole
  // fallback while the two leagues shared an Instagram account; Tameside has its own since
  // 15 Sep 2026, but the escape hatch is worth keeping.)
  it('allows Facebook without Instagram', () => {
    process.env.META_TAMESIDE_PAGE_ID = '413441425183665';
    process.env.META_TAMESIDE_PAGE_TOKEN = 'tok';
    const t = meta.configuredTargets();
    assert.deepStrictEqual(t.map(x => x.kind), ['page']);
  });

  // Measured against the live Graph API 15 Sep 2026: the Tameside page token resolves the
  // shared Instagram account and its scopes include instagram_content_publish. Stockport
  // pairs Instagram with its OWN page token; copying that split here would leave Instagram
  // unconfigured whenever META_PAGE_TOKEN happened to be absent.
  it('uses the one Tameside token for both targets', () => {
    process.env.META_TAMESIDE_PAGE_ID = '413441425183665';
    process.env.META_TAMESIDE_PAGE_TOKEN = 'tok';
    process.env.META_IG_USER_ID = '17841424897459443';  // tameside.badminton
    const t = meta.configuredTargets();
    assert.deepStrictEqual(t.map(x => x.kind), ['page', 'instagram']);
    assert.ok(t.every(x => x.token === 'tok'));
  });
});

describe('publishEverywhere', () => {
  // A stub Graph API: the Facebook half accepts, the Instagram half refuses. A partial
  // failure is the case no test against the live API can cover without publishing
  // something, and it is the one whose handling matters most.
  let server, origin;
  before(async () => {
    server = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url.includes('/media')) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ error: { message: 'Only photo or video can be accepted as media type.', code: 2207052 } }));
      }
      res.end(JSON.stringify({ id: 'fake-id' }));
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => server.close());

  const TWO = [{ name: 'Tameside page', kind: 'page', id: '1', token: 't' },
               { name: 'Instagram', kind: 'instagram', id: '2', token: 't' }];

  // **A post that reached Facebook and not Instagram has still reached Facebook.** Throwing
  // on the first failure would lose that, or — worse — make a retry double-post the half
  // that worked. And reporting only success makes a half failure indistinguishable from a
  // whole one.
  it('collects per-target outcomes instead of throwing on the first failure', async () => {
    process.env.META_GRAPH_ORIGIN = origin;
    const out = await meta.publishEverywhere(TWO,
      { imageUrls: ['https://tameside-badminton.co.uk/x.jpg'], message: 'm' });

    assert.strictEqual(out.ok, false);
    assert.deepStrictEqual(out.posted.map(p => p.target), ['Tameside page']);
    assert.deepStrictEqual(out.failed.map(f => f.target), ['Instagram']);
  });

  // fetch does not throw on a 4xx, and Meta puts its error in the body rather than the
  // status. Missing that branch turns every refusal into a silent success.
  it('reads the refusal out of the body, not the status', async () => {
    process.env.META_GRAPH_ORIGIN = origin;
    const out = await meta.publishEverywhere(TWO,
      { imageUrls: ['https://tameside-badminton.co.uk/x.jpg'], message: 'm' });
    assert.match(out.failed[0].error.message, /Only photo or video/);
  });

  // A Page token does not expire on a clock, so code 190 means a person changed a password
  // or lost a role on the Page. Surfacing a bare "OAuthException" sends you hunting a code
  // bug that is not there.
  it('says in English when the token has been revoked', async () => {
    const dead = http.createServer((req, res) => {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: { message: 'Error validating access token', code: 190, type: 'OAuthException' } }));
    });
    await new Promise(r => dead.listen(0, '127.0.0.1', r));
    process.env.META_GRAPH_ORIGIN = `http://127.0.0.1:${dead.address().port}`;

    const out = await meta.publishEverywhere([TWO[0]],
      { imageUrls: ['https://tameside-badminton.co.uk/x.jpg'], message: 'm' });
    assert.match(out.failed[0].error.message, /needs re-minting by hand/);
    assert.strictEqual(out.failed[0].error.code, 190);
    dead.close();
  });

  it('skips a null target rather than treating it as an error', async () => {
    const out = await meta.publishEverywhere([null, undefined], { imageUrls: [], message: 'm' });
    assert.deepStrictEqual(out, { posted: [], failed: [], ok: true });
  });
});

describe('the weekly tables post', () => {
  it('builds absolute https .jpg urls for every division', () => {
    process.env.SITE_URL = 'https://tameside-badminton.co.uk';
    const weekly = require('../controllers/weeklyTablesController');
    const urls = weekly.imageUrls();

    assert.strictEqual(urls.length, weekly.DIVISIONS.length);
    for (const u of urls) {
      assert.match(u, /^https:\/\/tameside-badminton\.co\.uk\//, u);
      assert.ok(u.endsWith('.jpg'), u);
      // The guard Meta would otherwise apply for us, silently and after the fact.
      meta.assertPublishableImage(u, { forInstagram: true });
    }
  });

  // Instagram carousels take ten. Tameside has two divisions and Stockport four, so this is
  // not close — but Meta refuses the parent container rather than truncating, and a league
  // that grows should find that out here.
  it('fits in one Instagram carousel', () => {
    const weekly = require('../controllers/weeklyTablesController');
    assert.ok(weekly.imageUrls().length <= meta.IG_MAX_CAROUSEL);
  });
});

describe('what the table image actually says', () => {
  // `played` is 0 until a team's first result of the season, and the original divided by it
  // unguarded: `(0 / 0).toFixed(1)` is the three characters "NaN", printed down the Avg.
  // column of every table for the opening weeks of every season. Checked against the live
  // database on 15 Sep 2026: four of the nine Division 1 teams were on 0 played.
  //
  // Nobody had seen it because the URL serving the picture answered 404 from anywhere but
  // the container that drew it. A broken link was hiding a broken picture.
  it('prints 0, not NaN, before a team has played', () => {
    const v = social.tableRowValues({ played: 0, pointsFor: 0, pointsAgainst: 0 });
    assert.deepStrictEqual(v, { played: '0', won: '0', lost: '0', avg: '0' });
    assert.ok(!Object.values(v).some(x => /NaN|null|undefined/.test(x)), JSON.stringify(v));
  });

  // The columns are named "points" and hold GAMES: this league ranks on games won, all 18
  // of a fixture counting, which is why a team with 6 played shows 60 and 48.
  it('averages games won per match played', () => {
    assert.strictEqual(social.tableRowValues({ played: 6, pointsFor: 60, pointsAgainst: 48 }).avg, '10.0');
  });

  // The query coalesces these to 0, but it is one edit away from not doing so, and
  // `String(null)` is the four characters "null" — which is what the same column read on
  // the Stockport site.
  it('survives a null straight from the database', () => {
    const v = social.tableRowValues({ played: null, pointsFor: null, pointsAgainst: null });
    assert.deepStrictEqual(v, { played: '0', won: '0', lost: '0', avg: '0' });
  });
});

describe('the scheduled-post gate', () => {
  const reqWith = (query, user) => ({ query, user, get: () => undefined });
  const resSpy = () => {
    const r = { code: null, ended: false };
    r.status = (c) => { r.code = c; return r; };
    r.end = () => { r.ended = true; return r; };
    return r;
  };
  const run = (req) => {
    const res = resSpy();
    let nexted = false;
    requireCronCaller({ envVar: 'SOCIAL_WEEKLY_TABLES_TOKEN', callerProp: 'socialCaller' })(
      req, res, () => { nexted = true; });
    return { res, nexted };
  };

  // "Empty secret matches empty parameter" is how an unconfigured deploy becomes a public
  // endpoint that posts to Facebook.
  it('refuses when the token is unset, rather than admitting', () => {
    const { nexted, res } = run(reqWith({}));
    assert.strictEqual(nexted, false);
    assert.strictEqual(res.code, 404);
  });

  it('refuses a wrong token and admits the right one', () => {
    process.env.SOCIAL_WEEKLY_TABLES_TOKEN = 'secret';
    assert.strictEqual(run(reqWith({ t: 'nope' })).nexted, false);

    const req = reqWith({ t: 'secret' });
    assert.strictEqual(run(req).nexted, true);
    assert.strictEqual(req.socialCaller, 'scheduler');
  });

  // A superadmin curling it, or pressing the button on the preview page.
  it('admits a superadmin session', () => {
    const req = reqWith({}, { _json: { 'https://my-app.example.com/role': 'superadmin' } });
    assert.strictEqual(run(req).nexted, true);
    assert.strictEqual(req.socialCaller, 'superadmin');
  });

  // **The property that matters most.** `secured` answers a logged-out caller with a 302 to
  // /login; a scheduler's HTTP client follows it, gets a 200 from Auth0, and records a
  // successful run — so an endpoint refusing every request looks green for a year. That is
  // how the Stockport league lost an invoice run.
  it('never answers a refusal with a redirect', () => {
    const { res } = run(reqWith({}));
    assert.ok(res.code < 300 || res.code >= 400, `refusal used status ${res.code}`);
  });
});

describe('nothing builds a social url by hand any more', () => {
  // This was one expression copy-pasted into models/fixture.js and views/fixtures-results.ejs
  // in two spellings, neither percent-encoded. It is exactly what gets reintroduced from an
  // older handler.
  const ROOT = path.join(__dirname, '..');
  const FILES = ['models/fixture.js', 'views/fixtures-results.ejs', 'controllers/fixtureController.js',
    'controllers/weeklyTablesController.js'];

  it('has no interpolated /resultImage/ or /league-table-image/ url outside the helper', () => {
    for (const f of FILES) {
      const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
      // A literal path followed by an interpolation marker, in JS (`${`) or EJS (`<%`).
      const offenders = src.split('\n')
        .map((line, i) => ({ line, n: i + 1 }))
        .filter(({ line }) => /\/(resultImage|league-table-image)\/[^'"`\s]*(\$\{|<%)/.test(line));
      assert.deepStrictEqual(offenders.map(o => `${f}:${o.n}`), [],
        'build these through utils/socialPaths.js, which percent-encodes');
    }
  });
});

describe('the cached backgrounds', () => {
  const social = require('../controllers/social_controller');
  const crypto = require('crypto');
  const hash = b => crypto.createHash('md5').update(b).digest('hex');

  const A = { homeTeam: 'Hyde A', awayTeam: 'Shell B', homeScore: 13, awayScore: 5, division: 'Division 1' };
  const B = { homeTeam: 'Manor A', awayTeam: 'Medlock A', homeScore: 2, awayScore: 16, division: 'Division 1' };

  // **The bug this exists to catch, and it would be silent.** The backgrounds are decoded
  // once and kept, because re-decoding a 1080x1350 PNG per card is 36% of the work and the
  // video draws one card per result inside a 60-second request timeout. But Jimp's
  // `print`, `resize`, `cover` and `composite` all mutate in place — so handing the cached
  // instance out instead of a clone means the second card carries the first card's text
  // baked into it, then the third carries both. Nothing throws; the pictures are simply
  // wrong, and only in production where one process draws many cards in a row.
  it('draw the same card identically however many were drawn in between', async () => {
    const first = await social.buildResultCard(A, 'jpeg');
    const other = await social.buildResultCard(B, 'jpeg');
    const again = await social.buildResultCard(A, 'jpeg');

    assert.notStrictEqual(hash(first), hash(other), 'two different results drew the same picture');
    assert.strictEqual(hash(first), hash(again),
      'the cached background accumulated the other card — it is being mutated, not cloned');
  });

  // Same property for the other two drawings, which share the cache.
  it('do not leak between a fixtures card and a result card', async () => {
    const rows = [{ dayLabel: 'Mon 21 Sep', homeTeam: 'GHAP B', awayTeam: 'Syddal Park A' }];
    const before = await social.buildFixturesCard('Division 1', rows, 'jpeg');
    await social.buildResultCard(A, 'jpeg');
    const after = await social.buildFixturesCard('Division 1', rows, 'jpeg');
    assert.strictEqual(hash(before), hash(after));
  });
});
