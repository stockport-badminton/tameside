// Result Stories: a 9:16 card for Instagram Stories, posted beside the feed post when
// SOCIAL_POST_STORY=true. Ported from Stockport (league-site ed74712).
const { describe, it, before, after, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const sharp = require('sharp');
const request = require('supertest');

const { app } = require('./helpers/app');
const paths = require('../utils/socialPaths');
const meta = require('../utils/metaPublisher');
const social = require('../controllers/social_controller');
const card = require('../utils/cardRender');
const Fixture = require('../models/fixture');

const ENV_KEYS = ['META_TAMESIDE_PAGE_ID', 'META_TAMESIDE_PAGE_TOKEN', 'META_IG_USER_ID', 'SITE_URL',
  'META_GRAPH_ORIGIN', 'SOCIAL_POST_DIRECT', 'SOCIAL_POST_STORY'];
let saved;
beforeEach(() => { saved = {}; for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; } });
afterEach(() => { mock.restoreAll(); for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

const RESULT = { homeTeam: 'Hyde A', awayTeam: 'Manchester Edgeley B', homeScore: 13, awayScore: 5, division: 'Division 1' };

describe('the story card', () => {
  it('has its own percent-encoded path, ending story.jpg so the Instagram JPEG guard passes', () => {
    assert.strictEqual(paths.resultStoryImagePath(RESULT),
      '/resultImage/Hyde%20A/Manchester%20Edgeley%20B/13/5/Division%201/story.jpg');
  });

  it('is 9:16, and the feed card is still 4:5', async () => {
    const storyMeta = await sharp(await social.buildResultCard(RESULT, 'jpeg', { layout: 'story' })).metadata();
    const feedMeta = await sharp(await social.buildResultCard(RESULT, 'jpeg')).metadata();
    assert.deepStrictEqual([storyMeta.width, storyMeta.height], [1080, 1920]);
    assert.deepStrictEqual([feedMeta.width, feedMeta.height], [1080, 1350]);
  });

  // The feed panel runs to the bottom edge; on a story that is under Instagram's reply box.
  it('lifts the panel to end at 80% of the height, clear of the reply box', async () => {
    let body;
    mock.method(card, 'render', async (args) => { body = args.body; return Buffer.alloc(0); });
    await social.buildResultCard(RESULT, 'jpeg', { layout: 'story' });
    const [, y, h] = body.match(/<rect x="0" y="(\d+)" width="1080" height="(\d+)"/).map(Number);
    assert.strictEqual(y + h, Math.round(1920 * social.STORY.panelEnd));
    assert.ok(y > 1920 * 0.12, 'and starts below the account header');
  });

  // Covering 9:16 with 4:5 artwork cropped a fifth off each side — the division numeral and
  // the second player with it. The art is inset at full width, ending where the panel ends.
  it('insets the artwork uncropped rather than covering the frame with it', async () => {
    let args;
    mock.method(card, 'render', async (a) => { args = a; return Buffer.alloc(0); });
    await social.buildResultCard(RESULT, 'jpeg', { layout: 'story' });
    assert.deepStrictEqual(args.inset, { top: Math.round(1920 * social.STORY.panelEnd) - 1350 });
    await social.buildResultCard(RESULT, 'jpeg');
    assert.strictEqual(args.inset, undefined, 'the feed card still covers');
  });

  it('is served as a JPEG from its route', async () => {
    const res = await request(app).get(paths.resultStoryImagePath(RESULT));
    assert.strictEqual(res.status, 200);
    assert.match(res.headers['content-type'], /image\/jpeg/);
    const m = await sharp(res.body).metadata();
    assert.deepStrictEqual([m.width, m.height], [1080, 1920]);
  });
});

describe('posting a story', () => {
  let server, origin, calls;
  before(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => (body += c));
      req.on('end', () => {
        calls.push({ url: req.url, body });
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ id: 'id-' + calls.length, post_id: 'p', status_code: 'FINISHED' }));
      });
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => server.close());
  beforeEach(() => { calls = []; });

  const params = c => Object.fromEntries(new URLSearchParams(c.body.startsWith('{') ? '' : c.body));
  const sentStories = () => calls.filter(c => /media_type=STORIES|"media_type":"STORIES"/.test(c.body) || /media_type=STORIES/.test(c.url));

  it('creates a STORIES container with the story image and no caption, as its own target', async () => {
    process.env.META_GRAPH_ORIGIN = origin;
    const out = await meta.publishEverywhere(
      [{ name: 'Instagram story', kind: 'instagram-story', id: '2', token: 't' }],
      { imageUrls: ['https://tameside-badminton.co.uk/feed.jpg'], message: 'm',
        storyImageUrl: 'https://tameside-badminton.co.uk/resultImage/a/b/1/2/D/story.jpg' });
    assert.strictEqual(out.ok, true, JSON.stringify(out.failed.map(f => f.error.message)));
    assert.deepStrictEqual(out.posted.map(p => p.kind), ['instagram-story']);
    const story = sentStories();
    assert.strictEqual(story.length, 1, JSON.stringify(calls));
    assert.match(story[0].body + story[0].url, /story\.jpg/);
    assert.doesNotMatch(story[0].body + story[0].url, /caption=m\b|"caption":"m"/);
  });

  it('a story target with no story image fails on its own, without throwing', async () => {
    process.env.META_GRAPH_ORIGIN = origin;
    const out = await meta.publishEverywhere(
      [{ name: 'Instagram story', kind: 'instagram-story', id: '2', token: 't' }],
      { imageUrls: ['https://tameside-badminton.co.uk/feed.jpg'], message: 'm' });
    assert.deepStrictEqual(out.failed.map(f => f.target), ['Instagram story']);
    assert.strictEqual(calls.length, 0);
  });

  const zap = () => new Promise(resolve => Fixture.sendResultZap(
    { ...RESULT, host: 'tameside-badminton.co.uk' }, (err, r) => resolve(r)));
  const directEnv = () => {
    Object.assign(process.env, { META_GRAPH_ORIGIN: origin, SOCIAL_POST_DIRECT: 'true',
      META_TAMESIDE_PAGE_ID: '1', META_TAMESIDE_PAGE_TOKEN: 't', META_IG_USER_ID: '2' });
  };

  it('a published result posts NO story while SOCIAL_POST_STORY is unset', async () => {
    directEnv();
    const r = await zap();
    assert.deepStrictEqual(r.posted, ['Tameside page', 'Instagram']);
    assert.strictEqual(sentStories().length, 0);
  });

  it('a published result posts the story card too when SOCIAL_POST_STORY=true', async () => {
    directEnv();
    process.env.SOCIAL_POST_STORY = 'true';
    const r = await zap();
    assert.deepStrictEqual(r.posted, ['Tameside page', 'Instagram', 'Instagram story']);
    const story = sentStories();
    assert.strictEqual(story.length, 1);
    // Still percent-encoded when it reaches Meta: a raw space is what made Facebook answer
    // "Missing or invalid image file (324)" before socialPaths existed.
    const sent = new URLSearchParams(story[0].body).get('image_url');
    assert.strictEqual(sent, 'https://tameside-badminton.co.uk' + paths.resultStoryImagePath(RESULT));
  });
});
