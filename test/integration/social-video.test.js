// GET /social-video/:aspect and the gating on the generate/post endpoints.
//
// The read route is the one that matters most, and Stockport's equivalent test got it
// wrong the first time in a way worth not repeating: **the traversal cases asserted only
// a 404, which a handler interpolating `req.params.aspect` straight into the S3 key would
// also return**, because the mocked bucket holds no such object. It passed against the
// vulnerable version. So the assertions here are about the KEY that reached S3, which is
// the only form of the question that tells the two implementations apart.
//
// That matters here more than it did there: this bucket is shared with the Stockport
// league site and holds its scorecards at the root, so a route that streams any object a
// caller can name would serve another league's private documents out of our origin.

const { describe, it, afterEach, mock } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { Readable } = require('node:stream');

const { app, setModel, clearModels } = require('../helpers/app');
const s3util = require('../../utils/s3');
const video = require('../../utils/socialVideo');

afterEach(() => { clearModels(); mock.restoreAll(); });

const BUCKET = process.env.S3_BUCKET_NAME; // 'test-bucket', from the helper

function stubS3({ body = 'MP4BYTES', throws = null, declaredType = 'text/html' } = {}) {
  const calls = [];
  mock.method(s3util, 's3Client', () => ({
    send: async (command) => {
      calls.push(command.input);
      if (throws) { const e = new Error('nope'); e.name = throws; throw e; }
      return {
        ContentType: declaredType,
        ContentLength: Buffer.byteLength(body),
        Body: Readable.from([Buffer.from(body)]),
      };
    },
  }));
  return calls;
}

function asUser({ role } = {}, fn) {
  return async () => {
    const saved = { DEV_MODE: process.env.DEV_MODE, DEV_ROLE: process.env.DEV_ROLE };
    if (role === undefined) delete process.env.DEV_MODE;
    else { process.env.DEV_MODE = 'true'; process.env.DEV_ROLE = role; }
    try { await fn(); } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
  };
}

describe('GET /social-video/:aspect', () => {
  it('streams the stored video for a known aspect', async () => {
    const calls = stubS3();
    const res = await request(app).get('/social-video/4-5').expect(200);

    assert.strictEqual(res.headers['content-type'], 'video/mp4');
    assert.strictEqual(res.headers['x-content-type-options'], 'nosniff');
    assert.match(res.headers['cache-control'], /public/);
    assert.strictEqual(res.headers['accept-ranges'], 'bytes');
    assert.deepStrictEqual(calls, [{ Bucket: BUCKET, Key: video.VIDEO_KEYS['4-5'] }]);
  });

  // **The assertion that tells a safe handler from a vulnerable one.** A 404 alone proves
  // nothing: a handler that built the key from the request would 404 here too, because the
  // stub holds nothing. What matters is that S3 was never asked at all.
  it('never lets a request-supplied string reach an S3 key', async () => {
    for (const aspect of ['../scorecard.jpg', '..%2Fx', 'tameside-scorecards/1.jpg', '16-9', '']) {
      const calls = stubS3();
      const res = await request(app).get('/social-video/' + encodeURIComponent(aspect));
      assert.ok(res.status === 404, `${aspect} answered ${res.status}`);
      assert.deepStrictEqual(calls, [], `S3 was queried for ${aspect}`);
      mock.restoreAll();
    }
  });

  // Firebase Hosting applies its own max-age to any response that sets no Cache-Control,
  // 404s included — and **Meta retries**. A transient miss (a deploy in flight, a video
  // not generated yet) would be cached and the retry would never see the fix.
  it('never caches a miss', async () => {
    stubS3();
    const unknown = await request(app).get('/social-video/nope').expect(404);
    assert.strictEqual(unknown.headers['cache-control'], 'no-store');

    mock.restoreAll();
    stubS3({ throws: 'NoSuchKey' });
    const missing = await request(app).get('/social-video/4-5').expect(404);
    assert.strictEqual(missing.headers['cache-control'], 'no-store');
  });

  // The type is ours, from the key. Legacy objects in this bucket were uploaded through an
  // unauthenticated /sign-s3 that stored the caller's content type, so one can claim
  // text/html — and echoing that serves attacker-chosen HTML from our own origin,
  // same-origin with the __session cookie.
  it('never echoes the content type S3 reports', async () => {
    stubS3({ declaredType: 'text/html' });
    const res = await request(app).get('/social-video/4-5').expect(200);
    assert.strictEqual(res.headers['content-type'], 'video/mp4');
  });

  // Unauthenticated on purpose, like the league-table and fixtures images: Meta fetches it
  // from Meta's own servers, so anything gated here could never be posted.
  it('is reachable without a session', asUser({}, async () => {
    stubS3();
    await request(app).get('/social-video/4-5').expect(200);
  }));
});

