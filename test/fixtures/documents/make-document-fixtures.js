#!/usr/bin/env node
/**
 * Generate the document-scorecard fixtures.
 *
 *   node test/fixtures/documents/make-document-fixtures.js
 *
 * WHY THESE ARE GENERATED RATHER THAN REAL
 *
 * The obvious fixtures are real scorecards out of the bucket. They are not usable: a
 * filled card carries twelve players' names and both captains' signatures, and a git
 * repository is forever and possibly public. Stockport's first version of this used real
 * files and had to be redone for exactly that reason.
 *
 * Generating them is not a compromise, it is better. Each file exists to carry ONE
 * structural shape and is named after it, and the shapes are the ones that actually break
 * an extractor. A real scorecard carries a shape incidentally and you cannot tell which by
 * looking at it.
 *
 * Ported from the Stockport league site, plus `scorecard-pdf-mrc-layered.pdf`, which is
 * this league's own finding — see utils/documentImage.js.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const sharp = require('sharp');

const OUT = __dirname;

// Something clearly a fixture, so nobody mistakes one for league data.
async function testImage(format, label) {
  const svg = Buffer.from(
    '<svg width="600" height="400" xmlns="http://www.w3.org/2000/svg">' +
    '<rect width="600" height="400" fill="#ffffff"/>' +
    '<rect x="20" y="20" width="560" height="360" fill="none" stroke="#0b2d6d" stroke-width="3"/>' +
    '<text x="300" y="190" font-family="sans-serif" font-size="34" fill="#0b2d6d" ' +
    'text-anchor="middle">TEST FIXTURE</text>' +
    '<text x="300" y="235" font-family="sans-serif" font-size="20" fill="#68758a" ' +
    'text-anchor="middle">' + (label || 'not a real scorecard') + '</text></svg>');
  const img = sharp(svg);
  return format === 'png' ? img.png().toBuffer() : img.jpeg({ quality: 85 }).toBuffer();
}

// --- docx -------------------------------------------------------------------
// Built with the `docx` package, already a dependency, so these are real Word files with
// the image at word/media/ exactly as Word writes it.
async function writeDocx(name, format, count) {
  const docx = require('docx');
  const images = [];
  for (let i = 0; i < (count || 1); i++) images.push(await testImage(format, 'image ' + (i + 1)));
  const doc = new docx.Document({
    sections: [{
      children: images.map(image => new docx.Paragraph({
        children: [new docx.ImageRun({
          data: image,
          transformation: { width: 600, height: 400 },
          type: format === 'png' ? 'png' : 'jpg',
        })],
      })),
    }],
  });
  const buf = await docx.Packer.toBuffer(doc);
  fs.writeFileSync(path.join(OUT, name), buf);
}

// --- pdf --------------------------------------------------------------------
//
// Hand-built, because the point of each is its dictionary and no library will emit a
// deliberately awkward one. Minimal but valid: catalog, pages, page(s), image XObject(s),
// and a content stream that draws them.
function buildPdf(images, opts) {
  const o = opts || {};
  const EOL = o.eol || '\n';
  const pageCount = o.pages || 1;
  const objects = [];
  const add = body => { objects.push(body); return objects.length; };

  add('<< /Type /Catalog /Pages 2 0 R >>');
  const kids = [];
  for (let p = 0; p < pageCount; p++) kids.push((3 + p) + ' 0 R');
  add('<< /Type /Pages /Kids [' + kids.join(' ') + '] /Count ' + pageCount + ' >>');

  const firstImageObj = 3 + pageCount * 2;
  for (let p = 0; p < pageCount; p++) {
    const xobjects = images.map((_, i) => '/Im' + i + ' ' + (firstImageObj + i) + ' 0 R').join(' ');
    add('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 400] '
      + '/Resources << /XObject << ' + xobjects + ' >> >> /Contents '
      + (3 + pageCount + p) + ' 0 R >>');
  }
  for (let p = 0; p < pageCount; p++) {
    const draw = images.map((_, i) => 'q 600 0 0 400 0 0 cm /Im' + i + ' Do Q').join('\n');
    add({ dict: '<< /Length ' + draw.length + ' >>', stream: Buffer.from(draw) });
  }

  for (const img of images) {
    // `reorderKeys` puts /Filter BEFORE /Subtype, which is legal — PDF dictionary keys are
    // unordered — and is what an extractor scanning only after /Subtype silently misses.
    const parts = o.reorderKeys
      ? ['/Filter ' + img.filter, '/Type /XObject', '/Subtype /Image']
      : ['/Type /XObject', '/Subtype /Image', '/Filter ' + img.filter];
    add({
      dict: '<< ' + parts.join(' ') + ' /Width ' + (img.width || 600)
        + ' /Height ' + (img.height || 400) + ' /ColorSpace ' + (img.colorSpace || '/DeviceRGB')
        + ' /BitsPerComponent ' + (img.bpc || 8)
        + (img.decodeParms ? ' /DecodeParms ' + img.decodeParms : '')
        + ' /Length ' + img.bytes.length + ' >>',
      stream: img.bytes,
    });
  }

  const chunks = [Buffer.from('%PDF-1.4\n')];
  const offsets = [];
  let pos = chunks[0].length;
  objects.forEach((obj, i) => {
    offsets.push(pos);
    const head = Buffer.from((i + 1) + ' 0 obj\n');
    const body = typeof obj === 'string'
      ? Buffer.concat([Buffer.from(obj), Buffer.from('\nendobj\n')])
      : Buffer.concat([
          Buffer.from(obj.dict), Buffer.from(EOL + 'stream' + EOL), obj.stream,
          Buffer.from(EOL + 'endstream' + EOL + 'endobj' + EOL),
        ]);
    chunks.push(head, body);
    pos += head.length + body.length;
  });

  let xref = 'xref\n0 ' + (objects.length + 1) + '\n0000000000 65535 f \n';
  offsets.forEach(off => { xref += String(off).padStart(10, '0') + ' 00000 n \n'; });
  xref += 'trailer\n<< /Size ' + (objects.length + 1) + ' /Root 1 0 R >>\nstartxref\n'
        + pos + '\n%%EOF\n';
  chunks.push(Buffer.from(xref));
  return Buffer.concat(chunks);
}

const dct = bytes => ({ bytes, filter: '/DCTDecode' });

(async () => {
  await writeDocx('scorecard-docx-jpeg.docx', 'jpeg');
  await writeDocx('scorecard-docx-png.docx', 'png');
  // Two images: genuinely ambiguous, and must decline. Also the shape that exposed a zip
  // DIRECTORY entry being counted as a second image.
  await writeDocx('scorecard-docx-two-images.docx', 'jpeg', 2);

  const jpeg = await testImage('jpeg');

  // The common case: the stream IS a jpeg, so it comes out verbatim.
  fs.writeFileSync(path.join(OUT, 'scorecard-pdf-dct.pdf'), buildPdf([dct(jpeg)]));

  // Same, with /Filter written before /Subtype.
  fs.writeFileSync(path.join(OUT, 'scorecard-pdf-dct-keys-reordered.pdf'),
    buildPdf([dct(jpeg)], { reorderKeys: true }));

  // A bare CR after `stream`, and the filter as a one-element array with spaces inside the
  // brackets. PDF-1.3 from an old scanner driver that writes CR for every line ending; the
  // spec says CRLF or LF, and 21 of Stockport's files say otherwise.
  fs.writeFileSync(path.join(OUT, 'scorecard-pdf-dct-bare-cr.pdf'),
    buildPdf([{ bytes: jpeg, filter: '[ /DCTDecode ]' }], { eol: '\r' }));

  // A jpeg with zlib on top, which Acrobat writes — and which 11 of this league's own
  // files use as their background layer.
  fs.writeFileSync(path.join(OUT, 'scorecard-pdf-flate-over-dct.pdf'),
    buildPdf([{ bytes: zlib.deflateSync(jpeg), filter: '[/FlateDecode /DCTDecode]' }]));

  // MRC: THE SHAPE THAT MUST BE DECLINED, and this league's own finding. A photocopier's
  // "compact PDF" is one large background image plus many small /CCITTFaxDecode bitonal
  // masks composited over it, and the masks are where the sharp text lives. 11 of our 41
  // pdf scorecards are this. Extracting the background alone yields a real-looking card
  // with its text layer missing, which is worse than declining, so this fixture exists to
  // fail loudly if the multi-image guard is ever "fixed".
  const masks = [];
  for (let i = 0; i < 40; i++) {
    masks.push({
      bytes: Buffer.from([0x26, 0xa0, 0x00, 0x00]),   // token CCITT payload; never decoded
      filter: '/CCITTFaxDecode', width: 816, height: 24, colorSpace: '/DeviceGray', bpc: 1,
      decodeParms: '<< /K -1 /Columns 816 /Rows 24 >>',
    });
  }
  fs.writeFileSync(path.join(OUT, 'scorecard-pdf-mrc-layered.pdf'), buildPdf(
    [{ bytes: zlib.deflateSync(jpeg), filter: '[/FlateDecode /DCTDecode]',
       width: 1240, height: 1754, colorSpace: '/DeviceGray' }].concat(masks)));

  // Two pages: picking one is a guess, so it declines.
  fs.writeFileSync(path.join(OUT, 'scorecard-pdf-multipage.pdf'),
    buildPdf([dct(jpeg)], { pages: 2 }));

  // Raw pixel data — no jpeg to lift out, and inflating it is what a decompression bomb
  // would exploit. Declined.
  const raw = await sharp(await testImage('png')).raw().toBuffer();
  fs.writeFileSync(path.join(OUT, 'scorecard-pdf-flate-raw.pdf'),
    buildPdf([{ bytes: zlib.deflateSync(raw), filter: '/FlateDecode' }]));

  for (const f of fs.readdirSync(OUT).filter(n => /\.(pdf|docx)$/.test(n)).sort()) {
    console.log('  ' + f.padEnd(42) + Math.round(fs.statSync(path.join(OUT, f)).size / 1024) + 'KB');
  }
})().catch(e => { console.error(e); process.exit(1); });
