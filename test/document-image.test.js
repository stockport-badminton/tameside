// Pulling the photo out of a document scorecard.
//
// Every fixture is GENERATED (test/fixtures/documents/make-document-fixtures.js) and
// carries exactly one structural shape, named after it. Real scorecards are not usable:
// a filled card carries twelve players' names and both captains' signatures, and a git
// repository is forever.
//
// The declining cases matter as much as the working ones. This extractor's contract is
// that it returns null rather than guessing, because a plausible-looking card with
// something missing is worse than no card at all — see the MRC test below.

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const { extractEmbeddedImage, isRefusedArchive, sniff } = require('../utils/documentImage');

const DIR = path.join(__dirname, 'fixtures', 'documents');
const load = (name) => fs.readFileSync(path.join(DIR, name));

// An extraction is only real if something can decode the bytes. Sniffing a magic number
// proves nothing — a truncated jpeg still starts FF D8 FF.
async function assertDecodable(result, expected) {
  assert.ok(result, 'expected an extraction');
  assert.strictEqual(result.contentType, expected.contentType);
  assert.strictEqual(result.extension, expected.extension);
  const meta = await sharp(result.buffer).metadata();
  assert.strictEqual(meta.width, 600);
  assert.strictEqual(meta.height, 400);
}

describe('docx: the image comes out verbatim', () => {
  it('reads a pasted jpeg', async () => {
    const out = extractEmbeddedImage(load('scorecard-docx-jpeg.docx'), 'card.docx');
    await assertDecodable(out, { contentType: 'image/jpeg', extension: 'jpg' });
    assert.strictEqual(out.source, 'docx');
  });

  it('reads a pasted png, and does not re-encode it', async () => {
    const out = extractEmbeddedImage(load('scorecard-docx-png.docx'), 'card.docx');
    await assertDecodable(out, { contentType: 'image/png', extension: 'png' });
  });

  // The type comes from the bytes, never the entry name: Word will happily store a png at
  // word/media/image1.jpeg and not care. Everything downstream does.
  it('trusts the bytes rather than the entry name', () => {
    const png = extractEmbeddedImage(load('scorecard-docx-png.docx'), 'card.docx');
    assert.strictEqual(sniff(png.buffer).type, 'image/png');
  });

  it('declines a document with two images, rather than picking one', () => {
    assert.strictEqual(
      extractEmbeddedImage(load('scorecard-docx-two-images.docx'), 'card.docx'), null);
  });
});

describe('pdf: the /DCTDecode stream IS a jpeg', () => {
  it('reads the plain case', async () => {
    const out = extractEmbeddedImage(load('scorecard-pdf-dct.pdf'), 'card.pdf');
    await assertDecodable(out, { contentType: 'image/jpeg', extension: 'jpg' });
    assert.strictEqual(out.source, 'pdf');
  });

  // PDF dictionary keys are UNORDERED. Searching forwards from /Subtype /Image misses
  // every file that happens to write /Filter first, which is legal and common.
  it('reads it with /Filter written before /Subtype', async () => {
    const out = extractEmbeddedImage(load('scorecard-pdf-dct-keys-reordered.pdf'), 'card.pdf');
    await assertDecodable(out, { contentType: 'image/jpeg', extension: 'jpg' });
  });

  // `stream` is followed by CRLF or LF per the spec, and by a BARE CR in 21 of the files
  // on the sister site — PDF-1.3 from an old scanner driver. `/stream\r?\n/` matched none
  // of them, so the exact case this exists for extracted nothing.
  it('reads it with a bare CR after `stream`', async () => {
    const out = extractEmbeddedImage(load('scorecard-pdf-dct-bare-cr.pdf'), 'card.pdf');
    await assertDecodable(out, { contentType: 'image/jpeg', extension: 'jpg' });
  });

  // Acrobat writes [/FlateDecode /DCTDecode] — zlib on top of a jpeg. It is also the
  // background layer of 11 of this league's own scorecards.
  it('inflates a jpeg wrapped in zlib', async () => {
    const out = extractEmbeddedImage(load('scorecard-pdf-flate-over-dct.pdf'), 'card.pdf');
    await assertDecodable(out, { contentType: 'image/jpeg', extension: 'jpg' });
  });
});

describe('what it must decline', () => {
  // THE ONE MOST WORTH KEEPING. A photocopier's "compact PDF" is Mixed Raster Content:
  // one large background image plus dozens of small /CCITTFaxDecode masks composited over
  // it, and the masks carry the sharp text. 11 of this league's 41 pdf scorecards are
  // this shape.
  //
  // Their 32-89 declared images look exactly like a keyword count fooled by binary stream
  // data, and "fixing" that guard is a few lines and takes the extraction rate from 63%
  // to 90%. It was written, measured, and reverted: the background alone is a real,
  // plausible-looking scorecard with its text layer missing, and the row would then point
  // at that instead of the complete pdf the captain filed. Silently losing information is
  // worse than declining.
  it('declines an MRC layered scan, so a text layer cannot be silently dropped', () => {
    const buffer = load('scorecard-pdf-mrc-layered.pdf');
    // It really does declare many images, and the background really is extractable —
    // which is exactly why the guard has to hold.
    const declared = (buffer.toString('latin1').match(/\/Subtype\s*\/Image/g) || []).length;
    assert.ok(declared > 30, `fixture should declare many images, declared ${declared}`);
    assert.strictEqual(extractEmbeddedImage(buffer, 'card.pdf'), null);
  });

  it('declines a two-page pdf, rather than guessing which page is the card', () => {
    assert.strictEqual(extractEmbeddedImage(load('scorecard-pdf-multipage.pdf'), 'card.pdf'), null);
  });

  // Raw pixels, not a jpeg. Declined because inflating arbitrary pixel data is the one
  // path here that could be made to decompression-bomb: a jpeg's size is bounded by
  // something sane, raw pixels can declare any dimensions they like.
  it('declines raw /FlateDecode pixel data', () => {
    assert.strictEqual(extractEmbeddedImage(load('scorecard-pdf-flate-raw.pdf'), 'card.pdf'), null);
  });

  it('declines a .doc, which is not a zip', () => {
    assert.strictEqual(extractEmbeddedImage(load('scorecard-docx-jpeg.docx'), 'card.doc'), null);
  });

  it('never throws on rubbish, because the caller keeps the original either way', () => {
    for (const input of [Buffer.alloc(0), Buffer.from('not a document'),
                         Buffer.from('%PDF-1.4 truncated'), Buffer.from([0x50, 0x4b, 0x03])]) {
      assert.strictEqual(extractEmbeddedImage(input, 'card.pdf'), null);
    }
    assert.strictEqual(extractEmbeddedImage(null, 'card.pdf'), null);
    assert.strictEqual(extractEmbeddedImage(undefined, undefined), null);
  });
});

describe('archives are refused by name, before anything reads a byte', () => {
  it('names the formats', () => {
    for (const n of ['x.zip', 'X.ZIP', 'x.rar', 'x.7z', 'x.gz', 'x.tar']) {
      assert.strictEqual(isRefusedArchive(n), true, n);
    }
    for (const n of ['x.pdf', 'x.docx', 'x.jpg', 'x']) {
      assert.strictEqual(isRefusedArchive(n), false, n);
    }
  });
});
