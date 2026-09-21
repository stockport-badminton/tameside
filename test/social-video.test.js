// The weekly results video: the encode, the read route's key handling, and the staleness
// guard on the post.
//
// Every assertion here corresponds to a way this feature has actually gone wrong on the
// Stockport league site, which shipped it first and ran it for four months without anyone
// being able to fetch the output. None of them are hypothetical.

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert');

const video = require('../utils/socialVideo');
const paths = require('../utils/socialPaths');
const meta = require('../utils/metaPublisher');

describe('the ffmpeg filter graph', () => {
  const slides = ['/tmp/a.jpg', '/tmp/b.jpg', '/tmp/c.jpg'];

  // The offsets accumulate at `slide - transition`, because a crossfade CONSUMES that much
  // of the running total rather than adding to it. Getting it wrong does not fail the
  // encode — it produces a video that freezes on one slide and skips another, which is
  // only visible by watching the thing. Exactly the class of fault that left the Stockport
  // output stretched for four months: it rendered, it just rendered wrong.
  it('offsets each crossfade by slide minus transition', () => {
    const args = video.encodeArgs(slides, '/tmp/out.mp4', { slide: 3, transition: 0.5 });
    const graph = args[args.indexOf('-filter_complex') + 1];
    assert.match(graph, /offset=2\.500/);
    assert.match(graph, /offset=5\.000/);
  });

  it('reports the duration the graph actually produces', () => {
    // 3 slides x 3s, overlapping by 0.5s twice = 8s. Stockport's builder INSERTS transition
    // frames instead of overlapping, so theirs is 10s for the same inputs. Neither is
    // wrong; the reported number has to match whichever is built.
    assert.strictEqual(video.totalDuration(3, 3, 0.5), 8);
    assert.strictEqual(video.totalDuration(1, 3, 0.5), 3);
    assert.strictEqual(video.totalDuration(0, 3, 0.5), 0);
  });

  // A one-result week is ordinary in April. `xfade` with nothing to fade to is an error,
  // so the single-slide case has to reach the same code path with an empty chain rather
  // than a second, unexercised branch.
  it('handles a single slide without an xfade', () => {
    const args = video.encodeArgs(['/tmp/a.jpg'], '/tmp/out.mp4');
    const graph = args[args.indexOf('-filter_complex') + 1];
    assert.ok(!graph.includes('xfade'), graph);
    assert.ok(graph.startsWith('[0:v]'), graph);
    assert.ok(graph.endsWith('[v]'), graph);
  });

  // A JPEG decodes as FULL-range YUV, so `-pix_fmt yuv420p` on its own yields a stream
  // tagged `yuvj420p` — 4:2:0 as asked, but full range, which renders washed out in any
  // player that ignores the tag. Measured here 21 Sep 2026 before the scale filter existed.
  it('converts to limited-range yuv420p', () => {
    const args = video.encodeArgs(slides, '/tmp/out.mp4');
    const graph = args[args.indexOf('-filter_complex') + 1];
    assert.match(graph, /scale=in_range=full:out_range=tv,format=yuv420p\[v\]$/);
    assert.strictEqual(args[args.indexOf('-pix_fmt') + 1], 'yuv420p');
  });

  // Meta fetches this by URL and starts reading immediately. With the index at the end of
  // the file it has to pull the whole thing before it can begin.
  it('puts the moov atom at the front', () => {
    const args = video.encodeArgs(slides, '/tmp/out.mp4');
    assert.strictEqual(args[args.indexOf('-movflags') + 1], '+faststart');
  });

  it('loops each still for the slide duration and writes to the given path', () => {
    const args = video.encodeArgs(slides, '/tmp/out.mp4', { slide: 4 });
    assert.strictEqual(args.filter(a => a === '-loop').length, 3);
    assert.strictEqual(args.filter(a => a === '4').length, 3);
    assert.strictEqual(args[args.length - 1], '/tmp/out.mp4');
  });
});

describe('letterboxing', () => {
  // A no-op for a card already at frame size, which is every card today. It exists for the
  // case that is not hypothetical: xfade refuses inputs of differing dimensions, so a
  // background replaced at a different size would fail the whole encode.
  it('fits inside the frame and centres the remainder, never squashing', () => {
    const g = video.letterboxGeometry(1080, 1350, 1080, 1080);
    assert.strictEqual(g.width, 864);
    assert.strictEqual(g.height, 1080);
    assert.strictEqual(g.left, 108);
    assert.strictEqual(g.top, 0);
    // The aspect survives. Stockport's `-resize 1080:1080` did not preserve it — a colon
    // is an aspect RATIO in ImageMagick geometry, and a 1080x1350 card came out stretched.
    assert.ok(Math.abs((g.width / g.height) - (1080 / 1350)) < 0.001);
  });

  it('is exact for a frame the card already matches', () => {
    const g = video.letterboxGeometry(1080, 1350, 1080, 1350);
    assert.deepStrictEqual(g, { width: 1080, height: 1350, left: 0, top: 0 });
  });
});

