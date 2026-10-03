// Where the Vision response for an uploaded scorecard comes from: the S3 cache beside the
// upload, or a fresh read of the photo. One Vision call per uploaded photo, ever — the
// cached response is what lets a re-analyse (after the captain picks the teams the header
// couldn't identify) re-map the SAME detection instead of re-reading the card.
//
// Its own module, called through rather than destructured, so the route tests can stub
// it and never reach S3 or spend a Vision unit. Before this the analyse tests only stayed
// off AWS because the test credentials happened to fail.
//
// A cache that fails is never a failed read, but it is logged: a cache that silently
// stopped working would quietly double the Vision bill and nothing would say so.

const { GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const { s3Client } = require('./s3');
// The module, not its members — see the note in controllers/scorecardOcrController.js.
const vision = require('./scorecardVision');
const { OcrFailure } = require('./ocrFailure');

const BUCKET = process.env.S3_BUCKET_NAME || 'badmintontemp';

const visionCacheKey = (key) => `scorecard-ocr-cache/${key}.vision.json`;

const isNoSuchKey = (err) => !!err && (err.name === 'NoSuchKey'
  || (err.$metadata && err.$metadata.httpStatusCode === 404));

async function readCache(s3, key) {
  try {
    const cached = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: visionCacheKey(key) }));
    return JSON.parse(Buffer.from(await cached.Body.transformToByteArray()).toString());
  } catch (err) {
    if (!isNoSuchKey(err)) console.log(`[ocr] vision cache read failed for ${key}: ${err.name}: ${err.message}`);
    return null;
  }
}

async function getVisionForKey(key, deps = {}) {
  const s3 = deps.s3 || s3Client();
  const cached = await readCache(s3, key);
  if (cached) return cached;

  let obj;
  try {
    obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  } catch (err) {
    // The wizard PUTs the photo and then names it here, so a missing object means the
    // upload did not land — something the captain can fix by trying again. Anything else
    // (credentials, S3 down) is ours, and is left to reach Sentry.
    if (isNoSuchKey(err)) throw new OcrFailure('photo-missing', `No object at ${key}`);
    throw err;
  }
  const buffer = Buffer.from(await obj.Body.transformToByteArray());
  const annotated = await vision.annotateScorecard(buffer);
  // Not awaited — the read shouldn't wait for, or fail on, the cache write.
  s3.send(new PutObjectCommand({
    Bucket: BUCKET, Key: visionCacheKey(key),
    Body: JSON.stringify(annotated), ContentType: 'application/json',
  })).catch((err) => console.log(`[ocr] vision cache write failed for ${key}: ${err.name}: ${err.message}`));
  return annotated;
}

module.exports = { getVisionForKey, visionCacheKey };
