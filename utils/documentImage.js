// Pull the photo out of a document scorecard.
//
// WHY THIS IS EXTRACTION AND NOT RENDERING
//
// A document scorecard is a picture with a wrapper around it, not a document that happens
// to contain one. A `.pdf` is one page whose only content is one image XObject, with zero
// fonts; a `.docx` is `word/media/image1.*` and a document.xml with zero words. Somebody
// pasted a photo into Word, or a scanner said "save as PDF".
//
// So the job is to copy bytes out, not to rasterise a page — which is why it needs no
// Ghostscript, no pdf.js and no new dependency. ImageMagick is not in this image either
// way, and `convert card.pdf out.jpg` would only delegate to Ghostscript regardless.
//
// MEASURED AGAINST THIS LEAGUE'S ARCHIVE, 2026-09-06. Ported from the Stockport league
// site (their utils/documentImage.js, HARD-25). Their numbers do not transfer: of our 324
// scorecard objects **41 are PDFs — 12.7% against their 7% — and none is a .docx**.
// Run over all 41, this extracts **26, or 63%**. What declines, and why each is right to:
//
//   MRC layered scan     11   see below — the big one, and the one worth understanding
//   multi-page            3   two pages each; picking one is a guess
//   image in an /ObjStm   1   PDF 1.5 compressed object streams: the dict is not in the
//                             clear, so a byte-level walk cannot see it
//
// THE MRC CASE IS A TRAP, AND THE GUARD THAT CATCHES IT LOOKS WRONG. Those 11 files each
// declare between 32 and 89 image XObjects, so `/Subtype /Image` appearing 65 times looks
// exactly like a keyword count fooled by binary stream data — and "fixing" that is a few
// lines and takes the rate to 90%. It was written, measured and reverted.
//
// They are Mixed Raster Content, which is what a photocopier means by "compact PDF": ONE
// large [/FlateDecode /DCTDecode] background (1240x1754 here) plus 31-88 small
// /CCITTFaxDecode bitonal masks composited over it, and the masks are where the sharp text
// lives. Take the background alone and you get a real, plausible-looking scorecard with
// its text layer missing — checked by extracting one and looking at it: the grid and some
// handwriting survive, the printed team names are grey smudges.
//
// That is worse than declining, because the row would then point at the degraded image
// instead of the complete PDF the captain filed. The PDF still renders correctly in any
// viewer, all layers composited. Handling these properly needs a CCITT decoder AND
// compositing, which is a different project; "kept as a PDF, no OCR" is what those 11 have
// had for two seasons and nothing regresses by leaving them there.
//
// WHAT THIS DELIBERATELY DOES NOT DO
//
// The verbatim cases only: the stream between `stream` and `endstream` either IS a JPEG
// (/DCTDecode) or inflates to one (/FlateDecode then /DCTDecode). Nothing is decoded into
// raw pixels, so it cannot be made to decompression-bomb — the one inflate is capped, and
// its output is a JPEG, bounded by something sane, unlike raw pixel data which can declare
// any dimensions it likes.
//
// Anything not matching exactly returns null rather than guessing. A general PDF parser is
// what the declining cases need; guessing is what this must not do.

const zlib = require('zlib');
const { zipEntries } = require('./zip');

// A jpeg inside a pdf, inflated, should not exceed this. The upload cap is 25MB, so a
// stream that expands past 30MB is not a scorecard photo.
const MAX_INFLATED_BYTES = 30 * 1024 * 1024;

// Refused outright rather than attempted. A zip was never a supported scorecard — the one
// in the bucket has no row pointing at it, so nothing ever displayed it — and unpacking
// arbitrary archives from an unauthenticated endpoint is a different risk class entirely.
const REFUSED_EXTENSIONS = ['zip', 'rar', '7z', 'gz', 'tar'];