describe('the S3 keys', () => {
  // The bucket is SHARED with the Stockport league site, which owns it and keeps its own
  // scorecards at the root. `utils/scorecardPhoto.js` decides what is ours by the
  // `tameside-` prefix and nothing else, so an object written without it is
  // indistinguishable from theirs.
  it('carry the tameside- prefix', () => {
    for (const key of Object.values(video.VIDEO_KEYS)) {
      assert.ok(key.startsWith('tameside-'), key);
    }
  });

  it('cover exactly the aspects that can be rendered', () => {
    assert.deepStrictEqual(Object.keys(video.VIDEO_KEYS), Object.keys(video.VIDEO_SIZES));
  });

  // 4:5 because the cards are 1080x1350 and that IS 4:5 — no letterboxing at all, every
  // pixel content. Stockport shipped 16:9 and 1:1 before the question was answerable and
  // dropped 16:9 once it was.
  it('render at the source cards own aspect', () => {
    const { width, height } = video.VIDEO_SIZES['4-5'];
    assert.strictEqual(width, 1080);
    assert.strictEqual(height, 1350);
  });
});

describe('the video URL', () => {
  // No `.jpg`-style extension rule here, unlike the images. `assertPublishableImage`
  // requires one because Instagram documents JPEG-only for photos and a self-describing
  // URL lets that guard stay strict; Meta documents no equivalent for a fetched video, so
  // a rule about the extension would be invented rather than enforced.
  it('is a path built in one place, with the aspect encoded', () => {
    assert.strictEqual(paths.socialVideoPath('4-5'), '/social-video/4-5');
    assert.strictEqual(paths.socialVideoPath('a/b'), '/social-video/a%2Fb');
  });

  // Meta fetches it from Meta's own servers. A relative or http URL can never resolve for
  // it, however well it renders in a browser here.
  it('must be absolute https to be publishable', () => {
    for (const bad of ['/social-video/4-5', 'http://x/v.mp4', '', null]) {
      assert.throws(() => meta.assertPublishableVideo(bad), /absolute https/);
    }
    meta.assertPublishableVideo('https://tameside-badminton.co.uk/social-video/4-5');
  });
});

describe('waitForContainer', () => {
  // **Video is not photo-with-a-different-field.** A photo container is usable the moment
  // it is created; a video container has to be fetched and transcoded by Meta first, and
  // publishing early fails with container-not-ready.
  it('polls until FINISHED and returns the container id', async () => {
    let calls = 0;
    const origin = await stubGraph(() => {
      calls += 1;
      return { status_code: calls < 2 ? 'IN_PROGRESS' : 'FINISHED' };
    });
    try {
      const id = await meta.waitForContainer('c1', 'tok', { pollMs: 5, timeoutMs: 2000 });
      assert.strictEqual(id, 'c1');
      assert.ok(calls >= 2);
    } finally { await origin.close(); }
  });

  // ERROR carries a `status` string that is the only description of what was wrong with
  // the file. Flattening it to "failed" throws away the one useful sentence.
  it('passes through what Meta said when it refuses the file', async () => {
    const origin = await stubGraph(() => ({ status_code: 'ERROR', status: 'Video format not supported' }));
    try {
      await assert.rejects(
        meta.waitForContainer('c1', 'tok', { pollMs: 5, timeoutMs: 2000 }),
        /Video format not supported/);
    } finally { await origin.close(); }
  });

  // The timeout is tuned to THIS service's 60s Cloud Run request timeout, which is where
  // Tameside differs from Stockport (they run the 600s default). A 180s poll would be cut
  // off by the platform mid-publish, which is the one failure that could double-post on a
  // retry.
  it('gives up inside the request timeout rather than being cut off by it', () => {
    assert.ok(meta.VIDEO_TIMEOUT_MS < 60000,
      `poll ceiling ${meta.VIDEO_TIMEOUT_MS}ms must leave room inside the 60s request timeout`);
    // Measured 21 Sep 2026: a 5.4-second video took 27.6s to reach FINISHED. The ceiling
    // has to clear that with room for a longer week, or the weekly Instagram half fails
    // routinely while Facebook succeeds.
    assert.ok(meta.VIDEO_TIMEOUT_MS >= 45000,
      `poll ceiling ${meta.VIDEO_TIMEOUT_MS}ms is below the 27.6s a short video actually took`);
  });

  // **Facebook first, Instagram second, and that order is load-bearing.** The Facebook
  // video is one unpolled call; Instagram has to be polled through a transcode that has
  // been measured at 27.6s. Reversed, a slow transcode would eat the request budget and
  // Cloud Run would cut the whole thing off before Facebook was ever attempted.
  it('posts to Facebook before the target that has to be polled', () => {
    const saved = { ...process.env };
    process.env.META_TAMESIDE_PAGE_ID = 'p';
    process.env.META_TAMESIDE_PAGE_TOKEN = 't';
    process.env.META_IG_USER_ID = 'i';
    try {
      assert.deepStrictEqual(meta.configuredTargets().map(t => t.kind), ['page', 'instagram']);
    } finally {
      for (const k of ['META_TAMESIDE_PAGE_ID', 'META_TAMESIDE_PAGE_TOKEN', 'META_IG_USER_ID']) {
        if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
      }
    }
  });

  it('says nothing was published when it gives up', async () => {
    const origin = await stubGraph(() => ({ status_code: 'IN_PROGRESS' }));
    try {
      await assert.rejects(
        meta.waitForContainer('c1', 'tok', { pollMs: 5, timeoutMs: 40 }),
        /Nothing was published/);
    } finally { await origin.close(); }
  });
});

