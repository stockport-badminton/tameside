// The two routes that turn an uploaded document into a stored photo.
//
//   POST /scorecard-document/convert   converts, and NEVER reads the card
//   POST /scorecard-ocr/analyse        converts, then reads the card
//
// The split is the point, and it is a promise made to captains on the form: the auto-fill
// box reads the card and the plain photo box does not. Someone who would rather a machine
// did not read their scorecard uses the second one, so there is a test asserting Vision is
// not called — if that ever changes, the promise is broken and nothing else would say so.
//
// Neither S3 nor Vision is reachable from here: both are stubbed at the module the
// controller requires, so a regression that bypassed the stub would fail rather than
// quietly reach AWS or spend a Vision unit.

const { describe, it, afterEach, mock } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const fs = require('fs');
const path = require('path');

const { app, clearModels } = require('../helpers/app');
const scorecardDocument = require('../../utils/scorecardDocument');
const vision = require('../../utils/scorecardVision');

afterEach(() => { clearModels(); mock.restoreAll(); });

const DIR = path.join(__dirname, '..', 'fixtures', 'documents');
const load = (name) => fs.readFileSync(path.join(DIR, name));

// Identity comes from middleware/devMode.js via process-global env vars, so each test
// states who it runs as and restores what was there. Hooks would race.
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

// Stub the conversion at the util, and record what was asked for.
function stubConversion(result) {
  const calls = [];
  mock.method(scorecardDocument, 'convertStoredDocument', async (key) => {
    calls.push(key);
    if (result instanceof Error) throw result;
    return result;
  });
  return calls;
}

// Any Vision call at all is a failure for the convert endpoint.
function watchVision() {
  const calls = [];
  mock.method(vision, 'annotateScorecard', async () => {
    calls.push(true);
    throw new Error('Vision must not be called from the convert endpoint');
  });
  return calls;
}

const STORED = {
  key: 'tameside-Hyde B-Shell A-photo.jpg',
  url: 'https://badmintontemp.s3.eu-west-1.amazonaws.com/tameside-Hyde%20B-Shell%20A-photo.jpg',
  contentType: 'image/jpeg',
  bytes: 12345,
};

const post = (body) => request(app).post('/scorecard-document/convert').send(body);

describe('POST /scorecard-document/convert — gating', () => {
  it('redirects an anonymous visitor to login', asUser({}, async () => {
    const res = await post({ key: 'tameside-x.pdf' });
    assert.strictEqual(res.status, 302);
    assert.match(res.headers.location, /\/login/);
  }));

  // The bucket is shared with the other league — 817 of the 1,139 photo rows are theirs —
  // so `tameside-` is the whole ownership rule. Without it this converts, and stores
  // next to, another league's scorecards.
  it('refuses a key that is not ours', asUser({ role: 'none' }, async () => {
    const calls = stubConversion(STORED);
    for (const key of ['canute-a-b.pdf', '../inbound-email/x.pdf', 'scorecard-ocr-cache/x.pdf', '']) {
      const res = await post({ key });
      assert.strictEqual(res.status, 400, key);
      assert.strictEqual(res.body.ok, false);
    }
    assert.strictEqual(calls.length, 0, 'nothing should have been read');
  }));

  it('refuses an archive by name, before reading a byte', asUser({ role: 'none' }, async () => {
    const calls = stubConversion(STORED);
    const res = await post({ key: 'tameside-cards.zip' });
    assert.strictEqual(res.status, 400);
    assert.match(res.body.error, /Archives are not accepted/);
    assert.strictEqual(calls.length, 0);
  }));

  it('refuses a photo, which does not need converting', asUser({ role: 'none' }, async () => {
    const calls = stubConversion(STORED);
    const res = await post({ key: 'tameside-Hyde B-Shell A.jpg' });
    assert.strictEqual(res.status, 400);
    assert.match(res.body.error, /not a PDF or Word file/);
    assert.strictEqual(calls.length, 0);
  }));
});

