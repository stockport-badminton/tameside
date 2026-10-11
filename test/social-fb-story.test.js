// Facebook Page stories: every Page post also goes out as a Page story when
// SOCIAL_POST_FB_STORY=true. Ported from Stockport (league-site b79b221).
//
// Against a fake Graph API (META_GRAPH_ORIGIN), so the real fetch calls run — including the
// video story's upload to Meta's rupload host, which the fake also stands in for.
const { describe, it, before, after, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert');
const http = require('http');

require('./helpers/app');
const meta = require('../utils/metaPublisher');
const paths = require('../utils/socialPaths');
const Fixture = require('../models/fixture');

const ENV_KEYS = ['META_TAMESIDE_PAGE_ID', 'META_TAMESIDE_PAGE_TOKEN', 'META_IG_USER_ID', 'SITE_URL',
  'META_GRAPH_ORIGIN', 'SOCIAL_POST_DIRECT', 'SOCIAL_POST_STORY', 'SOCIAL_POST_FB_STORY'];
let saved;
beforeEach(() => { saved = {}; for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; } });
afterEach(() => { mock.restoreAll(); for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

const PAGE = '1';
const TOKEN = 't';
const SITE = 'https://tameside-badminton.co.uk';
const RESULT = { homeTeam: 'Hyde A', awayTeam: 'Manchester Edgeley B', homeScore: 13, awayScore: 5, division: 'Division 1' };

let server, origin, calls, refuseUpload;
before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const p = Object.fromEntries(new URLSearchParams(body));
      calls.push({ url: req.url, body, params: p, headers: req.headers });
      res.setHeader('Content-Type', 'application/json');
      if (req.url.startsWith('/rupload/')) {
        if (refuseUpload) { res.statusCode = 400; return res.end(JSON.stringify({ error: { message: 'Could not fetch the file', code: 100 } })); }
        return res.end(JSON.stringify({ success: true }));
      }
      if (/video_stories$/.test(req.url) && p.upload_phase === 'start') {
        return res.end(JSON.stringify({ video_id: 'v1', upload_url: origin + '/rupload/v1' }));
      }
      if (/video_stories$/.test(req.url) && p.upload_phase === 'finish') {
        return res.end(JSON.stringify({ success: true, post_id: 'story-v1' }));
      }
      res.end(JSON.stringify({ id: 'id-' + calls.length, post_id: 'p-' + calls.length, status_code: 'FINISHED' }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());
beforeEach(() => { calls = []; refuseUpload = false; });

const uploads = () => calls.filter((c) => /\/photos$/.test(c.url));
const storyPublishes = () => calls.filter((c) => /\/photo_stories$/.test(c.url));

describe('photo stories', () => {
  it('uploads each card unpublished, then publishes one story frame per card, in order', async () => {
    process.env.META_GRAPH_ORIGIN = origin;
    const urls = [SITE + '/league-table-image/Division%201.jpg', SITE + '/league-table-image/Division%202.jpg'];
    const out = await meta.publishPageStories(PAGE, TOKEN, { imageUrls: urls });

    assert.deepStrictEqual(uploads().map((c) => [c.params.url, c.params.published]),
      [[urls[0], 'false'], [urls[1], 'false']]);
    assert.strictEqual(storyPublishes().length, 2);
    // Division order, whichever upload Meta answered first.
    assert.deepStrictEqual(storyPublishes().map((c) => c.params.photo_id), out.photoIds);
    assert.strictEqual(out.postIds.length, 2);
  });

  it('the result story uses the 9:16 card, carries no message, and is reported apart from the feed post', async () => {
    process.env.META_GRAPH_ORIGIN = origin;
    const story = SITE + paths.resultStoryImagePath(RESULT);
    const out = await meta.publishEverywhere([
      { name: 'Tameside page', kind: 'page', id: PAGE, token: TOKEN },
      { name: 'Tameside page story', kind: 'page-story', id: PAGE, token: TOKEN },
    ], { imageUrls: [SITE + '/resultImage/a.jpg'], message: 'Result', storyImageUrl: story });

    assert.strictEqual(out.ok, true, JSON.stringify(out.failed.map((f) => f.error.message)));
    assert.deepStrictEqual(out.posted.map((p) => p.target), ['Tameside page', 'Tameside page story']);
    const storyUpload = uploads().find((c) => c.params.url === story);
    assert.ok(storyUpload, 'the story card was uploaded');
    assert.strictEqual(storyUpload.params.published, 'false');
    assert.strictEqual(storyUpload.params.message, undefined);
    assert.strictEqual(storyPublishes().length, 1);
  });

  it('a story that fails leaves the feed post standing', async () => {
    process.env.META_GRAPH_ORIGIN = origin;
    const out = await meta.publishEverywhere([
      { name: 'Tameside page', kind: 'page', id: PAGE, token: TOKEN },
      { name: 'Tameside page story', kind: 'page-story', id: PAGE, token: TOKEN },
    ], { imageUrls: [], message: 'Result' });
    // No images at all: the album refuses too, but each is reported on its own.
    assert.deepStrictEqual(out.failed.map((f) => f.target).sort(), ['Tameside page', 'Tameside page story']);
  });
});

describe('a video story', () => {
  const VIDEO = SITE + '/social-video/4-5';

  it('is three calls: start, hand Meta the file url, finish', async () => {
    process.env.META_GRAPH_ORIGIN = origin;
    const out = await meta.publishVideoEverywhere(
      [{ name: 'Tameside page story', kind: 'page-story', id: PAGE, token: TOKEN }], { videoUrl: VIDEO });

    assert.strictEqual(out.ok, true, JSON.stringify(out.failed.map((f) => f.error.message)));
    const [start, upload, finish] = calls;
    assert.match(start.url, /\/1\/video_stories$/);
    assert.strictEqual(start.params.upload_phase, 'start');
    assert.strictEqual(upload.url, '/rupload/v1');
    assert.strictEqual(upload.headers.authorization, `OAuth ${TOKEN}`);
    assert.strictEqual(upload.headers.file_url, VIDEO);
    assert.deepStrictEqual([finish.params.upload_phase, finish.params.video_id], ['finish', 'v1']);
    assert.deepStrictEqual(out.posted, [{ target: 'Tameside page story', kind: 'page-story', id: 'story-v1' }]);
  });

  // fetch does not throw on a 4xx: without the explicit check this "succeeded" and went on
  // to `finish` a video Meta never received.
  it('an upload Meta refuses fails that target, and never finishes', async () => {
    process.env.META_GRAPH_ORIGIN = origin;
    refuseUpload = true;
    const out = await meta.publishVideoEverywhere(
      [{ name: 'Tameside page story', kind: 'page-story', id: PAGE, token: TOKEN }], { videoUrl: VIDEO });
    assert.deepStrictEqual(out.failed.map((f) => f.target), ['Tameside page story']);
    assert.match(out.failed[0].error.message, /Could not fetch the file/);
    assert.ok(!calls.some((c) => c.params.upload_phase === 'finish'));
  });
});

describe('the switch', () => {
  it('is off unless SOCIAL_POST_FB_STORY is set, and needs the Page configured', () => {
    const t = { page: { id: PAGE, token: TOKEN }, instagram: null };
    assert.strictEqual(meta.pageStoryTarget(t), null);
    process.env.SOCIAL_POST_FB_STORY = 'true';
    assert.deepStrictEqual(meta.pageStoryTarget(t), { id: PAGE, token: TOKEN, name: 'Tameside page story', kind: 'page-story' });
    assert.strictEqual(meta.pageStoryTarget({ page: null }), null);
  });

  // All four Facebook posts read configuredTargets(), so this is what puts the story on the
  // weekly tables, fixtures and video too. LAST, so inside the 60s request a slow story can
  // only ever cost itself, never a feed post.
  it('adds the story to every post, after the feed targets', () => {
    Object.assign(process.env, { META_TAMESIDE_PAGE_ID: PAGE, META_TAMESIDE_PAGE_TOKEN: TOKEN, META_IG_USER_ID: '2' });
    assert.deepStrictEqual(meta.configuredTargets().map((t) => t.kind), ['page', 'instagram']);
    process.env.SOCIAL_POST_FB_STORY = 'true';
    assert.deepStrictEqual(meta.configuredTargets().map((t) => t.kind), ['page', 'instagram', 'page-story']);
  });
});

describe('a published result', () => {
  const zap = () => new Promise((resolve) => Fixture.sendResultZap(
    { ...RESULT, host: 'tameside-badminton.co.uk' }, (err, r) => resolve(r)));
  const directEnv = () => Object.assign(process.env, { META_GRAPH_ORIGIN: origin, SOCIAL_POST_DIRECT: 'true',
    META_TAMESIDE_PAGE_ID: PAGE, META_TAMESIDE_PAGE_TOKEN: TOKEN, META_IG_USER_ID: '2' });

  it('posts no Facebook story while SOCIAL_POST_FB_STORY is unset', async () => {
    directEnv();
    const r = await zap();
    assert.deepStrictEqual(r.posted, ['Tameside page', 'Instagram']);
    assert.strictEqual(storyPublishes().length, 0);
  });

  // Even with the Instagram story off, the Page story must get the 9:16 card, not fall back
  // to the 4:5 feed card.
  it('posts the 9:16 card as a Page story when SOCIAL_POST_FB_STORY=true', async () => {
    directEnv();
    process.env.SOCIAL_POST_FB_STORY = 'true';
    const r = await zap();
    assert.deepStrictEqual(r.posted, ['Tameside page', 'Instagram', 'Tameside page story']);
    assert.strictEqual(storyPublishes().length, 1);
    assert.ok(uploads().some((c) => c.params.url === SITE + paths.resultStoryImagePath(RESULT)),
      'the story card was the one uploaded for the story');
  });
});
