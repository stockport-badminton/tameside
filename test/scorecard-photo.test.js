// Key derivation for GET /scorecard-photo/:id.
//
// Tameside and the Stockport league site share ONE S3 bucket, and every object at its
// root was world-readable from a per-object ACL. Stockport is stripping those ACLs, so
// the photos have to be read with credentials instead — which means turning a stored
// public URL back into an object key. This module is that step, and it is the security
// boundary of the whole route: it decides which objects in a bucket holding another
// league's scorecards this site will stream out of its own origin.
//
// Every URL shape below is a real value measured out of production `scorecardstore`
// (2026-09-01), not an invention. The counts are there because the awkward branches only
// look like over-engineering until you know how much of the archive depends on them:
//
//   1,139 rows have a non-empty scoresheet-url
//     322   are ours     (keys `tameside-...`, ids 1758-2087)
//     817   are NOT ours (un-prefixed keys, ids 878-1757 — Stockport rows inherited when
//                         scorecardstore was cloned from their database; their teams are
//                         clubs that do not exist in this database at all)
//     808   use the dashed host s3-eu-west-1, 325 the dotted s3.eu-west-1
//     314   spell a space as `+`, 819 as %20
//       6   hold the literal string "undefined"

const { describe, it } = require('node:test');
const assert = require('node:assert');

process.env.S3_BUCKET_NAME = process.env.S3_BUCKET_NAME || 'badmintontemp';
const BUCKET = process.env.S3_BUCKET_NAME;

const {
  photoKeyFromStored, contentTypeFor, downloadTypeFor, downloadNameFor,
} = require('../utils/scorecardPhoto');

describe('photoKeyFromStored: the two host spellings in the data', () => {
  // 325 rows. What the current uploader writes.
  it('accepts the dotted regional host', () => {
    assert.strictEqual(
      photoKeyFromStored(`https://${BUCKET}.s3.eu-west-1.amazonaws.com/tameside-20252026-GHAP+B-Shell+A.JPG`),
      'tameside-20252026-GHAP B-Shell A.JPG');
  });

  // 808 rows — the MAJORITY of the archive. A reader written only for the shape above
  // would 404 two thirds of the photos on the site, silently.
  it('accepts the dashed regional host', () => {
    assert.strictEqual(
      photoKeyFromStored(`https://${BUCKET}.s3-eu-west-1.amazonaws.com/tameside-Mellor%20A-Mellor%20B.pdf`),
      'tameside-Mellor A-Mellor B.pdf');
  });

  it('accepts the global host, which S3 hands out by default', () => {
    assert.strictEqual(
      photoKeyFromStored(`https://${BUCKET}.s3.amazonaws.com/tameside-x.jpg`), 'tameside-x.jpg');
  });

  it('accepts path style, where the bucket is the first path segment', () => {
    assert.strictEqual(
      photoKeyFromStored(`https://s3.eu-west-1.amazonaws.com/${BUCKET}/tameside-x.jpg`), 'tameside-x.jpg');
  });

  it('refuses path style naming somebody else\'s bucket', () => {
    // The regional host fronts every bucket in the region, so the host test alone is
    // not enough — without the bucket check this would proxy any bucket on S3.
    assert.strictEqual(photoKeyFromStored('https://s3.eu-west-1.amazonaws.com/some-other-bucket/tameside-x.jpg'), null);
  });

  it('refuses a host that merely contains the bucket name', () => {
    assert.strictEqual(photoKeyFromStored(`https://${BUCKET}.evil.example.com/tameside-x.jpg`), null);
    assert.strictEqual(photoKeyFromStored(`https://not-${BUCKET}.s3.eu-west-1.amazonaws.com/tameside-x.jpg`), null);
    assert.strictEqual(photoKeyFromStored('https://evil.example.com/tameside-x.jpg'), null);
  });
});