describe('publishVideoEverywhere', () => {
  // A post that reached Facebook and not Instagram has still reached Facebook. Throwing on
  // the first failure would lose that, or make a retry double-post the half that worked.
  it('reports per target and does not throw', async () => {
    const origin = await stubGraph((url) => {
      if (url.includes('/videos')) throw new Error('page refused');
      if (url.includes('/media_publish')) return { id: 'ig-1' };
      if (url.includes('/media')) return { id: 'container-1' };
      return { status_code: 'FINISHED' };
    });
    try {
      const out = await meta.publishVideoEverywhere([
        { id: 'p', token: 't', name: 'Tameside page', kind: 'page' },
        { id: 'i', token: 't', name: 'Instagram', kind: 'instagram' },
      ], { videoUrl: 'https://tameside-badminton.co.uk/social-video/4-5', message: 'm', caption: 'c' });

      assert.strictEqual(out.ok, false);
      assert.deepStrictEqual(out.posted.map(p => p.target), ['Instagram']);
      assert.deepStrictEqual(out.failed.map(f => f.target), ['Tameside page']);
    } finally { await origin.close(); }
  });
});

describe('the staleness guard on the post', () => {
  const controllerPath = require.resolve('../controllers/weeklyVideoController');
  const svcPath = require.resolve('../controllers/socialVideoController');

  function loadController(ageMs) {
    delete require.cache[controllerPath];
    delete require.cache[svcPath];
    const svc = require('../controllers/socialVideoController');
    svc.storedVideoAge = async () => ageMs;
    return require('../controllers/weeklyVideoController');
  }

  afterEach(() => {
    delete require.cache[controllerPath];
    delete require.cache[svcPath];
  });

  // **The handler posts whatever is in the bucket, and the bucket keeps the last render
  // for ever.** Without this, a generation that did not happen means last week's results
  // are published as this week's, under a caption saying so — worse than posting nothing,
  // and the same class of silent wrongness this feature produced twice on the other site.
  it('refuses a video older than two days', async () => {
    const c = loadController(3 * 24 * 60 * 60 * 1000);
    const f = await c.videoFreshness();
    assert.strictEqual(f.ok, false);
    assert.match(f.reason, /3 days old/);
  });

  // A missing video is refused too. Handing Meta a URL that 404s makes the job report a
  // cheerful failure; a 409 names the step that was missed.
  it('refuses when nothing has been generated', async () => {
    const c = loadController(null);
    const f = await c.videoFreshness();
    assert.strictEqual(f.ok, false);
    assert.match(f.reason, /No video has been generated/);
  });

  it('accepts one generated this morning', async () => {
    const c = loadController(4 * 60 * 60 * 1000);
    assert.strictEqual((await c.videoFreshness()).ok, true);
  });

  // The caption carries no @-mentions, deliberately and unlike the tables post: a results
  // video names every club that played, and mentioning all of them reads as spam.
  it('mentions nobody', () => {
    const c = loadController(0);
    const text = c.captions('16 - 20 Sep');
    assert.ok(!text.instagram.includes('@'), text.instagram);
    assert.ok(!text.facebook.includes('@'), text.facebook);
    assert.match(text.instagram, /16 - 20 Sep/);
  });
});

/**
 * A stand-in Graph API, so the partial-failure and polling behaviour can be exercised
 * without publishing anything. `META_GRAPH_ORIGIN` exists for exactly this.
 */
async function stubGraph(handler) {
  const http = require('http');
  const saved = process.env.META_GRAPH_ORIGIN;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      let out;
      try {
        out = handler(req.url, body);
      } catch (err) {
        res.writeHead(400, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: err.message, code: 100 } }));
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  process.env.META_GRAPH_ORIGIN = `http://127.0.0.1:${server.address().port}`;
  return {
    close: () => new Promise(r => {
      if (saved === undefined) delete process.env.META_GRAPH_ORIGIN;
      else process.env.META_GRAPH_ORIGIN = saved;
      server.close(r);
    }),
  };
}
