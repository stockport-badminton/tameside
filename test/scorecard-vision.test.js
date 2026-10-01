// utils/scorecardVision: which key it uses, and the retry on Google's capacity refusal.
// fetch is stubbed throughout — no Vision call is ever made.
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const sharp = require('sharp');
const vision = require('../utils/scorecardVision');

const NO_DELAY = { retryDelaysMs: [0, 0, 0] };
const exhausted = { responses: [{ error: { code: 8, message: 'Resource has been exhausted (e.g. check quota).' } }] };
const ok = { responses: [{ fullTextAnnotation: { text: 'RESULT' } }] };

let image;
let realFetch;
let calls;
let saved;

function answer(...bodies) {
  calls = [];
  globalThis.fetch = async (url) => {
    calls.push(url);
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

test('gives up after three retries, with a message a captain can read', async () => {
  answer(exhausted);
  await assert.rejects(vision.annotateScorecard(image, undefined, NO_DELAY), (e) => {
    assert.match(e.message, /busy right now/);
    assert.doesNotMatch(e.message, /quota/);
    return true;
  });
  assert.strictEqual(calls.length, 4);
});

test('does not retry an error that is not about capacity', async () => {
  answer({ responses: [{ error: { code: 3, message: 'Bad image data.' } }] });
  await assert.rejects(vision.annotateScorecard(image, undefined, NO_DELAY), /Bad image data/);
  assert.strictEqual(calls.length, 1);
});

test('isCapacityRefusal recognises code 8 in a 200 body', () => {
  assert.ok(vision.isCapacityRefusal(200, exhausted));
  assert.ok(!vision.isCapacityRefusal(200, ok));
});