describe('photoKeyFromStored: `+` means a space', () => {
  // The upload widget rebuilds the object URL from the presigned one and rewrites %20 as
  // '+' (views/email-scorecard.ejs). Those URLs work in a browser because S3's REST
  // endpoint decodes '+' in a path as a space — so both spellings answer 200 over HTTPS
  // and it reads like two objects when it is one. GetObject does NOT do that; it takes
  // the key literally. Verified against the real bucket: HeadObject on the '+' form is
  // NotFound, on the space form it is found.
  it('translates + to a space, or 314 rows ask for a key that has never existed', () => {
    assert.strictEqual(
      photoKeyFromStored(`https://${BUCKET}.s3.eu-west-1.amazonaws.com/tameside-20242025-Aerospace+A-GHAP+A.pdf`),
      'tameside-20242025-Aerospace A-GHAP A.pdf');
  });

  it('percent-decodes %20 to the same key', () => {
    assert.strictEqual(
      photoKeyFromStored(`https://${BUCKET}.s3.eu-west-1.amazonaws.com/tameside-20242025-Aerospace%20A-GHAP%20A.pdf`),
      'tameside-20242025-Aerospace A-GHAP A.pdf');
  });
});

describe('photoKeyFromStored: ownership is an allowlist, not a denylist', () => {
  // THE central test. 817 rows in this table point at un-prefixed objects at the shared
  // bucket root that belong to the Stockport league. A denylist of the prefixes we know
  // about would have let /scorecard-photo/1545 stream another league's scorecard out of
  // OUR origin to any logged-in Tameside user.
  it('refuses the 817 inherited Stockport rows', () => {
    for (const stored of [
      `https://${BUCKET}.s3-eu-west-1.amazonaws.com/College%20Green%20A-GHAP%20A.jpg`,
      `https://${BUCKET}.s3-eu-west-1.amazonaws.com/Canute%20A-Dome%20A.jpg`,
      `https://${BUCKET}.s3-eu-west-1.amazonaws.com/Cheadle%20Hulme%20B-Tatton%20A.jpg`,
      `https://${BUCKET}.s3-eu-west-1.amazonaws.com/Aerospace%20A-Alderley%20Park%20B.pdf`,
    ]) {
      assert.strictEqual(photoKeyFromStored(stored), null, stored);
    }
  });

  it('refuses the other prefixes sharing the bucket', () => {
    for (const key of [
      'inbound-email/abc123',              // Stockport, written by SES
      'social-videos/week-1.mp4',          // Stockport
      'scorecard-ocr-cache/tameside-x.json', // ours, but cached Vision JSON, not a photo
    ]) {
      assert.strictEqual(photoKeyFromStored(`https://${BUCKET}.s3.eu-west-1.amazonaws.com/${key}`), null, key);
    }
  });

  it('refuses a key that only mentions tameside- later on', () => {
    assert.strictEqual(
      photoKeyFromStored(`https://${BUCKET}.s3.eu-west-1.amazonaws.com/inbound-email/tameside-x.jpg`), null);
  });
});

