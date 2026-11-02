// Published results go to Facebook and Instagram through a queue, not inside the publish
// request (Stockport's HARD-47, ported Nov 2026). Publishing writes one row per configured
// target; POST /admin/social/results/meta, on the `tbl-results-meta` scheduler job, posts them.
//
// Against a fake Graph API (META_GRAPH_ORIGIN), so the real fetch calls run, and an in-memory
// queue (helpers/fakeResultQueue.js) in place of the table.

const { describe, it, before, after, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const request = require('supertest');

const { app, setModel, clearModels } = require('../helpers/app');
const { installFakeResultQueue } = require('../helpers/fakeResultQueue');
const meta = require('../../utils/metaPublisher');
const paths = require('../../utils/socialPaths');
const Fixture = require('../../models/fixture');
const metaResults = require('../../controllers/metaResultsController');

const ENV_KEYS = ['META_TAMESIDE_PAGE_ID', 'META_TAMESIDE_PAGE_TOKEN', 'META_IG_USER_ID', 'SITE_URL',
  'META_GRAPH_ORIGIN', 'SOCIAL_POST_DIRECT', 'SOCIAL_POST_STORY', 'SOCIAL_POST_FB_STORY',
  'SOCIAL_RESULTS_META_TOKEN'];
let saved;
beforeEach(() => { saved = {}; for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; } });
afterEach(() => {
  clearModels(); mock.restoreAll();
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

const SITE = 'https://tameside-badminton.co.uk';
const TOKEN = 'the-real-token';
const FIXTURE = 6054;
const RESULT = { status: 'complete', homeTeam: 'Hyde A', awayTeam: 'Manchester Edgeley B',
  homeScore: 13, awayScore: 5, division: 'Division 1' };

// What the fake Graph API does. `behave(req, params)` may answer itself and return true.
let server, origin, calls, behave;
before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const params = Object.fromEntries(new URLSearchParams(body || req.url.split('?')[1] || ''));
      calls.push({ method: req.method, url: req.url, params });
      if (behave && behave(req, res, params)) return;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ id: 'id-' + calls.length, post_id: 'p-' + calls.length, status_code: 'FINISHED' }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());
beforeEach(() => { calls = []; behave = null; });

const directEnv = (extra = {}) => Object.assign(process.env, {
  META_GRAPH_ORIGIN: origin, SOCIAL_POST_DIRECT: 'true', SOCIAL_RESULTS_META_TOKEN: TOKEN,
  META_TAMESIDE_PAGE_ID: '1', META_TAMESIDE_PAGE_TOKEN: 't', META_IG_USER_ID: '2', ...extra });

const zap = (extra = {}) => new Promise((resolve) => Fixture.sendResultZap(
  { fixtureId: FIXTURE, ...RESULT, host: 'tameside-badminton.co.uk', ...extra }, (err, r) => resolve(r)));
const runJob = () => request(app).post(`/admin/social/results/meta?t=${TOKEN}`);

describe('publishing a result', () => {
  // The acceptance test from the brief: it must fail with the queue taken out, because the
  // publish would then sit on Meta until the test's own timeout.
  it('returns at once while Meta hangs, having queued the post instead of making it', { timeout: 5000 }, async () => {
    directEnv({ SOCIAL_POST_STORY: 'true', SOCIAL_POST_FB_STORY: 'true' });
    const rows = installFakeResultQueue(setModel);
    behave = () => true;   // never answer

    const r = await zap();
    assert.deepStrictEqual(r.queued, ['page', 'instagram', 'page-story', 'instagram-story']);
    assert.strictEqual(calls.length, 0, 'nothing was sent to Meta from the publish');
    assert.deepStrictEqual(rows.map(x => [x.fixtureId, x.target, x.state]), [
      [FIXTURE, 'page', 'pending'], [FIXTURE, 'instagram', 'pending'],
      [FIXTURE, 'page-story', 'pending'], [FIXTURE, 'instagram-story', 'pending']]);
  });

  it('queues only the configured targets, and a republish queues nothing new', async () => {
    directEnv();
    const rows = installFakeResultQueue(setModel);
    assert.deepStrictEqual((await zap()).queued, ['page', 'instagram']);
    assert.deepStrictEqual((await zap()).queued, []);
    assert.strictEqual(rows.length, 2);
  });

  it('with no Meta credentials, reports the misconfiguration and queues nothing', async () => {
    process.env.SOCIAL_POST_DIRECT = 'true';
    const rows = installFakeResultQueue(setModel);
    const r = await zap();
    assert.strictEqual(r.sent, false);
    assert.match(r.reason, /posted nowhere/);
    assert.strictEqual(rows.length, 0);
  });
});

