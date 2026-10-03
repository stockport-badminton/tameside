// POST /scorecard-ocr/analyse when the card cannot be read.
//
// Three promises, each of which used to be false:
//   - the captain is told something they can act on, never Google's or sharp's own text
//     ("Vision API HTTP 400: {...}", "Input buffer contains unsupported image format");
//   - every failure leaves a log line naming the key, so it can be reproduced from the
//     photo still in the bucket — a failed read used to leave no trace at all;
//   - only a bug reaches Sentry. An expected refusal reported there is how a Sentry
//     project stops being read.
//
// S3 and Vision are never reached: utils/scorecardOcrSource is stubbed at the module the
// controller calls through.

const { describe, it, afterEach, mock } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const Sentry = require('@sentry/node');

const { app, clearModels } = require('../helpers/app');
const ocrSource = require('../../utils/scorecardOcrSource');
const scorecardDocument = require('../../utils/scorecardDocument');
const { OcrFailure } = require('../../utils/ocrFailure');

afterEach(() => { clearModels(); mock.restoreAll(); });

function asCaptain(fn) {
  return async () => {
    const saved = { DEV_MODE: process.env.DEV_MODE, DEV_ROLE: process.env.DEV_ROLE };
    process.env.DEV_MODE = 'true'; process.env.DEV_ROLE = 'none';
    try { await fn(); } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
  };
}

function readFailsWith(err) {
  const keys = [];
  mock.method(ocrSource, 'getVisionForKey', async (key) => { keys.push(key); throw err; });
  return keys;
}

function watch() {
  const sentry = mock.method(Sentry, 'captureException', () => {});
  const logged = [];
  mock.method(console, 'log', (...args) => { logged.push(args.join(' ')); });
  return { sentry, logged };
}

const KEY = 'tameside-ocr-1759500000000.jpg';
const analyse = (body) => request(app).post('/scorecard-ocr/analyse').send(body);

describe('POST /scorecard-ocr/analyse — a card that cannot be read', () => {
  const expected = [
    ['not-a-card', 422, 'Scorecard anchors missing: could not find "events"'],
    ['no-text', 422, 'No text detected in the image.'],
    ['unreadable-image', 422, 'Vision error: Bad image data.'],
    ['busy', 503, 'Resource has been exhausted (e.g. check quota).'],
    ['unavailable', 503, 'Vision request failed: TimeoutError: aborted'],
    ['photo-missing', 422, `No object at ${KEY}`],
    ['hand-drawn', 422, 'Scorecard anchors missing: could not find "events"'],
    ['blank-card', 422, 'Card layout found but no score cells read.'],
  ];
  for (const [kind, status, detail] of expected) {
    it(`${kind}: answers ${status} in plain words, logs the key, and spares Sentry`, asCaptain(async () => {
      readFailsWith(new OcrFailure(kind, detail));
      const { sentry, logged } = watch();
      const res = await analyse({ key: KEY });

      assert.strictEqual(res.status, status);
      assert.strictEqual(res.body.ok, false);
      assert.strictEqual(res.body.kind, kind);
      assert.strictEqual(res.body.error, new OcrFailure(kind).userMessage);
      assert.ok(!res.body.error.includes(detail), 'the technical detail must not reach the captain');

      const line = logged.find((l) => l.startsWith('[ocr] read failed'));
      assert.ok(line, 'a failed read must leave a log line');
      const fields = JSON.parse(line.replace('[ocr] read failed ', ''));
      assert.strictEqual(fields.key, KEY);
      assert.strictEqual(fields.kind, kind);
      assert.strictEqual(fields.detail, detail);

      assert.strictEqual(sentry.mock.callCount(), 0);
    }));
  }

  it('a bug answers 500 with nothing internal, and goes to Sentry', asCaptain(async () => {
    readFailsWith(new Error('relation "player" does not exist'));
    const { sentry, logged } = watch();
    const res = await analyse({ key: KEY });

    assert.strictEqual(res.status, 500);
    assert.strictEqual(res.body.kind, 'error');
    assert.doesNotMatch(res.body.error, /relation|player/);
    assert.strictEqual(sentry.mock.callCount(), 1);
    assert.ok(logged.some((l) => l.startsWith('[ocr] read failed') && l.includes(KEY)));
  }));

  it('a re-analyse after a team pick is marked as one in the log', asCaptain(async () => {
    readFailsWith(new OcrFailure('not-a-card', 'x'));
    const { logged } = watch();
    await analyse({ key: KEY, homeTeamId: '12', awayTeamId: '34' });
    const fields = JSON.parse(logged.find((l) => l.startsWith('[ocr] read failed')).replace('[ocr] read failed ', ''));
    assert.strictEqual(fields.rematch, true);
  }));

  it('a document reads from the extracted photo, and the log names both keys', asCaptain(async () => {
    mock.method(scorecardDocument, 'convertStoredDocument', async () => ({
      key: 'tameside-Hyde B-Shell A-photo.jpg', url: 'https://example.invalid/x.jpg',
    }));
    const keys = readFailsWith(new OcrFailure('no-text'));
    const { logged } = watch();
    const res = await analyse({ key: 'tameside-Hyde B-Shell A.pdf' });

    assert.strictEqual(res.status, 422);
    assert.deepStrictEqual(keys, ['tameside-Hyde B-Shell A-photo.jpg']);
    const fields = JSON.parse(logged.find((l) => l.startsWith('[ocr] read failed')).replace('[ocr] read failed ', ''));
    assert.strictEqual(fields.key, 'tameside-Hyde B-Shell A.pdf');
    assert.strictEqual(fields.imageKey, 'tameside-Hyde B-Shell A-photo.jpg');
  }));

  it('a document that cannot be converted is logged as declined', asCaptain(async () => {
    mock.method(scorecardDocument, 'convertStoredDocument', async () => null);
    const { sentry, logged } = watch();
    const res = await analyse({ key: 'tameside-x.pdf' });
    assert.strictEqual(res.status, 422);
    assert.strictEqual(res.body.kind, 'document-declined');
    assert.ok(logged.some((l) => l.startsWith('[ocr] read failed') && l.includes('document-declined')));
    assert.strictEqual(sentry.mock.callCount(), 0);
  }));

  it('an oversize document keeps its own message and is not a bug', asCaptain(async () => {
    const tooBig = Object.assign(new Error('That file is 40MB, which is too large to read.'), { status: 413 });
    mock.method(scorecardDocument, 'convertStoredDocument', async () => { throw tooBig; });
    const { sentry } = watch();
    const res = await analyse({ key: 'tameside-x.pdf' });
    assert.strictEqual(res.status, 413);
    assert.match(res.body.error, /too large/);
    assert.strictEqual(sentry.mock.callCount(), 0);
  }));
});
