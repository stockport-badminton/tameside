// GET /scorecard-photo/:id — the credentialed read path for a scorecard photo.
//
// Tameside and the Stockport league site share ONE S3 bucket. Every object at its root
// was world-readable from a per-object ACL, and our photos were rendered straight from
// the bucket with the public URL stored in `scorecardstore."scoresheet-url"` and pasted
// into the results-secretary email — so the authorization on a photo of a match was
// "know the URL", forever, for anyone that email was forwarded to. Stockport is now
// stripping those ACLs, which is what forces this route to exist.
//
// Three properties are worth a test, because getting any of them wrong turns the fix into
// a worse bug than the one it replaces:
//
//   1. The route is keyed by ROW ID, and the row decides the object. There is no way to
//      name an object in the request.
//   2. It refuses rows that are not ours. 817 of the 1,139 photo rows in this table were
//      inherited when `scorecardstore` was cloned from Stockport's database and point at
//      THEIR objects at the shared bucket root. Serving one would leak another league's
//      scorecard out of our own origin.
//   3. The content type comes from the extension, never from what S3 reports. These
//      objects were uploaded through a /sign-s3 that was unauthenticated and took the
//      caller's content type, so a legacy object can claim `text/html` — and echoing that
//      back would serve attacker-chosen HTML same-origin with the __session cookie.

const { describe, it, afterEach, mock } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { Readable } = require('node:stream');

const { app, setModel, clearModels } = require('../helpers/app');
const s3util = require('../../utils/s3');

afterEach(() => { clearModels(); mock.restoreAll(); });

const BUCKET = process.env.S3_BUCKET_NAME; // 'test-bucket', from the helper

// Same reasoning as test/integration/auth-gating.test.js: the mock identity is driven by
// process-global env vars, so each test states the identity it runs as rather than using
// before/after hooks, which would race across describe blocks.
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
const LOGGED_IN = { role: 'none' };

// A scorecardstore row as getScorecardById returns it (an array of rows).
const rowWith = (url) => (id, done) => done(null, [{ id: Number(id), 'scoresheet-url': url }]);

// Stub S3 and record what was asked for. `declaredType` is what the object claims.
function stubS3({ declaredType = 'image/jpeg', body = 'JPEGBYTES', throws = null } = {}) {
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

describe('GET /scorecard-photo/:id — gating', () => {
  it('redirects an anonymous caller to login', asUser({}, async () => {
    const res = await request(app).get('/scorecard-photo/1800');
    assert.strictEqual(res.status, 302);
    assert.match(res.headers.location, /\/login/);
  }));

  it('never reaches S3 for an anonymous caller', asUser({}, async () => {
    const calls = stubS3();
    setModel('Fixture', 'getScorecardById',
      rowWith(`https://${BUCKET}.s3.eu-west-1.amazonaws.com/tameside-x.jpg`));
    await request(app).get('/scorecard-photo/1800');
    assert.deepStrictEqual(calls, []);
  }));

  it('404s a non-numeric id at the router, before any query runs', asUser(LOGGED_IN, async () => {
    let queried = false;
    setModel('Fixture', 'getScorecardById', (id, done) => { queried = true; done(null, []); });
    const res = await request(app).get('/scorecard-photo/notanid');
    assert.strictEqual(res.status, 404);
    assert.strictEqual(queried, false, 'a text id must not reach Postgres as an integer comparison');
  }));
});

describe('GET /scorecard-photo/:id — which objects it will serve', () => {
  it('serves one of ours, deriving the key from the row', asUser(LOGGED_IN, async () => {
    const calls = stubS3();
    setModel('Fixture', 'getScorecardById',
      rowWith(`https://${BUCKET}.s3.eu-west-1.amazonaws.com/tameside-20252026-GHAP+B-Shell+A.jpg`));
    const res = await request(app).get('/scorecard-photo/1800');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].Bucket, BUCKET);
    // `+` in the stored URL is a space in the real key — GetObject takes the key
    // literally, so without that translation every photo from the `+` era 404s.
    assert.strictEqual(calls[0].Key, 'tameside-20252026-GHAP B-Shell A.jpg');
  }));

  it('404s an inherited Stockport row without touching S3', asUser(LOGGED_IN, async () => {
    const calls = stubS3();
    // ids 878-1757 in the real table look exactly like this.
    setModel('Fixture', 'getScorecardById',
      rowWith(`https://${BUCKET}.s3-eu-west-1.amazonaws.com/College%20Green%20A-GHAP%20A.jpg`));
    const res = await request(app).get('/scorecard-photo/1545');
    assert.strictEqual(res.status, 404);
    assert.deepStrictEqual(calls, [], 'another league\'s object must not even be requested');
  }));

  it('404s a row whose url points at a different bucket', asUser(LOGGED_IN, async () => {
    const calls = stubS3();
    setModel('Fixture', 'getScorecardById', rowWith('https://evil.example.com/tameside-x.jpg'));
    assert.strictEqual((await request(app).get('/scorecard-photo/1800')).status, 404);
    assert.deepStrictEqual(calls, []);
  }));

  it('404s the rows holding the literal string "undefined"', asUser(LOGGED_IN, async () => {
    setModel('Fixture', 'getScorecardById', rowWith('undefined'));
    assert.strictEqual((await request(app).get('/scorecard-photo/1749')).status, 404);
  }));

  it('404s a row with no photo, and a missing row', asUser(LOGGED_IN, async () => {
    setModel('Fixture', 'getScorecardById', rowWith(''));
    assert.strictEqual((await request(app).get('/scorecard-photo/1800')).status, 404);
    setModel('Fixture', 'getScorecardById', (id, done) => done(null, []));
    assert.strictEqual((await request(app).get('/scorecard-photo/999999')).status, 404);
  }));

  it('404s rather than 500s when the object is gone from the bucket', asUser(LOGGED_IN, async () => {
    // One real row (id 1767) already points at an object that is not there. A photo that
    // has gone astray must not take the page with it, or spend a Sentry event.
    stubS3({ throws: 'NoSuchKey' });
    setModel('Fixture', 'getScorecardById',
      rowWith(`https://${BUCKET}.s3.eu-west-1.amazonaws.com/tameside-Manor+B-Aerospace+C.jpg`));
    assert.strictEqual((await request(app).get('/scorecard-photo/1767')).status, 404);
  }));
});

