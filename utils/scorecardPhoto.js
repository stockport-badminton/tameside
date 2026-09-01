// Reading a scorecard photo back out of S3, without the object needing to be public.
//
// WHY THIS EXISTS
//
// Tameside and the Stockport league site share ONE bucket, `badmintontemp`, which
// Stockport owns. Nobody planned that; it was found while auditing the bucket. Every
// object at the root is world-readable — not from a bucket policy but from the
// per-object `ACL: public-read` that /sign-s3 used to set at upload time — and our
// photos were rendered straight from the bucket, with the public URL stored in
// `scorecardstore."scoresheet-url"` and pasted into the notification email. So the
// authorization on a photo of a match was "know the URL", forever, for anyone that
// email was ever forwarded to.
//
// Stockport is now stripping those ACLs (their HARD-02b). The sweep covers the bucket
// ROOT, which is where our photos live, so without a credentialed read path every
// Tameside scorecard photo turns into a 403. This module is the key-derivation half of
// that read path; `GET /scorecard-photo/:id` (app.js) is the route.
//
// WHAT THE DATA ACTUALLY LOOKS LIKE (measured against production, 2026-09-01)
//
// 1,210 rows in `scorecardstore`, 1,139 with a non-empty `scoresheet-url`. They fall
// into two eras, and the split is the single most important fact here:
//
//   ids 1758-2087  322 rows  keys `tameside-...`     306 of 322 join a real fixture
//   ids  878-1757  817 rows  keys with NO prefix       9 of 817 join a real fixture
//
// The 817 are NOT ours. `scorecardstore` was cloned from Stockport's database when this
// site was built, and those rows are Stockport's drafts pointing at Stockport's objects
// at the bucket root: their team names are Canute, Dome, Cheadle Hulme, Macclesfield,
// Tatton, Parrswood, Racketeers, Carrington, Altrincham Central, David Lloyd — clubs
// that do not exist anywhere in this database. All 27 sampled are still live and still
// public.
//
// That is why the ownership rule below is an ALLOWLIST on the `tameside-` prefix rather
// than a denylist of the other prefixes in the bucket. A denylist would have let
// `/scorecard-photo/1545` stream another league's scorecard out of *our* origin to any
// logged-in Tameside user — the same "moved the problem rather than solved it" failure
// as a route that takes an object key from the request. Those 817 rows 404, which is
// correct: nothing in the UI has ever rendered a photo for them (the only two places a
// photo URL is surfaced are the upload thank-you page and the results-secretary email,
// both of which only ever see a row that was just created).
//
// Consequently the denied-prefix list is documentation rather than enforcement — the
// `tameside-` requirement already excludes `inbound-email/` (Stockport's SES drop),
// `social-videos/` (Stockport's weekly videos), `scorecard-ocr-cache/` (our Vision
// cache, which is not a scorecard) and every un-prefixed root object. It is kept
// because naming them is how the next person learns the bucket is shared.

// Other things living in the same bucket, none of which this route will ever serve.
// Enforcement is the `tameside-` allowlist in ownKey(); this list exists so the
// sharing is legible from the code.
const DENIED_PREFIXES = [
  'inbound-email/',        // Stockport, written by SES
  'social-videos/',        // Stockport, weekly social videos
  'scorecard-ocr-cache/',  // ours, but cached Vision JSON — not a photo
];

// The prefix that makes an object ours. Every one of the 322 photo rows this site has
// written carries it, and the client builds it explicitly (`"tameside-" + SEASON + ...`
// in views/email-scorecard.ejs), as does the OCR flow (`tameside-ocr-<timestamp>`).
const OWN_PREFIX = 'tameside-';

// Extension -> the type to SERVE. Built explicitly rather than by inverting a map of
// accepted upload types, so that two spellings of JPEG cannot collapse onto whichever
// happened to be last.
//
// Covers every extension present in our 322 rows: jpg (148), jpeg (120), pdf (40),
// heic (11), png (3). jfif and webp are here because a phone or scanner picking one is
// the sort of thing that shows up as a single broken photo months later, not because
// any row uses them today.
const TYPE_BY_EXTENSION = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  jfif: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
};

