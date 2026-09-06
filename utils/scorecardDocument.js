// Turning an uploaded document scorecard into a stored photo.
//
// The extraction itself is utils/documentImage.js. This is the part that is specific to
// how Tameside uploads: the browser has already PUT the file into the bucket through the
// presigned url from `/sign-s3`, so what arrives here is a KEY, not bytes.
//
// That is worth stating because the sister site does it the other way round — Stockport
// POSTs the file to a multer endpoint and stores the extracted image server-side, because
// their `/sign-s3` allows images only so a document can never reach their bucket. Ours
// takes the client's content type, which is how 41 PDFs are in there. Reading the object
// back costs one GET and means:
//
//   - no multer, no new dependency, and no path where the app proxies a large upload;
//   - the ORIGINAL DOCUMENT IS KEPT. It is already in the bucket by the time anything
//     here runs, and it is the thing the captain actually filed. If the extraction is
//     ever found to have dropped something (see the MRC note in documentImage.js for why
//     that is a live concern), the original is still there to go back to.
//
// The row ends up pointing at the extracted photo, which is the point: a jpeg previews in
// a browser and the OCR reader can read it, neither of which is true of the pdf.

const { GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const { s3Client } = require('./s3');
const { extractEmbeddedImage, isRefusedArchive } = require('./documentImage');

const BUCKET = process.env.S3_BUCKET_NAME;

// The extensions worth attempting. `doc` (old binary Word) is listed so it can be told
// apart from a photo and refused with a useful message rather than silently ignored;
// extractEmbeddedImage declines it, because it is not a zip.
const DOCUMENT_EXTENSIONS = ['pdf', 'docx', 'doc'];

// Nothing larger is read into memory. `/sign-s3` presigns a PUT with no size limit of its
// own, so this is the only cap on what a logged-in captain can make the server hold — and
// it is checked from the response headers BEFORE the body is buffered, which is the whole
// reason it is worth having. The largest real document scorecard on record is 0.9MB and
// the largest object of any kind we have written is well under this.
const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;

const extensionOf = (key) => String(key || '').split('.').pop().toLowerCase();

function isDocumentKey(key) {
  return DOCUMENT_EXTENSIONS.includes(extensionOf(key));
}

// The key the extracted photo is stored under.
//
// Derived from the document's own key rather than randomly generated, so the two sit next
// to each other in a bucket listing and the results secretary browsing it can still see
// which match a photo belongs to — the real keys are
// `tameside-20252026-Hyde High B-GHAP A.pdf`, and a uuid would throw that away.
//
// It keeps the `tameside-` prefix, which is not cosmetic: that prefix IS the ownership
// test in utils/scorecardPhoto.js, and this bucket holds another league's scorecards.
// An extracted photo that lost it would 404 from `GET /scorecard-photo/:id`.
function photoKeyFor(documentKey, extension) {
  const base = String(documentKey).replace(/\.[^.]*$/, '');
  return `${base}-photo.${extension}`;
}

// The url to record in `scorecardstore."scoresheet-url"`.
//
// Spaces are percent-encoded, and only spaces need to be: the derived key is the
// document's key plus a suffix, and those are the league's own naming
// (`tameside-<season>-<home>-<away>`), so the only character in them that is not
// url-safe is the space.
//
// NOT written as `+`. views/email-scorecard.ejs rewrites `%20` to `+` when it builds a
// url from the presigned one, which is why 314 rows in this table name a key that has
// never existed and why utils/scorecardPhoto.js has to translate them back. S3's REST
// endpoint decodes `+` in a path as a space so both spellings answer 200 over HTTPS and
// it looks like two objects when it is one; `GetObject` takes the key literally and does
// not. This is a new url, so it is written correctly.
function photoUrlFor(key) {
  return `https://${BUCKET}.s3.eu-west-1.amazonaws.com/${key.replace(/ /g, '%20')}`;
}

/**
 * Read a document out of the bucket, pull the photo out of it, and store that photo.
 *
 * @param {string} key  an S3 key that has already passed the caller's ownership check
 * @returns {Promise<{key, url, contentType, bytes} | null>} null when the document is not
 *          one of the shapes utils/documentImage.js handles — which is not an error, and
 *          leaves the document itself untouched and still referenced.
 * @throws  only when S3 itself fails, or the object is too large to read.
 */
async function convertStoredDocument(key, deps = {}) {
  const s3 = deps.s3 || s3Client();

  const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));

  // Checked from the response metadata, before the body is buffered. `transformToByteArray`
  // would happily hold half a gigabyte otherwise.
  if (obj.ContentLength && obj.ContentLength > MAX_DOCUMENT_BYTES) {
    if (obj.Body && typeof obj.Body.destroy === 'function') obj.Body.destroy();
    const err = new Error(`That file is ${(obj.ContentLength / 1024 / 1024).toFixed(0)}MB, `
      + `which is too large to read. Upload a photo of the card instead.`);
    err.status = 413;
    throw err;
  }

  const buffer = Buffer.from(await obj.Body.transformToByteArray());
  const extracted = extractEmbeddedImage(buffer, key);
  if (!extracted) return null;

  const photoKey = photoKeyFor(key, extracted.extension);
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: photoKey,
    // The type comes from the SNIFFED bytes, never from anything the client said. These
    // objects are served back by `GET /scorecard-photo/:id`, same-origin with the session
    // cookie, and that route already refuses to echo a stored content type for exactly
    // this reason — a legacy object can claim `text/html`. Storing a truthful one keeps
    // the two ends agreeing.
    ContentType: extracted.contentType,
    Body: extracted.buffer,
    // No ACL, deliberately. Every object in this bucket is private and read through the
    // photo route; a public-read object here would be a hole in that.
  }));

  return {
    key: photoKey,
    url: photoUrlFor(photoKey),
    contentType: extracted.contentType,
    bytes: extracted.buffer.length,
  };
}

module.exports = {
  convertStoredDocument,
  isDocumentKey,
  isRefusedArchive,
  photoKeyFor,
  photoUrlFor,
  DOCUMENT_EXTENSIONS,
  MAX_DOCUMENT_BYTES,
};
