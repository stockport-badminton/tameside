// Scorecard image -> Google Vision text detection.
//
// Calls the Vision REST API with a plain API key, so no service-account JSON is
// needed. VISION_API_KEY is a server-only key in Tameside's own project, restricted
// to the Vision API. GMAPSAPIKEY is the fallback only until that is set everywhere:
// it is Stockport's unrestricted 2019 key, rendered into the club pages for Maps, so
// anyone reading page source could spend Vision on it.
// The image is pre-enhanced with sharp (greyscale/normalize/sharpen/contrast),
// the same recipe the Stockport pipeline uses — it measurably improves
// handwriting detection on phone photos.
//
// Kept separate from utils/scorecardExtraction.js (pure, unit-tested) so the
// extraction logic can be tested against cached responses without API calls.

const sharp = require('sharp');
const { OcrFailure } = require('./ocrFailure');

const VISION_ENDPOINT = 'https://vision.googleapis.com/v1/images:annotate';

// Vision answers code 8 RESOURCE_EXHAUSTED when GOOGLE is short of capacity, not only
// when we are over quota. Measured 1 Oct 2026: 7-10 of every 10 calls refused, with the
// project's quotas untouched, from two projects, two billing accounts, API key and OAuth
// alike, on the global, eu and us endpoints, for every feature. Calls that got through
// were interleaved with refusals, so a retry is what helps. The delays keep the worst
// case (four calls plus 7s of waiting) inside the 60s request timeout.
const RETRY_DELAYS_MS = [1000, 2000, 4000];
const RESOURCE_EXHAUSTED = 8;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isCapacityRefusal(httpStatus, json) {
  if (httpStatus === 429 || httpStatus === 503) return true;
  const response = json && json.responses && json.responses[0];
  return !!(response && response.error && response.error.code === RESOURCE_EXHAUSTED);
}

// The whole read — every attempt and every wait — has to finish inside the 60s request
// timeout with room left for S3 and the roster queries. Without a bound a hung call ran
// into the platform's own timeout, whose HTML 504 the wizard could not even parse.
const VISION_BUDGET_MS = 40000;

// A fetch that fails outright (timeout, DNS, reset) comes back as `{ failed }` rather than
// throwing, so the retry loop can tell it apart from an answer it does not like.
async function callVision(body, key, deadline) {
  let res;
  try {
    res = await fetch(`${VISION_ENDPOINT}?key=${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
    });
  } catch (err) {
    return { failed: err };
  }
  const text = await res.text().catch(() => '');
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* reported below */ }
  return { res, text, json };
}

// Downscale monster phone photos (some uploads are 25MB) and normalise format;
// Vision accuracy doesn't need more than ~2000px on the long edge.
async function enhanceImage(buffer) {
  return sharp(buffer)
    .rotate() // honour EXIF orientation before we lose it
    .resize({ width: 2000, height: 2000, fit: 'inside', withoutEnlargement: true })
    .greyscale()
    .normalize()
    .sharpen()
    .linear(1.2, -(128 * 0.2))
    .jpeg({ quality: 90 })
    .toBuffer();
}

// sharp cannot decode everything a phone or scanner produces — a real 11.9MB jpeg on the
// Stockport side failed with `VipsJpeg: Invalid SOS parameters` and Vision read it fine.
// Enhancement only improves the read, so losing it is no reason to lose the read: send the
// original bytes and let Vision decide. If Vision cannot open them either, that is an
// 'unreadable-image' failure with Vision's own reason, which is the honest answer.
async function prepareImage(buffer) {
  try {
    return await enhanceImage(buffer);
  } catch (err) {
    console.log(`[ocr] enhance failed, sending the original bytes to Vision: ${err.message}`);
    return buffer;
  }
}

// Returns the Vision response object for one image (the responses[0] shape the
// extractor consumes). Every expected failure is an OcrFailure (utils/ocrFailure.js),
// whose `message` keeps Google's wording for the log and whose `userMessage` is what a
// captain sees. A plain Error means something is wrong with us — no key, a key Google
// refuses — and is left to reach Sentry.
async function annotateScorecard(buffer, apiKey, { retryDelaysMs = RETRY_DELAYS_MS, budgetMs = VISION_BUDGET_MS } = {}) {
  const key = apiKey || process.env.VISION_API_KEY || process.env.GMAPSAPIKEY;
  if (!key) throw new Error('No Vision API key: set VISION_API_KEY.');

  const image = await prepareImage(buffer);
  const body = JSON.stringify({
    requests: [{
      image: { content: image.toString('base64') },
      features: [{ type: 'DOCUMENT_TEXT_DETECTION' }],
    }],
  });

  const deadline = Date.now() + budgetMs;
  let attempt = await callVision(body, key, deadline);
  for (let i = 0; i < retryDelaysMs.length && !attempt.failed
    && isCapacityRefusal(attempt.res.status, attempt.json); i++) {
    // Leave the last answer standing rather than start an attempt the budget cannot finish.
    if (Date.now() + retryDelaysMs[i] >= deadline) break;
    console.log(`[ocr] Vision refused for capacity, retry ${i + 1} of ${retryDelaysMs.length}`);
    await sleep(retryDelaysMs[i]);
    attempt = await callVision(body, key, deadline);
  }
  if (attempt.failed) {
    // Not retried: a call that hung for the whole budget has no budget left to retry in,
    // and a network failure from Cloud Run to Google is not one a second later fixes.
    const e = attempt.failed;
    throw new OcrFailure('unavailable', `Vision request failed: ${e.name}: ${e.message}`);
  }
  const { res, text, json } = attempt;
  if (!res.ok) {
    const detail = `Vision API HTTP ${res.status}: ${text.slice(0, 300)}`;
    if (isCapacityRefusal(res.status, json)) throw new OcrFailure('busy', detail);
    // 400 is about the request, i.e. the image (too large once sent unenhanced, say).
    if (res.status === 400) throw new OcrFailure('unreadable-image', detail);
    // 401/403 is our key or our project: a bug to fix, not a card to retake.
    if (res.status === 401 || res.status === 403) throw new Error(detail);
    throw new OcrFailure('unavailable', detail);
  }
  if (!json) throw new OcrFailure('unavailable', 'Vision API returned an unreadable response.');
  if (json.error) throw new Error(`Vision API error: ${json.error.status} ${json.error.message}`);
  const response = json.responses && json.responses[0];
  if (!response) throw new OcrFailure('unavailable', 'Vision API returned no response.');
  // Google's own wording ("Resource has been exhausted (e.g. check quota)") reads to a
  // captain as though the site has broken; after the retries it just means busy.
  if (response.error && response.error.code === RESOURCE_EXHAUSTED) {
    throw new OcrFailure('busy', 'Google\'s card reader is busy right now, so the card could not be read automatically'
      + ` (Vision: ${response.error.message})`);
  }
  // Per-image errors are about the image: code 3 "Bad image data" is the usual one.
  if (response.error) throw new OcrFailure('unreadable-image', `Vision error: ${response.error.message}`);
  if (!response.fullTextAnnotation) throw new OcrFailure('no-text', 'No text detected in the image.');
  return response;
}

module.exports = { annotateScorecard, enhanceImage, isCapacityRefusal, VISION_BUDGET_MS };
