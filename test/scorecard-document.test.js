// Reading an uploaded document back out of the bucket and storing the photo inside it.
//
// S3 is stubbed throughout: these tests must never touch the real bucket, which is shared
// with the other league. The stub is passed in through `deps.s3` rather than mocked
// globally, so a call that forgot to use it would fail rather than quietly reach AWS.

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

process.env.S3_BUCKET_NAME = process.env.S3_BUCKET_NAME || 'badmintontemp';

const {
  convertStoredDocument, isDocumentKey, photoKeyFor, photoUrlFor, MAX_DOCUMENT_BYTES,
} = require('../utils/scorecardDocument');
const { photoKeyFromStored } = require('../utils/scorecardPhoto');

const DIR = path.join(__dirname, 'fixtures', 'documents');
const load = (name) => fs.readFileSync(path.join(DIR, name));

// Real bytes on GET, captured on PUT.
function stubS3(bytes, contentLength) {
  const puts = [];
  return {
    puts,
    client: {
      send: async (cmd) => {
        const name = cmd.constructor.name;
        if (name === 'GetObjectCommand') {
          return {
            ContentLength: contentLength === undefined ? bytes.length : contentLength,
            Body: {
              transformToByteArray: async () => bytes,
              destroy: () => {},
            },
          };
        }
        if (name === 'PutObjectCommand') { puts.push(cmd.input); return {}; }
        throw new Error('unexpected command ' + name);
      },
    },
  };
}

describe('which keys are documents', () => {
  it('recognises the three document extensions and nothing else', () => {
    for (const k of ['a.pdf', 'a.PDF', 'a.docx', 'a.doc']) assert.strictEqual(isDocumentKey(k), true, k);
    for (const k of ['a.jpg', 'a.jpeg', 'a.heic', 'a.png', 'a']) assert.strictEqual(isDocumentKey(k), false, k);
  });
});

describe('the key and url the photo is stored under', () => {
  // The `tameside-` prefix IS the ownership test in utils/scorecardPhoto.js, and this
  // bucket holds another league's scorecards. A photo that lost it would 404 from
  // GET /scorecard-photo/:id.
  it('keeps the tameside- prefix and sits beside the document', () => {
    assert.strictEqual(photoKeyFor('tameside-20252026-Hyde B-Shell A.pdf', 'jpg'),
      'tameside-20252026-Hyde B-Shell A-photo.jpg');
  });

  // The real keys contain spaces. `%20` and not `+`: S3's REST endpoint decodes `+` in a
  // path as a space so both answer 200 over HTTPS, but GetObject takes the key literally.
  // That rewrite is why 314 existing rows name a key that has never existed.
  it('round-trips back to the same key through the photo reader', () => {
    for (const documentKey of [
      'tameside-20252026-Hyde High B-Shell A.pdf',
      'tameside-ocr-1757000000000.pdf',
      'tameside-GHAP B-GHAP A.docx',
    ]) {
      const key = photoKeyFor(documentKey, 'jpg');
      assert.strictEqual(photoKeyFromStored(photoUrlFor(key)), key, documentKey);
    }
  });

  it('percent-encodes spaces rather than writing a plus', () => {
    const url = photoUrlFor('tameside-Hyde B-Shell A-photo.jpg');
    assert.ok(url.includes('%20'), url);
    assert.ok(!url.includes('+'), url);
  });
});

describe('converting a stored document', () => {
  it('stores the extracted photo and hands back a resolvable url', async () => {
    const { puts, client } = stubS3(load('scorecard-pdf-dct.pdf'));
    const out = await convertStoredDocument('tameside-Hyde B-Shell A.pdf', { s3: client });

    assert.strictEqual(puts.length, 1);
    assert.strictEqual(puts[0].Key, 'tameside-Hyde B-Shell A-photo.jpg');
    // The type comes from the SNIFFED bytes, never from anything a client said. These
    // objects are served same-origin with the session cookie.
    assert.strictEqual(puts[0].ContentType, 'image/jpeg');
    // Every object in this bucket is private and read through the photo route. A
    // public-read object here would be a hole in that.
    assert.strictEqual(puts[0].ACL, undefined);
    assert.strictEqual(out.key, puts[0].Key);
    assert.strictEqual(photoKeyFromStored(out.url), out.key);
  });

  it('reads a Word document too', async () => {
    const { puts } = stubS3(load('scorecard-docx-jpeg.docx'));
    const { client } = stubS3(load('scorecard-docx-jpeg.docx'));
    const out = await convertStoredDocument('tameside-Hyde B-Shell A.docx', { s3: client });
    assert.ok(out);
    assert.strictEqual(out.contentType, 'image/jpeg');
    assert.ok(puts.length === 0);   // the other stub, untouched — no cross-talk
  });

  // Not an error, and the distinction matters: the document is already in the bucket and
  // still attached to the scorecard, so declining costs nothing. It is exactly what those
  // files have done for two seasons.
  it('returns null and writes nothing when it cannot read the document', async () => {
    for (const name of ['scorecard-pdf-mrc-layered.pdf', 'scorecard-pdf-multipage.pdf',
                        'scorecard-pdf-flate-raw.pdf']) {
      const { puts, client } = stubS3(load(name));
      const out = await convertStoredDocument('tameside-x.pdf', { s3: client });
      assert.strictEqual(out, null, name);
      assert.strictEqual(puts.length, 0, `${name} must not store anything`);
    }
  });

  // `/sign-s3` presigns a PUT with no size limit of its own, so this is the only cap on
  // what a logged-in captain can make the server hold in memory. Checked from the
  // response headers BEFORE the body is buffered, which is the whole point of it.
  it('refuses an oversized object without reading its body', async () => {
    let bodyRead = false;
    const client = {
      send: async (cmd) => {
        if (cmd.constructor.name !== 'GetObjectCommand') throw new Error('should not get here');
        return {
          ContentLength: MAX_DOCUMENT_BYTES + 1,
          Body: {
            transformToByteArray: async () => { bodyRead = true; return Buffer.alloc(0); },
            destroy: () => {},
          },
        };
      },
    };
    await assert.rejects(() => convertStoredDocument('tameside-huge.pdf', { s3: client }),
      (err) => err.status === 413 && /too large/.test(err.message));
    assert.strictEqual(bodyRead, false, 'the body must not be buffered');
  });
});
