// A minimal zip reader: walk the central directory, inflate one entry.
//
// A .docx is a zip, and this repo has no unzip helper — `jszip` is only a transitive
// dependency of `docx`, and depending on something nothing declares is how a `npm ci`
// somewhere else stops working. Thirty lines beats that.
//
// Ported from the Stockport league site, where it was promoted out of a test that needed
// to assert on a generated document's word/document.xml. Here it exists solely so
// utils/documentImage.js can pull the photo out of a Word scorecard.
//
// Tameside has no .docx scorecards on record today — all 41 document scorecards are PDFs
// — but Stockport's identical column holds 14, the two sites share a bucket and a
// captain pasting a photo into Word is not an exotic thing to do. The docx path costs
// thirty lines and is the one shape that comes out completely losslessly.

const zlib = require('zlib');

// Every entry, with a lazy reader. Lazy because a scorecard .docx holds one large image
// and several small bits of XML, and only one of them is ever wanted.
function zipEntries(buffer) {
  // End of central directory: signature 0x06054b50, scanned from the back because the
  // comment field is variable length.
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip file');

  const count = buffer.readUInt16LE(eocd + 10);
  let p = buffer.readUInt32LE(eocd + 16);
  const entries = [];

  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central directory');
    const method = buffer.readUInt16LE(p + 10);
    const compressedSize = buffer.readUInt32LE(p + 20);
    const uncompressedSize = buffer.readUInt32LE(p + 24);
    const nameLen = buffer.readUInt16LE(p + 28);
    const extraLen = buffer.readUInt16LE(p + 30);
    const commentLen = buffer.readUInt16LE(p + 32);
    const localOffset = buffer.readUInt32LE(p + 42);
    const name = buffer.toString('utf8', p + 46, p + 46 + nameLen);

    entries.push({
      name: name,
      compressedSize: compressedSize,
      uncompressedSize: uncompressedSize,
      read: function() {
        // The local header repeats the name and carries its own extra field, which is
        // often a different length from the central one.
        const lNameLen = buffer.readUInt16LE(localOffset + 26);
        const lExtraLen = buffer.readUInt16LE(localOffset + 28);
        const start = localOffset + 30 + lNameLen + lExtraLen;
        const data = buffer.slice(start, start + compressedSize);
        return method === 0 ? data : zlib.inflateRawSync(data);
      },
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function readZipEntry(buffer, wanted) {
  const entry = zipEntries(buffer).find(e => e.name === wanted);
  if (!entry) throw new Error(`no ${wanted} in the archive`);
  return entry.read();
}

module.exports = { zipEntries, readZipEntry };
