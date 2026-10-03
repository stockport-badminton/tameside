// utils/scorecardVision: which key it uses, and the retry on Google's capacity refusal.
// fetch is stubbed throughout — no Vision call is ever made.
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const sharp = require('sharp');
const vision = require('../utils/scorecardVision');
const { isOcrFailure } = require('../utils/ocrFailure');

const NO_DELAY = { retryDelaysMs: [0, 0, 0] };
const exhausted = { responses: [{ error: { code: 8, message: 'Resource has been exhausted (e.g. check quota).' } }] };
const ok = { responses: [{ fullTextAnnotation: { text: 'RESULT' } }] };

let image;
let realFetch;
let calls;
let sent;
let saved;

function answer(...bodies) {
  calls = [];
  sent = [];
  globalThis.fetch = async (url, opts) => {
    calls.push(url);
    sent.push(JSON.parse(opts.body));
    const b = bodies[Math.min(calls.length - 1, bodies.length - 1)];
    const status = typeof b === 'number' ? b : 200;
    const text = typeof b === 'number' ? '' : JSON.stringify(b);
    return { ok: status < 400, status, text: async () => text };
  };
}

beforeEach(async () => {
  image = image || await sharp({ create: { width: 4, height: 4, channels: 3, background: '#fff' } }).png().toBuffer();
  realFetch = globalThis.fetch;
  saved = { VISION_API_KEY: process.env.VISION_API_KEY, GMAPSAPIKEY: process.env.GMAPSAPIKEY };
  process.env.VISION_API_KEY = 'vision-key';
  process.env.GMAPSAPIKEY = 'maps-key';
});

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

test('uses VISION_API_KEY, not the browser Maps key', async () => {
  answer(ok);
  await vision.annotateScorecard(image, undefined, NO_DELAY);
  assert.match(calls[0], /key=vision-key/);
});

test('falls back to GMAPSAPIKEY while VISION_API_KEY is unset', async () => {
  delete process.env.VISION_API_KEY;
  answer(ok);
  await vision.annotateScorecard(image, undefined, NO_DELAY);
  assert.match(calls[0], /key=maps-key/);
});

test('retries a RESOURCE_EXHAUSTED and returns the answer that gets through', async () => {
  answer(exhausted, exhausted, ok);
  const r = await vision.annotateScorecard(image, undefined, NO_DELAY);
  assert.strictEqual(r.fullTextAnnotation.text, 'RESULT');
  assert.strictEqual(calls.length, 3);
});

test('retries HTTP 429 and 503', async () => {
  answer(429, 503, ok);
  await vision.annotateScorecard(image, undefined, NO_DELAY);
  assert.strictEqual(calls.length, 3);
});

// What a captain sees is `userMessage`; `message` keeps Google's wording for the log.
const failsAs = (kind) => (e) => {
  assert.ok(isOcrFailure(e), `expected an OcrFailure, got ${e && e.stack}`);
  assert.strictEqual(e.kind, kind);
  return true;
};

test('gives up after three retries, with a message a captain can read', async () => {
  answer(exhausted);
  await assert.rejects(vision.annotateScorecard(image, undefined, NO_DELAY), (e) => {
    failsAs('busy')(e);
    assert.match(e.userMessage, /busy right now/);
    assert.doesNotMatch(e.userMessage, /quota/);
    assert.match(e.message, /quota/, 'the log line keeps what Google actually said');
    return true;
  });
  assert.strictEqual(calls.length, 4);
});

test('does not retry an error that is not about capacity', async () => {
  answer({ responses: [{ error: { code: 3, message: 'Bad image data.' } }] });
  await assert.rejects(vision.annotateScorecard(image, undefined, NO_DELAY), (e) => {
    failsAs('unreadable-image')(e);
    assert.match(e.message, /Bad image data/);
    return true;
  });
  assert.strictEqual(calls.length, 1);
});

test('a card with no text is a no-text failure, not a bug', async () => {
  answer({ responses: [{}] });
  await assert.rejects(vision.annotateScorecard(image, undefined, NO_DELAY), failsAs('no-text'));
});

test('an HTTP 400 is about the image; Google\'s JSON never reaches the captain', async () => {
  answer(400);
  await assert.rejects(vision.annotateScorecard(image, undefined, NO_DELAY), (e) => {
    failsAs('unreadable-image')(e);
    assert.doesNotMatch(e.userMessage, /HTTP|Vision API/);
    return true;
  });
});

// A refused key is ours to fix, so it must stay a plain Error and reach Sentry.
test('a 403 is a plain Error, not an OcrFailure', async () => {
  answer(403);
  await assert.rejects(vision.annotateScorecard(image, undefined, NO_DELAY), (e) => {
    assert.ok(!isOcrFailure(e));
    assert.match(e.message, /HTTP 403/);
    return true;
  });
});

test('a call that times out or fails on the network is unavailable, and not retried', async () => {
  calls = [];
  globalThis.fetch = async (url) => {
    calls.push(url);
    const e = new Error('The operation was aborted due to timeout');
    e.name = 'TimeoutError';
    throw e;
  };
  await assert.rejects(vision.annotateScorecard(image, undefined, NO_DELAY), (e) => {
    failsAs('unavailable')(e);
    assert.match(e.message, /TimeoutError/);
    return true;
  });
  assert.strictEqual(calls.length, 1);
});

test('every call carries a timeout signal', async () => {
  let signal;
  globalThis.fetch = async (url, opts) => {
    signal = opts.signal;
    return { ok: true, status: 200, text: async () => JSON.stringify(ok) };
  };
  await vision.annotateScorecard(image, undefined, NO_DELAY);
  assert.ok(signal instanceof AbortSignal);
});

test('stops retrying when the next wait would overrun the budget', async () => {
  answer(exhausted);
  await assert.rejects(
    vision.annotateScorecard(image, undefined, { retryDelaysMs: [60000, 60000, 60000], budgetMs: 1000 }),
    failsAs('busy'));
  assert.strictEqual(calls.length, 1);
});

test('the budget leaves room inside the 60s request timeout', () => {
  assert.ok(vision.VISION_BUDGET_MS <= 45000);
});

// Stockport had a real 11.9MB jpeg that sharp refused (`VipsJpeg: Invalid SOS
// parameters`) and Vision read fine. Losing the enhancement is no reason to lose the read.
test('when sharp cannot decode the file, the original bytes go to Vision', async () => {
  const notAnImageSharpKnows = Buffer.from('definitely not an image');
  answer(ok);
  const r = await vision.annotateScorecard(notAnImageSharpKnows, undefined, NO_DELAY);
  assert.strictEqual(r.fullTextAnnotation.text, 'RESULT');
  assert.strictEqual(sent[0].requests[0].image.content, notAnImageSharpKnows.toString('base64'));
});

test('isCapacityRefusal recognises code 8 in a 200 body', () => {
  assert.ok(vision.isCapacityRefusal(200, exhausted));
  assert.ok(!vision.isCapacityRefusal(200, ok));
});
