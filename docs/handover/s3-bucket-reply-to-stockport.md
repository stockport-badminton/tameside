# Reply: Tameside has its own read path — you can sweep the whole root

**Written 1 Sep 2026, in answer to `league-site/docs/handover/tameside-s3-bucket.md`.**
The change your note asked for is done and verified; this is the "tell the Stockport side
which one you picked" half, plus three corrections to the audit that note was based on.

## The answer

**Option A.** Tameside now reads scorecard photos through
`GET /scorecard-photo/:id` — keyed by our own `scorecardstore` row id, resolved to an
object key server-side, fetched with credentials and streamed. Nothing on our side renders
a photo from a bucket URL any more.

**So HARD-02b step 3 does not need to exclude `tameside-*`.** Sweep the whole root. Our
photos keep working whether the objects are public or private, because the read path does
not care which they are.

One sequencing ask, in **Residual risks** below: don't change **Object Ownership** to
`bucket owner enforced` without a word first.

## What we changed, on both sides of the object

**Read.** `GET /scorecard-photo/:id` (`secured`), modelled closely on yours —
`utils/scorecardPhoto.js` for key derivation, `controllers/fixtureController.js` for the
route. Keyed on the row, never on a key from the request. Content type from the extension
only, never echoed from S3. PDFs as `attachment`, `X-Content-Type-Options: nosniff`,
`Cache-Control: private`.

**Write.** `GET /sign-s3` **no longer sets `ACL: 'public-read'`**, and is now `secured`.
This is the part that makes your sweep durable rather than one-off: while that ACL was
there, the bucket would have drifted back to world-readable one scorecard at a time and
nobody would have noticed. It also means Tameside will not add a new public object to your
bucket again.

While we were in there: our `/sign-s3` was **unauthenticated** and presigned a PUT with a
caller-chosen key and content type into your bucket, so anyone could write any object
anywhere in it — including over your scorecards. That is closed. (Your own `/sign-s3`
already builds the key itself, and its comment says the residual anonymous upload is
deliberately out of scope, so this is a note rather than a suggestion.)

## Three corrections to the audit

### 1. `tameside-` is a reliable discriminator for objects — but our *database* references 817 of yours

Your note says "nothing in the bucket distinguishes the two leagues except that
`tameside-` prefix", and that holds up: all 322 photo rows Tameside has ever written
resolve to a `tameside-`-prefixed key, and 321 of the 322 exist in the bucket today.

What the audit could not see is the other direction. **`scorecardstore` in the Tameside
database was cloned from yours when that site was built.** Of 1,139 rows holding a photo
URL:

| rows | ids | keys | join a real Tameside fixture |
|---|---|---|---|
| 322 | 1758–2087 | `tameside-…` | 306 |
| **817** | **878–1757** | **un-prefixed, i.e. yours** | **9** |

The 817 are your drafts, pointing at your objects at the shared root. Their teams are
Canute, Dome, Cheadle Hulme, Macclesfield, Tatton, Parrswood, Racketeers, Carrington,
Altrincham Central, David Lloyd — clubs that do not exist anywhere in the Tameside
database.

**Nothing is needed from you for this, and it does not change the sweep.** It mattered on
our side because it decided the shape of the containment rule: ownership had to be an
**allowlist** on `tameside-`, not a denylist of the prefixes we knew about. With a
denylist, `/scorecard-photo/1545` would have streamed one of your scorecards out of *our*
origin to any logged-in Tameside user — the same class of mistake as accepting an object
key from the request, only harder to spot. Those 817 rows now 404 deliberately.

It is worth knowing if you ever reconcile object counts against a database, though: the
~1,117 un-prefixed root objects are entirely yours to decide about, and 817 Tameside rows
naming some of them is an artefact of the clone, not a claim on them.

### 2. `%20` and `+` are one object reached two ways, not two objects

Your `utils/scorecardPhoto.js` already has this right, and the comment in it is what
saved us the debugging, so this is only a flag for the *audit* rather than the code.

Anonymous `curl` over HTTPS answers **200 for both spellings**, which reads at a glance
like two objects:

```
tameside-20242025-Aerospace%20A-GHAP%20A.pdf   200
tameside-20242025-Aerospace+A-GHAP+A.pdf       200
```

Credentialed `HeadObject` settles it — there is one object, and its key has a space:

```
NotFound   "tameside-20242025-Aerospace+A-GHAP+A.pdf"
FOUND      "tameside-20242025-Aerospace A-GHAP A.pdf"   application/pdf  207874
```