// Not images, but real scorecards — 40 of our 322 photos are PDFs, an eighth of the
// archive, filed by captains who scanned the card rather than photographing it. A
// reader that 404s them turns "make photos private" into "silently lose an eighth of
// the archive", which is a worse outcome than the one being prevented.
//
// Served as a download, never inline: an inline PDF renders in OUR origin and PDFs can
// carry script. The route pairs the attachment disposition with `nosniff` so the type
// cannot be re-guessed. `doc`/`docx` are listed because Stockport's identical column
// held 16 of them; ours holds none today, and one arriving should not 404.
const DOWNLOAD_TYPE_BY_EXTENSION = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  doc: 'application/msword',
};

// The three host spellings that appear in the column, all of which are this bucket:
//
//   808 badmintontemp.s3-eu-west-1.amazonaws.com   (the dashed regional form, majority)
//   325 badmintontemp.s3.eu-west-1.amazonaws.com   (what the current uploader writes)
//         badmintontemp.s3.amazonaws.com           (the global form; not in our data,
//                                                   but is what S3 hands out by default)
//
// Path style (`s3.eu-west-1.amazonaws.com/badmintontemp/...`) is accepted too. A reader
// built only for the shape today's uploader writes would 404 two thirds of the archive,
// silently.
function isOurHost(host, bucket) {
  const h = host.toLowerCase();
  if (h === bucket) return 'path';                       // rare, but legal
  if (h.startsWith(bucket + '.') && /\.amazonaws\.com$/.test(h)) return 'virtual';
  if (/^s3[.-][a-z0-9-]+\.amazonaws\.com$/.test(h) || h === 's3.amazonaws.com') return 'path';
  return null;
}

// Structural checks that have nothing to do with ownership: is this a plausible S3 key
// at all, and is it one we are willing to name?
function cleanKey(raw) {
  if (typeof raw !== 'string') return null;

  // Percent-decoding is what the browser did on its way to S3, so the key GetObject
  // needs is the decoded one. A malformed escape throws; that is not a photo.
  let key;
  try {
    key = decodeURIComponent(raw.replace(/^\/+/, ''));
  } catch (err) {
    return null;
  }

  if (!key || key.length > 1024) return null;
  // S3 has no directories, so `..` can only ever be a literal segment — but a key
  // containing one is not something this codebase put there.
  if (key.startsWith('/') || key.split('/').includes('..')) return null;
  // Control characters only. Spaces are legitimate and in fact the norm: the real keys
  // are `tameside-20252026-Hyde High B-GHAP A.pdf`.
  if (/[\x00-\x1f\x7f]/.test(key)) return null;

  const lower = key.toLowerCase();
  if (DENIED_PREFIXES.some(prefix => lower.startsWith(prefix))) return null;

  return key;
}

// The ownership rule, kept separate from cleanKey so the reason it exists stays visible.
//
// Two conditions, and the second is not redundant. `startsWith('tameside-')` alone admits
// `tameside-../inbound-email/x`: no path SEGMENT equals `..`, so cleanKey's traversal
// check does not fire, and the denied-prefix check compares against the start of the
// string, which is `tameside-`. S3 keys are literal — there is no path resolution, so
// that key would not actually reach `inbound-email/` — but "starts with our prefix and
// then names someone else's" is not a shape the ownership rule should be conceding.
//
// Requiring a flat key closes the class rather than the instance, and it is the tightest
// true statement about our objects: all 322 of them are root objects
// (`tameside-<season>-<home>-<away>.<ext>`, or `tameside-ocr-<timestamp>.<ext>` from the
// wizard), and none contains a slash — verified against production. The only prefixed
// thing this site writes is the Vision cache under `scorecard-ocr-cache/`, which is JSON
// rather than a photo and is denied above.
function ownKey(key) {
  if (!key) return null;
  if (!key.startsWith(OWN_PREFIX)) return null;
  if (key.includes('/')) return null;
  return key;
}

