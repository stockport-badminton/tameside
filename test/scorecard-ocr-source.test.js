// utils/scorecardOcrSource: the Vision-response cache and the photo read, against a fake
// S3. Vision itself is stubbed — nothing here reaches AWS or Google.

const { test, afterEach, mock } = require('node:test');
const assert = require('node:assert');
const { GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');

const ocrSource = require('../utils/scorecardOcrSource');
const vision = require('../utils/scorecardVision');
const { isOcrFailure } = require('../utils/ocrFailure');

afterEach(() => mock.restoreAll());

const KEY = 'tameside-ocr-1.jpg';
const RESPONSE = { fullTextAnnotation: { text: 'RESULT' } };

const notFound = () => Object.assign(new Error('The specified key does not exist.'), { name: 'NoSuchKey' });
const body = (s) => ({ Body: { transformToByteArray: async () => Buffer.from(s) } });

// objects: key -> string | Error. Records every command sent.
function fakeS3(objects) {
  const sent = [];
  return {
    sent,
    send: async (cmd) => {
      sent.push(cmd);
      if (cmd instanceof PutObjectCommand) return {};
      assert.ok(cmd instanceof GetObjectCommand);
      const v = objects[cmd.input.Key];
      if (v === undefined) throw notFound();
      if (v instanceof Error) throw v;
      return body(v);
    },
  };
}

function quietLog() {
  const logged = [];
  mock.method(console, 'log', (...a) => { logged.push(a.join(' ')); });
  return logged;
}

test('a cached response is used and Vision is not called', async () => {
  const annotate = mock.method(vision, 'annotateScorecard', async () => RESPONSE);
  const s3 = fakeS3({ [ocrSource.visionCacheKey(KEY)]: JSON.stringify(RESPONSE) });
  assert.deepStrictEqual(await ocrSource.getVisionForKey(KEY, { s3 }), RESPONSE);
  assert.strictEqual(annotate.mock.callCount(), 0);
});

test('an ordinary cache miss reads the photo, writes the cache, and logs nothing', async () => {
  const logged = quietLog();
  mock.method(vision, 'annotateScorecard', async () => RESPONSE);
  const s3 = fakeS3({ [KEY]: 'jpeg bytes' });
  assert.deepStrictEqual(await ocrSource.getVisionForKey(KEY, { s3 }), RESPONSE);
  await new Promise((r) => setImmediate(r));
  assert.ok(s3.sent.some((c) => c instanceof PutObjectCommand && c.input.Key === ocrSource.visionCacheKey(KEY)));
  assert.deepStrictEqual(logged, []);
});

// A cache that silently stopped working would quietly double the Vision bill.
test('a cache read that fails for any other reason is logged, and the read carries on', async () => {
  const logged = quietLog();
  mock.method(vision, 'annotateScorecard', async () => RESPONSE);
  const denied = Object.assign(new Error('Access Denied'), { name: 'AccessDenied' });
  const s3 = fakeS3({ [ocrSource.visionCacheKey(KEY)]: denied, [KEY]: 'jpeg bytes' });
  assert.deepStrictEqual(await ocrSource.getVisionForKey(KEY, { s3 }), RESPONSE);
  assert.ok(logged.some((l) => /vision cache read failed/.test(l) && l.includes(KEY)));
});

test('a corrupt cache entry is logged and read past', async () => {
  const logged = quietLog();
  mock.method(vision, 'annotateScorecard', async () => RESPONSE);
  const s3 = fakeS3({ [ocrSource.visionCacheKey(KEY)]: '{not json', [KEY]: 'jpeg bytes' });
  assert.deepStrictEqual(await ocrSource.getVisionForKey(KEY, { s3 }), RESPONSE);
  assert.ok(logged.some((l) => /vision cache read failed/.test(l)));
});

test('a failed cache write is logged, not thrown', async () => {
  const logged = quietLog();
  mock.method(vision, 'annotateScorecard', async () => RESPONSE);
  const s3 = fakeS3({ [KEY]: 'jpeg bytes' });
  const realSend = s3.send;
  s3.send = async (cmd) => {
    if (cmd instanceof PutObjectCommand) throw new Error('SlowDown');
    return realSend(cmd);
  };
  assert.deepStrictEqual(await ocrSource.getVisionForKey(KEY, { s3 }), RESPONSE);
  await new Promise((r) => setImmediate(r));
  assert.ok(logged.some((l) => /vision cache write failed/.test(l)));
});

test('a photo that is not in the bucket is photo-missing, which the captain can fix', async () => {
  quietLog();
  const s3 = fakeS3({});
  await assert.rejects(ocrSource.getVisionForKey(KEY, { s3 }), (e) => {
    assert.ok(isOcrFailure(e));
    assert.strictEqual(e.kind, 'photo-missing');
    return true;
  });
});

test('any other S3 failure on the photo is ours, so it stays a plain Error', async () => {
  quietLog();
  const denied = Object.assign(new Error('Access Denied'), { name: 'AccessDenied' });
  const s3 = fakeS3({ [KEY]: denied });
  await assert.rejects(ocrSource.getVisionForKey(KEY, { s3 }), (e) => !isOcrFailure(e) && /Access Denied/.test(e.message));
});