const IMAGE_MAGIC = [
  { bytes: [0xff, 0xd8, 0xff], type: 'image/jpeg', ext: 'jpg' },
  { bytes: [0x89, 0x50, 0x4e, 0x47], type: 'image/png', ext: 'png' },
  { bytes: [0x47, 0x49, 0x46, 0x38], type: 'image/gif', ext: 'gif' },
];

// Trust the bytes, not the name: a .docx can hold image1.png named .jpeg and Word does not
// care. Every consumer downstream does.
function sniff(buffer) {
  for (const m of IMAGE_MAGIC) {
    if (m.bytes.every((b, i) => buffer[i] === b)) return m;
  }
  // RIFF....WEBP
  if (buffer.slice(0, 4).toString('latin1') === 'RIFF' &&
      buffer.slice(8, 12).toString('latin1') === 'WEBP') {
    return { type: 'image/webp', ext: 'webp' };
  }
  return null;
}

const extensionOf = name => String(name || '').split('.').pop().toLowerCase();

function isRefusedArchive(name) {
  return REFUSED_EXTENSIONS.includes(extensionOf(name));
}

// --- docx -------------------------------------------------------------------
// The image comes out verbatim. No re-encode, so no quality loss.
function fromDocx(buffer) {
  // A zip may carry an entry for the directory itself (`word/media/`, zero bytes). Word
  // does not write them but plenty of writers do, and counting one as a second image is
  // what made `media.length !== 1` reject a perfectly good single-photo document.
  const media = zipEntries(buffer)
    .filter(e => /^word\/media\/./i.test(e.name) && !e.name.endsWith('/'));
  if (media.length !== 1) return null;   // not the one-pasted-photo shape
  const data = media[0].read();
  const kind = sniff(data);
  if (!kind) return null;
  return { buffer: data, contentType: kind.type, extension: kind.ext, source: 'docx' };
}

// --- pdf --------------------------------------------------------------------
//
// Only the /DCTDecode case, where the stream between `stream` and `endstream` IS a
// complete JPEG file and can be written out untouched.
//
// This reads the bytes rather than parsing the document, which is enough for the shape
// these files have — one page, one image, no fonts — and is deliberately conservative:
// anything that does not match exactly returns null instead of guessing. A general PDF
// parser is what Phase 2 needs; guessing is what it must not do.
// For each `stream` keyword, the dictionary that introduces it — the text between the
// `<<` that opens it and the `>>` that closes it. Walked BACKWARDS with a depth count,
// because a dict can nest (`/DecodeParms << ... >>`) and the outer one is what describes
// the stream.
//
// This exists because PDF dictionary keys are UNORDERED. An earlier version searched only
// the 600 bytes after `/Subtype /Image` and silently missed every file that happens to put
// `/Filter /DCTDecode` first — four of twenty in the real corpus, which dropped extraction
// from ~70% to 48% for no reason but key order.
function streamDictionaries(s) {
  const out = [];
  // `stream` is followed by CRLF or LF *per the spec*, and by a bare CR in 21 of the 127
  // real files — PDF-1.3 output from some old scanner driver, which writes CR for every
  // line ending in the whole file. `/stream\r?\n/` never matched them, so a one-page
  // one-image /DCTDecode scorecard, the exact case this exists for, extracted nothing.
  // The alternation is ordered so CRLF is consumed whole and `m[0].length` stays right.
  const re = /stream(?:\r\n|\n|\r)/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    // The `>>` closing the dict sits just before `stream`, modulo whitespace.
    let i = m.index - 1;
    while (i > 0 && /\s/.test(s[i])) i--;
    if (s[i - 1] !== '>' || s[i] !== '>') continue;
    // depth starts at 1: the closing `>>` we just matched is already consumed, so the
    // `<<` that balances it is the one to stop on. Starting at 0 made every walk run past
    // its own opening brace to the 20000-byte guard and return nothing.
    let depth = 1;
    let j = i - 1;
    for (; j > 0; j--) {
      if (s[j - 1] === '>' && s[j] === '>') { depth++; j--; continue; }
      if (s[j - 1] === '<' && s[j] === '<') {
        depth--;
        if (depth === 0) break;
        j--;
        continue;
      }
      // A dictionary is not megabytes long; if we have walked that far, the file is not
      // the shape this handles.
      if (i - j > 20000) { j = 0; break; }
    }
    if (j <= 0) continue;
    out.push({ dict: s.slice(j - 1, i + 1), streamStart: m.index + m[0].length });
  }
  return out;
}

