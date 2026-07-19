// Scorecard image -> Google Vision text detection.
//
// Calls the Vision REST API with a plain API key (GMAPSAPIKEY — the shared
// Stockport key has Vision access), so no service-account JSON is needed.
// The image is pre-enhanced with sharp (greyscale/normalize/sharpen/contrast),
// the same recipe the Stockport pipeline uses — it measurably improves
// handwriting detection on phone photos.
//
// Kept separate from utils/scorecardExtraction.js (pure, unit-tested) so the
// extraction logic can be tested against cached responses without API calls.

const sharp = require('sharp');

const VISION_ENDPOINT = 'https://vision.googleapis.com/v1/images:annotate';

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
async function annotateScorecard(buffer, apiKey) {
  const key = apiKey || process.env.GMAPSAPIKEY;
  if (!key) throw new Error('No Vision API key: set GMAPSAPIKEY.');

  const enhanced = await enhanceImage(buffer);

  const res = await fetch(`${VISION_ENDPOINT}?key=${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requests: [{
        image: { content: enhanced.toString('base64') },
        features: [{ type: 'DOCUMENT_TEXT_DETECTION' }],
      }],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Vision API HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  const json = await res.json();
  if (json.error) throw new Error(`Vision API error: ${json.error.status} ${json.error.message}`);
  const response = json.responses && json.responses[0];
  if (!response) throw new Error('Vision API returned no response.');
  if (response.error) throw new Error(`Vision error: ${response.error.message}`);
  if (!response.fullTextAnnotation) throw new Error('No text detected in the image.');
  return response;
}

module.exports = { annotateScorecard, enhanceImage };
