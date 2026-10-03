// The ways reading a scorecard can fail that are NOT bugs, each with what to tell the
// captain. Anything thrown that is not an OcrFailure is a bug: it answers 500 and goes to
// Sentry. These answer 4xx/503 and do not — a Sentry project that fills with "blurry
// photo" stops being read.
//
// `message` stays technical (it is what the log line and the superadmin review page
// show); `userMessage` is what the wizard shows. The two used to be the same string, so a
// captain could be shown "Vision API HTTP 400: {...}" or sharp's "Input buffer contains
// unsupported image format".
//
// User messages are sentence fragments: the wizard appends " — no problem, just continue
// entering below."

const KINDS = {
  // Google's capacity refusal after the retries. See utils/scorecardVision.js.
  busy: {
    status: 503,
    userMessage: 'Google\'s card reader is busy right now, so the card could not be read automatically',
  },
  // Timed out, the network failed, or Google answered with something we cannot use.
  unavailable: {
    status: 503,
    userMessage: 'Google\'s card reader didn\'t answer, so the card could not be read automatically',
  },
  // A file Vision (or sharp, then Vision) could not open as an image.
  'unreadable-image': {
    status: 422,
    userMessage: 'That file couldn\'t be opened as a photo, so the card could not be read automatically. '
      + 'A JPEG or PNG photo of the card works best',
  },
  'no-text': {
    status: 422,
    userMessage: 'No writing could be found in that photo — check it is the scorecard, in focus and not too dark',
  },
  // Text was read, but not the printed layout of our card.
  'not-a-card': {
    status: 422,
    userMessage: 'The printed layout of a Tameside scorecard couldn\'t be found in that photo. '
      + 'Make sure the whole card is in the shot, in focus and not at a steep angle',
  },
  // None of the card's printed words at all: a home-made sheet. A clearer photo won't help.
  'hand-drawn': {
    status: 422,
    userMessage: 'This looks like a hand-drawn scoresheet, and the card reader only works with the '
      + 'printed league scorecard — a clearer photo won\'t help. You can still attach this photo',
  },
  // The printed card, but not a single score on it.
  'blank-card': {
    status: 422,
    userMessage: 'No scores could be read from that card — if it\'s the blank template, choose the '
      + 'photo of the filled-in card instead',
  },
  // The key the wizard sent names no object: its upload did not land.
  'photo-missing': {
    status: 422,
    userMessage: 'The uploaded photo couldn\'t be found, so the card could not be read. Try choosing the photo again',
  },
};

class OcrFailure extends Error {
  constructor(kind, message) {
    if (!KINDS[kind]) throw new Error(`Unknown OCR failure kind: ${kind}`);
    super(message || KINDS[kind].userMessage);
    this.name = 'OcrFailure';
    this.kind = kind;
    this.status = KINDS[kind].status;
    this.userMessage = KINDS[kind].userMessage;
  }
}

const isOcrFailure = (err) => err instanceof OcrFailure;

module.exports = { OcrFailure, isOcrFailure, KINDS };