// The S3 object key a stored `scoresheet-url` refers to, or null if the value is not one
// of OUR scorecard photos.
//
// Fails closed when S3_BUCKET_NAME is unset: with no bucket name there is nothing to
// compare a host against, and "serve it anyway" is the bug being fixed.
function photoKeyFromStored(stored) {
  if (typeof stored !== 'string') return null;
  const value = stored.trim();
  if (!value) return null;
  // 6 rows hold the literal string "undefined" (ids 1749-1754), from a client that
  // interpolated a missing variable. Not a URL, not a key, and `new URL()` would throw.
  if (value === 'undefined' || value === 'null') return null;

  const bucket = String(process.env.S3_BUCKET_NAME || '').trim().toLowerCase();
  if (!bucket) return null;

  // A bare key, for when new uploads eventually store the key instead of a URL. That
  // stays a one-line decision rather than a migration of a column of historical URLs.
  if (!/^[a-z][a-z0-9+.-]*:/i.test(value)) return ownKey(cleanKey(value));

  let url;
  try {
    url = new URL(value);
  } catch (err) {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;

  const style = isOurHost(url.hostname, bucket);
  if (!style) return null;

  let path = url.pathname.replace(/^\/+/, '');
  if (style === 'path') {
    // The bucket is the first segment, and it must be ours — `s3.eu-west-1.amazonaws.com`
    // fronts every bucket in the region, so without this check any bucket on S3 would
    // pass the host test.
    if (path !== bucket && !path.startsWith(bucket + '/')) return null;
    path = path.slice(bucket.length + 1);
  }

  // `+` in a stored URL means a space, and the object's real key has the space.
  //
  // The upload widget rebuilds the object URL by trimming the signature off the
  // presigned one and then rewriting `%20` as `+`
  // (`.replaceAll('%20','+')`, views/email-scorecard.ejs). So 314 rows hold URLs like
  // `.../tameside-20252026-Manor+A-Syddal+Park+A.jpg` for an object actually keyed
  // `tameside-20252026-Manor A-Syddal Park A.jpg`.
  //
  // Those URLs work, which is why nobody noticed: S3's REST endpoint decodes `+` in a
  // path as a space, so the browser fetched the right object — both spellings answer 200
  // over HTTPS, which reads at first glance like two objects and is one. GetObject does
  // NOT do that; it takes the key literally. So proxying without this line asks for a key
  // that has never existed and 404s every photo from the `+` era.
  //
  // Safe unconditionally on this branch: it runs only for values that arrived as a URL,
  // where `+` is the URL spelling of a space. No key this codebase mints contains a
  // literal `+` — they are built from `tameside-`, a season, and two team names.
  path = path.replace(/\+/g, ' ');

  return ownKey(cleanKey(path));
}

// The Content-Type the route will admit to for an inline image, or null if this object
// is not an image we recognise.
//
// What S3 reports is deliberately NOT trusted. Objects uploaded before /sign-s3 stopped
// setting the caller's content type carry whatever the browser sent, and /sign-s3 was
// unauthenticated, so a legacy object can claim anything at all. Echoing that back would
// make this route a way to serve HTML or script from our OWN origin — strictly worse than
// from the bucket, because here it is same-origin with the `__session` cookie. The
// extension is the only input.
function contentTypeFor(key) {
  const match = String(key || '').match(/\.([a-z0-9]+)$/i);
  if (!match) return null;
  return TYPE_BY_EXTENSION[match[1].toLowerCase()] || null;
}

// The type for an object that is a genuine scorecard but not an image. Kept as a
// separate function from contentTypeFor rather than one map with a flag, so that a
// caller cannot accidentally render one of these inline: the two answers mean different
// things and the attachment disposition is not optional.
function downloadTypeFor(key) {
  const match = String(key || '').match(/\.([a-z0-9]+)$/i);
  if (!match) return null;
  return DOWNLOAD_TYPE_BY_EXTENSION[match[1].toLowerCase()] || null;
}

// The filename offered to the browser for an attachment. Quotes, backslashes and CRLF
// are stripped so the value cannot break out of the Content-Disposition header — the key
// comes from a database column that accepted any string for years, which is reason enough
// not to trust it, and three rows in it end in `.DomeA`, `.22` and
// `.12102022_APBC_C_Vs_CollegeGreenD`.
function downloadNameFor(key) {
  const base = String(key || '').split('/').pop() || 'scorecard';
  const safe = base.replace(/["\\\r\n]/g, '').trim();
  return safe || 'scorecard';
}

module.exports = {
  photoKeyFromStored,
  contentTypeFor,
  downloadTypeFor,
  downloadNameFor,
  cleanKey,
  ownKey,
  OWN_PREFIX,
  DENIED_PREFIXES,
  TYPE_BY_EXTENSION,
  DOWNLOAD_TYPE_BY_EXTENSION,
};
