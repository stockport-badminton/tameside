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

async function callVision(body, key) {
  const res = await fetch(`${VISION_ENDPOINT}?key=${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
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

// Returns the Vision response object for one image (the responses[0] shape the
// extractor consumes). Throws with a useful message on API or detection errors.
async function annotateScorecard(buffer, apiKey, { retryDelaysMs = RETRY_DELAYS_MS } = {}) {
  const key = apiKey || process.env.VISION_API_KEY || process.env.GMAPSAPIKEY;
  if (!key) throw new Error('No Vision API key: set VISION_API_KEY.');

  const enhanced = await enhanceImage(buffer);
  const body = JSON.stringify({
    requests: [{
      image: { content: enhanced.toString('base64') },
      features: [{ type: 'DOCUMENT_TEXT_DETECTION' }],
    }],
  });

  let attempt = await callVision(body, key);
  for (let i = 0; i < retryDelaysMs.length && isCapacityRefusal(attempt.res.status, attempt.json); i++) {
    console.log(`[ocr] Vision refused for capacity, retry ${i + 1} of ${retryDelaysMs.length}`);
    await sleep(retryDelaysMs[i]);
    attempt = await callVision(body, key);
  }
  const { res, text, json } = attempt;
  if (!res.ok) throw new Error(`Vision API HTTP ${res.status}: ${text.slice(0, 300)}`);
  if (!json) throw new Error('Vision API returned an unreadable response.');
  if (json.error) throw new Error(`Vision API error: ${json.error.status} ${json.error.message}`);
  const response = json.responses && json.responses[0];
  if (!response) throw new Error('Vision API returned no response.');
  // Google's own wording ("Resource has been exhausted (e.g. check quota)") reads to a
  // captain as though the site has broken; after the retries it just means busy.
  if (response.error && response.error.code === RESOURCE_EXHAUSTED) {
    throw new Error('Google\'s card reader is busy right now, so the card could not be read automatically');
  }
  if (response.error) throw new Error(`Vision error: ${response.error.message}`);
  if (!response.fullTextAnnotation) throw new Error('No text detected in the image.');
  return response;
}

module.exports = { annotateScorecard, enhanceImage, isCapacityRefusal };