S3's REST endpoint decodes `+` in a path as a space; `GetObject` does not. **314 of our 322
rows use the `+` spelling** — 98% of the Tameside archive — because our upload widget
rewrites `%20` to `+` when it trims the signature off the presigned URL. Getting this line
wrong does not degrade gracefully; it 404s almost everything. (For contrast, 811 of the 817
inherited rows use `%20` and none uses `+`, so this is our widget's doing, not something
that came over with the clone.) Any checker that counts over HTTP will
double-count this class; `scorecard-photo-audit.js`, going through the app's own key
derivation, will not — which is the point your note makes about hand-rolled parsers, and
it is correct.

### 3. Two host spellings, and the majority is the one you would not write today

Also already handled in your `normalisePhotoUrl`, and mentioned only because a
re-implementation would get it wrong. Across all 1,139 rows in our table, both eras:

| rows | host |
|---|---|
| 808 | `badmintontemp.s3-eu-west-1.amazonaws.com` (dashed) |
| 325 | `badmintontemp.s3.eu-west-1.amazonaws.com` (dotted — what the uploader writes now) |
| 6 | the literal string `undefined` |

A reader built only for the current shape 404s two thirds of the archive, silently.

## For your object inventory

Ours at the root, all `tameside-` prefixed and all flat (no slashes):

- `tameside-<season>-<home>-<away>.<ext>` — captain uploads. Older ones omit the season.
- `tameside-ocr-<timestamp>.<ext>` — entry-wizard uploads that go through OCR.
- Extensions, across our 322: `jpg` 148, `jpeg` 120, `pdf` 40, `heic` 11, `png` 3 (plus
  uppercase `.JPG`/`.JPEG` variants). **An eighth of our archive is PDFs**, so the same
  "don't 404 the non-images" point your note makes applies here.

`scorecard-ocr-cache/` is ours — cached Google Vision JSON, not photos. It is read only
with credentials and never served to a browser, so it can go private with everything else.
Your note counted 338 root objects to our 322 rows; the difference is re-uploads that
replaced a key, and wizard uploads that never got a row. We don't need any of them
enumerated.

## Residual risks, and the one ask

**Please say so before changing Object Ownership to `bucket owner enforced`.** Your note
covers reads, but that setting breaks *writes*: a presigned PUT carrying `x-amz-acl` fails
outright with `AccessControlListNotSupported`. Tameside's no longer sends one, so we are
fine as of the deploy that carries this — but that ordering is a real dependency, and if it
had gone the other way round it would have broken uploads rather than displays, which is
the harder failure to diagnose from your side.

What we did **not** do, deliberately:

- **We did not move to our own bucket (option B).** The coupling stays: Tameside still
  writes into a bucket Stockport owns, and the next person will rediscover that. Worth
  doing eventually; it wasn't worth blocking your sweep on.
- **We did not clean up the 817 inherited rows.** Harmless — they 404 — and rewriting a
  column that is also the rollback path is its own change.
- **Our route authorizes with `secured` only** — any logged-in league member. Tameside has
  no per-draft token, so we have no equivalent of your HARD-03 `mayOpenDraft`. Matching on
  the uploader's identity instead is a trap we know about: a login address very often is
  not the contact address typed into the form (only 34 of 101 of our role-holders matched
  on their registered email), so that would lock captains out of the photo they had just
  filed. Tightening it needs a token, which is a separate piece of work.
- **One of our rows (id 1767) points at an object that is not in the bucket.**
  Pre-existing; it 404s.

## How this was verified

Against production, 1 Sep 2026:

- **Full sweep of every stored URL through the real key derivation, then credentialed
  `HeadObject`**: 322 claimed as ours, **321 resolved**, 817 refused, 0 with an unservable
  content type. The single miss is id 1767 above.
- **The live route against real S3**: JPEG, PDF and HEIC all served with byte counts
  matching `Content-Length` and `file(1)` confirming real payloads; the inherited rows, the
  `undefined` rows, the dead object, a missing row and a non-numeric id all 404.
- **`/sign-s3`**: the presigned URL's `X-Amz-SignedHeaders` is now `host` alone — no
  `x-amz-acl`.
- **373 tests pass.** `test/scorecard-photo.test.js` pins the key derivation against the
  real URL shapes above (including the `+` translation and the 817-row refusal);
  `test/integration/scorecard-photo.test.js` pins the route's gating and headers,
  specifically that an object claiming `text/html` is still served as `image/jpeg`.

Your point about the checker measuring the checker is well taken and we took it: the sweep
above calls `photoKeyFromStored` rather than reimplementing the parse.

## The one-line version

Option A is shipped. Sweep the whole root, don't flip Object Ownership without a word, and
`tameside-` needs no carve-out.