describe('POST /admin/social/results/meta', () => {
  it('404s without the token, and never redirects', async () => {
    directEnv();
    installFakeResultQueue(setModel);
    for (const url of ['/admin/social/results/meta', '/admin/social/results/meta?t=guess']) {
      const res = await request(app).post(url);
      assert.strictEqual(res.status, 404, url);
      assert.strictEqual(res.headers.location, undefined);
    }
  });

  it('posts every queued target with the result as it stands now', async () => {
    directEnv({ SOCIAL_POST_STORY: 'true' });
    // Corrected between publishing and the job: the corrected score is what goes out.
    const rows = installFakeResultQueue(setModel, { results: { [FIXTURE]: { ...RESULT, homeScore: 12, awayScore: 6 } } });
    await zap();

    const res = await runJob();
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.deepStrictEqual(res.body.results.map(r => [r.target, r.outcome]),
      [['page', 'posted'], ['instagram', 'posted'], ['instagram-story', 'posted']]);
    assert.ok(rows.every(r => r.state === 'posted' && r.mediaId), JSON.stringify(rows));

    const feed = calls.find(c => c.params.caption);
    assert.match(feed.params.caption, /Hyde A vs Manchester Edgeley B : 12-6/);
    const story = calls.find(c => c.params.media_type === 'STORIES');
    assert.strictEqual(story.params.image_url,
      SITE + paths.resultStoryImagePath({ ...RESULT, homeScore: 12, awayScore: 6 }));
  });

  it('an empty queue is a green run that posts nothing', async () => {
    directEnv();
    installFakeResultQueue(setModel);
    const res = await runJob();
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body.results, []);
    assert.strictEqual(calls.length, 0);
  });

  it('a refusal before anything is visible is retried, up to three attempts, and the run is red', async () => {
    directEnv();
    const rows = installFakeResultQueue(setModel, { results: { [FIXTURE]: RESULT } });
    await zap();
    behave = (req, res) => {
      if (!/\/media$/.test(req.url)) return false;
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: { message: 'Only photo or video can be accepted', code: 9004 } }));
      return true;
    };

    const first = await runJob();
    assert.strictEqual(first.status, 502);
    assert.deepStrictEqual(first.body.results.map(r => [r.target, r.outcome]),
      [['page', 'posted'], ['instagram', 'retrying']]);
    const ig = rows.find(r => r.target === 'instagram');
    assert.strictEqual(ig.state, 'pending');

    await runJob();
    await runJob();
    assert.strictEqual(ig.state, 'failed');
    assert.strictEqual(ig.attempts, 3);
    assert.strictEqual(rows.find(r => r.target === 'page').state, 'posted', 'the page post was not repeated');
    assert.strictEqual(calls.filter(c => /\/feed$/.test(c.url)).length, 1);
  });

  it('a publish that got no answer may be live, so it is failed and never retried', async () => {
    directEnv();
    const rows = installFakeResultQueue(setModel, { results: { [FIXTURE]: RESULT } });
    await zap();
    behave = (req, res) => {
      if (!/media_publish$/.test(req.url)) return false;
      res.destroy();
      return true;
    };

    const res = await runJob();
    assert.strictEqual(res.status, 502);
    const ig = rows.find(r => r.target === 'instagram');
    assert.strictEqual(ig.state, 'failed');
    assert.match(ig.lastError, /may be live/);
  });

  it('skips a stale row and one whose fixture lost its result; fails one whose target was unconfigured', async () => {
    directEnv({ SOCIAL_POST_STORY: 'true' });
    const rows = installFakeResultQueue(setModel, { results: { [FIXTURE]: RESULT, 7000: { ...RESULT, homeScore: null } } });
    await zap();
    await zap({ fixtureId: 7000 });
    rows.find(r => r.fixtureId === FIXTURE && r.target === 'page').queuedAt = new Date(Date.now() - 49 * 3600e3);
    delete process.env.SOCIAL_POST_STORY;

    const res = await runJob();
    const byKey = Object.fromEntries(res.body.results.map(r => [`${r.fixtureId}/${r.target}`, r.outcome]));
    assert.strictEqual(byKey[`${FIXTURE}/page`], 'skipped');
    assert.strictEqual(byKey[`${FIXTURE}/instagram`], 'posted');
    assert.strictEqual(byKey[`${FIXTURE}/instagram-story`], 'failed');
    assert.strictEqual(byKey['7000/page'], 'skipped');
    assert.strictEqual(res.status, 502);
  });

  // Every request here is cut at 60 s, and a run cut off mid-post leaves a row someone has
  // to check by hand. So the job stops starting rows once its budget is spent.
  it('stops starting new rows once its time budget is spent', async () => {
    directEnv();
    const rows = installFakeResultQueue(setModel, { results: { [FIXTURE]: RESULT } });
    await zap();
    let now = 1_000_000;
    mock.method(Date, 'now', () => now);
    behave = () => { now += metaResults.START_BUDGET_MS; return false; };

    const res = await runJob();
    assert.deepStrictEqual(res.body.results.map(r => r.target), ['page']);
    assert.strictEqual(rows.find(r => r.target === 'instagram').state, 'pending');
  });
});