// Only the /DCTDecode case, where the bytes between `stream` and `endstream` ARE a
// complete JPEG file and can be written out untouched.
//
// Byte-level rather than a real parser, which is enough for the shape these files have —
// one page, one image, no fonts — and deliberately conservative: anything that does not
// match exactly returns null instead of guessing. A general parser is what Phase 2 needs;
// guessing is what it must not do.
function fromPdf(buffer) {
  const s = buffer.toString('latin1');

  // Not our shape: more than one page, or more than one image. Bail rather than pick.
  if ((s.match(/\/Type\s*\/Page[^s]/g) || []).length > 1) return null;
  if ((s.match(/\/Subtype\s*\/Image/g) || []).length !== 1) return null;

  for (const { dict, streamStart } of streamDictionaries(s)) {
    if (!/\/Subtype\s*\/Image/.test(dict)) continue;

    // Two shapes carry a jpeg. Both end with DCTDecode, because that IS the jpeg.
    //
    //   /Filter/DCTDecode                    the stream is the jpeg
    //   /Filter[/FlateDecode/DCTDecode]      the jpeg, then zlib on top of it
    //
    // The second is common — Acrobat writes it — and an earlier version of this bailed on
    // any filter array, which is why extraction sat at 48% when the codec census said 80%.
    // Bailing was right that the raw bytes are not a jpeg; giving up was not.
    const filter = /\/Filter\s*(\/\w+|\[[^\]]*\])/.exec(dict);
    if (!filter) return null;
    const chain = (filter[1].match(/\/\w+/g) || []);
    const isPlainDct = chain.length === 1 && chain[0] === '/DCTDecode';
    const isFlateOverDct = chain.length === 2 &&
      chain[0] === '/FlateDecode' && chain[1] === '/DCTDecode';
    if (!isPlainDct && !isFlateOverDct) return null;

    const end = s.indexOf('endstream', streamStart);
    if (end < 0) return null;
    let data = buffer.slice(streamStart, end);

    if (isFlateOverDct) {
      try {
        // maxOutputLength IS the bomb guard, and it is why this stays a Phase 1 case: the
        // output is a jpeg, so it is bounded by something sane, unlike raw pixel data
        // which can declare any dimensions it likes.
        data = zlib.inflateSync(data, { maxOutputLength: MAX_INFLATED_BYTES });
      } catch (err) {
        return null;   // truncated, or larger than we are willing to hold
      }
    }

    const kind = sniff(data);
    // It should be a jpeg by now. If it does not sniff as one, something about this file is
    // not what it claims, so leave it alone.
    if (!kind || kind.type !== 'image/jpeg') return null;
    return { buffer: data, contentType: kind.type, extension: kind.ext, source: 'pdf' };
  }
  return null;
}

/**
 * The embedded image, or null when this file is not one of the shapes handled above.
 * Never throws: a malformed document is a null, because the caller's job is to store the
 * original and carry on.
 */
function extractEmbeddedImage(buffer, filename) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) return null;
  const ext = extensionOf(filename);
  try {
    if (ext === 'docx' || buffer.slice(0, 2).toString('latin1') === 'PK') {
      // A .doc (old binary Word) is not a zip and is not handled.
      if (ext === 'doc') return null;
      return fromDocx(buffer);
    }
    if (ext === 'pdf' || buffer.slice(0, 5).toString('latin1') === '%PDF-') {
      return fromPdf(buffer);
    }
  } catch (err) {
    return null;
  }
  return null;
}

module.exports = { extractEmbeddedImage, isRefusedArchive, sniff, REFUSED_EXTENSIONS };
