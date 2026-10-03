// iPhone HEIC photo -> jpeg.
//
// The prebuilt sharp has no HEVC decoder (`sharp.format.heif.input.fileSuffix` is
// ['.avif']), and Vision refuses HEIC outright ("Bad image data"), so an iPhone photo
// could neither be read by the OCR wizard nor shown by `GET /scorecard-photo/:id` in any
// browser but Safari. Measured 3 Oct 2026: 11 of our 340 scorecard uploads are HEIC —
// nearly all one captain's — and every one failed. Decoded, 9 of the 10 distinct photos
// read fine.
//
// `heic-decode` is libheif compiled to wasm: pure JS, no system package, nothing to build
// in the image. ~1.2s and a ~400MB peak RSS for a 12MP photo, inside the service's 2GB.
// libheif applies the HEIF orientation transforms itself, so the output is upright.
//
// Like utils/documentImage.js this never throws: null means "could not convert", and the
// caller treats that exactly like a document it could not extract from.

const sharp = require('sharp');
const decodeHeic = require('heic-decode');

// ISO BMFF: bytes 4-7 are 'ftyp', 8-11 the major brand.
const HEIF_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'mif1', 'msf1']);

function isHeif(buffer) {
  if (!buffer || buffer.length < 12) return false;
  if (buffer.toString('latin1', 4, 8) !== 'ftyp') return false;
  return HEIF_BRANDS.has(buffer.toString('latin1', 8, 12));
}

async function toJpeg(buffer) {
  try {
    let jpeg;
    if (isHeif(buffer)) {
      const { width, height, data } = await decodeHeic({ buffer });
      jpeg = await sharp(Buffer.from(data.buffer, data.byteOffset, data.byteLength),
        { raw: { width, height, channels: 4 } })
        .jpeg({ quality: 90 })
        .toBuffer();
    } else {
      // Named .heic but not one: some apps export a jpeg under the iPhone's extension.
      // Whatever sharp can read is re-encoded rather than refused.
      jpeg = await sharp(buffer).rotate().jpeg({ quality: 90 }).toBuffer();
    }
    return { buffer: jpeg, extension: 'jpg', contentType: 'image/jpeg' };
  } catch (err) {
    console.log(`[heic] could not convert: ${err.message}`);
    return null;
  }
}

module.exports = { toJpeg, isHeif };