describe('Instagram image containers', () => {
  // Every Meta failure on a Stockport result from 25 Sep to 23 Oct 2026 was "The media is not
  // ready to be published". So the container is waited on before it is published.
  it('are waited on until FINISHED before publishing', async () => {
    process.env.META_GRAPH_ORIGIN = origin;
    let checks = 0;
    behave = (req, res) => {
      if (req.method !== 'GET') return false;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ status_code: ++checks < 2 ? 'IN_PROGRESS' : 'FINISHED' }));
      return true;
    };
    await meta.publishInstagramPhoto('2', 't', { imageUrl: SITE + '/x.jpg', caption: 'c' });
    const order = calls.map(c => c.method === 'GET' ? 'check' : c.url.split('/').pop());
    assert.deepStrictEqual(order, ['media', 'check', 'check', 'media_publish']);
  });

  it('a container Meta could not process fails before the publish, so it may be retried', async () => {
    process.env.META_GRAPH_ORIGIN = origin;
    behave = (req, res) => {
      if (req.method !== 'GET') return false;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ status_code: 'ERROR', status: 'bad image' }));
      return true;
    };
    await assert.rejects(meta.publishInstagramPhoto('2', 't', { imageUrl: SITE + '/x.jpg', caption: 'c' }),
      (err) => err.step === 'processing an image' && !meta.mayHavePublished(err));
    assert.ok(!calls.some(c => /media_publish$/.test(c.url)));
  });
});

describe('mayHavePublished', () => {
  it('only a publishing step with no answer counts as possibly live', () => {
    const e = (step, status) => new meta.MetaError('x', { step, status });
    assert.strictEqual(meta.mayHavePublished(e('the Instagram publish')), true);
    assert.strictEqual(meta.mayHavePublished(e('the page post')), true);
    assert.strictEqual(meta.mayHavePublished(e('the page story')), true);
    assert.strictEqual(meta.mayHavePublished(e('the Instagram publish', 400)), false);
    assert.strictEqual(meta.mayHavePublished(e('an Instagram media container')), false);
    assert.strictEqual(meta.mayHavePublished(e('processing an image')), false);
  });
});