describe('GET /scorecard-photo/:id — response headers', () => {
  it('ignores the content type S3 reports and uses the extension', asUser(LOGGED_IN, async () => {
    // THE test. /sign-s3 was unauthenticated and stored the caller's content type, so a
    // legacy object can claim anything. Reflecting it would serve HTML from our own
    // origin, same-origin with the session cookie — worse than serving it from S3.
    stubS3({ declaredType: 'text/html' });
    setModel('Fixture', 'getScorecardById',
      rowWith(`https://${BUCKET}.s3.eu-west-1.amazonaws.com/tameside-x.jpg`));
    const res = await request(app).get('/scorecard-photo/1800');
    assert.strictEqual(res.status, 200);
    assert.match(res.headers['content-type'], /^image\/jpeg/);
    assert.strictEqual(res.headers['x-content-type-options'], 'nosniff');
  }));

  it('serves an image inline', asUser(LOGGED_IN, async () => {
    stubS3();
    setModel('Fixture', 'getScorecardById',
      rowWith(`https://${BUCKET}.s3.eu-west-1.amazonaws.com/tameside-x.jpg`));
    const res = await request(app).get('/scorecard-photo/1800');
    assert.strictEqual(res.headers['content-disposition'], 'inline');
  }));

  it('serves a PDF as an attachment, never inline', asUser(LOGGED_IN, async () => {
    // 40 of our 322 photos are PDFs. An inline PDF renders in our origin and PDFs can
    // carry script; an attachment is saved and nothing executes.
    stubS3({ declaredType: 'application/pdf', body: '%PDF-1.4' });
    setModel('Fixture', 'getScorecardById',
      rowWith(`https://${BUCKET}.s3.eu-west-1.amazonaws.com/tameside-Mellor+A-Mellor+B.pdf`));
    const res = await request(app).get('/scorecard-photo/1800');
    assert.strictEqual(res.status, 200);
    assert.match(res.headers['content-type'], /^application\/pdf/);
    assert.match(res.headers['content-disposition'], /^attachment; filename="tameside-Mellor A-Mellor B\.pdf"$/);
  }));

  it('marks the response private, because a session is the authorization', asUser(LOGGED_IN, async () => {
    stubS3();
    setModel('Fixture', 'getScorecardById',
      rowWith(`https://${BUCKET}.s3.eu-west-1.amazonaws.com/tameside-x.jpg`));
    const res = await request(app).get('/scorecard-photo/1800');
    // A shared cache holding this would hand one person's scorecard to the next caller.
    assert.match(res.headers['cache-control'], /private/);
  }));

  it('404s an object whose extension is not a photo or a document', asUser(LOGGED_IN, async () => {
    const calls = stubS3({ declaredType: 'image/jpeg' });
    setModel('Fixture', 'getScorecardById',
      rowWith(`https://${BUCKET}.s3.eu-west-1.amazonaws.com/tameside-x.html`));
    assert.strictEqual((await request(app).get('/scorecard-photo/1800')).status, 404);
    assert.deepStrictEqual(calls, [], 'decided before the fetch, so no bytes are paid for');
  }));
});

describe('/sign-s3 no longer mints world-readable objects', () => {
  it('requires a session', asUser({}, async () => {
    // It was unauthenticated, presigning a PUT with a caller-chosen key into a bucket
    // shared with the other league — i.e. anyone could write any object anywhere in it.
    const res = await request(app).get('/sign-s3?file-name=x.jpg&file-type=image/jpeg');
    assert.strictEqual(res.status, 302);
    assert.match(res.headers.location, /\/login/);
  }));

  it('does not sign a public-read ACL', asUser(LOGGED_IN, async () => {
    // The read path above is only durable if new uploads stop being public: Stockport's
    // ACL sweep is one-off, so while this was here the bucket would drift back to
    // world-readable one scorecard at a time.
    const res = await request(app).get('/sign-s3?file-name=tameside-x.jpg&file-type=image%2Fjpeg');
    assert.strictEqual(res.status, 200);
    const signed = res.body.signedUrl;
    assert.ok(signed, 'expected a signed url');
    assert.ok(!/x-amz-acl/i.test(signed), 'presigned PUT must not carry an ACL: ' + signed);
  }));
});