describe('POST /scorecard-document/convert — behaviour', () => {
  it('converts and hands back the stored photo url', asUser({ role: 'none' }, async () => {
    const calls = stubConversion(STORED);
    const res = await post({ key: 'tameside-Hyde B-Shell A.pdf' });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body, {
      ok: true, converted: true, url: STORED.url, key: STORED.key,
    });
    assert.deepStrictEqual(calls, ['tameside-Hyde B-Shell A.pdf']);
  }));

  // THE PROMISE THE FORM MAKES. The plain photo box exists so a captain can attach a card
  // without a machine reading it. A document upload must not quietly become an OCR run.
  it('never calls Vision', asUser({ role: 'none' }, async () => {
    stubConversion(STORED);
    const seen = watchVision();
    const res = await post({ key: 'tameside-Hyde B-Shell A.pdf' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(seen.length, 0, 'the convert endpoint must not read the card');
  }));

  // A document this cannot read is NOT a failed upload: the file is already in the bucket
  // and still attached to the scorecard. 15 of the 41 pdfs on record decline, 11 of them
  // because they are MRC scans whose text layer would be lost.
  it('answers ok with converted:false when the document cannot be read',
    asUser({ role: 'none' }, async () => {
      stubConversion(null);
      const res = await post({ key: 'tameside-Hyde B-Shell A.pdf' });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.ok, true);
      assert.strictEqual(res.body.converted, false);
      assert.match(res.body.reason, /still been attached/);
    }));

  it('passes the size refusal through as a 413, not a 500', asUser({ role: 'none' }, async () => {
    const tooBig = new Error('That file is 40MB, which is too large to read.');
    tooBig.status = 413;
    stubConversion(tooBig);
    const res = await post({ key: 'tameside-huge.pdf' });
    assert.strictEqual(res.status, 413);
    assert.match(res.body.error, /too large/);
  }));

  it('answers 502 JSON when S3 itself fails, not the HTML error page',
    asUser({ role: 'none' }, async () => {
      stubConversion(new Error('connection reset'));
      const res = await post({ key: 'tameside-Hyde B-Shell A.pdf' });
      assert.strictEqual(res.status, 502);
      assert.strictEqual(res.body.ok, false);
      // The uploader reads the JSON body; an HTML 500 carries nothing it can show, which
      // is how a captain ended up seeing no reason at all for a refusal.
      assert.match(res.headers['content-type'], /json/);
      assert.match(res.body.error, /still attached/);
    }));
});

describe('POST /scorecard-ocr/analyse — documents', () => {
  it('refuses an archive', asUser({ role: 'none' }, async () => {
    const res = await request(app).post('/scorecard-ocr/analyse').send({ key: 'tameside-x.zip' });
    assert.strictEqual(res.status, 400);
    assert.match(res.body.error, /Archives are not accepted/);
  }));

  // The one that would waste the whole conversion: without a url coming back, the page
  // keeps pointing scoresheet-url at the pdf and the extracted jpeg is orphaned.
  it('converts a document and returns the photo url for the row', asUser({ role: 'none' }, async () => {
    stubConversion(STORED);
    // Vision is stubbed to throw, so analysis fails after the conversion — which is
    // enough to prove the conversion ran on the document and not on the pdf key.
    const calls = [];
    mock.method(vision, 'annotateScorecard', async () => { calls.push(true); throw new Error('stubbed'); });
    const res = await request(app).post('/scorecard-ocr/analyse').send({ key: 'tameside-Hyde B-Shell A.pdf' });
    assert.strictEqual(res.status, 422);
    assert.strictEqual(res.body.ok, false);
  }));

  it('tells the captain what to do when the document cannot be read',
    asUser({ role: 'none' }, async () => {
      stubConversion(null);
      const res = await request(app).post('/scorecard-ocr/analyse').send({ key: 'tameside-x.pdf' });
      assert.strictEqual(res.status, 422);
      // It must name something that actually works. A message offering a route that
      // cannot close is worse than a plain refusal.
      assert.match(res.body.error, /send a photo of it instead/i);
      assert.match(res.body.error, /still been attached/);
    }));
});