describe('the scheduled endpoints', () => {
  // `secured` redirects an anonymous caller to /login; a scheduler's HTTP client follows
  // the 302, gets a 200 from Auth0 and records a successful run — so an endpoint refusing
  // every request looks green for a year. These answer 404, never a redirect.
  const SCHEDULED = [
    ['post', '/admin/social/weekly-fixtures'],
    ['post', '/admin/social/weekly-video'],
    ['get', '/api/social/generate-weekly-video'],
  ];

  for (const [method, path] of SCHEDULED) {
    it(`${method.toUpperCase()} ${path} refuses an anonymous caller with 404, not a redirect`,
      asUser({}, async () => {
        const res = await request(app)[method](path);
        assert.strictEqual(res.status, 404, `${path} answered ${res.status}`);
      }));

    // An unset token must close the path, not open it. "Empty secret matches empty
    // parameter" is how an unconfigured deploy becomes a public endpoint.
    it(`${method.toUpperCase()} ${path} is inert while its token is unset`, asUser({}, async () => {
      const res = await request(app)[method](path + '?t=');
      assert.strictEqual(res.status, 404);
    }));
  }

  // An ordinary logged-in user is not a superadmin, and the gate is role-based rather than
  // session-based — the Stockport league put 127 club captains into the admin branch by
  // moving roles to the database and found a crash nobody had hit.
  it('refuses a logged-in non-superadmin', asUser({ role: 'none' }, async () => {
    await request(app).post('/admin/social/weekly-video').expect(404);
    await request(app).get('/admin/social/weekly-video').expect(403);
  }));
});

describe('the generate endpoint', () => {
  const withToken = (fn) => async () => {
    const saved = process.env.SOCIAL_WEEKLY_VIDEO_TOKEN;
    process.env.SOCIAL_WEEKLY_VIDEO_TOKEN = 'sekrit';
    try { await fn(); } finally {
      if (saved === undefined) delete process.env.SOCIAL_WEEKLY_VIDEO_TOKEN;
      else process.env.SOCIAL_WEEKLY_VIDEO_TOKEN = saved;
    }
  };

  // **A quiet week must not touch the object.** Overwriting last week's video with an
  // empty one loses it; touching it at all would tell the post handler's freshness check
  // that something was generated this cycle when nothing was.
  it('writes nothing when there are no results', withToken(async () => {
    const calls = stubS3({ throws: 'NotFound' });
    setModel('Fixture', 'getWeekResults', async () => []);

    const res = await request(app).get('/api/social/generate-weekly-video?t=sekrit').expect(404);
    assert.match(res.body.error, /No results in the last seven days/);
    assert.ok(!calls.some(c => c.Body), 'nothing should have been uploaded');
  }));

  it('rejects an unknown aspect before doing any work', withToken(async () => {
    const calls = stubS3();
    const res = await request(app).get('/api/social/generate-weekly-video?t=sekrit&aspect=16-9').expect(400);
    assert.match(res.body.error, /aspect must be one of/);
    assert.deepStrictEqual(calls, []);
  }));

  // A retry, a double-click on the admin button or a scheduler firing twice should not pay
  // for the encode again.
  it('reuses a video generated moments ago', withToken(async () => {
    mock.method(s3util, 's3Client', () => ({
      send: async () => ({ LastModified: new Date(Date.now() - 30_000) }),
    }));
    const res = await request(app).get('/api/social/generate-weekly-video?t=sekrit').expect(200);
    assert.strictEqual(res.body.reused, true);
  }));
});