describe('photoKeyFromStored: junk in the column', () => {
  it('refuses the 6 rows holding the literal string "undefined"', () => {
    assert.strictEqual(photoKeyFromStored('undefined'), null);
    assert.strictEqual(photoKeyFromStored('null'), null);
  });

  it('refuses empty, blank and non-string values', () => {
    for (const v of ['', '   ', null, undefined, 42, {}, []]) {
      assert.strictEqual(photoKeyFromStored(v), null, JSON.stringify(v));
    }
  });

  it('refuses a malformed percent escape rather than throwing', () => {
    assert.strictEqual(photoKeyFromStored(`https://${BUCKET}.s3.eu-west-1.amazonaws.com/tameside-%E0%A4%A.jpg`), null);
  });

  it('refuses non-http schemes', () => {
    assert.strictEqual(photoKeyFromStored('file:///etc/passwd'), null);
    assert.strictEqual(photoKeyFromStored('s3://badmintontemp/tameside-x.jpg'), null);
  });

  it('refuses control characters', () => {
    assert.strictEqual(photoKeyFromStored('tameside-x\n.jpg'), null);
  });

  it('refuses a key that starts with our prefix and then names another prefix', () => {
    // `startsWith('tameside-')` alone admits this: no path SEGMENT equals '..', so the
    // traversal check does not fire, and the denied-prefix check looks at the start of
    // the string. S3 keys are literal so it would not actually resolve anywhere, but the
    // ownership rule should not concede the shape. Hence: our keys are flat.
    assert.strictEqual(photoKeyFromStored('tameside-../inbound-email/x'), null);
    assert.strictEqual(photoKeyFromStored('tameside-/social-videos/week-1.mp4'), null);
  });

  it('requires a flat key, which all 322 of ours are', () => {
    assert.strictEqual(photoKeyFromStored('tameside-2025/x.jpg'), null);
  });

  it('accepts a bare key, so storing keys instead of URLs stays a one-line change', () => {
    assert.strictEqual(photoKeyFromStored('tameside-20252026-Manor A-Disley A.jpg'),
      'tameside-20252026-Manor A-Disley A.jpg');
  });

  it('fails closed with no bucket configured', () => {
    const saved = process.env.S3_BUCKET_NAME;
    delete process.env.S3_BUCKET_NAME;
    try {
      // Nothing to compare a host against, and "serve it anyway" is the bug being fixed.
      assert.strictEqual(
        photoKeyFromStored(`https://${saved}.s3.eu-west-1.amazonaws.com/tameside-x.jpg`), null);
    } finally { process.env.S3_BUCKET_NAME = saved; }
  });
});

describe('content type comes from the extension, never from S3', () => {
  // These objects were uploaded through a /sign-s3 that was unauthenticated and took the
  // caller's content type, so a legacy object can claim anything at all. Echoing it back
  // would make the route a way to serve HTML or script from our OWN origin — worse than
  // from the bucket, because here it is same-origin with the __session cookie.
  it('has no way to be told a type', () => {
    assert.strictEqual(contentTypeFor.length, 1);
  });

  it('serves every extension present in our 322 rows', () => {
    assert.strictEqual(contentTypeFor('tameside-x.jpg'), 'image/jpeg');   // 148
    assert.strictEqual(contentTypeFor('tameside-x.jpeg'), 'image/jpeg');  // 120
    assert.strictEqual(contentTypeFor('tameside-x.heic'), 'image/heic');  //  11
    assert.strictEqual(contentTypeFor('tameside-x.png'), 'image/png');    //   3
    assert.strictEqual(downloadTypeFor('tameside-x.pdf'), 'application/pdf'); // 40
  });

  it('is case-insensitive, because 60-odd keys end .JPG', () => {
    assert.strictEqual(contentTypeFor('tameside-x.JPG'), 'image/jpeg');
    assert.strictEqual(contentTypeFor('tameside-x.JPEG'), 'image/jpeg');
  });

  it('refuses anything that is not an image or a document', () => {
    for (const key of ['tameside-x.html', 'tameside-x.svg', 'tameside-x.js', 'tameside-x', 'tameside-x.DomeA']) {
      assert.strictEqual(contentTypeFor(key), null, key);
      assert.strictEqual(downloadTypeFor(key), null, key);
    }
  });

  it('never reports a PDF as inline-able', () => {
    // A PDF rendered inline runs in our origin and PDFs can carry script. The two
    // functions are separate so a caller cannot serve one without the attachment header.
    assert.strictEqual(contentTypeFor('tameside-x.pdf'), null);
    assert.strictEqual(contentTypeFor('tameside-x.docx'), null);
  });
});

describe('downloadNameFor', () => {
  it('cannot break out of the Content-Disposition header', () => {
    assert.strictEqual(downloadNameFor('tameside-a"b\r\nX-Evil: 1.pdf'), 'tameside-abX-Evil: 1.pdf');
  });
  it('drops any path and falls back to a name', () => {
    assert.strictEqual(downloadNameFor('a/b/tameside-x.pdf'), 'tameside-x.pdf');
    assert.strictEqual(downloadNameFor(''), 'scorecard');
    assert.strictEqual(downloadNameFor(null), 'scorecard');
  });
});
